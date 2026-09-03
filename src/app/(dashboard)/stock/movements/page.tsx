import { redirect } from "next/navigation";
import { History } from "lucide-react";
import {
  verifySession,
  getMyCompanies,
  getLocations,
  getEpis,
  getEpiVariants,
  getStockMovements,
  type StockMovement,
  type StockMovementType,
} from "@/lib/supabase/dal";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelFooter } from "@/components/panel";
import { formatShortDateTimeBr } from "@/lib/format/datetime";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";
import { StockFilters } from "../stock-filters";

/** Capped, never a full-table read of an append-only ledger -- same rationale as
 * getStockMovements' own comment (mirroring getDeliveriesPage's). */
const MOVEMENTS_LIMIT = 100;

export default async function StockMovementsPage({
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

  const [locations, epis] = await Promise.all([getLocations(activeCompany.id), getEpis(activeCompany.id)]);

  const locationId = locationParam && locations.some((l) => l.id === locationParam) ? locationParam : undefined;
  const epiId = epiParam && epis.some((e) => e.id === epiParam) ? epiParam : undefined;

  const [movements, variantLists] = await Promise.all([
    getStockMovements(activeCompany.id, { locationId, epiId, limit: MOVEMENTS_LIMIT }),
    Promise.all(epis.map((epi) => getEpiVariants(epi.id))),
  ]);

  const locationsById = new Map(locations.map((l) => [l.id, l]));
  const episById = new Map(epis.map((e) => [e.id, e]));
  const variantLabelById = new Map<string, string>();
  epis.forEach((epi, i) => {
    for (const variant of variantLists[i] ?? []) variantLabelById.set(variant.id, variant.label);
  });

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        back={{ href: `/stock?company=${activeCompany.id}`, label: t.stock.backToStock }}
        kicker={activeCompany.legalName}
        title={t.stock.movementsTitle}
      />

      <StockFilters
        basePath="/stock/movements"
        companyId={activeCompany.id}
        locations={locations}
        epis={epis}
        activeLocationId={locationId}
        activeEpiId={epiId}
        t={t}
      />

      {movements.length === 0 ? (
        <Panel>
          <EmptyState icon={History} message={t.stock.noMovementsYet} />
        </Panel>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.stock.dateColumn}</TableHead>
                <TableHead>{t.stock.movementTypeColumn}</TableHead>
                <TableHead>{t.stock.epiColumn}</TableHead>
                <TableHead>{t.stock.variantColumn}</TableHead>
                <TableHead>{t.stock.locationColumn}</TableHead>
                <TableHead className="text-right">{t.stock.quantityColumn}</TableHead>
                <TableHead>{t.stock.reasonColumn}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.map((movement) => (
                <MovementRow
                  key={movement.id}
                  movement={movement}
                  epiLabel={episById.get(movement.epiId)}
                  variantLabel={movement.variantId ? variantLabelById.get(movement.variantId) : undefined}
                  locationName={movement.locationId ? locationsById.get(movement.locationId)?.name : undefined}
                  timeZone={activeCompany.timeZone}
                  t={t}
                />
              ))}
            </TableBody>
          </Table>

          <PanelFooter>
            <p>
              {movements.length >= MOVEMENTS_LIMIT
                ? `${t.employees.showingCount} ${MOVEMENTS_LIMIT} ${t.stock.movementsTitle.toLowerCase()}`
                : `${movements.length} ${t.stock.movementsTitle.toLowerCase()}`}
            </p>
          </PanelFooter>
        </Panel>
      )}
    </main>
  );
}

function movementTypeLabel(t: Dict, type: StockMovementType): string {
  const map: Record<StockMovementType, string> = {
    ENTRADA: t.stock.movementTypeEntradaLabel,
    AJUSTE: t.stock.movementTypeAjusteLabel,
    DESCARTE: t.stock.movementTypeDescarteLabel,
    ENTREGA: t.stock.movementTypeEntregaLabel,
    DEVOLUCAO: t.stock.movementTypeDevolucaoLabel,
    TRANSFERENCIA_SAIDA: t.stock.movementTypeTransferSaidaLabel,
    TRANSFERENCIA_ENTRADA: t.stock.movementTypeTransferEntradaLabel,
  };
  return map[type];
}

function MovementRow({
  movement,
  epiLabel,
  variantLabel,
  locationName,
  timeZone,
  t,
}: {
  movement: StockMovement;
  epiLabel: { name: string; caNumber: string } | undefined;
  variantLabel: string | undefined;
  locationName: string | undefined;
  timeZone: string | null;
  t: Dict;
}) {
  const positive = movement.quantity > 0;

  return (
    <TableRow>
      <TableCell className="text-muted-foreground tabular-nums">
        {formatShortDateTimeBr(movement.createdAt, timeZone)}
      </TableCell>
      <TableCell>{movementTypeLabel(t, movement.movementType)}</TableCell>
      <TableCell className="font-bold">
        {epiLabel ? `${epiLabel.name} — CA ${epiLabel.caNumber}` : "—"}
      </TableCell>
      <TableCell className="text-muted-foreground">{variantLabel ?? "—"}</TableCell>
      <TableCell className="text-muted-foreground">{locationName ?? t.stock.companyWideOption}</TableCell>
      <TableCell className={`text-right tabular-nums font-bold ${positive ? "text-success" : "text-destructive"}`}>
        {positive ? "+" : ""}
        {movement.quantity}
      </TableCell>
      <TableCell className="max-w-xs truncate text-muted-foreground">{movement.reason ?? "—"}</TableCell>
    </TableRow>
  );
}
