import Link from "next/link";
import { Panel, PanelKicker, PanelTitle } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ComplianceAggregateBadge, ComplianceRequirementBadge } from "@/components/compliance-badge";
import type { ComplianceResult, ComplianceSummary, EmployeeComplianceRequirement } from "@/lib/supabase/dal";
import type { Dict } from "@/i18n/dictionaries";
import { formatDayBr } from "@/lib/format/datetime";

/**
 * The ficha-360's compliance section (spec §12/§14): the aggregate badge, the percent, and
 * the full per-requirement breakdown -- what the manager needs to answer "is this person
 * conforme, and if not, why". Renders nothing at all for feature_disabled/forbidden/not_found
 * (the same silent-hide convention LowStockPanel already uses for inventory_enabled) --
 * those are not this employee's problem to explain. SEM_CARGO/MATRIZ_VAZIA render as an
 * explicit indeterminate message instead of a table -- never a fabricated conforme.
 */
export function CompliancePanel({
  detail,
  summary,
  t,
}: {
  detail: ComplianceResult<EmployeeComplianceRequirement[]>;
  summary: ComplianceResult<ComplianceSummary>;
  t: Dict;
}) {
  if (detail.status === "feature_disabled" || detail.status === "forbidden" || detail.status === "not_found") {
    return null;
  }
  if (detail.status === "error" || summary.status !== "ok") {
    return (
      <Panel className="flex flex-col gap-2">
        <PanelTitle>{t.compliance.title}</PanelTitle>
        <p className="text-sm text-muted-foreground">{t.compliance.loadError}</p>
      </Panel>
    );
  }

  const rows = detail.data;
  const indeterminateRow = rows.find((r) => r.state === "SEM_CARGO" || r.state === "MATRIZ_VAZIA");

  return (
    <Panel className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>{t.compliance.title}</PanelTitle>
        <ComplianceAggregateBadge state={summary.data.aggregateState} />
      </div>

      {indeterminateRow ? (
        <p className="text-sm text-muted-foreground">
          {indeterminateRow.state === "SEM_CARGO" ? t.compliance.reasonSemCargo : t.compliance.reasonMatrizVazia}
        </p>
      ) : (
        <>
          {summary.data.compliancePercent !== null ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-heading text-2xl font-extrabold tabular-nums text-foreground">
                {summary.data.compliancePercent}%
              </span>{" "}
              {t.compliance.percentLabel} ({summary.data.requiredOk}/{summary.data.requiredTotal})
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t.compliance.reasonSemRequisitosObrigatorios}</p>
          )}

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.compliance.requirementColumn}</TableHead>
                  <TableHead className="text-right">{t.compliance.requiredQuantityColumn}</TableHead>
                  <TableHead className="text-right">{t.compliance.heldQuantityColumn}</TableHead>
                  <TableHead>{t.compliance.dueDateColumn}</TableHead>
                  <TableHead>{t.compliance.stateColumn}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.requirementId ?? row.epiId}>
                    <TableCell className="font-bold">
                      {row.epiName}
                      {row.required === false ? (
                        <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                          ({t.compliance.optionalTag})
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.requiredQuantity ?? t.compliance.noneRequired}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.heldQuantity}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.earliestDueDate ? formatDayBr(row.earliestDueDate) : t.compliance.noneRequired}
                    </TableCell>
                    <TableCell>
                      <ComplianceRequirementBadge state={row.state} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </Panel>
  );
}

/** Dashboard panel (spec §13's "Precisa de atenção" surface): every employee currently
 * NÃO CONFORME or ATENÇÃO, named with why -- same "who, and why" shape as PendingReturns/
 * LowStockPanel (a separate panel, not merged into NeedsAttention's own confirmation-waiting
 * feed, which is a different kind of pendency). Returns null when empty, same convention as
 * every other attention panel on this dashboard. */
export function ComplianceAttentionPanel({
  rows,
  employeeHref,
  t,
}: {
  rows: Array<{
    employeeId: string;
    employeeFullName: string;
    positionTitle: string | null;
    aggregateReason: ComplianceSummary["aggregateReason"];
  }>;
  employeeHref: (employeeId: string) => string;
  t: Dict;
}) {
  if (rows.length === 0) return null;

  return (
    <Panel tone="warning" className="flex flex-col">
      <PanelKicker className="text-warning">{t.companies.needsAttention}</PanelKicker>
      <ul className="mt-4 flex flex-col gap-3.5">
        {rows.map((row) => (
          <li key={row.employeeId} className="flex items-baseline justify-between gap-3.5">
            <span className="min-w-0 flex-1">
              <Link
                href={employeeHref(row.employeeId)}
                className="block truncate text-[14px] font-bold underline-offset-4 hover:underline"
              >
                {row.employeeFullName}
              </Link>
              <span className="block truncate text-[12px] text-muted-foreground">
                {row.positionTitle ? `${row.positionTitle} · ` : ""}
                {complianceReasonLabel(t, row.aggregateReason)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function complianceReasonLabel(t: Dict, reason: ComplianceSummary["aggregateReason"]): string {
  const map: Record<ComplianceSummary["aggregateReason"], string> = {
    SEM_CARGO: t.compliance.reasonSemCargo,
    MATRIZ_VAZIA: t.compliance.reasonMatrizVazia,
    SEM_REQUISITOS_OBRIGATORIOS: t.compliance.reasonSemRequisitosObrigatorios,
    REQUISITOS_PENDENTES: t.compliance.reasonRequisitosPendentes,
    PROXIMO_DA_TROCA: t.compliance.reasonProximoDaTroca,
    OK: t.compliance.reasonOk,
  };
  return map[reason];
}
