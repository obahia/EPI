import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { verifySession, getCompany, getDashboardSummary, getCompanyAuditEvents } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AuditTimeline } from "@/app/(dashboard)/deliveries/[id]/audit-timeline";

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
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Painel operacional</h1>
        <p className="text-sm text-muted-foreground">{company.legalName}</p>
        <Link
          href={`/companies/${company.id}`}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Voltar para a empresa
        </Link>
      </div>

      {summary ? (
        <Card>
          <CardHeader>
            <CardTitle>Números dos últimos 30 dias</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatItem label="Funcionários ativos" value={summary.activeEmployeesCount} />
              <StatItem label="Entregas no período" value={summary.deliveriesInPeriod} />
              <StatItem label="Confirmadas" value={summary.confirmedCount} />
              <StatItem label="Aguardando" value={summary.pendingCount} />
              <StatItem label="Contestadas" value={summary.contestedCount} />
              <StatItem label="Canceladas" value={summary.cancelledCount} />
              <StatItem label="Pendentes há mais de 3 dias" value={summary.pendingOver3DaysCount} />
              <StatItem label="Pendentes há mais de 7 dias" value={summary.pendingOver7DaysCount} />
            </dl>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Não foi possível carregar os números do painel.
          </CardContent>
        </Card>
      )}

      {auditEvents.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Últimas atividades</CardTitle>
          </CardHeader>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nenhuma atividade registrada ainda.
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

function StatItem({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
