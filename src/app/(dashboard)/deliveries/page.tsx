import Link from "next/link";
import { redirect } from "next/navigation";
import { Truck } from "lucide-react";
import { verifySession, getMyCompanies, getDeliveries } from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeliveryStatusBadge } from "@/components/delivery-status-badge";
import { CompanyChooser } from "@/components/company-chooser";
import { EmptyState } from "@/components/empty-state";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";

export default async function DeliveriesPage({
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
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-tight">{t.deliveries.title}</h1>
          <Link href="/deliveries/batches" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            {t.deliveries.viewBatches}
          </Link>
        </div>
        {activeCompany ? (
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href={`/deliveries/batch/new?company=${activeCompany.id}`}>{t.deliveries.newBatch}</Link>
            </Button>
            <Button asChild>
              <Link href={`/deliveries/new?company=${activeCompany.id}`}>{t.deliveries.newDelivery}</Link>
            </Button>
          </div>
        ) : null}
      </div>

      <CompanyChooser
        companies={companies}
        activeCompanyId={activeCompany?.id}
        basePath="/deliveries"
        title={t.deliveries.companyCardTitle}
      />

      {!activeCompany ? (
        <p className="text-sm text-muted-foreground">{t.deliveries.selectCompanyPrompt}</p>
      ) : (
        <DeliveryTable companyId={activeCompany.id} t={t} />
      )}
    </main>
  );
}

async function DeliveryTable({ companyId, t }: { companyId: string; t: Dict }) {
  const deliveries = await getDeliveries(companyId);

  if (deliveries.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState icon={Truck} message={t.deliveries.noDeliveriesYet} />
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
              <TableHead>{t.deliveries.employeeColumn}</TableHead>
              <TableHead>{t.common.date}</TableHead>
              <TableHead>{t.common.status}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deliveries.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Link href={`/deliveries/${d.id}`} className="font-medium underline-offset-4 hover:underline">
                    {d.employeeFullName}
                  </Link>
                </TableCell>
                <TableCell>{new Date(`${d.deliveryDate}T00:00:00`).toLocaleDateString("pt-BR")}</TableCell>
                <TableCell>
                  <DeliveryStatusBadge status={d.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
