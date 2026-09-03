import { notFound, redirect } from "next/navigation";
import { verifySession, getJobPosition, getPositionMatrix, getMyCompanies, getEpis } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelTitle } from "@/components/panel";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { PositionEditForm } from "./position-edit-form";
import { PositionMatrix } from "./position-matrix";

export default async function PositionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ company?: string }>;
}) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const { id } = await params;
  const position = await getJobPosition(id);
  if (!position) {
    notFound();
  }

  const companies = await getMyCompanies();
  const { company: companyParam } = await searchParams;
  // Same "where do we send the epi picker" problem epis/[id]/page.tsx solves: an org-wide
  // position has no company of its own, so fall back to the ?company= the list linked with,
  // then to the caller's first company -- there is always SOME company to scope the EPI
  // picker to, even for a shared position.
  const returnCompanyId = companyParam ?? position.companyId ?? companies[0]?.id ?? "";

  const [matrix, epis] = await Promise.all([
    getPositionMatrix(position.id),
    returnCompanyId ? getEpis(returnCompanyId) : Promise.resolve([]),
  ]);

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        back={{ href: `/positions?company=${returnCompanyId}`, label: t.positions.backToPositions }}
        title={position.title}
      />

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <Card className="min-w-0 flex-1 xl:max-w-lg">
          <CardHeader>
            <CardTitle>{t.positions.editPositionTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <PositionEditForm position={position} returnCompanyId={returnCompanyId} />
          </CardContent>
        </Card>

        <Panel className="min-w-0 flex-1">
          <PanelTitle>{t.positions.matrixTitle}</PanelTitle>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">{t.positions.matrixHint}</p>
          <div className="mt-4.5">
            <PositionMatrix positionId={position.id} epis={epis} requirements={matrix} />
          </div>
        </Panel>
      </div>
    </main>
  );
}
