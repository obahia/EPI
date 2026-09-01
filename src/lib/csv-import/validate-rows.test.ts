import { describe, expect, it } from "vitest";
import { validateImportRows, type ColumnMapping, type ParsedCsvRow } from "./validate-rows";

// Same vector as src/lib/br/cpf.test.ts -- computed by hand from the mod-11 algorithm, not
// copied from an unverified source.
const VALID_CPF = "529.982.247-25";
const VALID_CPF_2 = "111.444.777-35"; // classic textbook-valid CPF, independently verified

const mapping: ColumnMapping = {
  full_name: "Nome",
  cpf: "CPF",
  phone: "Telefone",
  email: "E-mail",
};

function row(fields: Partial<Record<"Nome" | "CPF" | "Telefone" | "E-mail", string>>): ParsedCsvRow {
  return { Nome: "", CPF: "", Telefone: "", "E-mail": "", ...fields };
}

describe("validateImportRows", () => {
  it("accepts a well-formed row", () => {
    const { validRows, errors } = validateImportRows(
      [row({ Nome: "Maria Silva", CPF: VALID_CPF, Telefone: "11987654321", "E-mail": "maria@example.com" })],
      mapping,
    );
    expect(errors).toHaveLength(0);
    expect(validRows).toHaveLength(1);
    expect(validRows[0]).toMatchObject({
      rowNumber: 2,
      fullName: "Maria Silva",
      cpf: "52998224725",
      email: "maria@example.com",
    });
    expect(validRows[0]!.phone).toBe("+5511987654321");
  });

  it("flags a missing required field", () => {
    const { validRows, errors } = validateImportRows([row({ Nome: "", CPF: VALID_CPF })], mapping);
    expect(validRows).toHaveLength(0);
    expect(errors).toEqual([{ rowNumber: 2, reasons: ["Nome ausente"] }]);
  });

  it("flags a structurally invalid CPF", () => {
    const { validRows, errors } = validateImportRows([row({ Nome: "João", CPF: "111.111.111-11" })], mapping);
    expect(validRows).toHaveLength(0);
    expect(errors).toEqual([{ rowNumber: 2, reasons: ["CPF inválido"] }]);
  });

  it("flags a duplicate CPF within the file, keeping only the first occurrence valid", () => {
    const { validRows, errors } = validateImportRows(
      [row({ Nome: "Maria Silva", CPF: VALID_CPF }), row({ Nome: "Maria S.", CPF: VALID_CPF })],
      mapping,
    );
    expect(validRows).toHaveLength(1);
    expect(validRows[0]!.rowNumber).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.rowNumber).toBe(3);
    expect(errors[0]!.reasons[0]).toMatch(/CPF duplicado.*linha 2/);
  });

  it("flags an invalid phone but does not reject the row for a missing optional field", () => {
    const { validRows, errors } = validateImportRows(
      [row({ Nome: "Ana", CPF: VALID_CPF_2, Telefone: "123" })],
      mapping,
    );
    expect(validRows).toHaveLength(0);
    expect(errors).toEqual([{ rowNumber: 2, reasons: ["Telefone inválido"] }]);
  });

  it("accepts a row with optional fields left blank", () => {
    const { validRows, errors } = validateImportRows([row({ Nome: "Ana", CPF: VALID_CPF_2 })], mapping);
    expect(errors).toHaveLength(0);
    expect(validRows).toHaveLength(1);
    expect(validRows[0]!.phone).toBeNull();
    expect(validRows[0]!.email).toBeNull();
  });

  it("flags an invalid e-mail", () => {
    const { validRows, errors } = validateImportRows(
      [row({ Nome: "Ana", CPF: VALID_CPF_2, "E-mail": "not-an-email" })],
      mapping,
    );
    expect(validRows).toHaveLength(0);
    expect(errors).toEqual([{ rowNumber: 2, reasons: ["E-mail inválido"] }]);
  });

  it("processes an empty file without error", () => {
    expect(validateImportRows([], mapping)).toEqual({ validRows: [], errors: [] });
  });
});
