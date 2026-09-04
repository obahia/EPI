import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  verifySession,
  getEmployee,
  getEmployeeDeliveries,
  getJobPositions,
  getLocations,
  getEmployeeEpiLifecycle,
  getEmployeeComplianceDetail,
  getEmployeeComplianceSummary,
  type EmployeeStatus,
  type EmployeeEpiLifecycle,
} from "@/lib/supabase/dal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelKicker, PanelTitle } from "@/components/panel";
import { EpiLifecycleBadge } from "@/components/epi-lifecycle-badge";
import { CompliancePanel } from "@/components/compliance-panel";
import { formatPhoneBr } from "@/lib/br/phone";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";
import { EmployeeEditForm } from "./employee-edit-form";
import { formatDayBr } from "@/lib/format/datetime";

function statusLabel(t: Dict, status: EmployeeStatus): string {
  const map: Record<EmployeeStatus, string> = {
    ACTIVE: t.employees.statusActive,
    ON_LEAVE: t.employees.statusOnLeave,
    TERMINATED: t.employees.statusTerminated,
  };
  return map[status];
}

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const { id } = await params;
  const employee = await getEmployee(id);
  if (!employee) {
    notFound();
  }

  const [mine, positions, locations, lifecycle, complianceDetail, complianceSummary] = await Promise.all([
    getEmployeeDeliveries(employee.id),
    getJobPositions(employee.companyId),
    getLocations(employee.companyId),
    getEmployeeEpiLifecycle(employee.id),
    getEmployeeComplianceDetail(employee.id),
    getEmployeeComplianceSummary(employee.id),
  ]);
  const awaiting = mine.filter((d) => d.status === "ISSUED").length;

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        back={{ href: `/employees?company=${employee.companyId}`, label: t.employees.backToEmployees }}
        title={employee.fullName}
        titleSuffix={
          employee.status === "ACTIVE" ? (
            <Badge variant="outline" className="border-transparent bg-success-soft text-success">
              {t.employees.statusActive}
            </Badge>
          ) : (
            <Badge variant="ghost" className="bg-secondary text-muted-foreground">
              {statusLabel(t, employee.status)}
            </Badge>
          )
        }
        subtitle={`${t.employees.cpfLabel} ${employee.cpfMasked}${
          employee.registrationNumber ? ` · ${t.employees.registrationNumberLabel} ${employee.registrationNumber}` : ""
        }`}
        actions={
          <Button asChild variant="outline" size="lg">
            <Link href={`/ficha/${employee.id}`}>{t.employees.epiControlSheet}</Link>
          </Button>
        }
      />

      {/* Two columns from `xl` up, the same way the delivery detail is laid out: what you
          can change reads down the left, what is merely true about this person sits on the
          right. */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <Panel className="min-w-0 flex-1">
          <PanelTitle>{t.employees.editEmployee}</PanelTitle>
          <div className="mt-4.5">
            <EmployeeEditForm employee={employee} positions={positions} locations={locations} />
          </div>
        </Panel>

        <div className="flex flex-col gap-4 xl:w-84 xl:shrink-0">
          <Panel className="flex flex-col gap-4">
            <PanelKicker className="text-muted-foreground">{t.employees.recordTitle}</PanelKicker>
            <dl className="flex flex-col gap-2 text-[13px]">
              <Fact label={t.employees.deliveriesColumn} value={String(mine.length)} />
              <Fact label={t.deliveries.filterAwaiting} value={String(awaiting)} />
              <Fact
                label={t.employees.phoneLabel}
                value={employee.phoneE164 ? formatPhoneBr(employee.phoneE164) : "—"}
              />
              <Fact label={t.common.email} value={employee.email ?? "—"} />
              <Fact
                label={t.employees.dataOriginLabel}
                value={
                  employee.dataOrigin === "IMPORT"
                    ? t.employees.dataOriginImport
                    : employee.dataOrigin === "MANUAL"
                      ? t.employees.dataOriginManual
                      : employee.dataOrigin
                }
              />
              {employee.terminatedOn ? (
                <Fact
                  label={t.employees.terminatedOnLabel}
                  value={formatDayBr(employee.terminatedOn)}
                />
              ) : null}
            </dl>
          </Panel>

          <Panel tone="secondary">
            <PanelKicker className="text-muted-foreground">{t.employees.cpfLabel}</PanelKicker>
            <p className="mt-2 font-mono text-lg font-bold">{employee.cpfMasked}</p>
            <p className="mt-1.5 text-[12px] text-muted-foreground">{t.employees.cpfNotEditableHint}</p>
          </Panel>
        </div>
      </div>

      <CompliancePanel detail={complianceDetail} summary={complianceSummary} t={t} />

      <Panel className="flex flex-col gap-4">
        <PanelTitle>{t.employees.lifecycleTitle}</PanelTitle>
        {lifecycle.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.employees.lifecycleEmpty}</p>
        ) : (
          <ul className="flex flex-col gap-3.5">
            {lifecycle.map((item) => (
              <li
                key={item.deliveryItemId}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border/45 pb-3.5 last:border-b-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-bold">
                    {item.epiName}
                    {item.variantLabel ? ` · ${item.variantLabel}` : ""}
                  </p>
                  <p className="truncate text-[12px] text-muted-foreground">
                    {t.epis.caLabel} {item.caNumber}
                    {lifecycleDueLabel(t, item) ? ` · ${lifecycleDueLabel(t, item)}` : ""}
                  </p>
                </div>
                <EpiLifecycleBadge status={item.status} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-bold">{value}</dd>
    </div>
  );
}

/** pt: "vence em 12 dias" / "venceu há 5 dias" -- null for an item with no tracked lifespan
 * at all (dueDate/daysRemaining both null, same VIGENTE-by-default rule the RPC itself
 * documents on app.epi_lifecycle_status). */
function lifecycleDueLabel(t: Dict, item: EmployeeEpiLifecycle): string | null {
  if (item.dueDate == null || item.daysRemaining == null) return null;
  return item.daysRemaining >= 0
    ? `${t.employees.lifecycleDueInPrefix} ${item.daysRemaining} ${t.employees.lifecycleDaysUnit}`
    : `${t.employees.lifecycleOverduePrefix} ${Math.abs(item.daysRemaining)} ${t.employees.lifecycleDaysUnit}`;
}
