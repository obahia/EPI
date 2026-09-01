import { describe, expect, it } from "vitest";
import { isValidCpf, formatCpf, maskCpf } from "./cpf";

// Computed by hand from the standard mod-11 algorithm, not copied from an unverified
// source: base 529.982.247 -> weights [10..2] sum -> DV1=2, then DV2 with the resulting
// 10 digits -> DV2=5. Cross-checked against multiple independent public CPF validators.
const VALID_CPF = "52998224725";

describe("isValidCpf", () => {
  it("accepts a structurally valid CPF, bare digits", () => {
    expect(isValidCpf(VALID_CPF)).toBe(true);
  });

  it("accepts the same CPF formatted", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
  });

  it("rejects a wrong first check digit", () => {
    expect(isValidCpf("52998224735")).toBe(false);
  });

  it("rejects a wrong second check digit", () => {
    expect(isValidCpf("52998224726")).toBe(false);
  });

  it("rejects all known repeated-digit sequences (structurally valid mod-11 but not real CPFs)", () => {
    expect(isValidCpf("11111111111")).toBe(false);
    expect(isValidCpf("00000000000")).toBe(false);
    expect(isValidCpf("99999999999")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isValidCpf("123456789")).toBe(false);
    expect(isValidCpf("123456789012")).toBe(false);
  });

  it("rejects empty/garbage input", () => {
    expect(isValidCpf("")).toBe(false);
    expect(isValidCpf("abc")).toBe(false);
  });
});

describe("formatCpf / maskCpf", () => {
  it("formats with punctuation", () => {
    expect(formatCpf(VALID_CPF)).toBe("529.982.247-25");
  });

  it("masks the first 3 and last 2 digits, per docs/architecture.md §6/§16", () => {
    expect(maskCpf(VALID_CPF)).toBe("***.982.247-**");
  });

  it("throws on malformed input rather than silently truncating", () => {
    expect(() => formatCpf("123")).toThrow();
    expect(() => maskCpf("123")).toThrow();
  });
});
