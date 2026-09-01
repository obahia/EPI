import "server-only";
import { decryptCpf } from "@/lib/crypto/cpf-secrets";
import type { IdentityCheckInput, IdentityCheckResult, IdentityVerificationProvider } from "./provider";

/**
 * AL1_LINK_KNOWLEDGE, the org default (docs/architecture.md §16): the worker proves they
 * are who the link is for by typing the last 3 digits of their own CPF. The ciphertext is
 * decrypted here, compared, and discarded within this single call -- the plaintext CPF
 * never leaves this function, never reaches the browser, never gets logged or persisted.
 * See docs/mvp-roadmap.md FASE 3 for why this challenge (not OTP) was chosen.
 */
export class LinkKnowledgeProvider implements IdentityVerificationProvider {
  readonly assuranceLevel = "AL1_LINK_KNOWLEDGE" as const;

  async check(input: IdentityCheckInput): Promise<IdentityCheckResult> {
    if (!input.cpfEncBase64 || !input.knowledgeAnswer || !/^\d{3}$/.test(input.knowledgeAnswer)) {
      return { passed: false, method: "LINK_KNOWLEDGE" };
    }

    const decrypted = decryptCpf(Buffer.from(input.cpfEncBase64, "base64"));
    const passed = decrypted.slice(-3) === input.knowledgeAnswer;

    if (!passed) {
      return { passed: false, method: "LINK_KNOWLEDGE" };
    }
    return { passed: true, achievedAssuranceLevel: "AL1_LINK_KNOWLEDGE", method: "LINK_KNOWLEDGE", matchScore: null };
  }
}
