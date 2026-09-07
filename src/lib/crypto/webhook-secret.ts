import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Webhook signing secrets, server-only.
 *
 * Unlike an API key -- which only ever has to be COMPARED, and so is stored as a one-way
 * hash -- a webhook secret has to be READ BACK to compute the HMAC on every delivery.
 * It is therefore encrypted rather than hashed, with the same AES-256-GCM layout as
 * app.employees.cpf_enc (cpf-secrets.ts), and the key lives in the application environment.
 * Supabase Vault would also work, but this keeps one encryption discipline in the codebase
 * instead of two, and keeps the key outside the database that stores the ciphertext.
 */

const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const value = process.env.WEBHOOK_SECRET_KEY;
  if (!value) throw new Error("Missing WEBHOOK_SECRET_KEY env var. See .env.example.");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("WEBHOOK_SECRET_KEY must decode to exactly 32 bytes (AES-256).");
  return key;
}

/** 32 bytes of CSPRNG, base64url. Shown to the subscriber exactly once, at endpoint
 * creation or rotation. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** iv(12) || tag(16) || ciphertext, so one bytea column holds everything needed to decrypt. */
export function encryptWebhookSecret(secret: string): Buffer {
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptWebhookSecret(encrypted: Buffer): string {
  const iv = encrypted.subarray(0, GCM_IV_LENGTH);
  const tag = encrypted.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_TAG_LENGTH);
  const ciphertext = encrypted.subarray(GCM_IV_LENGTH + GCM_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * The signature scheme, documented for subscribers as:
 *
 *   Selo-Signature: t=<unix_seconds>,v1=<hex>
 *   signed_payload = "<t>" + "." + <the exact response body bytes>
 *   v1             = hex(hmac_sha256(secret, signed_payload))
 *
 * The timestamp is INSIDE the signature. Without it a captured payload replays forever,
 * because a signature over the body alone stays valid for as long as the secret does.
 *
 * `body` is taken as the exact string that will be transmitted, never a re-serialisation of
 * a parsed object -- the same rule that governs evidence canonical_bytes. Two JSON encoders
 * that differ in key order or escaping would produce a signature the subscriber cannot
 * reproduce.
 */
export function signWebhookBody(secret: string, body: string, timestampSeconds: number): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${body}`, "utf8").digest("hex");
}

/**
 * Builds the header value. During a rotation window both secrets sign the same payload and
 * both appear, so a subscriber that has migrated and one that has not are BOTH able to
 * verify. Rotating without an overlap makes every in-flight event fail verification.
 */
export function buildSignatureHeader(
  secrets: readonly string[],
  body: string,
  timestampSeconds: number,
): string {
  const parts = secrets.map((s) => `v1=${signWebhookBody(s, body, timestampSeconds)}`);
  return [`t=${timestampSeconds}`, ...parts].join(",");
}
