import Link from "next/link";
import { redirect } from "next/navigation";
import { Package } from "lucide-react";
import {
  verifySession,
  getMyCompanies,
  getLocations,
  getEpis,
  getStockBalances,
  getOrganizationPolicy,
  type StockBalance,
} from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelKicker } from "@/components/panel";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";
import { StockFilters } from "./stock-filters";

/** Balances at or under this quantity get the destructive-red treatment inline, same
 * threshold as the "Estoque baixo" dashboard card (companies/[id]/dashboard/page.tsx) --
 * a fixed v1 value, not a per-EPI configurable one (see that card's own comment). */
const LOW_STOCK_THRESHOLD = 5;

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; location?: string; epi?: string }>;
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

  const { company: companyParam, location: locationParam, epi: epiParam } = await searchParams;
  const activeCompany = companies.find((c) => c.id === companyParam) ?? companies[0]!;

  const [policy, locations, epis] = await Promise.all([
    getOrganizationPolicy(activeCompany.organizationId),
    getLocations(activeCompany.id),
    getEpis(activeCompany.id),
  ]);

  const inventoryEnabled = policy?.inventoryEnabled ?? false;
  const locationId = locationParam && locations.some((l) => l.id === locationParam) ? locationParam : undefined;
  const epiId = epiParam && epis.some((e) => e.id === epiParam) ? epiParam : undefined;

  const balances = await getStockBalances(activeCompany.id, { locationId, epiId });
  const locationsById = new Map(locations.map((l) => [l.id, l]));

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        kicker={activeCompany.legalName}
        title={t.stock.title}
        actions={
          <>
            <Button asChild variant="outline" size="lg">
              <Link href={`/stock/movements?company=${activeCompany.id}`}>{t.stock.viewMovements}</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href={`/stock/transfer?company=${activeCompany.id}`}>{t.stock.newTransfer}</Link>
            </Button>
            <Button asChild size="lg">
              <Link href={`/stock/entrada?company=${activeCompany.id}`}>{t.stock.newEntry}</Link>
            </Button>
          </>
        }
      />

      {!inventoryEnabled ? (
        <Panel tone="warning">
          <PanelKicker className="text-warning">{t.stock.title}</PanelKicker>
          <p className="mt-2 text-[13.5px]">{t.stock.inventoryDisabledNote}</p>
        </Panel>
      ) : null}

      <StockFilters
        basePath="/stock"
        companyId={activeCompany.id}
        locations={locations}
        epis={epis}
        activeLocationId={locationId}
        activeEpiId={epiId}
        t={t}
      />

      {balances.length === 0 ? (
        <Panel>
          <EmptyState
            icon={Package}
            message={locationId || epiId ? t.stock.noResultsForFilter : t.stock.noBalancesYet}
          />
        </Panel>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.stock.epiColumn}</TableHead>
                <TableHead>{t.stock.caColumn}</TableHead>
                <TableHead>{t.stock.variantColumn}</TableHead>
                <TableHead>{t.stock.locationColumn}</TableHead>
                <TableHead className="text-right">{t.stock.quantityColumn}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {balances.map((balance) => (
                <BalanceRow
                  key={`${balance.locationId ?? "none"}-${balance.epiId}-${balance.variantId ?? "none"}`}
                  balance={balance}
                  locationName={balance.locationId ? locationsById.get(balance.locationId)?.name : undefined}
                  t={t}
                />
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </main>
  );
}

function BalanceRow({
  balance,
  locationName,
  t,
}: {
  balance: StockBalance;
  locationName: string | undefined;
  t: Dict;
}) {
  const low = balance.quantity <= LOW_STOCK_THRESHOLD;

  return (
    <TableRow>
      <TableCell className="font-bold">{balance.epiName}</TableCell>
      <TableCell className="text-muted-foreground">{balance.caNumber}</TableCell>
      <TableCell className="text-muted-foreground">{balance.variantLabel ?? "—"}</TableCell>
      <TableCell className="text-muted-foreground">{locationName ?? t.stock.companyWideOption}</TableCell>
      <TableCell className={`text-right tabular-nums ${low ? "font-bold text-destructive" : ""}`}>
        {balance.quantity}
      </TableCell>
    </TableRow>
  );
}
