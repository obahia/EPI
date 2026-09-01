"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isValidCpf, onlyDigits, maskCpf } from "@/lib/br/cpf";
import { normalizePhoneE164 } from "@/lib/br/phone";
import { hashCpf, encryptCpf } from "@/lib/crypto/cpf-secrets";
import { describeRpcError } from "@/lib/supabase/rpc-error";

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
): Promise<ImportChunkResult> {
  if (!z.uuid().safeParse(companyId).success) {
    return { ok: false, error: "Empresa inválida." };
  }
  if (rows.length === 0) {
    return { ok: true, created: 0, updated: 0, skipped: 0 };
  }
  if (rows.length > MAX_ROWS_PER_CALL) {
    return { ok: false, error: `Máximo de ${MAX_ROWS_PER_CALL} linhas por lote.` };
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
    });
  }

  if (payload.length === 0) {
    return { ok: true, created: 0, updated: 0, skipped };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema("api").rpc("import_employees_commit", {
    p_company_id: companyId,
    p_rows: payload,
  });

  if (error) {
    return { ok: false, error: describeRpcError(error, "Falha ao importar um dos lotes.") };
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
