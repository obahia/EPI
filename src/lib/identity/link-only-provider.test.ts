import { describe, expect, it } from "vitest";
import { LinkOnlyProvider } from "./link-only-provider";
import { describeProviderContract } from "./provider.contract";

const provider = new LinkOnlyProvider();

describeProviderContract("LinkOnlyProvider", provider, {});

describe("LinkOnlyProvider", () => {
  it("always passes -- possession of the link is the entire claim at AL0", async () => {
    const result = await provider.check({});
    expect(result).toEqual({
      passed: true,
      achievedAssuranceLevel: "AL0_LINK_ONLY",
      method: "LINK_ONLY",
      matchScore: null,
    });
  });
});
