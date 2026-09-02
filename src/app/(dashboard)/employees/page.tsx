import Link from "next/link";
import { redirect } from "next/navigation";
import { Users } from "lucide-react";
import {
  verifySession,
  getMyCompanies,
  getEmployees,
  getDeliveries,
  type Employee,
  type EmployeeStatus,
} from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelFooter } from "@/components/panel";
import { SearchField } from "@/components/search-field";
import { StatusFilterPills, type StatusFilterOption } from "@/components/status-filter-pills";
import { formatPhoneBr } from "@/lib/br/phone";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";

const STATUSES: EmployeeStatus[] = ["ACTIVE", "ON_LEAVE", "TERMINATED"];

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; status?: string; q?: string }>;
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

  const { company: companyParam, status, q } = await searchParams;
  const activeCompany = companies.find((c) => c.id === companyParam) ?? companies[0]!;
  const [employees, deliveries] = await Promise.all([
    getEmployees(activeCompany.id),
    getDeliveries(activeCompany.id),
  ]);

  const countOf = (status: EmployeeStatus) => employees.filter((e) => e.status === status).length;

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        kicker={STATUSES.map((s) => `${countOf(s)} ${statusLabel(t, s).toLowerCase()}s`).join(" · ")}
        title={t.nav.employees}
        actions={
          <>
            <Button asChild variant="outline" size="lg">
              <Link href={`/employees/import?company=${activeCompany.id}`}>{t.employees.importCsv}</Link>
            </Button>
            <Button asChild size="lg">
              <Link href={`/employees/new?company=${activeCompany.id}`}>{t.employees.newEmployee}</Link>
            </Button>
          </>
        }
      />

      <EmployeeRoster
        companyId={activeCompany.id}
        employees={employees}
        deliveries={deliveries}
        status={status}
        q={q}
        t={t}
      />
    </main>
  );
}

function statusLabel(t: Dict, status: EmployeeStatus): string {
  const map: Record<EmployeeStatus, string> = {
    ACTIVE: t.employees.statusActive,
    ON_LEAVE: t.employees.statusOnLeave,
    TERMINATED: t.employees.statusTerminated,
  };
  return map[status];
}

/**
 * The roster as one table, implemented from the mockup (screen 4f): counted status
 * pills over a single list, and the column the mockup puts at the far right -- how
 * many deliveries each person has -- rather than the facet rail the roster used to
 * carry beside it.
 */
function EmployeeRoster({
  companyId,
  employees,
  deliveries,
  status,
  q,
  t,
}: {
  companyId: string;
  employees: Employee[];
  deliveries: { employeeId: string; status: string }[];
  status?: string;
  q?: string;
  t: Dict;
}) {
  if (employees.length === 0) {
    return (
      <Panel>
        <EmptyState icon={Users} message={t.employees.noEmployeesYet} />
      </Panel>
    );
  }

  const deliveriesByEmployee = new Map<string, number>();
  for (const delivery of deliveries) {
    deliveriesByEmployee.set(delivery.employeeId, (deliveriesByEmployee.get(delivery.employeeId) ?? 0) + 1);
  }

  const activeStatus = STATUSES.find((s) => s === status);
  const options: StatusFilterOption[] = STATUSES.map((s) => ({
    value: s,
    label: statusLabel(t, s),
    count: employees.filter((e) => e.status === s).length,
    tone: s === "ACTIVE" ? ("success" as const) : undefined,
  }));

  const needle = q?.trim().toLowerCase();
  const shown = employees
    .filter((e) => (activeStatus ? e.status === activeStatus : true))
    .filter((e) =>
      needle
        ? [e.fullName, e.registrationNumber, e.positionTitle, e.department, e.cpfMasked]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(needle))
        : true,
    );

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          basePath="/employees"
          params={{ company: companyId, ...(activeStatus ? { status: activeStatus } : {}) }}
          placeholder={t.employees.searchPlaceholder}
          defaultValue={q}
          className="w-full max-w-90 sm:w-90"
        />
        <StatusFilterPills
          options={options}
          active={activeStatus}
          basePath="/employees"
          params={{ company: companyId, ...(q ? { q } : {}) }}
        />
      </div>

      {shown.length === 0 ? (
        <Panel>
          <EmptyState icon={Users} message={t.common.noResults} />
        </Panel>
      ) : (
        <Panel>
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
                <TableHead className="text-right">{t.employees.deliveriesColumn}</TableHead>
                <TableHead className="text-right">{t.common.action}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((employee) => (
                <EmployeeRow
                  key={employee.id}
                  employee={employee}
                  deliveries={deliveriesByEmployee.get(employee.id) ?? 0}
                  t={t}
                />
              ))}
            </TableBody>
          </Table>

          <PanelFooter>
            <p>
              {t.employees.showingCount} {shown.length} {t.employees.ofCount} {employees.length}{" "}
              {t.employees.employeesUnit}
            </p>
            <p>{t.employees.cpfEncryptedNote}</p>
          </PanelFooter>
        </Panel>
      )}
    </>
  );
}

function EmployeeRow({ employee, deliveries, t }: { employee: Employee; deliveries: number; t: Dict }) {
  return (
    <TableRow>
      <TableCell className="font-bold">
        <Link href={`/employees/${employee.id}`} className="underline-offset-4 hover:underline">
          {employee.fullName}
        </Link>
      </TableCell>
      <TableCell className="font-mono text-[12.5px] text-muted-foreground">{employee.cpfMasked}</TableCell>
      <TableCell className="font-mono text-[12.5px] text-muted-foreground">
        {employee.registrationNumber ?? "—"}
      </TableCell>
      <TableCell className="font-mono text-[12.5px] text-muted-foreground">
        {employee.phoneE164 ? formatPhoneBr(employee.phoneE164) : "—"}
      </TableCell>
      <TableCell className="text-muted-foreground">{employee.positionTitle ?? "—"}</TableCell>
      <TableCell className="text-muted-foreground">{employee.department ?? "—"}</TableCell>
      <TableCell>
        {employee.status === "ACTIVE" ? (
          <Badge variant="outline" className="border-transparent bg-success-soft text-success">
            {t.employees.statusActive}
          </Badge>
        ) : (
          <Badge variant="ghost" className="text-muted-foreground">
            {statusLabel(t, employee.status)}
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right font-bold tabular-nums">{deliveries}</TableCell>
      <TableCell className="text-right">
        <Link
          href={`/employees/${employee.id}`}
          className="font-bold text-primary-deep underline-offset-4 hover:underline"
        >
          {t.common.edit}
        </Link>
      </TableCell>
    </TableRow>
  );
}
