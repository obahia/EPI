import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  generateInvitationToken,
  hashInvitationToken,
  isWellFormedInvitationToken,
} from "./invitation-token";

describe("generateInvitationToken", () => {
  it("produces 32 bytes of base64url, unpadded", () => {
    const token = generateInvitationToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain("=");
  });

  it("does not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(generateInvitationToken());
    expect(seen.size).toBe(1000);
  });

  it("is accepted by its own validator -- the URL shape and the generator cannot drift apart", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(isWellFormedInvitationToken(generateInvitationToken())).toBe(true);
    }
  });
});

describe("hashInvitationToken", () => {
  it("is plain SHA-256 of the UTF-8 token, 32 bytes -- matching the octet_length check on authz.membership_invitations.token_hash", () => {
    const token = generateInvitationToken();
    const digest = hashInvitationToken(token);
    expect(digest).toHaveLength(32);
    expect(digest.equals(createHash("sha256").update(token, "utf8").digest())).toBe(true);
  });

  it("is stable, so a link created in one process is redeemable in another", () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token).equals(hashInvitationToken(token))).toBe(true);
  });

  it("differs for tokens that differ by one character", () => {
    const a = "A".repeat(43);
    const b = `${"A".repeat(42)}B`;
    expect(hashInvitationToken(a).equals(hashInvitationToken(b))).toBe(false);
  });

  it("base64-encodes to what the RPC decodes back -- the only representation Postgres ever sees", () => {
    const token = generateInvitationToken();
    const b64 = hashInvitationToken(token).toString("base64");
    expect(Buffer.from(b64, "base64").equals(hashInvitationToken(token))).toBe(true);
  });
});

describe("isWellFormedInvitationToken", () => {
  // The point of this guard is that a malformed link never reaches the database at all --
  // not that it produces a nicer error afterwards.
  it("rejects every shape that cannot have come from the generator", () => {
    const valid = generateInvitationToken();
    for (const bad of [
      "",
      valid.slice(0, 42),
      `${valid}x`,
      `${valid.slice(0, 42)}+`, // base64, not base64url
      `${valid.slice(0, 42)}/`,
      `${valid.slice(0, 42)}=`,
      `${valid.slice(0, 41)} A`,
      "../../etc/passwd",
      null,
      undefined,
    ]) {
      expect(isWellFormedInvitationToken(bad)).toBe(false);
    }
  });

  it("accepts the exact character set base64url produces", () => {
    expect(isWellFormedInvitationToken(`${"-_aZ09".repeat(7)}A`)).toBe(true);
  });
});
