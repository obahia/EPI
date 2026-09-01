import { describe, expect, it } from "vitest";
import { isValidCnpj, formatCnpj, normalizeCnpj } from "./cnpj";

// Receita Federal's own published example for the alphanumeric CNPJ format
// (IN RFB 2.229/2024, effective ~jul/2026): base "12ABC34501DE" -> check digits "35".
// Hand-verified against the mod-11 algorithm during the FASE 0 library research before
// being encoded here -- see the module doc comment in cnpj.ts for the worked arithmetic.
const VALID_ALPHANUMERIC_CNPJ = "12ABC34501DE35";

// The classic numeric case, same algorithm, letters simply never appear.
const VALID_NUMERIC_CNPJ = "11222333000181";

describe("isValidCnpj", () => {
  it("accepts the official Receita Federal alphanumeric example", () => {
    expect(isValidCnpj(VALID_ALPHANUMERIC_CNPJ)).toBe(true);
  });

  it("accepts a classic numeric CNPJ", () => {
    expect(isValidCnpj(VALID_NUMERIC_CNPJ)).toBe(true);
  });

  it("accepts formatted input for both forms", () => {
    expect(isValidCnpj("12.ABC.345/01DE-35")).toBe(true);
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
  });

  it("accepts lowercase letters (normalized to uppercase before checking)", () => {
    expect(isValidCnpj("12abc34501de35")).toBe(true);
  });

  it("rejects a wrong first check digit", () => {
    expect(isValidCnpj("12ABC34501DE45")).toBe(false);
  });

  it("rejects a wrong second check digit", () => {
    expect(isValidCnpj("12ABC34501DE36")).toBe(false);
  });

  it("rejects letters in the check-digit positions (those are always numeric)", () => {
    expect(isValidCnpj("12ABC34501DEAB")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isValidCnpj("12ABC34501DE")).toBe(false);
    expect(isValidCnpj("12ABC34501DE350")).toBe(false);
  });

  it("rejects empty/garbage input", () => {
    expect(isValidCnpj("")).toBe(false);
  });
});

describe("formatCnpj / normalizeCnpj", () => {
  it("formats with punctuation", () => {
    expect(formatCnpj(VALID_ALPHANUMERIC_CNPJ)).toBe("12.ABC.345/01DE-35");
  });

  it("normalizes formatted/lowercase input to the canonical storage form", () => {
    expect(normalizeCnpj("12.abc.345/01de-35")).toBe(VALID_ALPHANUMERIC_CNPJ);
  });
});
