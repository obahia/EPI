import { redirect } from "next/navigation";
import Link from "next/link";
import { verifySession, getMyMemberships, getOrganizationPolicy } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { OrganizationPolicyForm } from "./organization-policy-form";

/**
 * Org-wide policy/feature-flag settings (early_replacement_policy, replacement_alert_days,
 * stock_negative_allowed, inventory_enabled, compliance_enabled, role_matrix_enabled) --
 * ORG_ADMIN only, gated the same way epis/new and positions/new gate their own org-wide
 * option: an org-wide (company_id NULL) ORG_ADMIN membership, which api.update_organization_
 * policy itself also requires. No company-scoped page under src/app/(dashboard)/companies
 * fit this (that page is company-scoped; these fields are organization-scoped), so this is a
 * new top-level page rather than an extension of an existing one.
 */
export default async function SettingsPage() {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const memberships = await getMyMemberships();
  const orgAdminMembership = memberships.find((m) => m.companyId === null && m.role === "ORG_ADMIN");

  if (!orgAdminMembership) {
    redirect("/dashboard");
  }

  const policy = await getOrganizationPolicy(orgAdminMembership.organizationId);
  if (!policy) {
    redirect("/dashboard");
  }

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <h1 className="font-heading text-4xl font-extrabold tracking-tight">{t.settings.title}</h1>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>{t.settings.policyCardTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <OrganizationPolicyForm organizationId={policy.organizationId} policy={policy} />
        </CardContent>
      </Card>

      {/* Phase G. Also reachable from the sidebar, which shows the row to ORG_ADMIN and
          COMPANY_ADMIN -- the two roles that hold membership.manage. This card is here as
          well because /settings is where an ORG_ADMIN already comes to change what the
          organization does. */}
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>{t.settings.teamCardTitle}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <p className="text-[13px] text-muted-foreground">{t.settings.teamCardDescription}</p>
          <Button asChild>
            <Link href="/settings/team">{t.settings.teamCardLink}</Link>
          </Button>
        </CardContent>
      </Card>

      {/* Phase F. Reached from here rather than from the sidebar: the sidebar is a client
          component that only receives the plain identity prop, so it cannot see the
          org-wide ORG_ADMIN membership this section requires -- and /settings already
          gates on exactly that. */}
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>{t.settings.integrationsCardTitle}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <p className="text-[13px] text-muted-foreground">{t.settings.integrationsCardDescription}</p>
          <Button asChild>
            <Link href="/settings/integrations">{t.settings.integrationsCardLink}</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
