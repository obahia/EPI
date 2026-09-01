import Link from "next/link";
import { redirect } from "next/navigation";
import { verifySession, getMyCompanies, getDeliveries } from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeliveryStatusBadge } from "@/components/delivery-status-badge";

export default async function DeliveriesPage({
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
          <h1 className="text-2xl font-semibold tracking-tight">Entregas de EPI</h1>
          <Link href="/deliveries/batches" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Ver lotes de entrega
          </Link>
        </div>
        {activeCompany ? (
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href={`/deliveries/batch/new?company=${activeCompany.id}`}>Novo lote</Link>
            </Button>
            <Button asChild>
              <Link href={`/deliveries/new?company=${activeCompany.id}`}>Nova entrega</Link>
            </Button>
          </div>
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
                    href={`/deliveries?company=${c.id}`}
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
        <p className="text-sm text-muted-foreground">Selecione uma empresa para ver suas entregas.</p>
      ) : (
        <DeliveryTable companyId={activeCompany.id} />
      )}
    </main>
  );
}

async function DeliveryTable({ companyId }: { companyId: string }) {
  const deliveries = await getDeliveries(companyId);

  if (deliveries.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Nenhuma entrega registrada ainda. Use “Nova entrega” para começar.
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
              <TableHead>Funcionário</TableHead>
              <TableHead>Data</TableHead>
              <TableHead>Status</TableHead>
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
