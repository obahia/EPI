/**
 * The identity verification abstraction (docs/architecture.md §9). The domain
 * (epi_deliveries, confirmation_requests) never imports a vendor SDK directly -- only this
 * interface and the boolean/enum RESULT it produces ever crosses into worker.finish_confirmation.
 *
 * Deliberately simpler than architecture.md §9's illustrative pseudocode (createVerification/
 * checkLiveness/verifyFace/getVerificationResult/enroll/deleteSubject): that shape was
 * written before FASE 3 settled on AL1_LINK_KNOWLEDGE (a synchronous CPF-knowledge
 * challenge, not a biometric session) as the actual product default -- see
 * docs/mvp-roadmap.md FASE 3. A single async check() honestly fits what both real
 * implementations (LinkOnlyProvider, LinkKnowledgeProvider) need today. When a real
 * biometric vendor is chosen (architecture.md §9/§20 -- pending business decision), the
 * multi-step session shape from the architecture doc will likely be needed THEN, as an
 * extension -- not built speculatively now.
 */

export type AssuranceLevel =
  | "AL0_LINK_ONLY"
  | "AL1_LINK_KNOWLEDGE"
  | "AL2_SELFIE_LIVENESS"
  | "AL3_FACE_MATCH_ENROLLED"
  | "AL4_GOV_VERIFIED";

export type IdentityCheckMethod =
  | "LINK_ONLY"
  | "LINK_KNOWLEDGE"
  | "SELFIE_LIVENESS"
  | "FACE_MATCH_ENROLLED"
  | "GOV_VERIFIED";

export type IdentityCheckInput = {
  /** Base64 AES-256-GCM ciphertext of the employee's CPF (app.employees.cpf_enc), as
   * returned by worker.begin_confirmation. Only LINK_KNOWLEDGE needs it; LINK_ONLY ignores
   * it entirely -- a provider must never assume a field is present. */
  cpfEncBase64?: string;
  /** What the worker typed in response to the challenge (e.g. the last 3 CPF digits for
   * LINK_KNOWLEDGE). Never logged, never persisted -- compared and discarded. */
  knowledgeAnswer?: string;
};

export type IdentityCheckResult =
  | { passed: true; achievedAssuranceLevel: AssuranceLevel; method: IdentityCheckMethod; matchScore: string | null }
  | { passed: false; method: IdentityCheckMethod };

/** One provider handles exactly one assurance level -- see src/lib/identity/registry.ts for
 * how a confirmation_request's required_assurance_level selects which provider runs. */
export interface IdentityVerificationProvider {
  readonly assuranceLevel: AssuranceLevel;
  check(input: IdentityCheckInput): Promise<IdentityCheckResult>;
}
