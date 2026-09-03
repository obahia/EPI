import { notFound, redirect } from "next/navigation";
import { verifySession, getLocation, getMyCompanies } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { LocationEditForm } from "./location-edit-form";

export default async function LocationPage({
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
  const location = await getLocation(id);
  if (!location) {
    notFound();
  }

  const companies = await getMyCompanies();
  const { company: companyParam } = await searchParams;
  const returnCompanyId = companyParam ?? location.companyId ?? companies[0]?.id ?? "";

  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5">
      <PageHeader
        back={{ href: `/locations?company=${returnCompanyId}`, label: t.locations.backToLocations }}
        title={location.name}
      />

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>{t.locations.editLocationTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <LocationEditForm location={location} returnCompanyId={returnCompanyId} />
        </CardContent>
      </Card>
    </main>
  );
}
