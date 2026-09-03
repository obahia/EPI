import { redirect } from "next/navigation";
import { verifySession, getMyMemberships, getOrganizationPolicy } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    </main>
  );
}
