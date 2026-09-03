"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

export type PositionFormState = { error: string | null };

/** Creates a job position via api.create_job_position. `scope` decides whether
 * p_company_id is this company or NULL (org-wide shared entry) -- the RPC itself
 * re-checks that only an org-wide ORG_ADMIN may create with company_id NULL, this is
 * just what the UI offers when that option is shown at all (see position-form.tsx),
 * mirroring epis/actions.ts's createEpi. */
export async function createJobPosition(_prevState: PositionFormState, formData: FormData): Promise<PositionFormState> {
  const t = getDictionary(await getLocale());
  const createSchema = z.object({
    organizationId: z.uuid(),
    companyId: z.uuid(),
    scope: z.enum(["company", "org"]).default("company"),
    title: z.string().trim().min(2, t.positions.nameTooShort).max(150),
    description: z.string().trim().max(2000).optional(),
  });

  const parsed = createSchema.safeParse({
    organizationId: formData.get("organizationId"),
    companyId: formData.get("companyId"),
    scope: formData.get("scope") || "company",
    title: formData.get("title"),
    description: formData.get("description") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.positions.invalidData };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("create_job_position", {
    p_organization_id: parsed.data.organizationId,
    p_company_id: parsed.data.scope === "org" ? null : parsed.data.companyId,
    p_title: parsed.data.title,
    p_description: parsed.data.description || null,
  });

  if (error) {
    return { error: describeRpcError(error, t.positions.createFailed) };
  }

  revalidatePath("/positions");
  redirect(`/positions?company=${parsed.data.companyId}`);
}

/** Edits a job position in place via api.update_job_position (not versioned, unlike the
 * EPI catalog -- see the migration's own table comment). */
export async function updateJobPosition(_prevState: PositionFormState, formData: FormData): Promise<PositionFormState> {
  const t = getDictionary(await getLocale());
  const updateSchema = z.object({
    positionId: z.uuid(),
    companyId: z.string().trim().optional(),
    title: z.string().trim().min(2, t.positions.nameTooShort).max(150),
    description: z.string().trim().max(2000).optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]),
  });

  const parsed = updateSchema.safeParse({
    positionId: formData.get("positionId"),
    companyId: formData.get("companyId") || undefined,
    title: formData.get("title"),
    description: formData.get("description") || undefined,
    status: formData.get("status"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.positions.invalidData };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("update_job_position", {
    p_position_id: parsed.data.positionId,
    p_title: parsed.data.title,
    p_description: parsed.data.description || null,
    p_status: parsed.data.status,
  });

  if (error) {
    return { error: describeRpcError(error, t.positions.saveFailed) };
  }

  revalidatePath("/positions");
  revalidatePath(`/positions/${parsed.data.positionId}`);
  redirect(parsed.data.companyId ? `/positions?company=${parsed.data.companyId}` : "/positions");
}

export type MatrixRowState = { error: string | null; ok: boolean };

/** Upserts one matriz cargo x EPI row via api.set_position_epi_requirement. Each row in
 * the matrix editor is its own tiny form/action pair (see position-matrix.tsx) rather
 * than one big submit, so saving one EPI's requirement never risks another row's
 * unsaved edits. */
export async function setPositionEpiRequirement(_prevState: MatrixRowState, formData: FormData): Promise<MatrixRowState> {
  const t = getDictionary(await getLocale());
  const schema = z.object({
    positionId: z.uuid(),
    epiId: z.uuid(),
    required: z.enum(["true", "false"]),
    quantity: z.coerce.number().int().min(1).max(100),
    periodicityDays: z.coerce.number().int().min(1).max(3650).optional(),
    substitutionNotes: z.string().trim().max(1000).optional(),
  });

  const parsed = schema.safeParse({
    positionId: formData.get("positionId"),
    epiId: formData.get("epiId"),
    required: formData.get("required") === "true" ? "true" : "false",
    quantity: formData.get("quantity") || 1,
    periodicityDays: formData.get("periodicityDays") || undefined,
    substitutionNotes: formData.get("substitutionNotes") || undefined,
  });

  if (!parsed.success) {
    return { error: t.positions.invalidData, ok: false };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("set_position_epi_requirement", {
    p_position_id: parsed.data.positionId,
    p_epi_id: parsed.data.epiId,
    p_required: parsed.data.required === "true",
    p_quantity: parsed.data.quantity,
    p_periodicity_days: parsed.data.periodicityDays ?? null,
    p_substitution_notes: parsed.data.substitutionNotes || null,
  });

  if (error) {
    return { error: describeRpcError(error, t.positions.matrixSaveFailed), ok: false };
  }

  revalidatePath(`/positions/${parsed.data.positionId}`);
  return { error: null, ok: true };
}

const removeSchema = z.object({ requirementId: z.uuid(), positionId: z.uuid() });

/** Removes one matriz row via api.remove_position_epi_requirement -- a hard delete, same
 * as the RPC itself (current-state configuration, not evidentiary history). */
export async function removePositionEpiRequirement(formData: FormData): Promise<void> {
  const parsed = removeSchema.safeParse({
    requirementId: formData.get("requirementId"),
    positionId: formData.get("positionId"),
  });
  if (!parsed.success) {
    return;
  }

  const supabase = await createClient();
  await supabase.schema("api").rpc("remove_position_epi_requirement", {
    p_requirement_id: parsed.data.requirementId,
  });

  revalidatePath(`/positions/${parsed.data.positionId}`);
}
