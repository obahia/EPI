import { describe, expect, it } from "vitest";
import { normalizePhoneE164, isValidPhone } from "./phone";

describe("normalizePhoneE164", () => {
  it("normalizes a bare national number", () => {
    expect(normalizePhoneE164("11987654321")).toBe("+5511987654321");
  });

  it("normalizes a formatted national number", () => {
    expect(normalizePhoneE164("(11) 98765-4321")).toBe("+5511987654321");
  });

  it("accepts an already-E.164 number", () => {
    expect(normalizePhoneE164("+5511987654321")).toBe("+5511987654321");
  });

  it("returns null for an invalid number", () => {
    expect(normalizePhoneE164("123")).toBeNull();
    expect(normalizePhoneE164("not a phone")).toBeNull();
  });
});

describe("isValidPhone", () => {
  it("mirrors normalizePhoneE164's validity check", () => {
    expect(isValidPhone("11987654321")).toBe(true);
    expect(isValidPhone("123")).toBe(false);
  });
});
