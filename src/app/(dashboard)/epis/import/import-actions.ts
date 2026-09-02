"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isValidCaNumber } from "@/lib/epi/ca";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

// There is no api.import_epis_commit RPC: unlike employees (20,000 rows a shift), a PPE
// catalog is dozens of entries, so this loops over the existing, already permission-checked
// api.create_epi rather than adding a bulk RPC and a migration for it. That means one round
// trip per row, which is why the chunk is small -- it exists to give the wizard real
// progress, not to fit a request body.
const MAX_ROWS_PER_CALL = 50;

const rowSchema = z.object({
  name: z.string().trim().min(1).max(200),
  caNumber: z.string().trim(),
  manufacturer: z.string().trim().nullable().optional(),
  model: z.string().trim().nullable().optional(),
  description: z.string().trim().nullable().optional(),
  defaultUnit: z.enum(["UN", "PAR", "CX", "M", "KG"]),
});

export type EpiImportCommitRow = z.infer<typeof rowSchema>;

export type EpiImportChunkResult =
  | {
      ok: true;
      created: number;
      /** Rows whose CA is already in this catalog -- re-importing a file is not an error. */
      alreadyInCatalog: number;
      /** Rows that failed re-validation here and were left out of the batch. */
      skipped: number;
      /** Rows the database refused for some other reason, with the CA to look them up by. */
      failures: { caNumber: string; error: string }[];
    }
  | { ok: false; error: string };

/**
 * Commits ONE chunk of already client-validated catalog rows. Never receives the raw CSV
 * file -- only structured rows the wizard already ran through validateEpiImportRows()
 * (src/lib/csv-import/validate-epi-rows.ts). Re-validates the CA here too, exactly like
 * the manual-create path (src/app/(dashboard)/epis/actions.ts): client-side validation is
 * a UX gate, never the only gate.
 *
 * A duplicate CA is counted, not fatal. api.create_epi raises ca_already_registered
 * (23505) for one, and importing a corrected version of a file you already imported has to
 * be a safe thing to do -- so those rows are reported as "já no catálogo" and the rest of
 * the chunk still lands. This is deliberately NOT an upsert: changing a catalog entry opens
 * a new SCD2 version and is the edit screen's job, not an import's.
 */
export async function commitEpiImportChunk(
  organizationId: string,
  companyId: string,
  scope: "company" | "org",
  rows: EpiImportCommitRow[],
): Promise<EpiImportChunkResult> {
  const t = getDictionary(await getLocale());
  if (!z.uuid().safeParse(organizationId).success || !z.uuid().safeParse(companyId).success) {
    return { ok: false, error: t.epis.invalidCompany };
  }
  if (rows.length === 0) {
    return { ok: true, created: 0, alreadyInCatalog: 0, skipped: 0, failures: [] };
  }
  if (rows.length > MAX_ROWS_PER_CALL) {
    return {
      ok: false,
      error: `${t.epis.maxRowsPerBatchPrefix} ${MAX_ROWS_PER_CALL} ${t.epis.maxRowsPerBatchSuffix}`,
    };
  }

  const supabase = await createClient();
  let created = 0;
  let alreadyInCatalog = 0;
  let skipped = 0;
  const failures: { caNumber: string; error: string }[] = [];

  for (const raw of rows) {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success || !isValidCaNumber(parsed.data.caNumber)) {
      skipped += 1;
      continue;
    }

    const { error } = await supabase.schema("api").rpc("create_epi", {
      p_organization_id: organizationId,
      p_company_id: scope === "org" ? null : companyId,
      p_name: parsed.data.name,
      p_ca_number: parsed.data.caNumber,
      p_manufacturer: parsed.data.manufacturer || null,
      p_model: parsed.data.model || null,
      p_description: parsed.data.description || null,
      p_default_unit: parsed.data.defaultUnit,
    });

    if (!error) {
      created += 1;
      continue;
    }

    if (error.code === "23505") {
      alreadyInCatalog += 1;
      continue;
    }

    // A permission failure is about the whole import, not this row -- stop rather than
    // walk the rest of the file collecting the same message N times.
    if (error.code === "42501" || error.code === "28000") {
      return { ok: false, error: describeRpcError(error, t.epis.importChunkFailed) };
    }

    failures.push({ caNumber: parsed.data.caNumber, error: describeRpcError(error, t.epis.importChunkFailed) });
  }

  return { ok: true, created, alreadyInCatalog, skipped, failures };
}

/** Called once after all chunks have committed, to refresh the catalog list. Split out so
 * the wizard doesn't need to import next/cache directly. */
export async function revalidateEpisAfterImport(): Promise<void> {
  revalidatePath("/epis");
}
