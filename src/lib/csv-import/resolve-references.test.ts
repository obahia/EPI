import { describe, expect, it } from "vitest";
import {
  applyReferenceResolution,
  collectReferenceLabels,
  normalizeLabel,
  type ReferenceResolution,
} from "./resolve-references";
import type { ValidatedRow } from "./validate-rows";

function row(overrides: Partial<ValidatedRow> = {}): ValidatedRow {
  return {
    rowNumber: 2,
    fullName: "Maria Silva",
    cpf: "52998224725",
    registrationNumber: null,
    phone: null,
    email: null,
    positionTitle: null,
    department: null,
    location: null,
    ...overrides,
  };
}

const POSITION_OK: ReferenceResolution = {
  kind: "POSITION",
  raw: "Soldador",
  resolvedId: "11111111-1111-4111-8111-111111111111",
  outcome: "RESOLVED",
  suggestions: null,
};

const LOCATION_OK: ReferenceResolution = {
  kind: "LOCATION",
  raw: "Unidade Norte",
  resolvedId: "22222222-2222-4222-8222-222222222222",
  outcome: "RESOLVED",
  suggestions: null,
};

describe("normalizeLabel", () => {
  it("trims, collapses inner whitespace and lowercases", () => {
    expect(normalizeLabel("  Soldador   Industrial ")).toBe("soldador industrial");
  });

  it("PRESERVES accents -- folding them would silently merge two catalog entries", () => {
    expect(normalizeLabel("Soldádor")).not.toBe(normalizeLabel("Soldador"));
  });

  it("normalises unicode form, so a decomposed and a composed accent match", () => {
    expect(normalizeLabel("Eletricista Júnior")).toBe(normalizeLabel("Eletricista Júnior"));
  });
});

describe("applyReferenceResolution", () => {
  it("attaches ids when both labels resolve", () => {
    const result = applyReferenceResolution(
      [row({ positionTitle: "Soldador", location: "Unidade Norte" })],
      [POSITION_OK, LOCATION_OK],
    );
    expect(result.errors).toHaveLength(0);
    expect(result.resolvedRows[0]?.positionId).toBe(POSITION_OK.resolvedId);
    expect(result.resolvedRows[0]?.locationId).toBe(LOCATION_OK.resolvedId);
  });

  it("passes rows through untouched when neither column was mapped", () => {
    const result = applyReferenceResolution([row()], []);
    expect(result.errors).toHaveLength(0);
    expect(result.resolvedRows[0]?.positionId).toBeNull();
    expect(result.resolvedRows[0]?.locationId).toBeNull();
  });

  it("matches case-insensitively and across whitespace differences", () => {
    const result = applyReferenceResolution([row({ positionTitle: "  soldador " })], [POSITION_OK]);
    expect(result.resolvedRows[0]?.positionId).toBe(POSITION_OK.resolvedId);
  });

  it("makes an unknown cargo a ROW ERROR and never invents one", () => {
    const result = applyReferenceResolution(
      [row({ positionTitle: "Soldator" })],
      [{ kind: "POSITION", raw: "Soldator", resolvedId: null, outcome: "NOT_FOUND", suggestions: ["Soldador"] }],
    );
    expect(result.resolvedRows).toHaveLength(0);
    expect(result.errors[0]?.reasons[0]).toContain("não encontrado");
    expect(result.errors[0]?.reasons[0]).toContain("Soldador");
  });

  it("treats a missing resolution exactly like NOT_FOUND, never as 'no constraint'", () => {
    const result = applyReferenceResolution([row({ positionTitle: "Fantasma" })], []);
    expect(result.resolvedRows).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it("refuses an AMBIGUOUS unidade rather than picking the first candidate", () => {
    const result = applyReferenceResolution(
      [row({ location: "Matriz" })],
      [{ kind: "LOCATION", raw: "Matriz", resolvedId: null, outcome: "AMBIGUOUS", suggestions: ["Matriz", "Matriz"] }],
    );
    expect(result.resolvedRows).toHaveLength(0);
    expect(result.errors[0]?.reasons[0]).toContain("mais de um registro");
  });

  it("refuses an INACTIVE reference instead of silently reactivating it", () => {
    const result = applyReferenceResolution(
      [row({ positionTitle: "Antigo" })],
      [{ kind: "POSITION", raw: "Antigo", resolvedId: null, outcome: "INACTIVE", suggestions: null }],
    );
    expect(result.errors[0]?.reasons[0]).toContain("inativo");
  });

  it("reports both failures on one row rather than stopping at the first", () => {
    const result = applyReferenceResolution(
      [row({ positionTitle: "X", location: "Y" })],
      [
        { kind: "POSITION", raw: "X", resolvedId: null, outcome: "NOT_FOUND", suggestions: null },
        { kind: "LOCATION", raw: "Y", resolvedId: null, outcome: "NOT_FOUND", suggestions: null },
      ],
    );
    expect(result.errors[0]?.reasons).toHaveLength(2);
  });

  it("keeps good rows importable when other rows fail -- partial files still make progress", () => {
    const result = applyReferenceResolution(
      [
        row({ rowNumber: 2, positionTitle: "Soldador" }),
        row({ rowNumber: 3, positionTitle: "Inexistente" }),
      ],
      [POSITION_OK],
    );
    expect(result.resolvedRows.map((r) => r.rowNumber)).toEqual([2]);
    expect(result.errors.map((e) => e.rowNumber)).toEqual([3]);
  });
});

describe("collectReferenceLabels", () => {
  it("deduplicates, so a 5000-row file with 12 job titles asks about 12", () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      row({ rowNumber: i + 2, positionTitle: i % 2 === 0 ? "Soldador" : "Pedreiro", location: "Matriz" }),
    );
    const labels = collectReferenceLabels(rows);
    expect(labels.titles.sort()).toEqual(["Pedreiro", "Soldador"]);
    expect(labels.locationRefs).toEqual(["Matriz"]);
  });

  it("omits unmapped columns entirely", () => {
    expect(collectReferenceLabels([row()])).toEqual({ titles: [], locationRefs: [] });
  });
});
