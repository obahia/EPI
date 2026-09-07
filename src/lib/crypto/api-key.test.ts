import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

beforeAll(() => {
  process.env.API_KEY_PEPPER = randomBytes(32).toString("base64");
});

const { generateApiKey, parseApiKey, parseAuthorizationHeader, hashApiKeySecret, publicKeyPrefix } =
  await import("./api-key");

describe("generateApiKey", () => {
  it("produces the documented shape", () => {
    const key = generateApiKey("live");
    expect(key.full).toBe(`selo_live_${key.keyId}_${key.secret}`);
    expect(key.keyId).toHaveLength(16);
    // 32 bytes base64url, unpadded.
    expect(key.secret).toHaveLength(43);
  });

  it("never emits I, L, O or U in the key id -- Crockford base32, so a retyped key cannot become a different valid key", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateApiKey().keyId).not.toMatch(/[ILOU]/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generateApiKey().keyId);
    expect(seen.size).toBe(500);
  });
});

describe("parseApiKey", () => {
  it("round-trips a generated key", () => {
    const key = generateApiKey("test");
    expect(parseApiKey(key.full)).toEqual({ env: "test", keyId: key.keyId, secret: key.secret });
  });

  it("rejects every malformed shape without saying which part was wrong", () => {
    const key = generateApiKey();
    const bad = [
      null,
      undefined,
      "",
      "selo_live_short_abc",
      `selo_prod_${key.keyId}_${key.secret}`,          // unknown env
      `nope_live_${key.keyId}_${key.secret}`,          // wrong prefix
      `selo_live_${key.keyId}`,                        // missing secret
      `selo_live_${key.keyId}_${key.secret}_extra`,    // too many segments
      `selo_live_${"I".repeat(16)}_${key.secret}`,     // excluded Crockford letter
      `selo_live_${key.keyId}_short`,                  // secret too short
      `selo_live_${key.keyId}_${"!".repeat(43)}`,      // secret not base64url
    ];
    for (const value of bad) expect(parseApiKey(value)).toBeNull();
  });
});

describe("parseAuthorizationHeader", () => {
  it("accepts a Bearer header", () => {
    const key = generateApiKey();
    expect(parseAuthorizationHeader(`Bearer ${key.full}`)?.keyId).toBe(key.keyId);
  });

  it("rejects anything that is not Bearer", () => {
    const key = generateApiKey();
    expect(parseAuthorizationHeader(key.full)).toBeNull();
    expect(parseAuthorizationHeader(`Basic ${key.full}`)).toBeNull();
    expect(parseAuthorizationHeader(null)).toBeNull();
  });
});

describe("hashApiKeySecret", () => {
  it("is deterministic and 32 bytes", () => {
    const key = generateApiKey();
    const a = hashApiKeySecret(key.secret);
    expect(a).toEqual(hashApiKeySecret(key.secret));
    expect(a).toHaveLength(32);
  });

  it("differs for different secrets", () => {
    expect(hashApiKeySecret(generateApiKey().secret)).not.toEqual(
      hashApiKeySecret(generateApiKey().secret),
    );
  });

  it("depends on the pepper -- a database dump alone is not enough to verify a key", () => {
    const key = generateApiKey();
    const withFirstPepper = hashApiKeySecret(key.secret);
    process.env.API_KEY_PEPPER = randomBytes(32).toString("base64");
    expect(hashApiKeySecret(key.secret)).not.toEqual(withFirstPepper);
  });
});

describe("publicKeyPrefix", () => {
  it("is the public half only -- what may appear in logs, audit events and the panel", () => {
    const key = generateApiKey("live");
    const parsed = parseApiKey(key.full)!;
    const prefix = publicKeyPrefix(parsed);
    expect(prefix).toBe(`selo_live_${key.keyId}`);
    expect(prefix).not.toContain(key.secret);
  });
});
