import { redirect } from "next/navigation";
import { verifySession, getMyCompanies } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { LocationCreateForm } from "./location-form";

export default async function NewLocationPage({
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
    redirect("/locations");
  }

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <h1 className="font-heading text-4xl font-extrabold tracking-tight">{t.locations.newLocation}</h1>
      <p className="text-sm text-muted-foreground">{company.legalName}</p>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>{t.locations.locationDataCardTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <LocationCreateForm companyId={company.id} />
        </CardContent>
      </Card>
    </main>
  );
}
