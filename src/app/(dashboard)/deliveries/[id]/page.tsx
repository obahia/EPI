import { notFound, redirect } from "next/navigation";
import {
  verifySession,
  getDelivery,
  getDeliveryItems,
  getConfirmationRequests,
  getDeliveryContests,
  getDeliveryAuditEvents,
  getEvidenceSummary,
} from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeliveryStatusBadge } from "@/components/delivery-status-badge";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { DeliveryActions } from "./delivery-actions";
import { ConfirmationLinkPanel } from "./confirmation-link-panel";
import { ConfirmationStatusPanel } from "./confirmation-status-panel";
import { ContestPanel } from "./contest-panel";
import { AuditTimeline } from "./audit-timeline";
import { EvidencePanel } from "./evidence-panel";
import { LIVE_CONFIRMATION_STATUSES } from "./labels";

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

  const hasLiveConfirmationLink = confirmationRequests[0]
    ? LIVE_CONFIRMATION_STATUSES.has(confirmationRequests[0].status)
    : false;

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-tight">{delivery.employeeFullName}</h1>
          <p className="text-sm text-muted-foreground">
            {new Date(`${delivery.deliveryDate}T00:00:00`).toLocaleDateString("pt-BR")}
          </p>
        </div>
        <DeliveryStatusBadge status={delivery.status} />
      </div>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t.deliveries.itemsLabel}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.deliveries.epiColumn}</TableHead>
                <TableHead>{t.epis.caLabel}</TableHead>
                <TableHead>{t.epis.manufacturerLabel}</TableHead>
                <TableHead>{t.epis.modelLabel}</TableHead>
                <TableHead>{t.deliveries.quantityColumnAbbr}</TableHead>
                <TableHead>{t.deliveries.unitColumnAbbr}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.epiName}</TableCell>
                  <TableCell className="font-mono text-xs">{item.caNumber}</TableCell>
                  <TableCell>{item.manufacturer ?? "—"}</TableCell>
                  <TableCell>{item.model ?? "—"}</TableCell>
                  <TableCell>{item.quantity}</TableCell>
                  <TableCell>{UNIT_LABEL[item.unit] ?? item.unit}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {delivery.note ? (
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle>{t.common.note}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{delivery.note}</p>
          </CardContent>
        </Card>
      ) : null}

      {delivery.status === "CANCELLED" && delivery.cancelReason ? (
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle>{t.deliveries.cancelReasonTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{delivery.cancelReason}</p>
          </CardContent>
        </Card>
      ) : null}

      {delivery.status === "ISSUED" || delivery.status === "CONTESTED" ? (
        <ConfirmationLinkPanel deliveryId={delivery.id} hasLiveLink={hasLiveConfirmationLink} />
      ) : null}

      <ConfirmationStatusPanel requests={confirmationRequests} />

      {delivery.status === "CONFIRMED" && evidence ? <EvidencePanel evidence={evidence} /> : null}

      <ContestPanel deliveryId={delivery.id} contests={contests} />

      <AuditTimeline events={auditEvents} />

      <DeliveryActions deliveryId={delivery.id} status={delivery.status} />
    </main>
  );
}
