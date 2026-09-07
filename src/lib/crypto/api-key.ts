import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Public-API key generation and hashing, server-only. Same discipline as the worker link
 * token (worker-token.ts): the raw secret never reaches Postgres -- only
 * hashApiKeySecret()'s output does -- and the pepper lives in the application environment
 * rather than Supabase Vault, because the realistic breach is a database dump and Vault is
 * inside the database. A full dump of m2m.api_keys therefore yields nothing usable.
 *
 * Key shape: selo_<env>_<keyId>_<secret>
 *   env    -- "live" | "test"
 *   keyId  -- 16 chars, Crockford base32. PUBLIC: it appears in the panel, in logs and in
 *             audit events, and is the indexed lookup column. Never authenticates anything
 *             on its own.
 *   secret -- 32 bytes of CSPRNG, base64url (43 chars). Shown exactly once, at creation.
 */

/** Crockford base32: no I, L, O or U, so a key read aloud or retyped cannot be mangled
 * into a different valid key. Matches the CHECK on m2m.api_keys.key_id. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_ID_LENGTH = 16;
/** 32 bytes of CSPRNG encoded as unpadded base64url. */
const SECRET_LENGTH = 43;

export type ApiKeyEnv = "live" | "test";

export type GeneratedApiKey = {
  /** The only time the full key exists anywhere. Show once, never store. */
  full: string;
  keyId: string;
  secret: string;
  env: ApiKeyEnv;
};

function getPepper(): Buffer {
  const value = process.env.API_KEY_PEPPER;
  if (!value) throw new Error("Missing API_KEY_PEPPER env var. See .env.example.");
  return Buffer.from(value, "base64");
}

/** Rejection sampling over the CSPRNG rather than `% 32` on a byte: 256 is divisible by 32,
 * so modulo would in fact be uniform here, but writing it this way means the property does
 * not silently break if the alphabet size ever changes. */
function randomKeyId(): string {
  let out = "";
  while (out.length < KEY_ID_LENGTH) {
    for (const byte of randomBytes(KEY_ID_LENGTH)) {
      if (out.length === KEY_ID_LENGTH) break;
      const index = byte % CROCKFORD.length;
      if (byte - index + CROCKFORD.length > 256) continue;
      out += CROCKFORD[index];
    }
  }
  return out;
}

export function generateApiKey(env: ApiKeyEnv = "live"): GeneratedApiKey {
  const keyId = randomKeyId();
  const secret = randomBytes(32).toString("base64url");
  return { full: `selo_${env}_${keyId}_${secret}`, keyId, secret, env };
}

export type ParsedApiKey = { env: ApiKeyEnv; keyId: string; secret: string };

/**
 * Strictly structural. Returns null for anything malformed -- the caller must answer 401
 * identically for a malformed key, an unknown key and a wrong secret, so this function
 * deliberately gives no hint about which part was wrong.
 */
export function parseApiKey(raw: string | null | undefined): ParsedApiKey | null {
  if (!raw) return null;
  // Split on the FIRST THREE underscores only, never on all of them: the secret is
  // base64url, whose alphabet contains "_", so a plain split("_") rejected roughly half of
  // all valid keys. Caught by the round-trip test in api-key.test.ts.
  const firstSep = raw.indexOf("_");
  const secondSep = firstSep < 0 ? -1 : raw.indexOf("_", firstSep + 1);
  const thirdSep = secondSep < 0 ? -1 : raw.indexOf("_", secondSep + 1);
  if (firstSep < 0 || secondSep < 0 || thirdSep < 0) return null;

  const prefix = raw.slice(0, firstSep);
  const env = raw.slice(firstSep + 1, secondSep);
  const keyId = raw.slice(secondSep + 1, thirdSep);
  const secret = raw.slice(thirdSep + 1);
  if (prefix !== "selo") return null;
  if (env !== "live" && env !== "test") return null;
  if (keyId.length !== KEY_ID_LENGTH) return null;
  for (const ch of keyId) if (!CROCKFORD.includes(ch)) return null;
  // Exactly 43 chars = 32 bytes base64url unpadded. Pinned rather than a range: with the
  // secret allowed to contain "_", a permissive length let `selo_live_<id>_<secret>_extra`
  // parse as a longer secret instead of being rejected as malformed. If the secret length
  // ever changes, that is a key-format change and gets a new format, not a wider parser.
  if (secret.length !== SECRET_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) return null;
  return { env, keyId, secret };
}

/** Reads the bearer token out of an Authorization header, without leaking its value into
 * any error path. */
export function parseAuthorizationHeader(header: string | null): ParsedApiKey | null {
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) return null;
  return parseApiKey(match[1]);
}

/**
 * HMAC-SHA256(pepper, secret). The only representation of the secret that ever reaches
 * Postgres -- see m2m.api_keys.secret_hash. Not bcrypt/argon2 on purpose: the secret is 256
 * bits of uniform CSPRNG, so there is no dictionary to slow down, and a deliberately slow
 * KDF on every request would be a denial-of-service vector the attacker controls the rate of.
 */
export function hashApiKeySecret(secret: string): Buffer {
  return createHmac("sha256", getPepper()).update(secret, "utf8").digest();
}

/** Length-safe constant-time compare, for the rare places the app compares hashes itself
 * (the authoritative comparison happens in m2m.ct_eq, inside Postgres). */
export function hashesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What is safe to print: the public half only. Used in logs and error correlation so no
 * code path is ever tempted to log the header itself. */
export function publicKeyPrefix(parsed: ParsedApiKey): string {
  return `selo_${parsed.env}_${parsed.keyId}`;
}
