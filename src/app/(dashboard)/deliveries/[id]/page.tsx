import { notFound, redirect } from "next/navigation";
import {
  verifySession,
  getCompany,
  getDelivery,
  getDeliveryItems,
  getConfirmationRequests,
  getDeliveryContests,
  getDeliveryAuditEvents,
  getEvidenceSummary,
  getDeliveryBatches,
  getReturnsForItems,
  getEpis,
  getEpiVariants,
  type EpiVariant,
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
import { ReturnItemForm } from "./return-item-form";
import { ReplaceDeliveryForm } from "./replace-delivery-form";
import { LIVE_CONFIRMATION_STATUSES, epiReturnReasonLabel } from "./labels";
import { formatDateTimeBr, formatDayBr } from "@/lib/format/datetime";

/** Whole days since a delivery was confirmed -- the impure Date.now() call lives in its own
 * named helper rather than inline in the component body, same convention as
 * needs-attention.tsx's own daysWaiting(). */
function daysSinceConfirmed(confirmedAt: string): number {
  const ms = Date.now() - new Date(confirmedAt).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 86_400_000) : 0;
}

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

  // "Trocar EPI" (api.create_replacement_delivery) only accepts a CONFIRMED/CONTESTED
  // original -- gates both the button below and the extra catalog fetch it needs, so a
  // DRAFT/ISSUED/CANCELLED/SUPERSEDED delivery never pays for epis/variants it can't use.
  const canReplace = delivery.status === "CONFIRMED" || delivery.status === "CONTESTED";

  // The mockup's subtitle names the batch the delivery came out of; a one-off delivery
  // has no batch and simply drops that clause. company is only knowable once delivery
  // (and so delivery.companyId) has resolved, so it comes after the Promise.all above
  // rather than inside it -- fetched alongside the batch lookup, in parallel with that.
  const [batches, company, returns, epis] = await Promise.all([
    delivery.batchId ? getDeliveryBatches(delivery.companyId) : Promise.resolve([]),
    getCompany(delivery.companyId),
    getReturnsForItems(items.map((item) => item.id)),
    canReplace ? getEpis(delivery.companyId) : Promise.resolve([]),
  ]);
  const batch = batches.find((b) => b.id === delivery.batchId) ?? null;
  const timeZone = company?.timeZone;
  const returnByItemId = new Map(returns.map((r) => [r.deliveryItemId, r]));

  // Same "one getEpiVariants call per active EPI" pattern as deliveries/new/page.tsx.
  const activeEpis = canReplace ? epis.filter((e) => e.isActive) : [];
  const variantLists = canReplace ? await Promise.all(activeEpis.map((epi) => getEpiVariants(epi.id))) : [];
  const variantsByEpi: Record<string, EpiVariant[]> = {};
  activeEpis.forEach((epi, i) => {
    const list = variantLists[i] ?? [];
    if (list.length > 0) variantsByEpi[epi.id] = list;
  });

  // Precomputed from the ORIGINAL delivery's own items, matching api.create_replacement_
  // delivery's own v_earliest_due logic exactly (min(confirmed_at + lifespan_days) across
  // items that track a lifespan at all): same confirmed_at for every item on one delivery,
  // so the earliest due date is simply whichever item has the smallest lifespan_days.
  const trackedItems = items.filter(
    (item): item is typeof item & { lifespanDays: number } => item.lifespanDays != null,
  );
  const earliestTrackedItem =
    trackedItems.length > 0
      ? trackedItems.reduce((a, b) => (a.lifespanDays < b.lifespanDays ? a : b))
      : null;
  const earlyWarning =
    earliestTrackedItem && delivery.confirmedAt
      ? {
          daysSinceConfirmed: daysSinceConfirmed(delivery.confirmedAt),
          lifespanDays: earliestTrackedItem.lifespanDays,
        }
      : null;

  const hasLiveConfirmationLink = confirmationRequests[0]
    ? LIVE_CONFIRMATION_STATUSES.has(confirmationRequests[0].status)
    : false;

  const subtitle = [
    `${t.deliveries.deliveryOfPrefix} ${formatDayBr(delivery.deliveryDate)}`,
    batch
      ? `${t.deliveries.batchColumn.toLowerCase()} ${formatDayBr(batch.deliveryDate)}${batch.note?.trim() ? ` ${batch.note.trim()}` : ""}`
      : null,
    delivery.issuedAt ? `${t.deliveries.issuedOn} ${formatDateTimeBr(delivery.issuedAt, timeZone)}` : null,
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
        actions={
          <>
            <DeliveryActions deliveryId={delivery.id} status={delivery.status} />
            {canReplace ? (
              <ReplaceDeliveryForm
                originalDeliveryId={delivery.id}
                epis={activeEpis}
                variantsByEpi={variantsByEpi}
                earlyWarning={earlyWarning}
              />
            ) : null}
          </>
        }
      />

      {delivery.status === "CONFIRMED" && evidence ? (
        <SealedReceipt delivery={delivery} evidence={evidence} timeZone={timeZone} t={t} />
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
                    {delivery.status === "CONFIRMED" ? (
                      <TableHead className="text-right">{t.deliveries.returnColumn}</TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const itemReturn = returnByItemId.get(item.id);
                    return (
                      <TableRow key={item.id}>
                        <TableCell className="font-bold">{item.epiName}</TableCell>
                        <TableCell className="font-mono text-[12.5px]">{item.caNumber}</TableCell>
                        <TableCell className="text-muted-foreground">{item.manufacturer ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{item.model ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                        <TableCell className="text-muted-foreground">{UNIT_LABEL[item.unit] ?? item.unit}</TableCell>
                        {delivery.status === "CONFIRMED" ? (
                          <TableCell className="text-right">
                            {itemReturn ? (
                              <span className="text-[12.5px] text-muted-foreground">
                                {t.deliveries.returnedOnPrefix} {formatDayBr(itemReturn.returnedOn)} ·{" "}
                                {epiReturnReasonLabel(t)[itemReturn.reasonCode]}
                              </span>
                            ) : (
                              <ReturnItemForm deliveryId={delivery.id} deliveryItemId={item.id} />
                            )}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
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

          <ContestPanel deliveryId={delivery.id} contests={contests} timeZone={timeZone} />

          <AuditTimeline events={auditEvents} timeZone={timeZone} />
        </div>

        <div className="flex flex-col gap-4 xl:sticky xl:top-7.5 xl:w-84 xl:shrink-0">
          {delivery.status === "ISSUED" || delivery.status === "CONTESTED" ? (
            <ConfirmationLinkPanel
              deliveryId={delivery.id}
              hasLiveLink={hasLiveConfirmationLink}
              timeZone={timeZone}
            />
          ) : null}

          <ConfirmationStatusPanel requests={confirmationRequests} timeZone={timeZone} />
        </div>
      </div>
    </main>
  );
}
