import { redirect } from "next/navigation";
import { verifySession, getMyCompanies, getEmployees, getEpis } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { DeliveryCreateForm } from "./delivery-form";

export default async function NewDeliveryPage({
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
    redirect("/deliveries");
  }

  const [employees, epis] = await Promise.all([getEmployees(company.id), getEpis(company.id)]);
  const activeEpis = epis.filter((e) => e.isActive);

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <h1 className="font-heading text-4xl font-extrabold tracking-tight">{t.deliveries.newDelivery}</h1>
      <p className="text-sm text-muted-foreground">{company.legalName}</p>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{t.deliveries.deliveryDataCardTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <DeliveryCreateForm companyId={company.id} employees={employees} epis={activeEpis} />
        </CardContent>
      </Card>
    </main>
  );
}
