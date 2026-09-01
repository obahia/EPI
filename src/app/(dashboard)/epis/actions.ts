"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isValidCaNumber } from "@/lib/epi/ca";
import { describeRpcError } from "@/lib/supabase/rpc-error";

export type EpiFormState = { error: string | null };

const UNIT_VALUES = ["UN", "PAR", "CX", "M", "KG"] as const;

const createSchema = z.object({
  organizationId: z.uuid(),
  companyId: z.uuid(),
  scope: z.enum(["company", "org"]).default("company"),
  name: z.string().trim().min(2, "Nome muito curto").max(200),
  caNumber: z.string().refine(isValidCaNumber, "CA inválido (3 a 8 dígitos, apenas números)"),
  manufacturer: z.string().trim().max(150).optional(),
  model: z.string().trim().max(150).optional(),
  description: z.string().trim().max(2000).optional(),
  defaultUnit: z.enum(UNIT_VALUES),
});

/** Creates an EPI catalog entry (+ its version 1) via api.create_epi. `scope` decides
 * whether p_company_id is this company or NULL (org-wide shared entry) -- the RPC itself
 * re-checks that only an org-wide ORG_ADMIN may create with company_id NULL, this is just
 * what the UI offers when that option is shown at all (see epi-form.tsx). */
export async function createEpi(_prevState: EpiFormState, formData: FormData): Promise<EpiFormState> {
  const parsed = createSchema.safeParse({
    organizationId: formData.get("organizationId"),
    companyId: formData.get("companyId"),
    scope: formData.get("scope") || "company",
    name: formData.get("name"),
    caNumber: formData.get("caNumber"),
    manufacturer: formData.get("manufacturer") || undefined,
    model: formData.get("model") || undefined,
    description: formData.get("description") || undefined,
    defaultUnit: formData.get("defaultUnit"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("create_epi", {
    p_organization_id: parsed.data.organizationId,
    p_company_id: parsed.data.scope === "org" ? null : parsed.data.companyId,
    p_name: parsed.data.name,
    p_ca_number: parsed.data.caNumber,
    p_manufacturer: parsed.data.manufacturer || null,
    p_model: parsed.data.model || null,
    p_description: parsed.data.description || null,
    p_default_unit: parsed.data.defaultUnit,
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível cadastrar o EPI.") };
  }

  revalidatePath("/epis");
  redirect(`/epis?company=${parsed.data.companyId}`);
}

const updateSchema = z.object({
  epiId: z.uuid(),
  // Not the RPC's business at all -- purely where to redirect back to afterwards (the
  // catalog list for a specific company). May be empty for an org-wide entry opened
  // outside a company context; falls back to the plain /epis list in that case.
  companyId: z.string().trim().optional(),
  name: z.string().trim().min(2, "Nome muito curto").max(200),
  caNumber: z.string().refine(isValidCaNumber, "CA inválido (3 a 8 dígitos, apenas números)"),
  manufacturer: z.string().trim().max(150).optional(),
  model: z.string().trim().max(150).optional(),
  description: z.string().trim().max(2000).optional(),
  defaultUnit: z.enum(UNIT_VALUES),
});

/** Edits an EPI catalog entry via api.update_epi. This opens a NEW epi_version (SCD2)
 * under the hood -- from the UI it's just "edit and save"; deliveries already created
 * keep pointing at the old version, untouched (see docs/mvp-roadmap.md FASE 2). */
export async function updateEpi(_prevState: EpiFormState, formData: FormData): Promise<EpiFormState> {
  const parsed = updateSchema.safeParse({
    epiId: formData.get("epiId"),
    companyId: formData.get("companyId") || undefined,
    name: formData.get("name"),
    caNumber: formData.get("caNumber"),
    manufacturer: formData.get("manufacturer") || undefined,
    model: formData.get("model") || undefined,
    description: formData.get("description") || undefined,
    defaultUnit: formData.get("defaultUnit"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("update_epi", {
    p_epi_id: parsed.data.epiId,
    p_name: parsed.data.name,
    p_ca_number: parsed.data.caNumber,
    p_manufacturer: parsed.data.manufacturer || null,
    p_model: parsed.data.model || null,
    p_description: parsed.data.description || null,
    p_default_unit: parsed.data.defaultUnit,
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível salvar as alterações.") };
  }

  revalidatePath("/epis");
  revalidatePath(`/epis/${parsed.data.epiId}`);
  redirect(parsed.data.companyId ? `/epis?company=${parsed.data.companyId}` : "/epis");
}

const toggleSchema = z.object({
  epiId: z.uuid(),
  companyId: z.uuid(),
  isActive: z.enum(["true", "false"]),
});

/** Toggles ativar/desativar via api.deactivate_epi -- there is no delete for a catalog
 * entry (it may already be referenced by delivery items), only this. */
export async function toggleEpiActive(formData: FormData): Promise<void> {
  const parsed = toggleSchema.safeParse({
    epiId: formData.get("epiId"),
    companyId: formData.get("companyId"),
    isActive: formData.get("isActive"),
  });

  if (!parsed.success) {
    return;
  }

  const supabase = await createClient();
  await supabase.schema("api").rpc("deactivate_epi", {
    p_epi_id: parsed.data.epiId,
    p_is_active: parsed.data.isActive === "true",
  });

  revalidatePath("/epis");
  redirect(`/epis?company=${parsed.data.companyId}`);
}
