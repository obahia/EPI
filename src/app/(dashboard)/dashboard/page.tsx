import { redirect } from "next/navigation";
import { verifySession, getCurrentUser, getMyCompanies, getMyMemberships } from "@/lib/supabase/dal";
import { Panel, PanelTitle } from "@/components/panel";
import { PageHeader } from "@/components/page-header";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { OnboardingForm } from "./onboarding-form";

/**
 * "Painel" in the sidebar. In the mockup that target *is* the operational dashboard, so
 * as soon as there is a company to show, this hands straight over to it rather than
 * being a second, thinner dashboard of its own. What is left here is the two states
 * that have no company yet: onboarding, and a membership with no company attached.
 */
export default async function DashboardPage() {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const [user, companies, memberships] = await Promise.all([
    getCurrentUser(),
    getMyCompanies(),
    getMyMemberships(),
  ]);

  const company = companies[0];
  if (company) {
    redirect(`/companies/${company.id}/dashboard`);
  }

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        kicker={user ? `${t.dashboard.authenticatedAs} ${user.fullName}` : undefined}
        title={t.dashboard.title}
      />

      {memberships.length === 0 ? (
        <OnboardingForm />
      ) : (
        <Panel>
          <PanelTitle>{t.dashboard.yourOrganizations}</PanelTitle>
          <ul className="mt-4 flex flex-col gap-2 text-[13.5px]">
            {memberships.map((m) => (
              <li key={m.id} className="flex items-center justify-between rounded-2xl bg-secondary px-4 py-3">
                <span className="font-mono text-xs text-muted-foreground">{m.organizationId}</span>
                <span className="font-bold">{m.role}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[12.5px] text-muted-foreground">{t.companies.noCompaniesYet}</p>
        </Panel>
      )}
    </main>
  );
}
