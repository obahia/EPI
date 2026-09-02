import Link from "next/link";
import { redirect } from "next/navigation";
import { verifySession, getMyCompanies, getEmployees, getEpis } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { BatchCreateForm } from "./batch-form";

export default async function NewBatchPage({
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
    redirect("/deliveries/batches");
  }

  const [employees, epis] = await Promise.all([getEmployees(company.id), getEpis(company.id)]);
  const activeEpis = epis.filter((e) => e.isActive);

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="font-heading text-4xl font-extrabold tracking-tight">{t.deliveries.batchNewTitle}</h1>
        <p className="text-sm text-muted-foreground">{company.legalName}</p>
      </div>

      {companies.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t.deliveries.companyCardTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2 text-sm">
              {companies.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/deliveries/batch/new?company=${c.id}`}
                    className={
                      "rounded-md border px-3 py-1.5" +
                      (company.id === c.id ? " border-primary bg-primary/5 font-medium" : "")
                    }
                  >
                    {c.legalName}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t.deliveries.batchDataCardTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <BatchCreateForm companyId={company.id} employees={employees} epis={activeEpis} />
        </CardContent>
      </Card>
    </main>
  );
}
