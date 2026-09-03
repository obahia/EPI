import { notFound, redirect } from "next/navigation";
import {
  verifySession,
  getDelivery,
  getDeliveryItems,
  getConfirmationRequests,
  getDeliveryContests,
  getDeliveryAuditEvents,
  getEvidenceSummary,
  getDeliveryBatches,
} from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeliveryStatusBadge } from "@/components/delivery-status-badge";
import { PageHeader } from "@/components/page-header";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { DeliveryActions } from "./delivery-actions";
import { ConfirmationLinkPanel } from "./confirmation-link-panel";
import { ConfirmationStatusPanel } from "./confirmation-status-panel";
import { ContestPanel } from "./contest-panel";
import { AuditTimeline } from "./audit-timeline";
import { SealedReceipt } from "./sealed-receipt";
import { LIVE_CONFIRMATION_STATUSES } from "./labels";
import { formatDateTimeBr, formatDayBr } from "@/lib/format/datetime";

export default async function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const UNIT_LABEL: Record<string, string> = {
    UN: t.epis.unitUn,
    PAR: t.epis.unitPar,
    CX: t.epis.unitCx,
    M: t.epis.unitM,
    KG: t.epis.unitKg,
  };

  const { id } = await params;
  const [delivery, items, confirmationRequests, contests, auditEvents, evidence] = await Promise.all([
    getDelivery(id),
    getDeliveryItems(id),
    getConfirmationRequests(id),
    getDeliveryContests(id),
    getDeliveryAuditEvents(id),
    getEvidenceSummary(id),
  ]);
  if (!delivery) {
    notFound();
  }

  // The mockup's subtitle names the batch the delivery came out of; a one-off delivery
  // has no batch and simply drops that clause.
  const batches = delivery.batchId ? await getDeliveryBatches(delivery.companyId) : [];
  const batch = batches.find((b) => b.id === delivery.batchId) ?? null;

  const hasLiveConfirmationLink = confirmationRequests[0]
    ? LIVE_CONFIRMATION_STATUSES.has(confirmationRequests[0].status)
    : false;

  const subtitle = [
    `${t.deliveries.deliveryOfPrefix} ${formatDayBr(delivery.deliveryDate)}`,
    batch
      ? `${t.deliveries.batchColumn.toLowerCase()} ${formatDayBr(batch.deliveryDate)}${batch.note?.trim() ? ` ${batch.note.trim()}` : ""}`
      : null,
    delivery.issuedAt ? `${t.deliveries.issuedOn} ${formatDateTimeBr(delivery.issuedAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        back={{ href: "/deliveries", label: t.deliveries.backToDeliveries }}
        title={delivery.employeeFullName}
        titleSuffix={<DeliveryStatusBadge status={delivery.status} />}
        subtitle={subtitle}
        actions={<DeliveryActions deliveryId={delivery.id} status={delivery.status} />}
      />

      {delivery.status === "CONFIRMED" && evidence ? (
        <SealedReceipt delivery={delivery} evidence={evidence} t={t} />
      ) : null}

      {/* Two columns from `xl` up, as the mockup lays screen 4d out: the record (what was
          handed over, what was disputed, what the audit log says) reads down the left,
          while everything that is still an open loop -- the confirmation link, the level
          of identification it demands, the sealed evidence -- stacks on the right. */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t.deliveries.itemsLabel}</CardTitle>
            </CardHeader>
            <CardContent className="px-2.5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.deliveries.epiColumn}</TableHead>
                    <TableHead>{t.epis.caLabel}</TableHead>
                    <TableHead>{t.epis.manufacturerLabel}</TableHead>
                    <TableHead>{t.epis.modelLabel}</TableHead>
                    <TableHead className="text-right">{t.deliveries.quantityColumnAbbr}</TableHead>
                    <TableHead>{t.deliveries.unitColumnAbbr}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-bold">{item.epiName}</TableCell>
                      <TableCell className="font-mono text-[12.5px]">{item.caNumber}</TableCell>
                      <TableCell className="text-muted-foreground">{item.manufacturer ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{item.model ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                      <TableCell className="text-muted-foreground">{UNIT_LABEL[item.unit] ?? item.unit}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {delivery.note ? (
            <Card>
              <CardHeader>
                <CardTitle>{t.common.note}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm">{delivery.note}</p>
              </CardContent>
            </Card>
          ) : null}

          {delivery.status === "CANCELLED" && delivery.cancelReason ? (
            <Card>
              <CardHeader>
                <CardTitle>{t.deliveries.cancelReasonTitle}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm">{delivery.cancelReason}</p>
              </CardContent>
            </Card>
          ) : null}

          <ContestPanel deliveryId={delivery.id} contests={contests} />

          <AuditTimeline events={auditEvents} />
        </div>

        <div className="flex flex-col gap-4 xl:sticky xl:top-7.5 xl:w-84 xl:shrink-0">
          {delivery.status === "ISSUED" || delivery.status === "CONTESTED" ? (
            <ConfirmationLinkPanel deliveryId={delivery.id} hasLiveLink={hasLiveConfirmationLink} />
          ) : null}

          <ConfirmationStatusPanel requests={confirmationRequests} />
        </div>
      </div>
    </main>
  );
}
