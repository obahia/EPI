import { notFound, redirect } from "next/navigation";
import { verifySession, getEpi, getEpiVariants } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { EpiEditForm } from "./epi-edit-form";
import { EpiVariants } from "./epi-variants";

export default async function EpiPage({
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
  const epi = await getEpi(id);
  if (!epi) {
    notFound();
  }

  const { company: companyParam } = await searchParams;
  const returnCompanyId = companyParam ?? epi.companyId ?? "";
  const variants = await getEpiVariants(epi.id);

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="font-heading text-4xl font-extrabold tracking-tight">{epi.name}</h1>
        <p className="font-mono text-sm text-muted-foreground">
          {t.epis.caLabel} {epi.caNumber}
        </p>
      </div>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>{t.epis.editEpiTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <EpiEditForm epi={epi} returnCompanyId={returnCompanyId} />
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>{t.epis.variantsTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-[13px] text-muted-foreground">{t.epis.variantsHint}</p>
          <EpiVariants epiId={epi.id} variants={variants} />
        </CardContent>
      </Card>
    </main>
  );
}
