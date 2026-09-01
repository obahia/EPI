import { redirect } from "next/navigation";
import { verifySession, getMyCompanies } from "@/lib/supabase/dal";
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

  const companies = await getMyCompanies();
  const { company: companyParam } = await searchParams;
  const company = companies.find((c) => c.id === companyParam) ?? (companies.length === 1 ? companies[0]! : null);

  if (!company) {
    redirect("/employees");
  }

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Importar funcionários</h1>
        <p className="text-sm text-muted-foreground">{company.legalName}</p>
      </div>

      <ImportWizard companyId={company.id} />
    </main>
  );
}
