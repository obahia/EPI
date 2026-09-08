"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { hashInvitationToken, isWellFormedInvitationToken } from "@/lib/crypto/invitation-token";

export type AcceptState = { error: string | null };

/**
 * Sign out and come straight back to this same invitation. Plain signOut() would land on
 * /login with the link gone from the address bar, and the person would have to dig the
 * message out again -- which is exactly when someone gives up and asks for a second
 * invitation nobody needs to issue.
 *
 * The token is re-validated for shape before it is put back into a URL.
 */
export async function signOutToInvitation(formData: FormData): Promise<void> {
  const token = formData.get("token");
  const supabase = await createClient();
  await supabase.auth.signOut();
  const next =
    typeof token === "string" && isWellFormedInvitationToken(token) ? `/convite/${token}` : null;
  redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
}

/**
 * Accepting is a POST, never the page load.
 *
 * An invitation is single use, so consuming it on GET would mean a link preview, a mail
 * scanner, a corporate URL rewriter or a browser prefetch could burn it before the invited
 * person ever clicked -- and the failure would be indistinguishable from an attack, because
 * the second attempt gets the same deliberately opaque `invitation_not_available`.
 *
 * Every check that matters (unknown, expired, revoked, already accepted, and above all
 * "logged in as someone other than the invited address") happens inside api.accept_invitation,
 * under the caller's own session. Nothing here decides anything.
 */
export async function acceptInvitation(_prev: AcceptState, formData: FormData): Promise<AcceptState> {
  const token = formData.get("token");
  if (typeof token !== "string" || !isWellFormedInvitationToken(token)) {
    return { error: "Este convite não está mais disponível." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("accept_invitation", {
    p_token_hash_b64: hashInvitationToken(token).toString("base64"),
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível aceitar o convite.") };
  }

  redirect("/dashboard");
}
