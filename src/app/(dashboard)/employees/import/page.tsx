import { redirect } from "next/navigation";
import { verifySession, getMyCompanies } from "@/lib/supabase/dal";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { PageHeader } from "@/components/page-header";
import { ImportWizard } from "./import-wizard";

export default async function ImportEmployeesPage({
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
    redirect("/employees");
  }

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        back={{ href: `/employees?company=${company.id}`, label: t.employees.backToEmployees }}
        kicker={company.legalName}
        title={t.employees.importEmployees}
      />

      <ImportWizard companyId={company.id} />
    </main>
  );
}
