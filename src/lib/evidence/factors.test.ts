import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeEvidencePayload, EPI_CANON_VERSION, EPI_CANON_VERSION_2 } from "./canon";
import { buildEvidencePayload, buildEvidencePayloadV2, type EvidenceSource } from "./payload";
import { sortFactorsCanonically, type EvidenceFactor } from "./factors";
import type { EvidenceSignature } from "./signature";

/**
 * Phase E (spec §16). epi-canon/1's own golden vectors live in canon.test.ts and are NEVER
 * touched by this file -- v1 must keep producing identical bytes forever. These are v2's own
 * permanent vectors plus the proofs the Phase E contract demands: deterministic factor order
 * regardless of input order, the signature living in exactly one place, and assurance staying
 * an attribute of the confirmation rather than something a factor can raise.
 */

const SIGNATURE: EvidenceSignature = { format: "image/png", data: "iVBORw0KGgoAAAA=" };

const SOURCE: EvidenceSource = {
  delivery_id: "11111111-1111-1111-1111-111111111111",
  company_legal_name: "ACME Industrial LTDA",
  company_cnpj: "12ABC34501DE35",
  employee_full_name: "João Silva",
  employee_cpf_masked: "***.982.247-**",
  delivery_date: "2026-09-04",
  note: null,
  items: [
    { line_no: 1, epi_name: "Botina de Segurança", ca_number: "54321", manufacturer: null, model: null, quantity: 1, unit: "UN" },
  ],
};

const CONFIRMED_AT = "2026-09-04T13:12:44.031Z";

const IDENTITY_FACTOR: EvidenceFactor = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  type: "IDENTITY_KNOWLEDGE",
  provider: "INTERNAL",
  result: "PASS",
  occurred_at_utc: CONFIRMED_AT,
  method: "LINK_KNOWLEDGE",
};

const SIGNATURE_FACTOR: EvidenceFactor = {
  id: "bbbbbbbb-0000-4000-8000-000000000002",
  type: "DECLARATION_SIGNATURE",
  provider: "INTERNAL",
  result: "PASS",
  occurred_at_utc: CONFIRMED_AT,
  signature: SIGNATURE,
};

function buildV2(factors: readonly EvidenceFactor[]) {
  return buildEvidencePayloadV2({
    source: SOURCE,
    confirmationRequestId: "22222222-2222-2222-2222-222222222222",
    achievedAssuranceLevel: "AL1_LINK_KNOWLEDGE",
    confirmedAtUtc: CONFIRMED_AT,
    factors,
  });
}

describe("epi-canon/2 -- golden vectors", () => {
  // Permanent CI fixture, same rule as v1: if this hash changes, the epi-canon/2 algorithm
  // changed, which is never a fix -- it would be epi-canon/3, with this implementation kept.
  const GOLDEN_V2_JSON =
    '{"_canon":"epi-canon/2","company":{"cnpj":"12ABC34501DE35","legal_name":"ACME Industrial LTDA"},"confirmation_request_id":"22222222-2222-2222-2222-222222222222","confirmed_at_utc":"2026-09-04T13:12:44.031Z","declaration_text":"Eu, João Silva, declaro que recebi os equipamentos de proteção individual (EPI) listados neste documento, entregues por ACME Industrial LTDA.","delivery_date":"2026-09-04","delivery_id":"11111111-1111-1111-1111-111111111111","employee":{"cpf_masked":"***.982.247-**","full_name":"João Silva"},"factors":[{"id":"bbbbbbbb-0000-4000-8000-000000000002","occurred_at_utc":"2026-09-04T13:12:44.031Z","provider":"INTERNAL","result":"PASS","signature":{"data":"iVBORw0KGgoAAAA=","format":"image/png"},"type":"DECLARATION_SIGNATURE"},{"id":"aaaaaaaa-0000-4000-8000-000000000001","method":"LINK_KNOWLEDGE","occurred_at_utc":"2026-09-04T13:12:44.031Z","provider":"INTERNAL","result":"PASS","type":"IDENTITY_KNOWLEDGE"}],"identity":{"achieved_assurance_level":"AL1_LINK_KNOWLEDGE"},"items":[{"ca_number":"54321","epi_name":"Botina de Segurança","line_no":1,"quantity":1,"unit":"UN"}]}';

  it("produces the exact fixed byte sequence", () => {
    const { canonicalBytes } = canonicalizeEvidencePayload(buildV2([IDENTITY_FACTOR, SIGNATURE_FACTOR]));
    expect(canonicalBytes.toString("utf8")).toBe(GOLDEN_V2_JSON);
  });

  it("hashes exactly the canonical bytes it produced", () => {
    const { canonicalBytes, sha256 } = canonicalizeEvidencePayload(buildV2([IDENTITY_FACTOR, SIGNATURE_FACTOR]));
    expect(sha256.length).toBe(32);
    // Mirrors the seal's own DB CHECK (payload_sha256 = digest(canonical_bytes)) rather than
    // pinning a second literal that could silently drift from the bytes above.
    expect(sha256.toString("hex")).toBe(createHash("sha256").update(canonicalBytes).digest("hex"));
  });
});

describe("deterministic factor ordering", () => {
  it("produces identical bytes no matter what order the caller supplies", () => {
    const a = canonicalizeEvidencePayload(buildV2([IDENTITY_FACTOR, SIGNATURE_FACTOR]));
    const b = canonicalizeEvidencePayload(buildV2([SIGNATURE_FACTOR, IDENTITY_FACTOR]));
    expect(a.canonicalBytes.toString("utf8")).toBe(b.canonicalBytes.toString("utf8"));
    expect(a.sha256).toEqual(b.sha256);
  });

  it("orders by occurred_at_utc first", () => {
    const earlier: EvidenceFactor = { ...SIGNATURE_FACTOR, occurred_at_utc: "2026-09-04T13:12:44.030Z" };
    const ordered = sortFactorsCanonically([IDENTITY_FACTOR, earlier]);
    expect(ordered.map((f) => f.type)).toEqual(["DECLARATION_SIGNATURE", "IDENTITY_KNOWLEDGE"]);
  });

  it("falls back to type when the instant ties", () => {
    const ordered = sortFactorsCanonically([IDENTITY_FACTOR, SIGNATURE_FACTOR]);
    expect(ordered.map((f) => f.type)).toEqual(["DECLARATION_SIGNATURE", "IDENTITY_KNOWLEDGE"]);
  });

  it("falls back to id when instant and type both tie -- a total order", () => {
    const second: EvidenceFactor = { ...IDENTITY_FACTOR, id: "aaaaaaaa-0000-4000-8000-000000000009" };
    const ordered = sortFactorsCanonically([second, IDENTITY_FACTOR]);
    expect(ordered.map((f) => f.id)).toEqual([IDENTITY_FACTOR.id, second.id]);
  });

  it("never mutates the caller's array", () => {
    const input = [IDENTITY_FACTOR, SIGNATURE_FACTOR];
    sortFactorsCanonically(input);
    expect(input.map((f) => f.type)).toEqual(["IDENTITY_KNOWLEDGE", "DECLARATION_SIGNATURE"]);
  });
});

describe("epi-canon/2 shape contract", () => {
  it("keeps the signature in exactly one place -- inside its factor", () => {
    const payload = buildV2([IDENTITY_FACTOR, SIGNATURE_FACTOR]) as Record<string, unknown>;
    expect(payload.signature).toBeUndefined();
    const factors = payload.factors as Array<Record<string, unknown>>;
    const signatureFactors = factors.filter((f) => f.signature !== undefined);
    expect(signatureFactors).toHaveLength(1);
    expect(signatureFactors[0]?.type).toBe("DECLARATION_SIGNATURE");
  });

  it("keeps assurance on the confirmation and method on the factor", () => {
    const payload = buildV2([IDENTITY_FACTOR, SIGNATURE_FACTOR]) as Record<string, unknown>;
    const identity = payload.identity as Record<string, unknown>;
    expect(identity).toEqual({ achieved_assurance_level: "AL1_LINK_KNOWLEDGE" });
    expect(identity.method).toBeUndefined();
    const factors = payload.factors as Array<Record<string, unknown>>;
    expect(factors.find((f) => f.type === "IDENTITY_KNOWLEDGE")?.method).toBe("LINK_KNOWLEDGE");
  });

  it("gives the signature factor no method and no assurance -- it never raises identity confidence", () => {
    const payload = buildV2([IDENTITY_FACTOR, SIGNATURE_FACTOR]) as Record<string, unknown>;
    const factors = payload.factors as Array<Record<string, unknown>>;
    const signatureFactor = factors.find((f) => f.type === "DECLARATION_SIGNATURE")!;
    expect(signatureFactor.method).toBeUndefined();
    expect(signatureFactor.achieved_assurance_level).toBeUndefined();
  });

  it("omits empty metadata rather than emitting an empty object", () => {
    const withEmpty: EvidenceFactor = { ...IDENTITY_FACTOR, metadata: {} };
    const factors = (buildV2([withEmpty]) as Record<string, unknown>).factors as Array<Record<string, unknown>>;
    expect(factors[0]?.metadata).toBeUndefined();
  });

  it("refuses to seal a confirmation with no accepted factor", () => {
    expect(() => buildV2([])).toThrow(/at least one accepted factor/);
  });
});

describe("epi-canon/1 is untouched by Phase E", () => {
  it("still builds a v1 payload with the fixed identity.method and top-level signature", () => {
    const v1 = buildEvidencePayload({
      source: SOURCE,
      confirmationRequestId: "22222222-2222-2222-2222-222222222222",
      method: "LINK_KNOWLEDGE",
      achievedAssuranceLevel: "AL1_LINK_KNOWLEDGE",
      confirmedAtUtc: CONFIRMED_AT,
      signature: SIGNATURE,
    }) as Record<string, unknown>;

    expect(v1._canon).toBe(EPI_CANON_VERSION);
    expect(v1.signature).toEqual(SIGNATURE);
    expect(v1.identity).toEqual({ method: "LINK_KNOWLEDGE", achieved_assurance_level: "AL1_LINK_KNOWLEDGE" });
    expect(v1.factors).toBeUndefined();
  });

  it("canonicalizes both versions, rejecting anything else", () => {
    expect(() => canonicalizeEvidencePayload({ _canon: "epi-canon/3", a: 1 })).toThrow(/_canon must be one of/);
    expect(canonicalizeEvidencePayload({ _canon: EPI_CANON_VERSION, a: 1 }).sha256.length).toBe(32);
    expect(canonicalizeEvidencePayload({ _canon: EPI_CANON_VERSION_2, a: 1 }).sha256.length).toBe(32);
  });
});
