import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { I18nProvider } from "@/i18n/provider";
import { DashboardSidebar } from "@/components/dashboard-sidebar";

/**
 * Deliberately not doing the auth check here -- each page under (dashboard) already calls
 * verifySession()/redirect("/login") itself (see docs/architecture.md §4: authorization
 * lives close to the data, never in a layout or middleware). This is presentation only.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);

  return (
    <I18nProvider locale={locale} dict={dict}>
      <div className="flex flex-1 flex-col md:flex-row">
        <DashboardSidebar />
        <div className="flex flex-1 flex-col overflow-x-hidden">{children}</div>
      </div>
    </I18nProvider>
  );
}
