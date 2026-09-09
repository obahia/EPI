"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isValidCpf, onlyDigits, maskCpf } from "@/lib/br/cpf";
import { normalizePhoneE164 } from "@/lib/br/phone";
import { hashCpf, encryptCpf } from "@/lib/crypto/cpf-secrets";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { reportFailure } from "@/lib/observability/report";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import type { ReferenceResolution } from "@/lib/csv-import/resolve-references";

// The RPC itself hard-caps at 20,000 rows/call (batch_too_large, 54000) -- this is a much
// smaller per-request ceiling so a single Server Action invocation's body stays well under
// Next's default action body-size limit. The import wizard (import-wizard.tsx) is what
// enforces the real 20,000-row-per-file cap, client-side, before it ever starts calling
// this in a loop -- see docs/mvp-roadmap.md FASE 1.
const MAX_ROWS_PER_CALL = 2000;

const rowSchema = z.object({
  fullName: z.string().trim().min(1),
  cpf: z.string(),
  registrationNumber: z.string().trim().nullable().optional(),
  phone: z.string().trim().nullable().optional(),
  email: z.string().trim().nullable().optional(),
  positionTitle: z.string().trim().nullable().optional(),
  department: z.string().trim().nullable().optional(),
  // Phase F: already resolved to ids during the preview step. Re-validated inside
  // api.import_employees_commit against the tenant anyway -- the wizard is a UX gate,
  // never the security boundary.
  positionId: z.uuid().nullable().optional(),
  locationId: z.uuid().nullable().optional(),
});

export type ImportCommitRow = z.infer<typeof rowSchema>;

export type ImportChunkResult =
  | { ok: true; created: number; updated: number; skipped: number }
  | { ok: false; error: string };

/**
 * Commits ONE chunk of already client-validated rows for the CSV import flow. Never
 * receives the raw CSV file -- only structured row data the wizard already ran through
 * validateImportRows() (src/lib/csv-import/validate-rows.ts). Re-validates CPF/phone here
 * too and computes cpf_hash/cpf_enc/cpf_masked, exactly like the manual-create path
 * (src/app/(dashboard)/employees/actions.ts) -- client-side validation is a UX gate, never
 * the only gate. Any row that fails re-validation is silently excluded from the batch (not
 * the whole call) and counted in `skipped` -- this should be rare/never in practice since
 * the wizard only ever sends rows that already passed the same checks.
 */
export async function commitEmployeeImportChunk(
  companyId: string,
  rows: ImportCommitRow[],
  run?: { importRunId: string; chunkIndex: number; rowFrom: number; rowTo: number },
): Promise<ImportChunkResult> {
  const t = getDictionary(await getLocale());
  if (!z.uuid().safeParse(companyId).success) {
    return { ok: false, error: t.employees.invalidCompany };
  }
  if (rows.length === 0) {
    return { ok: true, created: 0, updated: 0, skipped: 0 };
  }
  if (rows.length > MAX_ROWS_PER_CALL) {
    return {
      ok: false,
      error: `${t.employees.maxRowsPerBatchPrefix} ${MAX_ROWS_PER_CALL} ${t.employees.maxRowsPerBatchSuffix}`,
    };
  }

  const payload: Record<string, string | null>[] = [];
  let skipped = 0;

  for (const raw of rows) {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success || !isValidCpf(parsed.data.cpf)) {
      skipped += 1;
      continue;
    }

    let phoneE164: string | null = null;
    if (parsed.data.phone) {
      phoneE164 = normalizePhoneE164(parsed.data.phone);
      if (!phoneE164) {
        skipped += 1;
        continue;
      }
    }

    const cpfDigits = onlyDigits(parsed.data.cpf);
    payload.push({
      full_name: parsed.data.fullName,
      cpf_hash_b64: hashCpf(cpfDigits).toString("base64"),
      cpf_enc_b64: encryptCpf(cpfDigits).toString("base64"),
      cpf_masked: maskCpf(cpfDigits),
      registration_number: parsed.data.registrationNumber || null,
      phone_e164: phoneE164,
      email: parsed.data.email || null,
      position_title: parsed.data.positionTitle || null,
      department: parsed.data.department || null,
      position_id: parsed.data.positionId ?? null,
      location_id: parsed.data.locationId ?? null,
    });
  }

  if (payload.length === 0) {
    return { ok: true, created: 0, updated: 0, skipped };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema("api").rpc("import_employees_commit", {
    p_company_id: companyId,
    p_rows: payload,
    p_import_run_id: run?.importRunId ?? null,
    p_chunk_index: run?.chunkIndex ?? null,
    p_row_from: run?.rowFrom ?? null,
    p_row_to: run?.rowTo ?? null,
  });

  if (error) {
    return { ok: false, error: describeRpcError(error, t.employees.importChunkFailed) };
  }

  const result = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    created: result?.created_count ?? 0,
    updated: result?.updated_count ?? 0,
    skipped,
  };
}

/** Called once after all chunks have committed, to refresh the employee list. Split out
 * so the wizard doesn't need to import next/cache directly. */
export async function revalidateEmployeesAfterImport(): Promise<void> {
  revalidatePath("/employees");
}

// ---------------------------------------------------------------------------------------
// Phase F: reference resolution and durable run tracking
// ---------------------------------------------------------------------------------------

export type ResolveReferencesResult =
  | { ok: true; resolutions: ReferenceResolution[] }
  | { ok: false; error: string };

/**
 * Resolves the distinct Cargo/Unidade labels of a file during the PREVIEW step, so a label
 * that does not match becomes a visible row error before anything is written. Never creates
 * a position or a location -- an unmatched label is the user's to fix.
 */
export async function resolveImportReferences(
  companyId: string,
  titles: string[],
  locationRefs: string[],
): Promise<ResolveReferencesResult> {
  const t = getDictionary(await getLocale());
  if (!z.uuid().safeParse(companyId).success) {
    return { ok: false, error: t.employees.invalidCompany };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema("api").rpc("resolve_import_references", {
    p_company_id: companyId,
    // Capped so a pathological file cannot turn one preview into an unbounded query. A file
    // with more than 500 distinct job titles is a mapping mistake, not a real payroll.
    p_titles: titles.slice(0, 500),
    p_location_refs: locationRefs.slice(0, 500),
  });

  if (error) {
    return { ok: false, error: describeRpcError(error, t.employees.importReferencesFailed) };
  }

  const rows = (data ?? []) as {
    kind: "POSITION" | "LOCATION";
    raw: string;
    resolved_id: string | null;
    outcome: "RESOLVED" | "NOT_FOUND" | "AMBIGUOUS" | "INACTIVE";
    suggestions: string[] | null;
  }[];

  return {
    ok: true,
    resolutions: rows.map((r) => ({
      kind: r.kind,
      raw: r.raw,
      resolvedId: r.resolved_id,
      outcome: r.outcome,
      suggestions: r.suggestions,
    })),
  };
}

export type StartImportRunResult = { ok: true; importRunId: string } | { ok: false; error: string };

/**
 * Opens the durable record of an import. Without it, "which 4000 of my 6000 rows actually
 * landed?" has no answer once the browser tab is gone -- and mass employee creation left no
 * audit trail at all before this phase.
 */
export async function startImportRun(input: {
  companyId: string;
  sourceFormat: "CSV" | "XLSX";
  sourceFilename: string | null;
  columnMapping: Record<string, string | undefined>;
  totalRows: number;
  validRows: number;
  errorRows: number;
  chunkSize: number;
  chunkCount: number;
}): Promise<StartImportRunResult> {
  const t = getDictionary(await getLocale());
  if (!z.uuid().safeParse(input.companyId).success) {
    return { ok: false, error: t.employees.invalidCompany };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema("api").rpc("start_import_run", {
    p_company_id: input.companyId,
    p_source_format: input.sourceFormat,
    p_source_filename: input.sourceFilename,
    p_source_sha256_b64: null,
    p_column_mapping: input.columnMapping,
    p_total_rows: input.totalRows,
    p_valid_rows: input.validRows,
    p_error_rows: input.errorRows,
    p_chunk_size: input.chunkSize,
    p_chunk_count: input.chunkCount,
  });

  if (error) {
    return { ok: false, error: describeRpcError(error, t.employees.importChunkFailed) };
  }
  return { ok: true, importRunId: data as string };
}

/** Marks the run COMPLETED, PARTIAL or ABANDONED from what actually committed -- never from
 * what the browser believes happened. */
export async function finishImportRun(
  importRunId: string,
): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const t = getDictionary(await getLocale());
  const supabase = await createClient();
  const { data, error } = await supabase.schema("api").rpc("finish_import_run", {
    p_import_run_id: importRunId,
  });
  if (error) {
    reportFailure("import.commit", error, { importRunId, signal: "finish_import_run_failed" });
    return { ok: false, error: describeRpcError(error, t.employees.importChunkFailed) };
  }
  return { ok: true, status: data as string };
}
