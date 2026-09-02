/**
 * Pure, client-safe validation for the CSV EPI-catalog import flow -- the catalog twin of
 * validate-rows.ts (employees). No I/O, no "use server"/"use client": this runs in the
 * browser right after PapaParse produces rows, so the user sees a full error report before
 * anything is sent anywhere. The Server Action that commits validated rows
 * (src/app/(dashboard)/epis/import/import-actions.ts) re-validates independently, and
 * api.create_epi's own CHECK constraints are the real gate -- this module is a UX gate,
 * never the security boundary.
 */
import { isValidCaNumber } from "@/lib/epi/ca";
import type { EpiUnit } from "@/lib/supabase/dal";

export const EPI_IMPORT_FIELDS = [
  "name",
  "ca_number",
  "manufacturer",
  "model",
  "description",
  "default_unit",
] as const;

export type EpiImportField = (typeof EPI_IMPORT_FIELDS)[number];
export const REQUIRED_EPI_IMPORT_FIELDS: EpiImportField[] = ["name", "ca_number"];

/** Maps each logical field to the CSV column header the user chose for it (or undefined
 * if left unmapped -- only name/ca_number are required to be mapped). */
export type EpiColumnMapping = Partial<Record<EpiImportField, string>>;

/** One row as PapaParse's `header: true` mode produces it: header name -> cell value. */
export type ParsedCsvRow = Record<string, string>;

export type ValidatedEpiRow = {
  rowNumber: number;
  name: string;
  caNumber: string; // 3-8 digits, already trimmed
  manufacturer: string | null;
  model: string | null;
  description: string | null;
  defaultUnit: EpiUnit;
};

export type EpiRowError = {
  rowNumber: number;
  reasons: string[];
};

export type EpiValidationResult = {
  validRows: ValidatedEpiRow[];
  errors: EpiRowError[];
};

/**
 * What people actually type in a "unidade" column. The DB stores the five-value enum
 * (app.epi_unit), but a catalog exported from a spreadsheet says "Par", "pares", "caixa",
 * "un." -- refusing those would send most real files straight into the error report for no
 * good reason. Anything unrecognised IS an error rather than a silent fallback to UN: a
 * wrong unit on a delivery receipt is a wrong document.
 */
const UNIT_SYNONYMS: Record<string, EpiUnit> = {
  un: "UN",
  und: "UN",
  unid: "UN",
  unidade: "UN",
  unidades: "UN",
  pc: "UN",
  peca: "UN",
  pecas: "UN",
  par: "PAR",
  pares: "PAR",
  cx: "CX",
  caixa: "CX",
  caixas: "CX",
  m: "M",
  metro: "M",
  metros: "M",
  kg: "KG",
  quilo: "KG",
  quilos: "KG",
  kilo: "KG",
  kilos: "KG",
};

/** Normalises a unit cell to the enum, or null when it means nothing we know. */
export function parseEpiUnit(value: string): EpiUnit | null {
  const key = value
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // strip combining diacritics: "peça" -> "peca"
    .toLowerCase()
    .replace(/[^a-z]/g, ""); // drop the dot in "un."
  return UNIT_SYNONYMS[key] ?? null;
}

function getField(row: ParsedCsvRow, mapping: EpiColumnMapping, field: EpiImportField): string {
  const header = mapping[field];
  if (!header) return "";
  const value = row[header];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validates every parsed CSV row against the current column mapping: name and CA present,
 * CA structurally valid (3-8 digits), unit recognisable when given, and no CA duplicated
 * within the file itself. Rows are never silently dropped -- every row ends up in exactly
 * one of `validRows` or `errors` (with the row number as it appears in the original file,
 * header counted as row 1).
 *
 * A CA that already exists in the company's catalog is NOT an error here: this module
 * cannot see the database. The commit step reports those separately as "já no catálogo",
 * which is what re-importing a slightly changed file should do.
 */
export function validateEpiImportRows(
  rows: ParsedCsvRow[],
  mapping: EpiColumnMapping,
): EpiValidationResult {
  const errors: EpiRowError[] = [];
  const validRows: ValidatedEpiRow[] = [];
  const firstRowByCa = new Map<string, number>();

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // row 1 is the header
    const reasons: string[] = [];

    const name = getField(row, mapping, "name");
    const caRaw = getField(row, mapping, "ca_number");
    const manufacturer = getField(row, mapping, "manufacturer") || null;
    const model = getField(row, mapping, "model") || null;
    const description = getField(row, mapping, "description") || null;
    const unitRaw = getField(row, mapping, "default_unit");

    if (!name) reasons.push("Nome ausente");
    else if (name.length > 200) reasons.push("Nome muito longo (máximo 200 caracteres)");

    let caNumber: string | null = null;
    if (!caRaw) {
      reasons.push("CA ausente");
    } else if (!isValidCaNumber(caRaw)) {
      reasons.push("CA inválido (3 a 8 dígitos, apenas números)");
    } else {
      caNumber = caRaw.trim();
      const firstRow = firstRowByCa.get(caNumber);
      if (firstRow !== undefined) {
        reasons.push(`CA duplicado (já aparece na linha ${firstRow})`);
        caNumber = null; // don't double-count the dupe as a candidate valid row
      } else {
        firstRowByCa.set(caNumber, rowNumber);
      }
    }

    // An unmapped or empty unit column means "unidade" -- the same default api.create_epi
    // uses. Only a value we cannot read is an error.
    let defaultUnit: EpiUnit = "UN";
    if (unitRaw) {
      const parsed = parseEpiUnit(unitRaw);
      if (!parsed) reasons.push(`Unidade não reconhecida: "${unitRaw}"`);
      else defaultUnit = parsed;
    }

    if (reasons.length > 0 || caNumber === null) {
      errors.push({ rowNumber, reasons });
      return;
    }

    validRows.push({ rowNumber, name, caNumber, manufacturer, model, description, defaultUnit });
  });

  return { validRows, errors };
}
