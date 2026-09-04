import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertCircle, Activity } from "lucide-react";
import {
  verifySession,
  getCompany,
  getDashboardSummary,
  getCompanyAuditEvents,
  getOldestWaitingDeliveries,
  getDeliveryItemsFor,
  summarizeDeliveryItems,
  getPendingReturns,
  getOrganizationPolicy,
  getStockBalances,
  getLocations,
  getCompanyComplianceSummary,
  type StockBalance,
  type Location,
} from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { PendingBanner } from "@/components/pending-banner";
import { RecentActivity } from "@/components/recent-activity";
import { NeedsAttention } from "@/components/needs-attention";
import { PendingReturns } from "@/components/pending-returns";
import { LowStockPanel } from "@/components/low-stock-panel";
import { ComplianceAttentionPanel } from "@/components/compliance-panel";
import { StatItem } from "@/components/stat-item";
import { EmptyState } from "@/components/empty-state";
import { formatCnpj } from "@/lib/br/cnpj";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

/**
 * Operational dashboard (docs/mvp-roadmap.md FASE 6): plain labeled numbers answering
 * "is anything stuck" -- deliberately not a chart. getDashboardSummary already bounds the
 * period counts at 30 days server-side; the two "pending over N days" counts are never
 * period-bound (see that function's own comment in dal.ts).
 *
 * Laid out from the mockup (screen 4b): the waiting count takes a terracotta tile the
 * height of the whole counter grid, the other four counters sit beside it as plain tiles,
 * and the bottom pairs the activity feed with the people who have been waiting longest.
 */
/** Same fixed v1 threshold the standalone stock list uses (src/app/(dashboard)/stock/page.tsx)
 * -- "estoque baixo" is quantity <= 5, no per-EPI configurable threshold yet. */
const LOW_STOCK_THRESHOLD = 5;

export default async function CompanyDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const { id } = await params;
  // Longest-waiting first: bounded to 3 rows in Postgres (deliveries_board_idx serves the
  // `status = ISSUED order by issued_at` shape) rather than sorting the company's whole
  // delivery history in JS for a right-hand column that only ever names three people.
  const [company, summary, auditEvents, oldestWaiting, pendingReturns] = await Promise.all([
    getCompany(id),
    getDashboardSummary(id),
    getCompanyAuditEvents(id, 8),
    getOldestWaitingDeliveries(id, 3),
    getPendingReturns(id),
  ]);
  if (!company) {
    notFound();
  }

  const items = await getDeliveryItemsFor(oldestWaiting.map((d) => d.id));
  const itemsByDelivery = summarizeDeliveryItems(items);

  // "Estoque baixo" only exists for an organization that has actually turned inventory on
  // (see this migration's own comment: inventory_enabled off means no automatic ENTREGA/
  // DEVOLUCAO movements, so balances would either be all-zero or stale manual entries).
  const policy = await getOrganizationPolicy(company.organizationId);
  const inventoryEnabled = policy?.inventoryEnabled ?? false;
  let lowStockBalances: StockBalance[] = [];
  let locations: Location[] = [];
  if (inventoryEnabled) {
    [lowStockBalances, locations] = await Promise.all([getStockBalances(company.id), getLocations(company.id)]);
  }
  const lowBalances = lowStockBalances.filter((b) => b.quantity <= LOW_STOCK_THRESHOLD);
  const locationNameById = new Map(locations.map((l) => [l.id, l.name]));

  // Compliance: same on/off convention as inventoryEnabled -- when off, the RPC itself would
  // refuse with feature_disabled, so this is skipped entirely rather than caught as an error.
  const complianceEnabled = policy?.complianceEnabled ?? false;
  const complianceResult = complianceEnabled ? await getCompanyComplianceSummary(company.id) : null;
  const complianceRows =
    complianceResult?.status === "ok"
      ? complianceResult.data
          .filter((row) => row.employeeStatus === "ACTIVE")
          .filter((row) => row.aggregateState === "NAO_CONFORME" || row.aggregateState === "ATENCAO")
          .sort((a, b) => (a.aggregateState === b.aggregateState ? 0 : a.aggregateState === "NAO_CONFORME" ? -1 : 1))
      : [];
  const complianceEvaluable =
    complianceResult?.status === "ok"
      ? complianceResult.data.filter((row) => row.employeeStatus === "ACTIVE" && row.aggregateState !== "INDETERMINADO")
      : [];
  const compliancePercentConforme =
    complianceEvaluable.length > 0
      ? Math.round(
          (complianceEvaluable.filter((row) => row.aggregateState === "CONFORME").length / complianceEvaluable.length) * 100,
        )
      : null;

  const pendingHref = `/deliveries?company=${company.id}&status=ISSUED`;
  const stockHref = `/stock?company=${company.id}`;

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        kicker={t.companies.last30DaysStats}
        title={t.companies.operationalDashboard}
        subtitle={`${company.legalName} · ${t.companies.cnpjLabel} ${formatCnpj(company.cnpj)}`}
        actions={
          <>
            <Button asChild variant="outline" size="lg">
              <Link href={`/deliveries/batch/new?company=${company.id}`}>{t.deliveries.newBatch}</Link>
            </Button>
            <Button asChild size="lg">
              <Link href={`/deliveries/new?company=${company.id}`}>{t.deliveries.newDelivery}</Link>
            </Button>
          </>
        }
      />

      {summary ? (
        <dl className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
          <PendingBanner
            pendingCount={summary.pendingCount}
            over3Days={summary.pendingOver3DaysCount}
            over7Days={summary.pendingOver7DaysCount}
            deliveriesHref={pendingHref}
            t={t}
            className="sm:col-span-2 xl:col-span-1 xl:row-span-2"
          />
          <StatItem label={t.companies.activeEmployees} value={summary.activeEmployeesCount} />
          <StatItem label={t.companies.deliveriesInPeriod} value={summary.deliveriesInPeriod} />
          <StatItem label={t.companies.confirmedLabel} value={summary.confirmedCount} tone="success" />
          <StatItem
            label={t.companies.contestedLabel}
            value={summary.contestedCount}
            hint={`${summary.cancelledCount} ${t.companies.cancelledLabel.toLowerCase()}`}
          />
          {compliancePercentConforme !== null ? (
            <StatItem
              label={t.companies.percentConformeLabel}
              value={`${compliancePercentConforme}%`}
              tone={compliancePercentConforme === 100 ? "success" : undefined}
            />
          ) : null}
        </dl>
      ) : (
        <Panel>
          <EmptyState icon={AlertCircle} message={t.companies.dashboardLoadError} />
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.75fr_1fr]">
        {auditEvents.length === 0 ? (
          <Panel>
            <EmptyState icon={Activity} message={t.companies.noActivityYet} />
          </Panel>
        ) : (
          <RecentActivity events={auditEvents} historyHref={`/deliveries?company=${company.id}`} timeZone={company.timeZone} t={t} />
        )}
        <NeedsAttention
          deliveries={oldestWaiting}
          itemsByDelivery={itemsByDelivery}
          deliveriesHref={pendingHref}
          t={t}
        />
      </div>

      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
        <PendingReturns returns={pendingReturns} timeZone={company.timeZone} t={t} />
        {inventoryEnabled ? (
          <LowStockPanel balances={lowBalances} locationNameById={locationNameById} stockHref={stockHref} t={t} />
        ) : null}
        {complianceEnabled ? (
          <ComplianceAttentionPanel
            rows={complianceRows}
            employeeHref={(employeeId) => `/employees/${employeeId}`}
            t={t}
          />
        ) : null}
      </div>
    </main>
  );
}
