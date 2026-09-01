import { describe, expect, it } from "vitest";
import type { IdentityCheckInput, IdentityVerificationProvider } from "./provider";

/**
 * Shared assertions every IdentityVerificationProvider must satisfy, regardless of
 * implementation -- run once per adapter (see link-only-provider.test.ts,
 * link-knowledge-provider.test.ts). This is the "troca de adaptador não altera nenhum
 * teste" property from docs/mvp-roadmap.md FASE 4: a future real biometric adapter runs
 * through the exact same suite with no changes here.
 */
export function describeProviderContract(
  name: string,
  provider: IdentityVerificationProvider,
  passingInput: IdentityCheckInput,
) {
  describe(`IdentityVerificationProvider contract: ${name}`, () => {
    it("reports its own assurance level", () => {
      expect(provider.assuranceLevel).toMatch(/^AL[0-4]_/);
    });

    it("a passing check reports passed=true with achievedAssuranceLevel equal to the provider's own level", async () => {
      const result = await provider.check(passingInput);
      expect(result.passed).toBe(true);
      if (result.passed) {
        expect(result.achievedAssuranceLevel).toBe(provider.assuranceLevel);
        expect(result.method).toBeTruthy();
      }
    });

    it("a failing check never leaks an achievedAssuranceLevel", async () => {
      const result = await provider.check({});
      if (!result.passed) {
        expect("achievedAssuranceLevel" in result).toBe(false);
        expect(result.method).toBeTruthy();
      }
    });

    it("matchScore, when present, is a fixed-decimal string, never a float", async () => {
      const result = await provider.check(passingInput);
      if (result.passed && result.matchScore !== null) {
        expect(result.matchScore).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      }
    });
  });
}
