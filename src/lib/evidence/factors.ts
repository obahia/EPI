import "server-only";
import { randomUUID } from "node:crypto";
import type { IdentityCheckMethod } from "@/lib/identity/provider";
import type { EvidenceSignature } from "./signature";

/**
 * Evidence factors (spec §16, Phase E contract). A factor is an ACCEPTED observation that
 * took part in a confirmation -- never an attempt. A wrong-digits identity try is recorded in
 * audit.audit_events + confirmation_requests.identity_attempts and never becomes a factor.
 *
 * Only two types are actually produced today. IDENTITY_OTP / IDENTITY_PRESENCIAL exist in the
 * database CHECK so the MODEL can represent what §16 lists, and are rejected at runtime by
 * worker.finish_confirmation (errcode 0A000) -- there is no provider, no flow and no UI for
 * them, and being representable must never look like being implemented.
 */
export type EvidenceFactorType = "IDENTITY_KNOWLEDGE" | "DECLARATION_SIGNATURE";

/** Closed allowlist, mirroring identity_verifications_provider_ck. INTERNAL is this product's
 * own mechanism; a real vendor is a one-line migration plus its own contract. */
export type EvidenceFactorProvider = "INTERNAL";

/** Phase E persists accepted factors only, so PASS is the only result it can produce. The
 * column keeps its pre-existing PASS/FAIL domain (narrowing it would be destructive for no
 * gain), but no code path emits FAIL. */
export type EvidenceFactorResult = "PASS";

export type EvidenceFactor = {
  id: string;
  type: EvidenceFactorType;
  provider: EvidenceFactorProvider;
  result: EvidenceFactorResult;
  occurred_at_utc: string;
  /** Identity factors only -- a drawn signature verifies no identity, so it carries no method
   * and never raises the achieved assurance level. */
  method?: IdentityCheckMethod;
  /** Non-sensitive context only; the RPC rejects denylisted keys (cpf/otp/token/secret/...). */
  metadata?: Record<string, string | number | boolean>;
  /** DECLARATION_SIGNATURE only: the drawn signature lives HERE in epi-canon/2, and nowhere
   * else in the payload -- the sealed factor is its single authority. */
  signature?: EvidenceSignature;
};

/**
 * Total, deterministic canonical order: (occurred_at_utc, type, id) ascending, compared as
 * ordinal UTF-16 code units -- never localeCompare, whose result depends on ICU data and
 * locale. Every value in the tuple is ASCII (RFC 3339 instant, SCREAMING_SNAKE type, lowercase
 * uuid), so code-unit order equals UTF-8 byte order here.
 *
 * `id` is the final tiebreaker and is unique, so the order is TOTAL: two factors sharing an
 * instant and a type still sort deterministically. This never relies on SELECT order, jsonb
 * aggregation order, or insertion order -- canon.ts rule 5 states arrays must already arrive
 * in the order the schema defines, and this function is that definition.
 */
export function sortFactorsCanonically(factors: readonly EvidenceFactor[]): EvidenceFactor[] {
  return [...factors].sort((a, b) => {
    if (a.occurred_at_utc !== b.occurred_at_utc) return a.occurred_at_utc < b.occurred_at_utc ? -1 : 1;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}

/**
 * Builds the factors for one confirmation. Ids and timestamps are generated HERE, once: the
 * same values are hashed into the canonical payload and handed to worker.finish_confirmation
 * for persistence, so a sealed payload and its relational row can never disagree about which
 * uuid or instant a factor had.
 */
export function buildConfirmationFactors(params: {
  method: IdentityCheckMethod;
  identityOccurredAtUtc: string;
  signature: EvidenceSignature;
  signatureOccurredAtUtc: string;
}): EvidenceFactor[] {
  const { method, identityOccurredAtUtc, signature, signatureOccurredAtUtc } = params;

  return sortFactorsCanonically([
    {
      id: randomUUID(),
      type: "IDENTITY_KNOWLEDGE",
      provider: "INTERNAL",
      result: "PASS",
      occurred_at_utc: identityOccurredAtUtc,
      method,
    },
    {
      id: randomUUID(),
      type: "DECLARATION_SIGNATURE",
      provider: "INTERNAL",
      result: "PASS",
      occurred_at_utc: signatureOccurredAtUtc,
      signature,
    },
  ]);
}

/** The shape worker.finish_confirmation's p_factors expects -- the same values that went into
 * the sealed payload, nothing added and nothing dropped. */
export function factorsForRpc(factors: readonly EvidenceFactor[]): unknown[] {
  return factors.map((f) => {
    const out: Record<string, unknown> = {
      id: f.id,
      type: f.type,
      provider: f.provider,
      result: f.result,
      occurred_at_utc: f.occurred_at_utc,
    };
    if (f.method) out.method = f.method;
    if (f.metadata) out.metadata = f.metadata;
    return out;
  });
}
