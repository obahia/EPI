import { redirect } from "next/navigation";
import { verifySession, getMyCompanies, getMyMemberships } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { PositionCreateForm } from "./position-form";

export default async function NewPositionPage({
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
    redirect("/positions");
  }

  // Same rationale as epis/new/page.tsx: only offer the org-wide toggle when the caller
  // actually has an org-wide ORG_ADMIN membership -- api.create_job_position enforces this
  // too, this just keeps a company-scoped user from seeing a choice they can't use.
  const memberships = await getMyMemberships();
  const canCreateOrgWide = memberships.some(
    (m) => m.companyId === null && m.organizationId === company.organizationId && m.role === "ORG_ADMIN",
  );

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <h1 className="font-heading text-4xl font-extrabold tracking-tight">{t.positions.newPosition}</h1>
      <p className="text-sm text-muted-foreground">{company.legalName}</p>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>{t.positions.positionDataCardTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <PositionCreateForm
            organizationId={company.organizationId}
            companyId={company.id}
            canCreateOrgWide={canCreateOrgWide}
          />
        </CardContent>
      </Card>
    </main>
  );
}
