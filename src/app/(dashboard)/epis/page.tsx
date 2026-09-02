import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { verifySession, getMyCompanies, getEpis, type Epi } from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelFooter } from "@/components/panel";
import { SearchField } from "@/components/search-field";
import { StatusFilterPills, type StatusFilterOption } from "@/components/status-filter-pills";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";
import { toggleEpiActive } from "./actions";

/** Catalog filters. Unlike deliveries/employees these are not one enum column:
 * "ORG" asks where the entry lives, the other two ask whether it can be issued. */
const FILTERS = ["ACTIVE", "INACTIVE", "ORG"] as const;
type EpiFilter = (typeof FILTERS)[number];

const MATCHES: Record<EpiFilter, (epi: Epi) => boolean> = {
  ACTIVE: (epi) => epi.isActive,
  INACTIVE: (epi) => !epi.isActive,
  ORG: (epi) => epi.companyId === null,
};

export default async function EpisPage({
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

  const { company: companyParam, status: statusParam, q } = await searchParams;
  const activeCompany = companies.find((c) => c.id === companyParam) ?? companies[0]!;
  const epis = await getEpis(activeCompany.id);

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        kicker={`${activeCompany.legalName} · ${epis.length} ${t.epis.itemsUnit}`}
        title={t.epis.catalogTitle}
        actions={
          <>
            <Button asChild variant="outline" size="lg">
              <Link href={`/epis/import?company=${activeCompany.id}`}>{t.epis.importCatalog}</Link>
            </Button>
            <Button asChild size="lg">
              <Link href={`/epis/new?company=${activeCompany.id}`}>{t.epis.newEpi}</Link>
            </Button>
          </>
        }
      />

      <EpiCatalog companyId={activeCompany.id} epis={epis} filter={statusParam} q={q} t={t} />
    </main>
  );
}

/**
 * The catalog as one table, implemented from the mockup (screen 4e). A CA number is
 * what a fiscalização asks for, so it keeps its mono treatment -- but in a column,
 * beside the manufacturer and model it has to be checked against, rather than on a
 * card of its own where the entries could not be compared down a line.
 */
function EpiCatalog({
  companyId,
  epis,
  filter,
  q,
  t,
}: {
  companyId: string;
  epis: Epi[];
  filter?: string;
  q?: string;
  t: Dict;
}) {
  if (epis.length === 0) {
    return (
      <Panel>
        <EmptyState icon={ShieldCheck} message={t.epis.noEpisYet} />
      </Panel>
    );
  }

  const active = FILTERS.find((f) => f === filter);
  const label: Record<EpiFilter, string> = {
    ACTIVE: t.epis.statusActive,
    INACTIVE: t.epis.statusInactive,
    ORG: t.epis.fromOrganization,
  };
  const options: StatusFilterOption[] = [
    { label: t.epis.filterAll, count: epis.length },
    ...FILTERS.map((f) => ({
      value: f,
      label: label[f],
      count: epis.filter(MATCHES[f]).length,
      tone: f === "ACTIVE" ? ("success" as const) : undefined,
    })),
  ];

  const needle = q?.trim().toLowerCase();
  const shown = epis
    .filter((epi) => (active ? MATCHES[active](epi) : true))
    .filter((epi) =>
      needle
        ? [epi.name, epi.caNumber, epi.manufacturer, epi.model]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(needle))
        : true,
    );

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          basePath="/epis"
          params={{ company: companyId, ...(active ? { status: active } : {}) }}
          placeholder={t.epis.searchPlaceholder}
          defaultValue={q}
          className="w-full max-w-90 sm:w-90"
        />
        <StatusFilterPills
          options={options}
          active={active}
          basePath="/epis"
          params={{ company: companyId, ...(q ? { q } : {}) }}
        />
      </div>

      {shown.length === 0 ? (
        <Panel>
          <EmptyState icon={ShieldCheck} message={t.common.noResults} />
        </Panel>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.common.name}</TableHead>
                <TableHead>{t.epis.caLabel}</TableHead>
                <TableHead>{t.epis.manufacturerLabel}</TableHead>
                <TableHead>{t.epis.modelLabel}</TableHead>
                <TableHead>{t.epis.unitColumn}</TableHead>
                <TableHead>{t.epis.originColumn}</TableHead>
                <TableHead>{t.common.status}</TableHead>
                <TableHead className="text-right">{t.common.action}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((epi) => (
                <EpiRow key={epi.id} epi={epi} companyId={companyId} t={t} />
              ))}
            </TableBody>
          </Table>

          <PanelFooter>
            <p>
              {t.employees.showingCount} {shown.length} {t.employees.ofCount} {epis.length} {t.epis.itemsUnit}
            </p>
          </PanelFooter>
        </Panel>
      )}
    </>
  );
}

function EpiRow({ epi, companyId, t }: { epi: Epi; companyId: string; t: Dict }) {
  const unitLabel: Record<string, string> = {
    UN: t.epis.unitUn,
    PAR: t.epis.unitPar,
    CX: t.epis.unitCx,
    M: t.epis.unitM,
    KG: t.epis.unitKg,
  };

  return (
    <TableRow>
      <TableCell className="font-bold">
        <Link href={`/epis/${epi.id}?company=${companyId}`} className="underline-offset-4 hover:underline">
          {epi.name}
        </Link>
      </TableCell>
      <TableCell className="font-mono text-[12.5px]">{epi.caNumber}</TableCell>
      <TableCell className="text-muted-foreground">{epi.manufacturer ?? "—"}</TableCell>
      <TableCell className="text-muted-foreground">{epi.model ?? "—"}</TableCell>
      <TableCell className="text-muted-foreground">{unitLabel[epi.defaultUnit] ?? epi.defaultUnit}</TableCell>
      <TableCell className="text-muted-foreground">
        {epi.companyId === null ? t.epis.originOrg : t.epis.originCompany}
      </TableCell>
      <TableCell>
        {epi.isActive ? (
          <Badge variant="outline" className="border-transparent bg-success-soft text-success">
            {t.epis.statusActive}
          </Badge>
        ) : (
          <Badge variant="ghost" className="text-muted-foreground">
            {t.epis.statusInactive}
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <form action={toggleEpiActive}>
          <input type="hidden" name="epiId" value={epi.id} />
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="isActive" value={(!epi.isActive).toString()} />
          <button
            type="submit"
            className="cursor-pointer text-[13.5px] font-bold text-primary-deep underline-offset-4 hover:underline"
          >
            {epi.isActive ? t.epis.deactivate : t.epis.activate}
          </button>
        </form>
      </TableCell>
    </TableRow>
  );
}
