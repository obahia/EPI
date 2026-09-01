import "server-only";
import { LinkOnlyProvider } from "./link-only-provider";
import { LinkKnowledgeProvider } from "./link-knowledge-provider";
import type { AssuranceLevel, IdentityVerificationProvider } from "./provider";

const linkOnly = new LinkOnlyProvider();
const linkKnowledge = new LinkKnowledgeProvider();

/**
 * Selects the provider for a confirmation_request's required_assurance_level. AL2-AL4
 * throw: no adapter exists yet -- the commercial vendor decision is pending
 * (docs/architecture.md §9/§20, requires a paid service + credentials) and no organization
 * can actually reach those levels today (app.organizations.default_assurance_level is
 * constrained to what FASE 3/4 support). Swapping which provider handles AL1+ later never
 * requires touching epi_deliveries/confirmation_requests -- only this registry and a new
 * adapter file.
 */
export function getIdentityProvider(level: AssuranceLevel): IdentityVerificationProvider {
  switch (level) {
    case "AL0_LINK_ONLY":
      return linkOnly;
    case "AL1_LINK_KNOWLEDGE":
      return linkKnowledge;
    default:
      throw new Error(`No IdentityVerificationProvider implemented for ${level} yet -- see docs/architecture.md §9/§20.`);
  }
}
