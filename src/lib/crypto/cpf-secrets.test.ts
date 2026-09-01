import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

// Env vars must be set BEFORE importing the module under test, since it reads them
// lazily inside each function (not at module load time) -- but set them up front here so
// every test in this file has them regardless of import order.
beforeAll(() => {
  process.env.CPF_HASH_PEPPER = randomBytes(32).toString("base64");
  process.env.CPF_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

const { hashCpf, encryptCpf, decryptCpf } = await import("./cpf-secrets");

describe("hashCpf", () => {
  it("is deterministic for the same input", () => {
    expect(hashCpf("52998224725")).toEqual(hashCpf("52998224725"));
  });

  it("differs for different CPFs", () => {
    expect(hashCpf("52998224725")).not.toEqual(hashCpf("11144477735"));
  });

  it("produces a 32-byte SHA-256 digest", () => {
    expect(hashCpf("52998224725").length).toBe(32);
  });

  it("rejects non-11-digit input", () => {
    expect(() => hashCpf("123")).toThrow();
    expect(() => hashCpf("529.982.247-25")).toThrow(); // must be pre-normalized to digits
  });
});

describe("encryptCpf / decryptCpf", () => {
  it("round-trips correctly", () => {
    expect(decryptCpf(encryptCpf("52998224725"))).toBe("52998224725");
  });

  it("produces different ciphertext each time (random IV)", () => {
    expect(encryptCpf("52998224725")).not.toEqual(encryptCpf("52998224725"));
  });

  it("fails to decrypt if the ciphertext is tampered with (GCM auth tag)", () => {
    const encrypted = encryptCpf("52998224725");
    const lastIndex = encrypted.length - 1;
    encrypted[lastIndex] = (encrypted[lastIndex] ?? 0) ^ 0xff; // flip the last ciphertext byte
    expect(() => decryptCpf(encrypted)).toThrow();
  });
});
