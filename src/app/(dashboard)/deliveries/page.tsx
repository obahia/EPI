import Link from "next/link";
import { redirect } from "next/navigation";
import { Truck } from "lucide-react";
import {
  verifySession,
  getMyCompanies,
  getDeliveriesPage,
  getDeliveryStatusCounts,
  getDeliveryBatches,
  getDeliveryItemsFor,
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
import { formatDayBr, formatDayMonthBr } from "@/lib/format/datetime";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";

/** The statuses that get their own pill, in the order the mockup shows them:
 * what is stuck first, what is settled last. */
const FILTERED_STATUSES: DeliveryStatus[] = ["ISSUED", "CONFIRMED", "CONTESTED", "CANCELLED"];

/** Rows per page. The mockup's footer ("Mostrando 7 de 142") and its Anterior/Próxima
 * controls only mean anything against a real window. */
const PAGE_SIZE = 25;

export default async function DeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; status?: string; q?: string; page?: string }>;
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

  const { company: companyParam, status, q, page } = await searchParams;
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

      <DeliveryList companyId={activeCompany.id} status={status} q={q} page={page} t={t} />
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
 *
 * Filtering, counting and paging all happen in Postgres. Only the rows on screen, the
 * items belonging to them, and six counts ever cross the wire.
 */
async function DeliveryList({
  companyId,
  status,
  q,
  page,
  t,
}: {
  companyId: string;
  status?: string;
  q?: string;
  page?: string;
  t: Dict;
}) {
  const activeStatus = FILTERED_STATUSES.find((s) => s === status);
  const pageIndex = Math.max(0, (Number.parseInt(page ?? "1", 10) || 1) - 1);

  const [{ rows, total }, counts, batches] = await Promise.all([
    getDeliveriesPage(companyId, {
      status: activeStatus,
      q,
      limit: PAGE_SIZE,
      offset: pageIndex * PAGE_SIZE,
    }),
    getDeliveryStatusCounts(companyId),
    getDeliveryBatches(companyId),
  ]);

  if (counts.total === 0) {
    return (
      <Panel>
        <EmptyState icon={Truck} message={t.deliveries.noDeliveriesYet} />
      </Panel>
    );
  }

  const items = await getDeliveryItemsFor(rows.map((d) => d.id));
  const itemsByDelivery = summarizeDeliveryItems(items);
  const batchesById = new Map(batches.map((batch) => [batch.id, batch]));

  const pillTone: Partial<Record<DeliveryStatus, PillTone>> = {
    ISSUED: "primary",
    CONFIRMED: "success",
    CONTESTED: "destructive",
  };
  const options: StatusFilterOption[] = [
    { label: t.deliveries.filterAll, count: counts.total },
    ...FILTERED_STATUSES.map((s) => ({
      value: s,
      label: filterLabel(t, s),
      count: counts.byStatus[s],
      tone: pillTone[s],
    })),
  ];

  const kept = { company: companyId, ...(q ? { q } : {}) };
  const firstShown = total === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const lastShown = Math.min(total, (pageIndex + 1) * PAGE_SIZE);

  function pageHref(target: number): string {
    const search = new URLSearchParams({ company: companyId });
    if (activeStatus) search.set("status", activeStatus);
    if (q) search.set("q", q);
    if (target > 0) search.set("page", String(target + 1));
    return `/deliveries?${search.toString()}`;
  }

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

      {rows.length === 0 ? (
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
              {rows.map((delivery) => (
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
              {t.employees.showingCount} {firstShown}–{lastShown} {t.employees.ofCount} {total}{" "}
              {t.companies.deliveriesUnit}
            </p>
            <div className="flex items-center gap-2">
              <PageLink href={pageHref(pageIndex - 1)} disabled={pageIndex === 0}>
                {t.common.previous}
              </PageLink>
              <PageLink href={pageHref(pageIndex + 1)} disabled={lastShown >= total} emphasis>
                {t.common.next}
              </PageLink>
            </div>
          </PanelFooter>
        </Panel>
      )}
    </>
  );
}

/** A disabled pager control stays visible but stops being a link -- the mockup shows both
 * controls at all times, and a link that silently goes nowhere is worse than a dead one. */
function PageLink({
  href,
  disabled,
  emphasis = false,
  children,
}: {
  href: string;
  disabled: boolean;
  emphasis?: boolean;
  children: React.ReactNode;
}) {
  const base = "inline-flex h-8.5 items-center rounded-full px-4 text-[13px] font-bold";
  if (disabled) {
    return <span className={`${base} text-muted-foreground/50`}>{children}</span>;
  }
  return (
    <Link
      href={href}
      className={
        emphasis
          ? `${base} bg-foreground text-background transition-colors hover:bg-foreground/85`
          : `${base} text-foreground transition-colors hover:bg-foreground/6`
      }
    >
      {children}
    </Link>
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

  return (
    <TableRow>
      <TableCell className="font-bold">
        <Link href={`/deliveries/${delivery.id}`} className="underline-offset-4 hover:underline">
          {delivery.employeeFullName}
        </Link>
      </TableCell>
      <TableCell className="tabular-nums">{formatDayBr(delivery.deliveryDate)}</TableCell>
      <TableCell className="text-muted-foreground">
        {items
          ? `${items.lines} ${items.lines === 1 ? t.deliveries.itemSingular : t.deliveries.itemPlural} · ${items.units} ${t.deliveries.unitsShort}`
          : "—"}
      </TableCell>
      <TableCell className="font-mono text-[12px] text-muted-foreground">
        {batch
          ? `${formatDayMonthBr(batch.deliveryDate)}${batch.note?.trim() ? ` ${batch.note.trim()}` : ""}`
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
