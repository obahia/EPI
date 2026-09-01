"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isValidCnpj, normalizeCnpj } from "@/lib/br/cnpj";
import { describeRpcError } from "@/lib/supabase/rpc-error";

export type OnboardingState = { error: string | null };

const schema = z.object({
  orgLegalName: z.string().trim().min(2, "Nome muito curto").max(200),
  orgCnpj: z.string().refine(isValidCnpj, "CNPJ da organização inválido"),
  companyLegalName: z.string().trim().min(2, "Nome muito curto").max(200),
  companyCnpj: z.string().refine(isValidCnpj, "CNPJ da empresa inválido"),
  companyTradeName: z.string().trim().max(200).optional(),
});

/**
 * One-time self-serve bootstrap: a user with zero memberships creates their own DIRECT
 * organization + its one company via api.onboard_organization. See
 * docs/mvp-roadmap.md FASE 1 and supabase/migrations/20260831150100_onboarding_and_company_rpcs.sql
 * -- the RPC itself rejects a second call once any membership exists (42710), which is
 * surfaced below as a clear message rather than a raw Postgres error.
 */
export async function onboardOrganization(
  _prevState: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const parsed = schema.safeParse({
    orgLegalName: formData.get("orgLegalName"),
    orgCnpj: formData.get("orgCnpj"),
    companyLegalName: formData.get("companyLegalName"),
    companyCnpj: formData.get("companyCnpj"),
    companyTradeName: formData.get("companyTradeName") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("onboard_organization", {
    p_org_legal_name: parsed.data.orgLegalName,
    p_org_cnpj: normalizeCnpj(parsed.data.orgCnpj),
    p_company_legal_name: parsed.data.companyLegalName,
    p_company_cnpj: normalizeCnpj(parsed.data.companyCnpj),
    p_company_trade_name: parsed.data.companyTradeName || null,
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível concluir o cadastro. Tente novamente.") };
  }

  revalidatePath("/dashboard");
  redirect("/dashboard");
}
