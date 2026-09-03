import Link from "next/link";
import { redirect } from "next/navigation";
import { Briefcase } from "lucide-react";
import { verifySession, getMyCompanies, getJobPositions, type JobPosition } from "@/lib/supabase/dal";
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

/** Same filter shape as epis/page.tsx: ACTIVE/INACTIVE ask about status, ORG asks where
 * the entry lives. */
const FILTERS = ["ACTIVE", "INACTIVE", "ORG"] as const;
type PositionFilter = (typeof FILTERS)[number];

const MATCHES: Record<PositionFilter, (position: JobPosition) => boolean> = {
  ACTIVE: (position) => position.status === "ACTIVE",
  INACTIVE: (position) => position.status === "INACTIVE",
  ORG: (position) => position.companyId === null,
};

export default async function PositionsPage({
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
  const positions = await getJobPositions(activeCompany.id);

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        kicker={`${activeCompany.legalName} · ${positions.length} ${t.positions.itemsUnit}`}
        title={t.positions.catalogTitle}
        actions={
          <Button asChild size="lg">
            <Link href={`/positions/new?company=${activeCompany.id}`}>{t.positions.newPosition}</Link>
          </Button>
        }
      />

      <PositionCatalog companyId={activeCompany.id} positions={positions} filter={statusParam} q={q} t={t} />
    </main>
  );
}

function PositionCatalog({
  companyId,
  positions,
  filter,
  q,
  t,
}: {
  companyId: string;
  positions: JobPosition[];
  filter?: string;
  q?: string;
  t: Dict;
}) {
  if (positions.length === 0) {
    return (
      <Panel>
        <EmptyState icon={Briefcase} message={t.positions.noPositionsYet} />
      </Panel>
    );
  }

  const active = FILTERS.find((f) => f === filter);
  const label: Record<PositionFilter, string> = {
    ACTIVE: t.positions.statusActive,
    INACTIVE: t.positions.statusInactive,
    ORG: t.positions.fromOrganization,
  };
  const options: StatusFilterOption[] = [
    { label: t.positions.filterAll, count: positions.length },
    ...FILTERS.map((f) => ({
      value: f,
      label: label[f],
      count: positions.filter(MATCHES[f]).length,
      tone: f === "ACTIVE" ? ("success" as const) : undefined,
    })),
  ];

  const needle = q?.trim().toLowerCase();
  const shown = positions
    .filter((position) => (active ? MATCHES[active](position) : true))
    .filter((position) => (needle ? position.title.toLowerCase().includes(needle) : true));

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          basePath="/positions"
          params={{ company: companyId, ...(active ? { status: active } : {}) }}
          placeholder={t.positions.searchPlaceholder}
          defaultValue={q}
          className="w-full max-w-90 sm:w-90"
        />
        <StatusFilterPills
          options={options}
          active={active}
          basePath="/positions"
          params={{ company: companyId, ...(q ? { q } : {}) }}
        />
      </div>

      {shown.length === 0 ? (
        <Panel>
          <EmptyState icon={Briefcase} message={t.common.noResults} />
        </Panel>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.positions.titleColumn}</TableHead>
                <TableHead>{t.positions.descriptionColumn}</TableHead>
                <TableHead>{t.positions.originColumn}</TableHead>
                <TableHead>{t.common.status}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((position) => (
                <PositionRow key={position.id} position={position} companyId={companyId} t={t} />
              ))}
            </TableBody>
          </Table>

          <PanelFooter>
            <p>
              {t.employees.showingCount} {shown.length} {t.employees.ofCount} {positions.length}{" "}
              {t.positions.itemsUnit}
            </p>
          </PanelFooter>
        </Panel>
      )}
    </>
  );
}

function PositionRow({ position, companyId, t }: { position: JobPosition; companyId: string; t: Dict }) {
  return (
    <TableRow>
      <TableCell className="font-bold">
        <Link href={`/positions/${position.id}?company=${companyId}`} className="underline-offset-4 hover:underline">
          {position.title}
        </Link>
      </TableCell>
      <TableCell className="max-w-xs truncate text-muted-foreground">{position.description ?? "—"}</TableCell>
      <TableCell className="text-muted-foreground">
        {position.companyId === null ? t.positions.originOrg : t.positions.originCompany}
      </TableCell>
      <TableCell>
        {position.status === "ACTIVE" ? (
          <Badge variant="outline" className="border-transparent bg-success-soft text-success">
            {t.positions.statusActive}
          </Badge>
        ) : (
          <Badge variant="ghost" className="text-muted-foreground">
            {t.positions.statusInactive}
          </Badge>
        )}
      </TableCell>
    </TableRow>
  );
}
