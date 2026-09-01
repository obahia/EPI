import Link from "next/link";
import { redirect } from "next/navigation";
import { verifySession, getMyCompanies, getDeliveryBatches } from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function DeliveryBatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string }>;
}) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const companies = await getMyCompanies();
  if (companies.length === 0) {
    redirect("/dashboard");
  }

  const { company: companyParam } = await searchParams;
  const activeCompany =
    companies.find((c) => c.id === companyParam) ?? (companies.length === 1 ? companies[0]! : null);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Lotes de entrega</h1>
          <Link href="/deliveries" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Voltar para entregas
          </Link>
        </div>
        {activeCompany ? (
          <Button asChild>
            <Link href={`/deliveries/batch/new?company=${activeCompany.id}`}>Novo lote</Link>
          </Button>
        ) : null}
      </div>

      {companies.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Empresa</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2 text-sm">
              {companies.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/deliveries/batches?company=${c.id}`}
                    className={
                      "rounded-md border px-3 py-1.5" +
                      (activeCompany?.id === c.id ? " border-primary bg-primary/5 font-medium" : "")
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

      {!activeCompany ? (
        <p className="text-sm text-muted-foreground">Selecione uma empresa para ver seus lotes.</p>
      ) : (
        <BatchTable companyId={activeCompany.id} />
      )}
    </main>
  );
}

async function BatchTable({ companyId }: { companyId: string }) {
  const batches = await getDeliveryBatches(companyId);

  if (batches.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Nenhum lote criado ainda. Use “Novo lote” para começar.
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
              <TableHead>Data da entrega</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Confirmadas</TableHead>
              <TableHead>Contestadas</TableHead>
              <TableHead>Canceladas</TableHead>
              <TableHead>Criado em</TableHead>
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
