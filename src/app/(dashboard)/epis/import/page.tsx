import { redirect } from "next/navigation";
import { verifySession, getMyCompanies, getMyMemberships } from "@/lib/supabase/dal";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { PageHeader } from "@/components/page-header";
import { EpiImportWizard } from "./epi-import-wizard";

export default async function ImportEpisPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string }>;
}) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const companies = await getMyCompanies();
  const { company: companyParam } = await searchParams;
  const company = companies.find((c) => c.id === companyParam) ?? (companies.length === 1 ? companies[0]! : null);

  if (!company) {
    redirect("/epis");
  }

  // Only offer the "catálogo compartilhado da organização" option when the caller has an
  // org-wide ORG_ADMIN membership for this company's organization -- api.create_epi
  // enforces this too, but a company-scoped user should never even see the choice. Same
  // rule the manual create form (epis/new/page.tsx) applies.
  const memberships = await getMyMemberships();
  const canCreateOrgWide = memberships.some(
    (m) => m.companyId === null && m.organizationId === company.organizationId && m.role === "ORG_ADMIN",
  );

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        back={{ href: `/epis?company=${company.id}`, label: t.epis.backToCatalog }}
        kicker={company.legalName}
        title={t.epis.importCatalog}
      />

      <EpiImportWizard
        organizationId={company.organizationId}
        companyId={company.id}
        canCreateOrgWide={canCreateOrgWide}
      />
    </main>
  );
}
