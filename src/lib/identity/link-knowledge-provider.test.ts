import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

// Set BEFORE importing (cpf-secrets.ts reads env lazily per-call, not at module load, but
// encryptCpf() below is called synchronously at module scope -- a beforeAll hook would run
// too late, after this file's top-level code has already executed).
process.env.CPF_HASH_PEPPER = randomBytes(32).toString("base64");
process.env.CPF_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { encryptCpf } = await import("@/lib/crypto/cpf-secrets");
const { LinkKnowledgeProvider } = await import("./link-knowledge-provider");
const { describeProviderContract } = await import("./provider.contract");

const CPF = "52998224725";
const cpfEncBase64 = encryptCpf(CPF).toString("base64");
const provider = new LinkKnowledgeProvider();

describeProviderContract("LinkKnowledgeProvider", provider, { cpfEncBase64, knowledgeAnswer: "725" });

describe("LinkKnowledgeProvider", () => {
  it("passes when the last 3 digits match", async () => {
    const result = await provider.check({ cpfEncBase64, knowledgeAnswer: "725" });
    expect(result).toEqual({
      passed: true,
      achievedAssuranceLevel: "AL1_LINK_KNOWLEDGE",
      method: "LINK_KNOWLEDGE",
      matchScore: null,
    });
  });

  it("fails when the digits are wrong", async () => {
    const result = await provider.check({ cpfEncBase64, knowledgeAnswer: "000" });
    expect(result).toEqual({ passed: false, method: "LINK_KNOWLEDGE" });
  });

  it("fails (never throws) when knowledgeAnswer is missing", async () => {
    const result = await provider.check({ cpfEncBase64 });
    expect(result).toEqual({ passed: false, method: "LINK_KNOWLEDGE" });
  });

  it("fails (never throws) when cpfEncBase64 is missing", async () => {
    const result = await provider.check({ knowledgeAnswer: "725" });
    expect(result).toEqual({ passed: false, method: "LINK_KNOWLEDGE" });
  });

  it("rejects a non-3-digit answer without attempting to decrypt", async () => {
    const result = await provider.check({ cpfEncBase64, knowledgeAnswer: "72" });
    expect(result).toEqual({ passed: false, method: "LINK_KNOWLEDGE" });
  });
});
