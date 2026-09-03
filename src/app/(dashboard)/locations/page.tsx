import Link from "next/link";
import { redirect } from "next/navigation";
import { MapPin } from "lucide-react";
import { verifySession, getMyCompanies, getLocations, type Location } from "@/lib/supabase/dal";
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

/** Same filter shape as positions/page.tsx: ACTIVE/INACTIVE ask about status. */
const FILTERS = ["ACTIVE", "INACTIVE"] as const;
type LocationFilter = (typeof FILTERS)[number];

const MATCHES: Record<LocationFilter, (location: Location) => boolean> = {
  ACTIVE: (location) => location.status === "ACTIVE",
  INACTIVE: (location) => location.status === "INACTIVE",
};

export default async function LocationsPage({
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
  const locations = await getLocations(activeCompany.id);

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        kicker={`${activeCompany.legalName} · ${locations.length} ${t.locations.itemsUnit}`}
        title={t.locations.title}
        actions={
          <Button asChild size="lg">
            <Link href={`/locations/new?company=${activeCompany.id}`}>{t.locations.newLocation}</Link>
          </Button>
        }
      />

      <LocationList companyId={activeCompany.id} locations={locations} filter={statusParam} q={q} t={t} />
    </main>
  );
}

function LocationList({
  companyId,
  locations,
  filter,
  q,
  t,
}: {
  companyId: string;
  locations: Location[];
  filter?: string;
  q?: string;
  t: Dict;
}) {
  if (locations.length === 0) {
    return (
      <Panel>
        <EmptyState icon={MapPin} message={t.locations.noLocationsYet} />
      </Panel>
    );
  }

  const active = FILTERS.find((f) => f === filter);
  const label: Record<LocationFilter, string> = {
    ACTIVE: t.locations.statusActive,
    INACTIVE: t.locations.statusInactive,
  };
  const options: StatusFilterOption[] = [
    { label: t.locations.filterAll, count: locations.length },
    ...FILTERS.map((f) => ({
      value: f,
      label: label[f],
      count: locations.filter(MATCHES[f]).length,
      tone: f === "ACTIVE" ? ("success" as const) : undefined,
    })),
  ];

  const needle = q?.trim().toLowerCase();
  const shown = locations
    .filter((location) => (active ? MATCHES[active](location) : true))
    .filter((location) => (needle ? location.name.toLowerCase().includes(needle) : true));

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          basePath="/locations"
          params={{ company: companyId, ...(active ? { status: active } : {}) }}
          placeholder={t.common.searchPlaceholder}
          defaultValue={q}
          className="w-full max-w-90 sm:w-90"
        />
        <StatusFilterPills
          options={options}
          active={active}
          basePath="/locations"
          params={{ company: companyId, ...(q ? { q } : {}) }}
        />
      </div>

      {shown.length === 0 ? (
        <Panel>
          <EmptyState icon={MapPin} message={t.common.noResults} />
        </Panel>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.locations.nameColumn}</TableHead>
                <TableHead>{t.locations.codeColumn}</TableHead>
                <TableHead>{t.locations.cityColumn}</TableHead>
                <TableHead>{t.common.status}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((location) => (
                <LocationRow key={location.id} location={location} companyId={companyId} t={t} />
              ))}
            </TableBody>
          </Table>

          <PanelFooter>
            <p>
              {t.employees.showingCount} {shown.length} {t.employees.ofCount} {locations.length}{" "}
              {t.locations.itemsUnit}
            </p>
          </PanelFooter>
        </Panel>
      )}
    </>
  );
}

function LocationRow({ location, companyId, t }: { location: Location; companyId: string; t: Dict }) {
  const city = typeof location.address?.city === "string" ? (location.address.city as string) : null;

  return (
    <TableRow>
      <TableCell className="font-bold">
        <Link href={`/locations/${location.id}?company=${companyId}`} className="underline-offset-4 hover:underline">
          {location.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{location.code ?? "—"}</TableCell>
      <TableCell className="text-muted-foreground">{city ?? "—"}</TableCell>
      <TableCell>
        {location.status === "ACTIVE" ? (
          <Badge variant="outline" className="border-transparent bg-success-soft text-success">
            {t.locations.statusActive}
          </Badge>
        ) : (
          <Badge variant="ghost" className="text-muted-foreground">
            {t.locations.statusInactive}
          </Badge>
        )}
      </TableCell>
    </TableRow>
  );
}
