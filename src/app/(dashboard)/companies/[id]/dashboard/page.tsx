import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertCircle, Activity } from "lucide-react";
import { verifySession, getCompany, getDashboardSummary, getCompanyAuditEvents } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AuditTimeline } from "@/app/(dashboard)/deliveries/[id]/audit-timeline";
import { StatItem } from "@/components/stat-item";
import { EmptyState } from "@/components/empty-state";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

/**
 * Operational dashboard (docs/mvp-roadmap.md FASE 6): plain labeled numbers answering
 * "is anything stuck" -- deliberately not a chart. getDashboardSummary already bounds the
 * period counts at 30 days server-side; the two "pending over N days" counts are never
 * period-bound (see that function's own comment in dal.ts).
 */
export default async function CompanyDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const { id } = await params;
  const [company, summary, auditEvents] = await Promise.all([
    getCompany(id),
    getDashboardSummary(id),
    getCompanyAuditEvents(id, 50),
  ]);
  if (!company) {
    notFound();
  }

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="font-heading text-2xl font-medium tracking-tight">{t.companies.operationalDashboard}</h1>
        <p className="text-sm text-muted-foreground">{company.legalName}</p>
        <Link
          href={`/companies/${company.id}`}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {t.companies.backToCompany}
        </Link>
      </div>

      {summary ? (
        <Card>
          <CardHeader>
            <CardTitle>{t.companies.last30DaysStats}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatItem label={t.companies.activeEmployees} value={summary.activeEmployeesCount} />
              <StatItem label={t.companies.deliveriesInPeriod} value={summary.deliveriesInPeriod} />
              <StatItem label={t.companies.confirmedLabel} value={summary.confirmedCount} />
              <StatItem label={t.companies.pendingLabel} value={summary.pendingCount} />
              <StatItem label={t.companies.contestedLabel} value={summary.contestedCount} />
              <StatItem label={t.companies.cancelledLabel} value={summary.cancelledCount} />
              <StatItem label={t.companies.pendingOver3Days} value={summary.pendingOver3DaysCount} />
              <StatItem label={t.companies.pendingOver7Days} value={summary.pendingOver7DaysCount} />
            </dl>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent>
            <EmptyState icon={AlertCircle} message={t.companies.dashboardLoadError} />
          </CardContent>
        </Card>
      )}

      {auditEvents.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t.companies.recentActivity}</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState icon={Activity} message={t.companies.noActivityYet} />
          </CardContent>
        </Card>
      ) : (
        // AuditTimeline already supplies its own Card + title ("Histórico") -- reused as-is
        // (docs task note: this feed's events have no deliveryId to link to individually,
        // and the component never links per-row anyway, so it's a direct reuse).
        <AuditTimeline events={auditEvents} />
      )}
    </main>
  );
}
