import type { RowError, ValidatedRow } from "./validate-rows";

/**
 * Turns the raw "Cargo" and "Unidade" labels from a spreadsheet into position/location ids,
 * using resolutions fetched from api.resolve_import_references during the PREVIEW step.
 *
 * Pure, so it can run in the browser next to validateImportRows and show the user every
 * unresolved label BEFORE a single row is written -- which is the whole point of §18's
 * "497 válidos / 3 erros" requirement.
 *
 * NOTHING is ever created here. A cargo that does not match is a row error the user fixes
 * explicitly; guessing would populate the Phase A requirement matrix with typos, and an
 * invented unidade would create a stock bucket nobody meant to exist.
 */

export type ReferenceKind = "POSITION" | "LOCATION";
export type ReferenceOutcome = "RESOLVED" | "NOT_FOUND" | "AMBIGUOUS" | "INACTIVE";

export type ReferenceResolution = {
  kind: ReferenceKind;
  raw: string;
  resolvedId: string | null;
  outcome: ReferenceOutcome;
  suggestions: string[] | null;
};

export type ResolvedRow = ValidatedRow & {
  positionId: string | null;
  locationId: string | null;
};

export type ResolutionResult = {
  resolvedRows: ResolvedRow[];
  errors: RowError[];
};

/** Matches app.normalize_import_label: trim, collapse whitespace, NFC, lower. Accents are
 * deliberately preserved on both sides -- "Soldador" and "Soldádor" must not silently
 * become the same catalog entry. */
export function normalizeLabel(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function describe(kind: ReferenceKind, raw: string, resolution: ReferenceResolution | undefined): string {
  const noun = kind === "POSITION" ? "Cargo" : "Unidade";
  if (!resolution || resolution.outcome === "NOT_FOUND") {
    const hint = resolution?.suggestions?.length
      ? ` Semelhantes: ${resolution.suggestions.slice(0, 3).join(", ")}.`
      : "";
    return `${noun} "${raw}" não encontrado. Crie ou corrija antes de importar.${hint}`;
  }
  if (resolution.outcome === "INACTIVE") {
    return `${noun} "${raw}" existe mas está inativo. Reative-o ou escolha outro.`;
  }
  // AMBIGUOUS is only reachable for locations: app.locations has no unique index on name or
  // code, so two active units of the same company can legitimately share a label. Picking
  // "the first one" would silently place people in the wrong stock bucket.
  return `${noun} "${raw}" corresponde a mais de um registro. Desfaça a ambiguidade antes de importar.`;
}

export function applyReferenceResolution(
  rows: readonly ValidatedRow[],
  resolutions: readonly ReferenceResolution[],
): ResolutionResult {
  const byKey = new Map<string, ReferenceResolution>();
  for (const resolution of resolutions) {
    byKey.set(`${resolution.kind}:${normalizeLabel(resolution.raw)}`, resolution);
  }

  const resolvedRows: ResolvedRow[] = [];
  const errors: RowError[] = [];

  for (const row of rows) {
    const reasons: string[] = [];
    let positionId: string | null = null;
    let locationId: string | null = null;

    if (row.positionTitle) {
      const resolution = byKey.get(`POSITION:${normalizeLabel(row.positionTitle)}`);
      if (resolution?.outcome === "RESOLVED" && resolution.resolvedId) {
        positionId = resolution.resolvedId;
      } else {
        reasons.push(describe("POSITION", row.positionTitle, resolution));
      }
    }

    if (row.location) {
      const resolution = byKey.get(`LOCATION:${normalizeLabel(row.location)}`);
      if (resolution?.outcome === "RESOLVED" && resolution.resolvedId) {
        locationId = resolution.resolvedId;
      } else {
        reasons.push(describe("LOCATION", row.location, resolution));
      }
    }

    if (reasons.length > 0) {
      errors.push({ rowNumber: row.rowNumber, reasons });
      continue;
    }

    resolvedRows.push({ ...row, positionId, locationId });
  }

  return { resolvedRows, errors };
}

/** The distinct labels the preview needs to ask the database about. Deduplicated so a
 * 5000-row file with 12 job titles sends 12 strings, not 5000. */
export function collectReferenceLabels(rows: readonly ValidatedRow[]): {
  titles: string[];
  locationRefs: string[];
} {
  const titles = new Set<string>();
  const locationRefs = new Set<string>();
  for (const row of rows) {
    if (row.positionTitle) titles.add(row.positionTitle);
    if (row.location) locationRefs.add(row.location);
  }
  return { titles: [...titles], locationRefs: [...locationRefs] };
}
