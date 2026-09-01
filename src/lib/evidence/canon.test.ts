import { describe, expect, it } from "vitest";
import { canonicalizeEvidencePayload, EPI_CANON_VERSION, formatTimestampUtc } from "./canon";

describe("canonicalizeEvidencePayload -- golden vectors", () => {
  // A permanent CI fixture (docs/architecture.md §12, rule 6): this hash must NEVER change
  // once committed. A PR that changes it means the epi-canon/1 algorithm changed, which is
  // never a fix -- it's a NEW version (epi-canon/2), with this implementation kept
  // untouched alongside it. The payload deliberately stresses: an accented name, an emoji,
  // an empty array, and Number.MAX_SAFE_INTEGER.
  const GOLDEN_PAYLOAD = {
    _canon: EPI_CANON_VERSION,
    company_legal_name: "José da Silva & Cia LTDA",
    emoji_stress_test: "🦺",
    empty_list: [] as unknown[],
    max_safe_integer: Number.MAX_SAFE_INTEGER,
    items: [{ line_no: 1, epi_name: "Capacete", quantity: 3 }],
  };
  const GOLDEN_JSON =
    '{"_canon":"epi-canon/1","company_legal_name":"José da Silva & Cia LTDA","emoji_stress_test":"🦺","empty_list":[],"items":[{"epi_name":"Capacete","line_no":1,"quantity":3}],"max_safe_integer":9007199254740991}';
  const GOLDEN_SHA256_HEX = "f0a1f9c14fe974a9313b42bde9b274b9e5d2a7506236fe52910d0cc234eea532".slice(0, 64);

  it("produces the exact fixed byte sequence for the golden payload", () => {
    const { canonicalBytes } = canonicalizeEvidencePayload(GOLDEN_PAYLOAD);
    expect(canonicalBytes.toString("utf8")).toBe(GOLDEN_JSON);
  });

  it("produces the exact fixed SHA-256 hash for the golden payload", () => {
    const { sha256 } = canonicalizeEvidencePayload(GOLDEN_PAYLOAD);
    expect(sha256.toString("hex")).toBe(GOLDEN_SHA256_HEX);
    expect(sha256.length).toBe(32);
  });

  it("two separate calls (simulating two different processes) produce an identical hash", () => {
    const a = canonicalizeEvidencePayload(GOLDEN_PAYLOAD);
    const b = canonicalizeEvidencePayload(structuredClone(GOLDEN_PAYLOAD));
    expect(a.sha256).toEqual(b.sha256);
    expect(a.canonicalBytes).toEqual(b.canonicalBytes);
  });

  it("changing a single character anywhere in the payload changes the hash", () => {
    const a = canonicalizeEvidencePayload(GOLDEN_PAYLOAD);
    const mutated = { ...GOLDEN_PAYLOAD, company_legal_name: "José da Silva & Cia LTDA " }; // trailing space
    const b = canonicalizeEvidencePayload(mutated);
    expect(a.sha256).not.toEqual(b.sha256);
  });

  it("key order in the input object does not affect the output (JCS sorts keys)", () => {
    const reordered = {
      max_safe_integer: GOLDEN_PAYLOAD.max_safe_integer,
      items: GOLDEN_PAYLOAD.items,
      empty_list: GOLDEN_PAYLOAD.empty_list,
      emoji_stress_test: GOLDEN_PAYLOAD.emoji_stress_test,
      company_legal_name: GOLDEN_PAYLOAD.company_legal_name,
      _canon: GOLDEN_PAYLOAD._canon,
    };
    const a = canonicalizeEvidencePayload(GOLDEN_PAYLOAD);
    const b = canonicalizeEvidencePayload(reordered);
    expect(a.sha256).toEqual(b.sha256);
  });
});

describe("canonicalizeEvidencePayload -- rule enforcement", () => {
  it("rejects a payload missing the correct _canon version", () => {
    expect(() => canonicalizeEvidencePayload({ _canon: "wrong" })).toThrow(/_canon/);
  });

  it("rejects null anywhere in the tree", () => {
    expect(() => canonicalizeEvidencePayload({ _canon: EPI_CANON_VERSION, x: null })).toThrow(/null is forbidden/);
  });

  it("rejects a non-integer number", () => {
    expect(() => canonicalizeEvidencePayload({ _canon: EPI_CANON_VERSION, x: 1.5 })).toThrow(/non-integer/);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => canonicalizeEvidencePayload({ _canon: EPI_CANON_VERSION, x: NaN })).toThrow();
    expect(() => canonicalizeEvidencePayload({ _canon: EPI_CANON_VERSION, x: Infinity })).toThrow();
  });

  it("NFC-normalizes decomposed accented characters to the same result as pre-composed ones", () => {
    const decomposed = "José"; // "José" as e + combining acute accent (NFD form)
    const composed = "José"; // pre-composed NFC form
    const a = canonicalizeEvidencePayload({ _canon: EPI_CANON_VERSION, name: decomposed });
    const b = canonicalizeEvidencePayload({ _canon: EPI_CANON_VERSION, name: composed });
    expect(a.sha256).toEqual(b.sha256);
  });

  it("rejects a bidi override character (RIGHT-TO-LEFT OVERRIDE, U+202E)", () => {
    const withBidiOverride = "safe" + String.fromCharCode(0x202e) + "text";
    expect(() =>
      canonicalizeEvidencePayload({ _canon: EPI_CANON_VERSION, x: withBidiOverride }),
    ).toThrow(/bidi-override/);
  });

  it("rejects an unpaired UTF-16 surrogate", () => {
    expect(() =>
      canonicalizeEvidencePayload({ _canon: EPI_CANON_VERSION, x: "broken\uD800text" }),
    ).toThrow(/surrogate/);
  });
});

describe("formatTimestampUtc", () => {
  it("always has exactly 3 fractional-second digits and a literal Z", () => {
    expect(formatTimestampUtc(new Date("2026-09-01T09:11:27.4Z"))).toBe("2026-09-01T09:11:27.400Z");
    expect(formatTimestampUtc(new Date("2026-09-01T09:11:27.000Z"))).toBe("2026-09-01T09:11:27.000Z");
  });
});
