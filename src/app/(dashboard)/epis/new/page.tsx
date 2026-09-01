import { redirect } from "next/navigation";
import { verifySession, getMyCompanies, getMyMemberships } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EpiCreateForm } from "./epi-form";

export default async function NewEpiPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string }>;
}) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const companies = await getMyCompanies();
  const { company: companyParam } = await searchParams;
  const company = companies.find((c) => c.id === companyParam) ?? (companies.length === 1 ? companies[0]! : null);

  if (!company) {
    redirect("/epis");
  }

  // Only offer the "catálogo compartilhado da organização" option when the caller has an
  // org-wide ORG_ADMIN membership for this company's organization -- api.create_epi
  // enforces this too, but a company-scoped user should never even see the choice.
  const memberships = await getMyMemberships();
  const canCreateOrgWide = memberships.some(
    (m) => m.companyId === null && m.organizationId === company.organizationId && m.role === "ORG_ADMIN",
  );

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Novo EPI</h1>
      <p className="text-sm text-muted-foreground">{company.legalName}</p>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Dados do EPI</CardTitle>
        </CardHeader>
        <CardContent>
          <EpiCreateForm
            organizationId={company.organizationId}
            companyId={company.id}
            canCreateOrgWide={canCreateOrgWide}
          />
        </CardContent>
      </Card>
    </main>
  );
}
