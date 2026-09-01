/**
 * Pure, client-safe validation for the CSV employee-import flow (docs/mvp-roadmap.md
 * FASE 1: "upload → preview → mapear colunas → validar → confirm → commit"). No I/O, no
 * "use server"/"use client" -- this runs in the browser right after PapaParse produces
 * rows, so the user sees a full error report before anything is sent anywhere. The Server
 * Action that eventually commits validated rows (src/app/(dashboard)/employees/import/
 * import-actions.ts) re-validates CPF/phone independently -- this module is a UX gate, not
 * the security boundary.
 */
import { isValidCpf, onlyDigits } from "@/lib/br/cpf";
import { normalizePhoneE164 } from "@/lib/br/phone";

export const IMPORT_FIELDS = [
  "full_name",
  "cpf",
  "registration_number",
  "phone",
  "email",
  "position_title",
  "department",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];
export const REQUIRED_IMPORT_FIELDS: ImportField[] = ["full_name", "cpf"];

/** Maps each logical field to the CSV column header the user chose for it (or undefined
 * if left unmapped -- only full_name/cpf are required to be mapped). */
export type ColumnMapping = Partial<Record<ImportField, string>>;

/** One row as PapaParse's `header: true` mode produces it: header name -> cell value. */
export type ParsedCsvRow = Record<string, string>;

export type ValidatedRow = {
  rowNumber: number;
  fullName: string;
  cpf: string; // 11 raw digits
  registrationNumber: string | null;
  phone: string | null; // E.164, already normalized
  email: string | null;
  positionTitle: string | null;
  department: string | null;
};

export type RowError = {
  rowNumber: number;
  reasons: string[];
};

export type ValidationResult = {
  validRows: ValidatedRow[];
  errors: RowError[];
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getField(row: ParsedCsvRow, mapping: ColumnMapping, field: ImportField): string {
  const header = mapping[field];
  if (!header) return "";
  const value = row[header];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validates every parsed CSV row against the current column mapping: required fields
 * present, CPF structurally valid, phone/e-mail well-formed when given, and no CPF
 * duplicated within the file itself. Rows are never silently dropped -- every row ends up
 * in exactly one of `validRows` or `errors` (with the row number as it appears in the
 * original file, header counted as row 1).
 */
export function validateImportRows(rows: ParsedCsvRow[], mapping: ColumnMapping): ValidationResult {
  const errors: RowError[] = [];
  const validRows: ValidatedRow[] = [];
  const firstRowByCpf = new Map<string, number>();

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // row 1 is the header
    const reasons: string[] = [];

    const fullName = getField(row, mapping, "full_name");
    const cpfRaw = getField(row, mapping, "cpf");
    const registrationNumber = getField(row, mapping, "registration_number") || null;
    const phoneRaw = getField(row, mapping, "phone");
    const email = getField(row, mapping, "email") || null;
    const positionTitle = getField(row, mapping, "position_title") || null;
    const department = getField(row, mapping, "department") || null;

    if (!fullName) reasons.push("Nome ausente");

    let cpfDigits: string | null = null;
    if (!cpfRaw) {
      reasons.push("CPF ausente");
    } else if (!isValidCpf(cpfRaw)) {
      reasons.push("CPF inválido");
    } else {
      cpfDigits = onlyDigits(cpfRaw);
      const firstRow = firstRowByCpf.get(cpfDigits);
      if (firstRow !== undefined) {
        reasons.push(`CPF duplicado (já aparece na linha ${firstRow})`);
        cpfDigits = null; // don't double-count the dupe as a candidate valid row
      } else {
        firstRowByCpf.set(cpfDigits, rowNumber);
      }
    }

    let phone: string | null = null;
    if (phoneRaw) {
      phone = normalizePhoneE164(phoneRaw);
      if (!phone) reasons.push("Telefone inválido");
    }

    if (email && !EMAIL_RE.test(email)) reasons.push("E-mail inválido");

    if (reasons.length > 0 || cpfDigits === null) {
      errors.push({ rowNumber, reasons });
      return;
    }

    validRows.push({
      rowNumber,
      fullName,
      cpf: cpfDigits,
      registrationNumber,
      phone,
      email,
      positionTitle,
      department,
    });
  });

  return { validRows, errors };
}
