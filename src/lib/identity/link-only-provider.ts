import type { IdentityCheckInput, IdentityCheckResult, IdentityVerificationProvider } from "./provider";

/** AL0_LINK_ONLY: possession of the link is the entire claim, no challenge at all. Still
 * produces a real identity_verifications row (docs/architecture.md §8: "não existe aresta
 * para CONFIRMED que não passe por uma verificação registrada, mesmo no nível mais baixo"). */
export class LinkOnlyProvider implements IdentityVerificationProvider {
  readonly assuranceLevel = "AL0_LINK_ONLY" as const;

  // input is intentionally ignored: AL0_LINK_ONLY has no challenge to evaluate, only the
  // interface shape to satisfy.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async check(input: IdentityCheckInput): Promise<IdentityCheckResult> {
    return { passed: true, achievedAssuranceLevel: "AL0_LINK_ONLY", method: "LINK_ONLY", matchScore: null };
  }
}
