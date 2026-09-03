import { redirect } from "next/navigation";
import { verifySession, getMyCompanies, getLocations, getEpis, getEpiVariants, type EpiVariant } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { TransferForm } from "./transfer-form";

export default async function StockTransferPage({
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
  const { company: companyParam } = await searchParams;
  const company = companies.find((c) => c.id === companyParam) ?? (companies.length === 1 ? companies[0]! : null);

  if (!company) {
    redirect("/stock");
  }

  const [locations, epis] = await Promise.all([getLocations(company.id), getEpis(company.id)]);
  const activeEpis = epis.filter((e) => e.isActive);

  const variantLists = await Promise.all(activeEpis.map((epi) => getEpiVariants(epi.id)));
  const variantsByEpi: Record<string, EpiVariant[]> = {};
  activeEpis.forEach((epi, i) => {
    const list = variantLists[i] ?? [];
    if (list.length > 0) variantsByEpi[epi.id] = list;
  });

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <h1 className="font-heading text-4xl font-extrabold tracking-tight">{t.stock.transferTitle}</h1>
      <p className="text-sm text-muted-foreground">{company.legalName}</p>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>{t.stock.transferTitle}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t.stock.transferHint}</p>
          <TransferForm
            companyId={company.id}
            locations={locations}
            epis={activeEpis}
            variantsByEpi={variantsByEpi}
          />
        </CardContent>
      </Card>
    </main>
  );
}
