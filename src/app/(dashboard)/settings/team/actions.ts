"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { generateInvitationToken, hashInvitationToken } from "@/lib/crypto/invitation-token";

/**
 * Team management. The counterpart of settings/integrations for people rather than machines.
 *
 * The invitation token is generated HERE, in Node, hashed here, and only the hash reaches
 * Postgres -- the same discipline as the API key secret and the worker link token. The
 * database therefore cannot mint a link for anyone, and a database reader who takes a dump
 * cannot redeem one.
 *
 * There is no email delivery in this project yet (see the FASE 0 note in
 * (auth)/login/actions.ts: no transactional email provider is configured), so the link is
 * returned to the inviter to pass along themselves, shown exactly once. That is a deliberate
 * honest limitation rather than a fake "invitation sent" toast -- if we claimed to have sent
 * an email, the invited person would wait for one that never arrives.
 *
 * Every authorization decision below is made in Postgres by auth_ctx.can_grant_role, not
 * here. This file chooses what to OFFER; the RPC decides what is allowed. A COMPANY_ADMIN
 * who forges a form post asking for ORG_ADMIN gets 42501 from the database.
 */

const ROLES = ["VIEWER", "SST_OPERATOR", "COMPANY_ADMIN", "ORG_ADMIN"] as const;

export type ActionState = { error: string | null };
export type InviteState = { error: string | null; link: string | null; email: string | null };

const inviteSchema = z.object({
  organizationId: z.uuid(),
  // "" is the org-wide option in the select -- NULL company_id means every present and
  // future company of the organization, the same convention authz.memberships uses.
  companyId: z.union([z.uuid(), z.literal("")]),
  email: z.email().max(254),
  role: z.enum(ROLES),
  ttlHours: z.coerce.number().int().min(1).max(720),
});

export async function inviteMember(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const parsed = inviteSchema.safeParse({
    organizationId: formData.get("organizationId"),
    companyId: formData.get("companyId") ?? "",
    email: formData.get("email"),
    role: formData.get("role"),
    ttlHours: formData.get("ttlHours") ?? 168,
  });
  if (!parsed.success) return { error: "Dados inválidos.", link: null, email: null };

  const token = generateInvitationToken();
  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("invite_member", {
    p_organization_id: parsed.data.organizationId,
    p_company_id: parsed.data.companyId === "" ? null : parsed.data.companyId,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
    p_token_hash_b64: hashInvitationToken(token).toString("base64"),
    p_ttl_hours: parsed.data.ttlHours,
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível criar o convite."), link: null, email: null };
  }

  const headerList = await headers();
  const proto = headerList.get("x-forwarded-proto") ?? (process.env.NODE_ENV === "production" ? "https" : "http");
  const origin = `${proto}://${headerList.get("host") ?? "localhost:3000"}`;

  revalidatePath("/settings/team");
  return { error: null, link: `${origin}/convite/${token}`, email: parsed.data.email };
}

export async function revokeInvitation(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const invitationId = formData.get("invitationId");
  if (typeof invitationId !== "string" || !z.uuid().safeParse(invitationId).success) {
    return { error: "Convite inválido." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("revoke_invitation", {
    p_invitation_id: invitationId,
  });

  if (error) return { error: describeRpcError(error, "Não foi possível cancelar o convite.") };
  revalidatePath("/settings/team");
  return { error: null };
}

export async function updateMembershipRole(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const membershipId = formData.get("membershipId");
  const role = formData.get("role");
  if (typeof membershipId !== "string" || !z.uuid().safeParse(membershipId).success) {
    return { error: "Acesso inválido." };
  }
  if (typeof role !== "string" || !ROLES.includes(role as (typeof ROLES)[number])) {
    return { error: "Perfil de acesso inválido." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("update_membership_role", {
    p_membership_id: membershipId,
    p_role: role,
  });

  if (error) return { error: describeRpcError(error, "Não foi possível alterar o acesso.") };
  revalidatePath("/settings/team");
  return { error: null };
}

export async function revokeMembership(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const membershipId = formData.get("membershipId");
  if (typeof membershipId !== "string" || !z.uuid().safeParse(membershipId).success) {
    return { error: "Acesso inválido." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("revoke_membership", {
    p_membership_id: membershipId,
  });

  if (error) return { error: describeRpcError(error, "Não foi possível remover o acesso.") };
  revalidatePath("/settings/team");
  return { error: null };
}
