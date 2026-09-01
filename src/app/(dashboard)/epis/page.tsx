import Link from "next/link";
import { redirect } from "next/navigation";
import { verifySession, getMyCompanies, getEpis } from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toggleEpiActive } from "./actions";

const UNIT_LABEL: Record<string, string> = {
  UN: "Unidade",
  PAR: "Par",
  CX: "Caixa",
  M: "Metro",
  KG: "Quilo",
};

export default async function EpisPage({
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
        <h1 className="text-2xl font-semibold tracking-tight">Catálogo de EPIs</h1>
        {activeCompany ? (
          <Button asChild>
            <Link href={`/epis/new?company=${activeCompany.id}`}>Novo EPI</Link>
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
                    href={`/epis?company=${c.id}`}
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
        <p className="text-sm text-muted-foreground">Selecione uma empresa para ver seu catálogo de EPIs.</p>
      ) : (
        <EpiTable companyId={activeCompany.id} />
      )}
    </main>
  );
}

async function EpiTable({ companyId }: { companyId: string }) {
  const epis = await getEpis(companyId);

  if (epis.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Nenhum EPI cadastrado ainda. Use “Novo EPI” para começar.
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
              <TableHead>Nome</TableHead>
              <TableHead>CA</TableHead>
              <TableHead>Fabricante</TableHead>
              <TableHead>Modelo</TableHead>
              <TableHead>Unidade</TableHead>
              <TableHead>Origem</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {epis.map((epi) => (
              <TableRow key={epi.id}>
                <TableCell>
                  <Link href={`/epis/${epi.id}?company=${companyId}`} className="font-medium underline-offset-4 hover:underline">
                    {epi.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{epi.caNumber}</TableCell>
                <TableCell>{epi.manufacturer ?? "—"}</TableCell>
                <TableCell>{epi.model ?? "—"}</TableCell>
                <TableCell>{UNIT_LABEL[epi.defaultUnit] ?? epi.defaultUnit}</TableCell>
                <TableCell>{epi.companyId === null ? "Organização" : "Esta empresa"}</TableCell>
                <TableCell>
                  <Badge variant={epi.isActive ? "default" : "outline"}>{epi.isActive ? "Ativo" : "Inativo"}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <form action={toggleEpiActive}>
                    <input type="hidden" name="epiId" value={epi.id} />
                    <input type="hidden" name="companyId" value={companyId} />
                    <input type="hidden" name="isActive" value={(!epi.isActive).toString()} />
                    <Button type="submit" size="sm" variant="outline">
                      {epi.isActive ? "Desativar" : "Ativar"}
                    </Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
