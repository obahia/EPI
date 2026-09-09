"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";

/**
 * The vendor's own support console. Everything here is refused by Postgres unless the caller
 * is on app.platform_admins, and every read behind a grant is refused unless that grant is
 * live -- this file decides what to OFFER, never what is permitted.
 *
 * Nothing in this module touches auth_ctx.*, so no RLS policy anywhere behaves differently
 * because it exists. That is the point of the design: a mistake in the support console
 * cannot become a cross-tenant leak in the product.
 */

export type ActionState = { error: string | null };

const grantSchema = z.object({
  adminUserId: z.uuid(),
  organizationId: z.uuid(),
  companyId: z.union([z.uuid(), z.literal("")]),
  reason: z.string().trim().min(20).max(1000),
  ticketRef: z.string().trim().max(120).optional().or(z.literal("")),
  ttlHours: z.coerce.number().int().min(1).max(72),
});

export async function grantPlatformAccess(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = grantSchema.safeParse({
    adminUserId: formData.get("adminUserId"),
    organizationId: formData.get("organizationId"),
    companyId: formData.get("companyId") ?? "",
    reason: formData.get("reason"),
    ticketRef: formData.get("ticketRef") ?? "",
    ttlHours: formData.get("ttlHours") ?? 24,
  });
  if (!parsed.success) {
    const tooShort = parsed.error.issues.some((i) => i.path[0] === "reason");
    return {
      error: tooShort
        ? "Descreva o motivo com pelo menos 20 caracteres — é o texto que o cliente vai ler."
        : "Dados inválidos.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("grant_platform_access", {
    p_admin_user_id: parsed.data.adminUserId,
    p_organization_id: parsed.data.organizationId,
    p_company_id: parsed.data.companyId === "" ? null : parsed.data.companyId,
    p_reason: parsed.data.reason,
    p_ticket_ref: parsed.data.ticketRef || null,
    p_ttl_hours: parsed.data.ttlHours,
  });

  if (error) return { error: describeRpcError(error, "Não foi possível conceder o acesso.") };
  revalidatePath("/plataforma");
  return { error: null };
}

export async function revokePlatformAccess(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const grantId = formData.get("grantId");
  if (typeof grantId !== "string" || !z.uuid().safeParse(grantId).success) {
    return { error: "Concessão inválida." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("revoke_platform_access", {
    p_grant_id: grantId,
  });

  if (error) return { error: describeRpcError(error, "Não foi possível encerrar o acesso.") };
  revalidatePath("/plataforma");
  return { error: null };
}

/**
 * Lockout recovery, and the only write support can perform inside a tenant. It elevates
 * somebody the organization already admitted; it cannot introduce anyone new, and the
 * database refuses it outright without an organization-wide grant.
 */
export async function promoteToOrgAdmin(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const organizationId = formData.get("organizationId");
  const userId = formData.get("userId");
  if (
    typeof organizationId !== "string" ||
    !z.uuid().safeParse(organizationId).success ||
    typeof userId !== "string" ||
    !z.uuid().safeParse(userId).success
  ) {
    return { error: "Dados inválidos." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("platform_grant_org_admin", {
    p_organization_id: organizationId,
    p_user_id: userId,
  });

  if (error) return { error: describeRpcError(error, "Não foi possível promover este membro.") };
  revalidatePath(`/plataforma/${organizationId}`);
  return { error: null };
}
