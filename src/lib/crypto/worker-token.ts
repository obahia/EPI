import "server-only";
import { createHmac, randomBytes } from "node:crypto";

/**
 * Worker confirmation-link token generation/hashing, server-only. Raw token never crosses
 * into Postgres (docs/architecture.md §8) -- only hashWorkerToken()'s output does. The
 * pepper lives outside Supabase Vault, same reasoning as CPF_HASH_PEPPER in
 * cpf-secrets.ts: the realistic breach is a database dump, and Vault is inside the database.
 */

function getPepper(): Buffer {
  const value = process.env.WORKER_TOKEN_PEPPER;
  if (!value) throw new Error("Missing WORKER_TOKEN_PEPPER env var. See .env.example.");
  return Buffer.from(value, "base64");
}

/** 32 bytes of CSPRNG, base64url without padding (43 chars) -- never a UUID, never
 * sequential (docs/architecture.md §8). */
export function generateWorkerToken(): string {
  return randomBytes(32).toString("base64url");
}

/** HMAC-SHA256(pepper, token). The only representation of the token that ever reaches
 * Postgres -- see app.confirmation_requests.token_hash. */
export function hashWorkerToken(token: string): Buffer {
  return createHmac("sha256", getPepper()).update(token, "utf8").digest();
}
