import Link from "next/link";
import { redirect } from "next/navigation";
import { Truck } from "lucide-react";
import {
  verifySession,
  getMyCompanies,
  getDeliveries,
  getDeliveryBatches,
  getCompanyDeliveryItems,
  summarizeDeliveryItems,
  type Delivery,
  type DeliveryBatch,
  type DeliveryItemSummary,
  type DeliveryStatus,
} from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeliveryStatusBadge } from "@/components/delivery-status-badge";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelFooter } from "@/components/panel";
import { SearchField } from "@/components/search-field";
import { StatusFilterPills, type PillTone, type StatusFilterOption } from "@/components/status-filter-pills";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";

/** The statuses that get their own pill, in the order the mockup shows them:
 * what is stuck first, what is settled last. */
const FILTERED_STATUSES: DeliveryStatus[] = ["ISSUED", "CONFIRMED", "CONTESTED", "CANCELLED"];

export default async function DeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; status?: string; q?: string }>;
}) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const companies = await getMyCompanies();
  if (companies.length === 0) {
    redirect("/dashboard");
  }

  const { company: companyParam, status, q } = await searchParams;
  const activeCompany = companies.find((c) => c.id === companyParam) ?? companies[0]!;

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        kicker={activeCompany.legalName}
        title={t.deliveries.title}
        actions={
          <>
            <Button asChild variant="outline" size="lg">
              <Link href={`/deliveries/batch/new?company=${activeCompany.id}`}>{t.deliveries.newBatch}</Link>
            </Button>
            <Button asChild size="lg">
              <Link href={`/deliveries/new?company=${activeCompany.id}`}>{t.deliveries.newDelivery}</Link>
            </Button>
          </>
        }
      />

      <DeliveryList companyId={activeCompany.id} status={status} q={q} t={t} />
    </main>
  );
}

/** The pills name the *set* they select ("Aguardando 18"), not the badge on one row
 * ("Emitida") -- the mockup's wording, and it reads as a filter rather than a status. */
function filterLabel(t: Dict, status: DeliveryStatus): string {
  const map: Partial<Record<DeliveryStatus, string>> = {
    ISSUED: t.deliveries.filterAwaiting,
    CONFIRMED: t.deliveries.filterConfirmed,
    CONTESTED: t.deliveries.filterContested,
    CANCELLED: t.deliveries.filterCancelled,
  };
  return map[status] ?? status;
}

/**
 * One row per delivery, implemented from the mockup (screen 4c): search and the
 * counted status pills above a single table, and every row ending in the one verb
 * that state actually affords -- issue a draft, resend a link nobody answered,
 * resolve a dispute, open the sealed receipt.
 */
async function DeliveryList({
  companyId,
  status,
  q,
  t,
}: {
  companyId: string;
  status?: string;
  q?: string;
  t: Dict;
}) {
  const [deliveries, items, batches] = await Promise.all([
    getDeliveries(companyId),
    getCompanyDeliveryItems(companyId),
    getDeliveryBatches(companyId),
  ]);

  if (deliveries.length === 0) {
    return (
      <Panel>
        <EmptyState icon={Truck} message={t.deliveries.noDeliveriesYet} />
      </Panel>
    );
  }

  const itemsByDelivery = summarizeDeliveryItems(items);
  const batchesById = new Map(batches.map((batch) => [batch.id, batch]));

  const activeStatus = FILTERED_STATUSES.find((s) => s === status);
  const pillTone: Partial<Record<DeliveryStatus, PillTone>> = {
    ISSUED: "primary",
    CONFIRMED: "success",
    CONTESTED: "destructive",
  };
  const options: StatusFilterOption[] = [
    { label: t.deliveries.filterAll, count: deliveries.length },
    ...FILTERED_STATUSES.map((s) => ({
      value: s,
      label: filterLabel(t, s),
      count: deliveries.filter((d) => d.status === s).length,
      tone: pillTone[s],
    })),
  ];

  const needle = q?.trim().toLowerCase();
  const shown = deliveries
    .filter((d) => (activeStatus ? d.status === activeStatus : true))
    .filter((d) => {
      if (!needle) return true;
      if (d.employeeFullName.toLowerCase().includes(needle)) return true;
      return items.some((item) => item.deliveryId === d.id && item.caNumber.toLowerCase().includes(needle));
    });

  const kept = { company: companyId, ...(q ? { q } : {}) };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          basePath="/deliveries"
          params={{ company: companyId, ...(activeStatus ? { status: activeStatus } : {}) }}
          placeholder={t.deliveries.searchPlaceholder}
          defaultValue={q}
          className="w-full max-w-90 sm:w-90"
        />
        <StatusFilterPills options={options} active={activeStatus} basePath="/deliveries" params={kept} />
      </div>

      {shown.length === 0 ? (
        <Panel>
          <EmptyState icon={Truck} message={t.common.noResults} />
        </Panel>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.deliveries.employeeColumn}</TableHead>
                <TableHead>{t.common.date}</TableHead>
                <TableHead>{t.deliveries.itemsLabel}</TableHead>
                <TableHead>{t.deliveries.batchColumn}</TableHead>
                <TableHead>{t.deliveries.confirmationColumn}</TableHead>
                <TableHead>{t.common.status}</TableHead>
                <TableHead className="text-right">{t.common.action}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((delivery) => (
                <DeliveryRow
                  key={delivery.id}
                  delivery={delivery}
                  items={itemsByDelivery.get(delivery.id)}
                  batch={delivery.batchId ? batchesById.get(delivery.batchId) : undefined}
                  t={t}
                />
              ))}
            </TableBody>
          </Table>

          <PanelFooter>
            <p>
              {t.employees.showingCount} {shown.length} {t.employees.ofCount} {deliveries.length}{" "}
              {t.companies.deliveriesUnit}
            </p>
          </PanelFooter>
        </Panel>
      )}
    </>
  );
}

/** Whole days between `iso` and now, or null when there is no timestamp to count from. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86_400_000);
}

/** "4 h", "26 min", "3 d" -- the mockup's own way of saying how long a confirmation took. */
function formatSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/**
 * The mockup's "confirmação" column: a sentence about where this delivery stands with
 * the person who has to answer it, not a second copy of the status. What is knowable
 * from the delivery row itself -- when it was issued, when it was answered -- is all it
 * claims; it never implies the link was opened, which lives on the confirmation request.
 */
function confirmationNote(delivery: Delivery, t: Dict): { text: string; emphasis: boolean } {
  if (delivery.status === "CONFIRMED" && delivery.issuedAt && delivery.confirmedAt) {
    const ms = new Date(delivery.confirmedAt).getTime() - new Date(delivery.issuedAt).getTime();
    return { text: `${t.deliveries.confirmedInPrefix} ${formatSpan(Math.max(0, ms))}`, emphasis: false };
  }
  if (delivery.status === "ISSUED") {
    const days = daysSince(delivery.issuedAt) ?? 0;
    return {
      text: `${t.deliveries.awaitingShort} · ${days} ${days === 1 ? t.deliveries.dayShort : t.deliveries.daysShort}`,
      emphasis: days >= 3,
    };
  }
  if (delivery.status === "CONTESTED") return { text: t.deliveries.contestedNote, emphasis: true };
  if (delivery.status === "DRAFT") return { text: t.deliveries.noLinkYet, emphasis: false };
  if (delivery.status === "SUPERSEDED") return { text: t.deliveries.supersededNote, emphasis: false };
  return { text: "—", emphasis: false };
}

/** The single verb each state affords, from the mockup's "ação" column. */
function rowAction(delivery: Delivery, t: Dict): string {
  if (delivery.status === "CONFIRMED") return t.deliveries.receiptAction;
  if (delivery.status === "ISSUED") return t.deliveries.resendAction;
  if (delivery.status === "CONTESTED") return t.deliveries.resolveAction;
  if (delivery.status === "DRAFT") return t.deliveries.issue;
  return t.common.view;
}

function DeliveryRow({
  delivery,
  items,
  batch,
  t,
}: {
  delivery: Delivery;
  items: DeliveryItemSummary | undefined;
  batch: DeliveryBatch | undefined;
  t: Dict;
}) {
  const note = confirmationNote(delivery, t);
  const batchDate = batch ? new Date(`${batch.deliveryDate}T00:00:00`) : null;

  return (
    <TableRow>
      <TableCell className="font-bold">
        <Link href={`/deliveries/${delivery.id}`} className="underline-offset-4 hover:underline">
          {delivery.employeeFullName}
        </Link>
      </TableCell>
      <TableCell className="tabular-nums">
        {new Date(`${delivery.deliveryDate}T00:00:00`).toLocaleDateString("pt-BR")}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {items ? `${items.lines} ${items.lines === 1 ? t.deliveries.itemSingular : t.deliveries.itemPlural} · ${items.units} ${t.deliveries.unitsShort}` : "—"}
      </TableCell>
      <TableCell className="font-mono text-[12px] text-muted-foreground">
        {batchDate
          ? `${batchDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}${batch?.note?.trim() ? ` ${batch.note.trim()}` : ""}`
          : "—"}
      </TableCell>
      <TableCell className={note.emphasis ? "font-bold text-primary-deep" : "text-muted-foreground"}>
        {note.text}
      </TableCell>
      <TableCell>
        <DeliveryStatusBadge status={delivery.status} />
      </TableCell>
      <TableCell className="text-right">
        <Link
          href={`/deliveries/${delivery.id}`}
          className="font-bold text-primary-deep underline-offset-4 hover:underline"
        >
          {rowAction(delivery, t)}
        </Link>
      </TableCell>
    </TableRow>
  );
}
