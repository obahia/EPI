import "server-only";
import { createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * CPF hashing/encryption, server-only. Both secrets live in the APPLICATION environment,
 * never in Supabase Vault -- consistent with the worker-link-token pepper decision in
 * docs/architecture.md §8: the realistic breach is a database dump, and Vault is inside
 * the database. A dump of app.employees alone yields neither the plaintext CPF nor
 * anything usable to derive it.
 *
 * cpf_hash (HMAC-SHA256, deterministic) is what dedupe/lookup queries use --
 * `UNIQUE (company_id, cpf_hash)`. cpf_enc (AES-256-GCM, randomized IV) is what would back
 * a future permissioned "reveal full CPF" feature -- NOT built in FASE 1 (see
 * mvp-roadmap.md), stored now so a real re-import isn't needed once reveal lands.
 */

function getPepper(): Buffer {
  const value = process.env.CPF_HASH_PEPPER;
  if (!value) throw new Error("Missing CPF_HASH_PEPPER env var. See .env.example.");
  return Buffer.from(value, "base64");
}

function getEncryptionKey(): Buffer {
  const value = process.env.CPF_ENCRYPTION_KEY;
  if (!value) throw new Error("Missing CPF_ENCRYPTION_KEY env var. See .env.example.");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("CPF_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).");
  return key;
}

/** Deterministic HMAC-SHA256 of the 11 raw CPF digits. Used for dedupe/lookup only --
 * never reversible, never displayed. */
export function hashCpf(cpfDigits: string): Buffer {
  if (!/^\d{11}$/.test(cpfDigits)) throw new Error("hashCpf expects exactly 11 digits");
  return createHmac("sha256", getPepper()).update(cpfDigits).digest();
}

const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

/** AES-256-GCM encryption of the 11 raw CPF digits. Output layout: iv(12) || tag(16) ||
 * ciphertext -- concatenated so a single bytea column holds everything needed to decrypt. */
export function encryptCpf(cpfDigits: string): Buffer {
  if (!/^\d{11}$/.test(cpfDigits)) throw new Error("encryptCpf expects exactly 11 digits");
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(cpfDigits, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/** Reverses encryptCpf(). Not called anywhere yet in FASE 1 -- kept alongside encryptCpf
 * so the pair is reviewed together, for the "reveal CPF" feature in a later phase. */
export function decryptCpf(encrypted: Buffer): string {
  const iv = encrypted.subarray(0, GCM_IV_LENGTH);
  const tag = encrypted.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_TAG_LENGTH);
  const ciphertext = encrypted.subarray(GCM_IV_LENGTH + GCM_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
