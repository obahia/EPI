import { redirect } from "next/navigation";
import Link from "next/link";
import { getMyMemberships, getVendorAccessGrants, verifySession } from "@/lib/supabase/dal";
import { Panel, PanelTitle } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * The customer's own audit of vendor access. This page is the reason break-glass is
 * defensible at all: docs/architecture.md §5 promised that an organization can see who at the
 * vendor was given access to their data and why, and until this existed that promise had no
 * surface behind it.
 *
 * Nothing here is a summary or a courtesy. It is the same rows the support console writes,
 * read by the person whose employees' data it is.
 */
export default async function SupportAccessPage() {
  const session = await verifySession();
  if (!session.isAuthenticated) redirect("/login");

  const memberships = await getMyMemberships();
  const orgAdmin = memberships.find((m) => m.companyId === null && m.role === "ORG_ADMIN");
  if (!orgAdmin) redirect("/dashboard");

  const grants = await getVendorAccessGrants(orgAdmin.organizationId);

  const stateOf = (g: (typeof grants)[number]): string => {
    if (g.revokedAt) return "Encerrado";
    if (new Date(g.expiresAt) <= new Date()) return "Expirado";
    return "Ativo agora";
  };

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <Link href="/settings" className="text-[12.5px] font-bold text-muted-foreground hover:underline">
          ← Configurações
        </Link>
        <h1 className="font-heading text-4xl font-extrabold tracking-tight">Acesso do suporte</h1>
        <p className="max-w-2xl text-[13.5px] text-muted-foreground">
          Quando alguém do Selo precisa olhar os dados da sua organização para resolver um
          chamado, isso exige uma autorização com prazo, aprovada por uma segunda pessoa da
          nossa equipe — e aparece aqui, com o motivo, quer você tenha perguntado ou não.
        </p>
      </div>

      <div className="flex max-w-5xl flex-col gap-6">
        <Panel className="flex flex-col gap-3">
          <PanelTitle>Autorizações</PanelTitle>
          {grants.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              Ninguém do Selo teve acesso aos dados desta organização.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quem</TableHead>
                  <TableHead>Aprovado por</TableHead>
                  <TableHead>Motivo</TableHead>
                  <TableHead>Período</TableHead>
                  <TableHead>Uso</TableHead>
                  <TableHead>Situação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.map((g) => (
                  <TableRow key={g.grantId}>
                    <TableCell>
                      <span className="font-bold">{g.adminName}</span>
                      <span className="block text-[12px] text-muted-foreground">{g.adminEmail}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{g.grantedByName}</TableCell>
                    <TableCell className="max-w-xs">
                      {g.reason}
                      {g.ticketRef ? (
                        <span className="block text-[12px] text-muted-foreground">
                          Chamado {g.ticketRef}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(g.grantedAt).toLocaleString("pt-BR")}
                      <span className="block text-[12px]">
                        até {new Date(g.expiresAt).toLocaleString("pt-BR")}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {g.useCount === 0 ? (
                        "Nunca usado"
                      ) : (
                        <>
                          {g.useCount}×
                          <span className="block text-[12px]">
                            desde {new Date(g.firstUsedAt ?? g.grantedAt).toLocaleString("pt-BR")}
                          </span>
                        </>
                      )}
                    </TableCell>
                    <TableCell>{stateOf(g)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="text-[12px] text-muted-foreground">
            Nenhuma autorização passa de 72 horas, e ninguém da nossa equipe aprova a própria.
            &quot;Nunca usado&quot; significa exatamente isso: a autorização foi emitida e nada foi
            lido com ela. Cada uma destas linhas também está na sua trilha de auditoria, encadeada
            junto com o resto do histórico da organização.
          </p>
        </Panel>
      </div>
    </main>
  );
}
