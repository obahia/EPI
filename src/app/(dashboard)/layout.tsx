import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { I18nProvider } from "@/i18n/provider";
import { AppSidebar, type SidebarIdentity } from "@/components/app-sidebar";
import { getCurrentUser, getMyCompanies, getMyMemberships, type Membership } from "@/lib/supabase/dal";

const ROLE_RANK: Record<Membership["role"], number> = {
  ORG_ADMIN: 3,
  COMPANY_ADMIN: 2,
  SST_OPERATOR: 1,
  VIEWER: 0,
};

/**
 * Deliberately not doing the auth check here -- each page under (dashboard) already calls
 * verifySession()/redirect("/login") itself (see docs/architecture.md §4: authorization
 * lives close to the data, never in a layout or middleware). This is presentation only.
 * The identity fetch below is the same story: display data for the sidebar's own chrome,
 * not a gate -- an unauthenticated hit never reaches here with real data anyway (the
 * page-level verifySession() redirect already ran first).
 *
 * The mockup has no top bar: the sidebar is the only chrome, and every page opens
 * straight onto its own header band.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);

  const [user, companies, memberships] = await Promise.all([getCurrentUser(), getMyCompanies(), getMyMemberships()]);

  const topRole = memberships.reduce<Membership | null>(
    (best, m) => (!best || ROLE_RANK[m.role] > ROLE_RANK[best.role] ? m : best),
    null,
  );

  const activeCompany = companies[0] ?? null;

  const identity: SidebarIdentity | null = user
    ? {
        fullName: user.fullName,
        role: topRole?.role ?? "",
        companyName: activeCompany?.legalName ?? null,
        hasMultipleCompanies: companies.length > 1,
      }
    : null;

  return (
    <I18nProvider locale={locale} dict={dict}>
      <div className="flex flex-1 flex-col md:flex-row">
        <AppSidebar identity={identity} />
        <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden">{children}</div>
      </div>
    </I18nProvider>
  );
}
