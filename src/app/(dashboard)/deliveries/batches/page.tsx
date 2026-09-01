import Link from "next/link";
import { redirect } from "next/navigation";
import { Layers } from "lucide-react";
import { verifySession, getMyCompanies, getDeliveryBatches } from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CompanyChooser } from "@/components/company-chooser";
import { EmptyState } from "@/components/empty-state";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary, type Dict } from "@/i18n/dictionaries";

export default async function DeliveryBatchesPage({
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
          <h1 className="font-heading text-2xl font-medium tracking-tight">{t.deliveries.batchesTitle}</h1>
          <Link href="/deliveries" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            {t.deliveries.backToDeliveries}
          </Link>
        </div>
        {activeCompany ? (
          <Button asChild>
            <Link href={`/deliveries/batch/new?company=${activeCompany.id}`}>{t.deliveries.newBatch}</Link>
          </Button>
        ) : null}
      </div>

      <CompanyChooser
        companies={companies}
        activeCompanyId={activeCompany?.id}
        basePath="/deliveries/batches"
        title={t.deliveries.companyCardTitle}
      />

      {!activeCompany ? (
        <p className="text-sm text-muted-foreground">{t.deliveries.selectCompanyPromptBatches}</p>
      ) : (
        <BatchTable companyId={activeCompany.id} t={t} />
      )}
    </main>
  );
}

async function BatchTable({ companyId, t }: { companyId: string; t: Dict }) {
  const batches = await getDeliveryBatches(companyId);

  if (batches.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState icon={Layers} message={t.deliveries.noBatchesYet} />
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
              <TableHead>{t.deliveries.deliveryDateLabel}</TableHead>
              <TableHead>{t.deliveries.totalColumn}</TableHead>
              <TableHead>{t.deliveries.confirmedColumn}</TableHead>
              <TableHead>{t.deliveries.contestedColumn}</TableHead>
              <TableHead>{t.deliveries.cancelledColumn}</TableHead>
              <TableHead>{t.deliveries.createdAtColumn}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.map((b) => (
              <TableRow key={b.id}>
                <TableCell>
                  <Link
                    href={`/deliveries/batches/${b.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {new Date(`${b.deliveryDate}T00:00:00`).toLocaleDateString("pt-BR")}
                  </Link>
                </TableCell>
                <TableCell>{b.totalCount}</TableCell>
                <TableCell>{b.confirmedCount}</TableCell>
                <TableCell>{b.contestedCount}</TableCell>
                <TableCell>{b.cancelledCount}</TableCell>
                <TableCell>{new Date(b.createdAt).toLocaleString("pt-BR")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
