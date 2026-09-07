import { beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";

beforeAll(() => {
  process.env.WEBHOOK_SECRET_KEY = randomBytes(32).toString("base64");
});

const {
  generateWebhookSecret,
  encryptWebhookSecret,
  decryptWebhookSecret,
  signWebhookBody,
  buildSignatureHeader,
} = await import("./webhook-secret");

describe("secret storage", () => {
  it("round-trips", () => {
    const secret = generateWebhookSecret();
    expect(decryptWebhookSecret(encryptWebhookSecret(secret))).toBe(secret);
  });

  it("is randomised -- the same secret encrypts to different ciphertext each time", () => {
    const secret = generateWebhookSecret();
    expect(encryptWebhookSecret(secret)).not.toEqual(encryptWebhookSecret(secret));
  });

  it("refuses tampered ciphertext instead of returning garbage (GCM auth tag)", () => {
    const encrypted = encryptWebhookSecret(generateWebhookSecret());
    const last = encrypted.length - 1;
    encrypted[last] = (encrypted.at(last) ?? 0) ^ 0xff;
    expect(() => decryptWebhookSecret(encrypted)).toThrow();
  });

  it("produces ciphertext long enough for the column CHECK (>= 29 bytes: iv 12 + tag 16 + body)", () => {
    expect(encryptWebhookSecret(generateWebhookSecret()).length).toBeGreaterThanOrEqual(29);
  });
});

describe("signWebhookBody", () => {
  // A permanent fixture. Subscribers implement verification against the published formula;
  // if this value ever changes, every subscriber's verification breaks silently, so this is
  // a contract test, not a smoke test.
  const SECRET = "test-secret-do-not-use";
  const BODY = '{"id":"11111111-1111-4111-8111-111111111111","type":"delivery.confirmed"}';
  const TIMESTAMP = 1_767_225_600;

  it("matches the documented formula exactly: hmac_sha256(secret, `${t}.${body}`)", () => {
    const expected = createHmac("sha256", SECRET).update(`${TIMESTAMP}.${BODY}`, "utf8").digest("hex");
    expect(signWebhookBody(SECRET, BODY, TIMESTAMP)).toBe(expected);
  });

  it("changes when the timestamp changes -- which is what makes a captured payload non-replayable", () => {
    expect(signWebhookBody(SECRET, BODY, TIMESTAMP)).not.toBe(
      signWebhookBody(SECRET, BODY, TIMESTAMP + 1),
    );
  });

  it("changes when a single byte of the body changes", () => {
    expect(signWebhookBody(SECRET, BODY, TIMESTAMP)).not.toBe(
      signWebhookBody(SECRET, `${BODY} `, TIMESTAMP),
    );
  });

  it("changes when the secret changes", () => {
    expect(signWebhookBody(SECRET, BODY, TIMESTAMP)).not.toBe(
      signWebhookBody("other", BODY, TIMESTAMP),
    );
  });
});

describe("buildSignatureHeader", () => {
  it("emits t plus one v1 for a single secret", () => {
    const header = buildSignatureHeader(["s1"], "body", 1000);
    expect(header).toBe(`t=1000,v1=${signWebhookBody("s1", "body", 1000)}`);
  });

  it("emits BOTH signatures during a rotation window, so a subscriber mid-migration can verify either", () => {
    const header = buildSignatureHeader(["new", "old"], "body", 1000);
    expect(header).toContain(`v1=${signWebhookBody("new", "body", 1000)}`);
    expect(header).toContain(`v1=${signWebhookBody("old", "body", 1000)}`);
    expect(header.match(/v1=/g)).toHaveLength(2);
  });

  it("never leaks the secret itself into the header", () => {
    expect(buildSignatureHeader(["super-secret"], "body", 1000)).not.toContain("super-secret");
  });
});
