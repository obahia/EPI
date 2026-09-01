import { describe, expect, it } from "vitest";
import { isValidCaNumber } from "./ca";

describe("isValidCaNumber", () => {
  it("accepts the shortest valid length (3 digits)", () => {
    expect(isValidCaNumber("123")).toBe(true);
  });

  it("accepts the longest valid length (8 digits)", () => {
    expect(isValidCaNumber("12345678")).toBe(true);
  });

  it("accepts a typical CA number", () => {
    expect(isValidCaNumber("38292")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isValidCaNumber("  12345  ")).toBe(true);
  });

  it("rejects fewer than 3 digits", () => {
    expect(isValidCaNumber("12")).toBe(false);
  });

  it("rejects more than 8 digits", () => {
    expect(isValidCaNumber("123456789")).toBe(false);
  });

  it("rejects non-digit characters", () => {
    expect(isValidCaNumber("12a45")).toBe(false);
    expect(isValidCaNumber("12.345")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isValidCaNumber("")).toBe(false);
  });
});
