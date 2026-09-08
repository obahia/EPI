import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Team invitation tokens. The raw token never reaches Postgres -- only hashInvitationToken()'s
 * output does -- which is the same discipline as the worker link token and the public API key.
 *
 * DELIBERATELY NOT PEPPERED, unlike those two. The reasoning is worth stating because it is a
 * departure from the house pattern:
 *
 *   A pepper protects against an attacker who has a database dump and can GUESS the input.
 *   That is exactly the CPF case -- eleven digits, fully enumerable, so an unpeppered hash
 *   would fall to a rainbow table in minutes. An invitation token is 256 bits of CSPRNG, so
 *   its SHA-256 is not reversible from a dump by any means, and the pepper would add nothing
 *   against the threat it exists to stop.
 *
 *   What it WOULD add is a seventh secret that every environment must keep byte-identical --
 *   and getting exactly that wrong is a class of failure this project has already paid for
 *   more than once. Fewer secrets to synchronise is a real security property, not laziness.
 *
 * The worker token and the API key keep their peppers: both are long-lived credentials whose
 * compromise is open-ended, whereas an invitation is single-use and expires in days.
 */

/** 32 bytes of CSPRNG, base64url, 43 chars. Never sequential, never derived from the email. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The only representation of the token that ever reaches Postgres --
 * see authz.membership_invitations.token_hash. */
export function hashInvitationToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Structural check before anything is hashed or looked up. Returns false for a shape that
 * cannot have come from generateInvitationToken, so a malformed link never reaches the
 * database at all. */
export function isWellFormedInvitationToken(token: string | null | undefined): boolean {
  return typeof token === "string" && token.length === 43 && /^[A-Za-z0-9_-]+$/.test(token);
}
