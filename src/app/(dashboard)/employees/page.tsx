import Link from "next/link";
import { redirect } from "next/navigation";
import { Users } from "lucide-react";
import { verifySession, getMyCompanies, getEmployees } from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CompanyChooser } from "@/components/company-chooser";
import { EmptyState } from "@/components/empty-state";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";

export default async function EmployeesPage({
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
  if (companies.length === 0) {
    redirect("/dashboard");
  }

  const { company: companyParam } = await searchParams;
  const activeCompany =
    companies.find((c) => c.id === companyParam) ?? (companies.length === 1 ? companies[0]! : null);

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-heading text-2xl font-medium tracking-tight">{t.nav.employees}</h1>
        {activeCompany ? (
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href={`/employees/import?company=${activeCompany.id}`}>{t.employees.importCsv}</Link>
            </Button>
            <Button asChild>
              <Link href={`/employees/new?company=${activeCompany.id}`}>{t.employees.newEmployee}</Link>
            </Button>
          </div>
        ) : null}
      </div>

      <CompanyChooser
        companies={companies}
        activeCompanyId={activeCompany?.id}
        basePath="/employees"
        title={t.employees.companyCardTitle}
      />

      {!activeCompany ? (
        <p className="text-sm text-muted-foreground">{t.employees.selectCompanyPrompt}</p>
      ) : (
        <EmployeeTable companyId={activeCompany.id} t={t} />
      )}
    </main>
  );
}

async function EmployeeTable({ companyId, t }: { companyId: string; t: Dict }) {
  const employees = await getEmployees(companyId);

  const statusLabel: Record<string, string> = {
    ACTIVE: t.employees.statusActive,
    ON_LEAVE: t.employees.statusOnLeave,
    TERMINATED: t.employees.statusTerminated,
  };

  if (employees.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState icon={Users} message={t.employees.noEmployeesYet} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.common.name}</TableHead>
              <TableHead>{t.employees.cpfLabel}</TableHead>
              <TableHead>{t.employees.registrationNumberLabel}</TableHead>
              <TableHead>{t.employees.phoneLabel}</TableHead>
              <TableHead>{t.employees.positionLabel}</TableHead>
              <TableHead>{t.employees.departmentLabel}</TableHead>
              <TableHead>{t.common.status}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {employees.map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <Link href={`/employees/${e.id}`} className="font-medium underline-offset-4 hover:underline">
                    {e.fullName}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{e.cpfMasked}</TableCell>
                <TableCell>{e.registrationNumber ?? "—"}</TableCell>
                <TableCell>{e.phoneE164 ?? "—"}</TableCell>
                <TableCell>{e.positionTitle ?? "—"}</TableCell>
                <TableCell>{e.department ?? "—"}</TableCell>
                <TableCell>{statusLabel[e.status] ?? e.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
