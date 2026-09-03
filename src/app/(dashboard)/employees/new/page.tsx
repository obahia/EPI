import { redirect } from "next/navigation";
import { verifySession, getMyCompanies, getJobPositions, getLocations } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { EmployeeCreateForm } from "./employee-form";

export default async function NewEmployeePage({
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

  const [positions, locations] = await Promise.all([getJobPositions(company.id), getLocations(company.id)]);

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <h1 className="font-heading text-4xl font-extrabold tracking-tight">{t.employees.newEmployee}</h1>
      <p className="text-sm text-muted-foreground">{company.legalName}</p>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>{t.employees.employeeData}</CardTitle>
        </CardHeader>
        <CardContent>
          <EmployeeCreateForm companyId={company.id} positions={positions} locations={locations} />
        </CardContent>
      </Card>
    </main>
  );
}
