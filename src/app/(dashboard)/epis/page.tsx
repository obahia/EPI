import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { verifySession, getMyCompanies, getEpis } from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CompanyChooser } from "@/components/company-chooser";
import { EmptyState } from "@/components/empty-state";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";
import { toggleEpiActive } from "./actions";

export default async function EpisPage({
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
  const activeCompany =
    companies.find((c) => c.id === companyParam) ?? (companies.length === 1 ? companies[0]! : null);

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-heading text-2xl font-medium tracking-tight">{t.epis.catalogTitle}</h1>
        {activeCompany ? (
          <Button asChild>
            <Link href={`/epis/new?company=${activeCompany.id}`}>{t.epis.newEpi}</Link>
          </Button>
        ) : null}
      </div>

      <CompanyChooser
        companies={companies}
        activeCompanyId={activeCompany?.id}
        basePath="/epis"
        title={t.epis.companyCardTitle}
      />

      {!activeCompany ? (
        <p className="text-sm text-muted-foreground">{t.epis.selectCompanyPrompt}</p>
      ) : (
        <EpiTable companyId={activeCompany.id} t={t} />
      )}
    </main>
  );
}

async function EpiTable({ companyId, t }: { companyId: string; t: Dict }) {
  const epis = await getEpis(companyId);

  const UNIT_LABEL: Record<string, string> = {
    UN: t.epis.unitUn,
    PAR: t.epis.unitPar,
    CX: t.epis.unitCx,
    M: t.epis.unitM,
    KG: t.epis.unitKg,
  };

  if (epis.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState icon={ShieldCheck} message={t.epis.noEpisYet} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
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
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {epis.map((epi) => (
              <TableRow key={epi.id}>
                <TableCell>
                  <Link href={`/epis/${epi.id}?company=${companyId}`} className="font-medium underline-offset-4 hover:underline">
                    {epi.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{epi.caNumber}</TableCell>
                <TableCell>{epi.manufacturer ?? "—"}</TableCell>
                <TableCell>{epi.model ?? "—"}</TableCell>
                <TableCell>{UNIT_LABEL[epi.defaultUnit] ?? epi.defaultUnit}</TableCell>
                <TableCell>{epi.companyId === null ? t.epis.originOrg : t.epis.originCompany}</TableCell>
                <TableCell>
                  <Badge variant={epi.isActive ? "default" : "outline"}>
                    {epi.isActive ? t.epis.statusActive : t.epis.statusInactive}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <form action={toggleEpiActive}>
                    <input type="hidden" name="epiId" value={epi.id} />
                    <input type="hidden" name="companyId" value={companyId} />
                    <input type="hidden" name="isActive" value={(!epi.isActive).toString()} />
                    <Button type="submit" size="sm" variant="outline">
                      {epi.isActive ? t.epis.deactivate : t.epis.activate}
                    </Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
