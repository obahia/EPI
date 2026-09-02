import { describe, expect, it } from "vitest";
import {
  parseEpiUnit,
  validateEpiImportRows,
  type EpiColumnMapping,
  type ParsedCsvRow,
} from "./validate-epi-rows";

const MAPPING: EpiColumnMapping = {
  name: "nome",
  ca_number: "ca",
  manufacturer: "fabricante",
  model: "modelo",
  default_unit: "unidade",
};

function rows(...values: ParsedCsvRow[]): ParsedCsvRow[] {
  return values;
}

describe("parseEpiUnit", () => {
  it("accepts the enum values themselves, in any case", () => {
    expect(parseEpiUnit("UN")).toBe("UN");
    expect(parseEpiUnit("par")).toBe("PAR");
    expect(parseEpiUnit("Cx")).toBe("CX");
  });

  it("accepts the words people actually type, accents and trailing dot included", () => {
    expect(parseEpiUnit("unidade")).toBe("UN");
    expect(parseEpiUnit("un.")).toBe("UN");
    expect(parseEpiUnit("Pares")).toBe("PAR");
    expect(parseEpiUnit("caixa")).toBe("CX");
    expect(parseEpiUnit("peça")).toBe("UN");
    expect(parseEpiUnit("quilos")).toBe("KG");
  });

  it("returns null for anything it cannot read", () => {
    expect(parseEpiUnit("dúzia")).toBeNull();
    expect(parseEpiUnit("")).toBeNull();
  });
});

describe("validateEpiImportRows", () => {
  it("accepts a well-formed row and normalises its unit", () => {
    const result = validateEpiImportRows(
      rows({ nome: "Luva nitrílica", ca: "38771", fabricante: "Danny", modelo: "DA-402", unidade: "Par" }),
      MAPPING,
    );
    expect(result.errors).toEqual([]);
    expect(result.validRows).toHaveLength(1);
    expect(result.validRows[0]).toMatchObject({
      rowNumber: 2,
      name: "Luva nitrílica",
      caNumber: "38771",
      manufacturer: "Danny",
      model: "DA-402",
      defaultUnit: "PAR",
    });
  });

  it("defaults an empty unit to UN rather than failing the row", () => {
    const result = validateEpiImportRows(rows({ nome: "Capacete", ca: "31469", unidade: "" }), MAPPING);
    expect(result.errors).toEqual([]);
    expect(result.validRows[0]?.defaultUnit).toBe("UN");
  });

  it("rejects a unit it cannot read instead of silently defaulting", () => {
    const result = validateEpiImportRows(rows({ nome: "Capacete", ca: "31469", unidade: "dúzia" }), MAPPING);
    expect(result.validRows).toEqual([]);
    expect(result.errors[0]?.reasons[0]).toContain("dúzia");
  });

  it("reports missing name and missing/invalid CA", () => {
    const result = validateEpiImportRows(
      rows({ nome: "", ca: "38771" }, { nome: "Bota", ca: "" }, { nome: "Óculos", ca: "12" }),
      MAPPING,
    );
    expect(result.validRows).toEqual([]);
    expect(result.errors.map((e) => e.rowNumber)).toEqual([2, 3, 4]);
    expect(result.errors[0]?.reasons).toContain("Nome ausente");
    expect(result.errors[1]?.reasons).toContain("CA ausente");
    expect(result.errors[2]?.reasons[0]).toContain("CA inválido");
  });

  it("keeps the first row of a duplicated CA and errors only the later one", () => {
    const result = validateEpiImportRows(
      rows({ nome: "Luva", ca: "38771" }, { nome: "Luva (dup)", ca: "38771" }),
      MAPPING,
    );
    expect(result.validRows).toHaveLength(1);
    expect(result.validRows[0]?.rowNumber).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.rowNumber).toBe(3);
    expect(result.errors[0]?.reasons[0]).toContain("linha 2");
  });

  it("puts every row in exactly one bucket", () => {
    const input = rows({ nome: "A", ca: "111" }, { nome: "", ca: "222" }, { nome: "C", ca: "333" });
    const result = validateEpiImportRows(input, MAPPING);
    expect(result.validRows.length + result.errors.length).toBe(input.length);
  });

  it("treats unmapped optional columns as absent", () => {
    const result = validateEpiImportRows(rows({ nome: "Bota", ca: "41234" }), {
      name: "nome",
      ca_number: "ca",
    });
    expect(result.validRows[0]).toMatchObject({ manufacturer: null, model: null, description: null });
  });
});
