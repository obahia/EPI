import Link from "next/link";
import { redirect } from "next/navigation";
import { verifySession, getMyCompanies, getEmployees } from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Ativo",
  ON_LEAVE: "Afastado",
  TERMINATED: "Desligado",
};

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string }>;
}) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const companies = await getMyCompanies();
  if (companies.length === 0) {
    redirect("/dashboard");
  }

  const { company: companyParam } = await searchParams;
  const activeCompany =
    companies.find((c) => c.id === companyParam) ?? (companies.length === 1 ? companies[0]! : null);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Funcionários</h1>
        {activeCompany ? (
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href={`/employees/import?company=${activeCompany.id}`}>Importar CSV</Link>
            </Button>
            <Button asChild>
              <Link href={`/employees/new?company=${activeCompany.id}`}>Novo funcionário</Link>
            </Button>
          </div>
        ) : null}
      </div>

      {companies.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Empresa</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2 text-sm">
              {companies.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/employees?company=${c.id}`}
                    className={
                      "rounded-md border px-3 py-1.5" +
                      (activeCompany?.id === c.id ? " border-primary bg-primary/5 font-medium" : "")
                    }
                  >
                    {c.legalName}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {!activeCompany ? (
        <p className="text-sm text-muted-foreground">Selecione uma empresa para ver seus funcionários.</p>
      ) : (
        <EmployeeTable companyId={activeCompany.id} />
      )}
    </main>
  );
}

async function EmployeeTable({ companyId }: { companyId: string }) {
  const employees = await getEmployees(companyId);

  if (employees.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Nenhum funcionário cadastrado ainda. Use “Novo funcionário” ou “Importar CSV” para começar.
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
              <TableHead>Nome</TableHead>
              <TableHead>CPF</TableHead>
              <TableHead>Matrícula</TableHead>
              <TableHead>Telefone</TableHead>
              <TableHead>Cargo</TableHead>
              <TableHead>Departamento</TableHead>
              <TableHead>Status</TableHead>
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
                <TableCell>{STATUS_LABEL[e.status] ?? e.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
