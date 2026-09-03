import Link from "next/link";
import { redirect } from "next/navigation";
import { Layers } from "lucide-react";
import { verifySession, getMyCompanies, getDeliveryBatches, type DeliveryBatch } from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelFooter, PanelKicker } from "@/components/panel";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";
import { formatDateTimeBr, formatDayBr } from "@/lib/format/datetime";

export default async function DeliveryBatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string }>;
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

  const { company: companyParam } = await searchParams;
  const activeCompany = companies.find((c) => c.id === companyParam) ?? companies[0]!;
  const batches = await getDeliveryBatches(activeCompany.id);

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        kicker={activeCompany.legalName}
        title={t.deliveries.batchesTitle}
        actions={
          <Button asChild size="lg">
            <Link href={`/deliveries/batch/new?company=${activeCompany.id}`}>{t.deliveries.newBatch}</Link>
          </Button>
        }
      />

      {batches.length === 0 ? (
        <Panel>
          <EmptyState icon={Layers} message={t.deliveries.noBatchesYet} />
        </Panel>
      ) : (
        <>
          <LatestBatch batch={batches[0]!} t={t} />
          <Panel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.deliveries.deliveryDateLabel}</TableHead>
                  <TableHead>{t.deliveries.createdAtColumn}</TableHead>
                  <TableHead className="text-right">{t.deliveries.totalColumn}</TableHead>
                  <TableHead className="text-right">{t.deliveries.confirmedColumn}</TableHead>
                  <TableHead className="text-right">{t.deliveries.contestedColumn}</TableHead>
                  <TableHead className="text-right">{t.deliveries.cancelledColumn}</TableHead>
                  <TableHead className="w-45">{t.deliveries.progressColumn}</TableHead>
                  <TableHead className="text-right">{t.common.action}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((batch) => (
                  <BatchRow key={batch.id} batch={batch} timeZone={activeCompany.timeZone} t={t} />
                ))}
              </TableBody>
            </Table>

            <PanelFooter>
              <p>{t.deliveries.batchesFootnote}</p>
            </PanelFooter>
          </Panel>
        </>
      )}
    </main>
  );
}

function pendingOf(batch: DeliveryBatch): number {
  return Math.max(0, batch.totalCount - batch.confirmedCount - batch.contestedCount - batch.cancelledCount);
}

/**
 * The newest batch as a terracotta banner, implemented from the mockup (screen 4h): a
 * batch is one act whose outcome arrives over the following days, so the most recent one
 * gets its running tally -- issued, confirmed, still waiting, disputed -- above the table
 * of everything before it, with the way into it on the same line.
 */
function LatestBatch({ batch, t }: { batch: DeliveryBatch; t: Dict }) {
  const pending = pendingOf(batch);

  return (
    <section className="rounded-3xl bg-primary px-7 py-6.5 text-primary-foreground">
      <div className="flex flex-col gap-6 xl:flex-row xl:items-center">
        <div className="xl:w-72 xl:shrink-0">
          <PanelKicker className="opacity-85">
            {t.deliveries.latestBatch} · {formatDayBr(batch.deliveryDate)}
            {batch.note?.trim() ? ` · ${batch.note.trim()}` : ""}
          </PanelKicker>
          <p className="mt-1 font-heading text-6xl leading-none font-extrabold tracking-tighter tabular-nums">
            {batch.totalCount}
          </p>
          <p className="mt-2 text-[13.5px] opacity-85">{t.deliveries.issuedAtOnce}</p>
        </div>

        <dl className="flex flex-1 flex-wrap gap-9">
          <HeroStat value={batch.confirmedCount} label={t.deliveries.confirmedColumn} />
          <HeroStat value={pending} label={t.deliveries.pendingColumn} />
          <HeroStat value={batch.contestedCount} label={t.deliveries.contestedColumn} />
        </dl>

        <Button asChild size="lg" variant="secondary" className="bg-background text-primary-deep hover:bg-background/85">
          <Link href={`/deliveries/batches/${batch.id}`}>{t.deliveries.openBatch}</Link>
        </Button>
      </div>
    </section>
  );
}

function HeroStat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <dd className="font-heading text-3xl font-extrabold tracking-tighter tabular-nums">{value}</dd>
      <dt className="text-[12.5px] lowercase opacity-85">{label}</dt>
    </div>
  );
}

function BatchRow({
  batch,
  timeZone,
  t,
}: {
  batch: DeliveryBatch;
  /** The company's own IANA zone (Company.timeZone) -- falls back to Brasília time in
   * formatDateTimeBr when null/undefined. */
  timeZone?: string | null;
  t: Dict;
}) {
  const settledPct =
    batch.totalCount > 0 ? Math.round((batch.confirmedCount / batch.totalCount) * 100) : 0;

  return (
    <TableRow>
      <TableCell className="font-bold tabular-nums">
        {formatDayBr(batch.deliveryDate)}
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        {formatDateTimeBr(batch.createdAt, timeZone)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{batch.totalCount}</TableCell>
      <TableCell className="text-right tabular-nums">{batch.confirmedCount}</TableCell>
      <TableCell className="text-right tabular-nums">{batch.contestedCount}</TableCell>
      <TableCell className="text-right tabular-nums">{batch.cancelledCount}</TableCell>
      <TableCell>
        <div
          className="h-2 overflow-hidden rounded-full bg-foreground/9"
          role="img"
          aria-label={`${settledPct}%`}
        >
          <div className="h-full bg-success" style={{ width: `${settledPct}%` }} />
        </div>
      </TableCell>
      <TableCell className="text-right">
        <Link
          href={`/deliveries/batches/${batch.id}`}
          className="font-bold text-primary-deep underline-offset-4 hover:underline"
        >
          {t.deliveries.openBatch}
        </Link>
      </TableCell>
    </TableRow>
  );
}
