"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

export type OrganizationPolicyState = { error: string | null; success: boolean };

const POLICY_VALUES = ["warn", "block", "allow"] as const;

const updatePolicySchema = z.object({
  organizationId: z.uuid(),
  earlyReplacementPolicy: z.enum(POLICY_VALUES),
  replacementAlertDays: z.coerce.number().int().min(1).max(365),
  stockNegativeAllowed: z.enum(["true", "false"]),
  inventoryEnabled: z.enum(["true", "false"]),
  complianceEnabled: z.enum(["true", "false"]),
  roleMatrixEnabled: z.enum(["true", "false"]),
});

/**
 * Writes the six org-wide policy/feature-flag fields via api.update_organization_policy --
 * ORG_ADMIN only (the RPC itself re-enforces this; SettingsPage just never renders the form
 * for anyone else, same "UI offers only what the RPC would actually accept" discipline as
 * epis/new/page.tsx's own canCreateOrgWide).
 */
export async function updateOrganizationPolicy(
  _prevState: OrganizationPolicyState,
  formData: FormData,
): Promise<OrganizationPolicyState> {
  const t = getDictionary(await getLocale());
  const parsed = updatePolicySchema.safeParse({
    organizationId: formData.get("organizationId"),
    earlyReplacementPolicy: formData.get("earlyReplacementPolicy"),
    replacementAlertDays: formData.get("replacementAlertDays"),
    // Checkboxes are simply absent from FormData when unchecked -- coerced to the same
    // "true"/"false" strings the schema (and the RPC's own boolean params) expect.
    stockNegativeAllowed: formData.get("stockNegativeAllowed") ? "true" : "false",
    inventoryEnabled: formData.get("inventoryEnabled") ? "true" : "false",
    complianceEnabled: formData.get("complianceEnabled") ? "true" : "false",
    roleMatrixEnabled: formData.get("roleMatrixEnabled") ? "true" : "false",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.settings.invalidData, success: false };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("update_organization_policy", {
    p_organization_id: parsed.data.organizationId,
    p_early_replacement_policy: parsed.data.earlyReplacementPolicy,
    p_replacement_alert_days: parsed.data.replacementAlertDays,
    p_stock_negative_allowed: parsed.data.stockNegativeAllowed === "true",
    p_inventory_enabled: parsed.data.inventoryEnabled === "true",
    p_compliance_enabled: parsed.data.complianceEnabled === "true",
    p_role_matrix_enabled: parsed.data.roleMatrixEnabled === "true",
  });

  if (error) {
    return { error: describeRpcError(error, t.settings.saveFailed), success: false };
  }

  revalidatePath("/settings");
  return { error: null, success: true };
}
