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
import { DeliveryActions } from "./delivery-actions";
import { ConfirmationLinkPanel } from "./confirmation-link-panel";
import { ConfirmationStatusPanel } from "./confirmation-status-panel";
import { ContestPanel } from "./contest-panel";
import { AuditTimeline } from "./audit-timeline";
import { EvidencePanel } from "./evidence-panel";
import { LIVE_CONFIRMATION_STATUSES } from "./labels";

const UNIT_LABEL: Record<string, string> = {
  UN: "Unidade",
  PAR: "Par",
  CX: "Caixa",
  M: "Metro",
  KG: "Quilo",
};

export default async function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

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
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{delivery.employeeFullName}</h1>
          <p className="text-sm text-muted-foreground">
            {new Date(`${delivery.deliveryDate}T00:00:00`).toLocaleDateString("pt-BR")}
          </p>
        </div>
        <DeliveryStatusBadge status={delivery.status} />
      </div>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Itens</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>EPI</TableHead>
                <TableHead>CA</TableHead>
                <TableHead>Fabricante</TableHead>
                <TableHead>Modelo</TableHead>
                <TableHead>Qtd.</TableHead>
                <TableHead>Un.</TableHead>
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
            <CardTitle>Observação</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{delivery.note}</p>
          </CardContent>
        </Card>
      ) : null}

      {delivery.status === "CANCELLED" && delivery.cancelReason ? (
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle>Motivo do cancelamento</CardTitle>
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
