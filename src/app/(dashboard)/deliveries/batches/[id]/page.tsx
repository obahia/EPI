import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { verifySession, getDeliveryBatch, getBatchDeliveries } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeliveryStatusBadge } from "@/components/delivery-status-badge";
import { StatItem } from "@/components/stat-item";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { ResendBatchPanel } from "./resend-panel";

export default async function DeliveryBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const { id } = await params;
  const [batch, deliveries] = await Promise.all([getDeliveryBatch(id), getBatchDeliveries(id)]);
  if (!batch) {
    notFound();
  }

  // No separate "pending" counter on the batch row -- derived here, same as the RPC/DAL
  // comment describes (docs/mvp-roadmap.md FASE 6).
  const pendingCount = batch.totalCount - batch.confirmedCount - batch.contestedCount - batch.cancelledCount;

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="font-heading text-4xl font-extrabold tracking-tight">
          {t.deliveries.batchOfPrefix} {new Date(`${batch.deliveryDate}T00:00:00`).toLocaleDateString("pt-BR")}
        </h1>
        <Link
          href="/deliveries/batches"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {t.deliveries.backToBatches}
        </Link>
      </div>

      {batch.note ? (
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle>{t.common.note}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{batch.note}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t.deliveries.summaryTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatItem label={t.deliveries.totalColumn} value={batch.totalCount} />
            <StatItem label={t.deliveries.confirmedColumn} value={batch.confirmedCount} />
            <StatItem label={t.deliveries.pendingColumn} value={pendingCount} />
            <StatItem label={t.deliveries.contestedColumn} value={batch.contestedCount} />
            <StatItem label={t.deliveries.cancelledColumn} value={batch.cancelledCount} />
          </dl>
        </CardContent>
      </Card>

      <ResendBatchPanel batchId={batch.id} />

      <Card>
        <CardHeader>
          <CardTitle>{t.nav.deliveries}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.deliveries.employeeColumn}</TableHead>
                <TableHead>{t.common.status}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <Link href={`/deliveries/${d.id}`} className="font-medium underline-offset-4 hover:underline">
                      {d.employeeFullName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <DeliveryStatusBadge status={d.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
}
