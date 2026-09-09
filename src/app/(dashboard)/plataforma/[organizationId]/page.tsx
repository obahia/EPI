import { redirect } from "next/navigation";
import Link from "next/link";
import {
  getMyPlatformLevel,
  getPlatformAuditEvents,
  getPlatformMembers,
  getPlatformOverview,
  verifySession,
} from "@/lib/supabase/dal";
import { Panel, PanelKicker, PanelTitle } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RescuePanel } from "../platform-panels";

/**
 * A single tenant, seen under a live grant. Opening this page IS the access: the first read
 * writes PLATFORM_ACCESS_USED into this organization's own audit chain, so the customer can
 * see not merely that access was authorised but that it happened.
 *
 * Everything here is counts, membership and the tenant's own event log. No employee record,
 * no delivery detail, and no CPF -- app.users is the manager table and an employee never has
 * a row in it, so the protected fields are not reachable from any query on this page.
 */
export default async function PlatformOrganizationPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const session = await verifySession();
  if (!session.isAuthenticated) redirect("/login");

  const level = await getMyPlatformLevel();
  if (!level) redirect("/dashboard");

  const { organizationId } = await params;
  const overview = await getPlatformOverview(organizationId);

  // Null means the database refused: no grant, an expired one, or one scoped to a single
  // company. The page does not distinguish them, because the RPC deliberately does not.
  if (!overview) {
    return (
      <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
        <Link href="/plataforma" className="text-[12.5px] font-bold text-muted-foreground hover:underline">
          ← Suporte
        </Link>
        <Panel tone="destructive" className="max-w-xl">
          <PanelTitle>Sem acesso ativo</PanelTitle>
          <p className="mt-2 text-[13px]">
            Você não tem uma concessão ativa e de escopo organizacional para este cliente. Peça a
            outra pessoa da equipe.
          </p>
        </Panel>
      </main>
    );
  }

  const [members, events] = await Promise.all([
    getPlatformMembers(organizationId),
    getPlatformAuditEvents(organizationId),
  ]);

  const stats: [string, string][] = [
    ["Empresas", String(overview.companyCount)],
    ["Funcionários", String(overview.employeeCount)],
    ["Membros do painel", String(overview.memberCount)],
    ["Admins da organização", String(overview.liveOrgAdminCount)],
    ["Entregas", String(overview.deliveryCount)],
    ["Aguardando confirmação", String(overview.pendingDeliveryCount)],
  ];

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <Link href="/plataforma" className="text-[12.5px] font-bold text-muted-foreground hover:underline">
          ← Suporte
        </Link>
        <h1 className="font-heading text-4xl font-extrabold tracking-tight">{overview.legalName}</h1>
        <p className="max-w-2xl text-[13.5px] text-muted-foreground">
          Este acesso já foi registrado na trilha de auditoria deste cliente. Contagens, quem tem
          acesso e o log de eventos — nenhum registro de funcionário e nenhum CPF.
        </p>
      </div>

      <div className="flex max-w-5xl flex-col gap-6">
        <Panel className="flex flex-wrap gap-x-10 gap-y-4">
          {stats.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <PanelKicker>{label}</PanelKicker>
              <span className="font-heading text-2xl font-extrabold tracking-tight">{value}</span>
            </div>
          ))}
        </Panel>

        <RescuePanel
          organizationId={organizationId}
          members={members}
          liveOrgAdminCount={overview.liveOrgAdminCount}
        />

        <Panel className="flex flex-col gap-3">
          <PanelTitle>Trilha de auditoria</PanelTitle>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Evento</TableHead>
                <TableHead>Ator</TableHead>
                <TableHead>Entidade</TableHead>
                <TableHead>Quando</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-[12px] text-muted-foreground">{e.seq}</TableCell>
                  <TableCell className="font-mono text-[12px]">{e.eventType}</TableCell>
                  <TableCell>{e.actorKind}</TableCell>
                  <TableCell className="text-muted-foreground">{e.entityTable ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString("pt-BR")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-[12px] text-muted-foreground">
            O conteúdo (`data`) de cada evento não é trazido para esta tela. Nada aqui precisa
            dele, e não carregá-lo é a metade barata de manter o acesso do suporte estreito — a
            metade cara é o banco recusar a chamada sem concessão ativa.
          </p>
        </Panel>
      </div>
    </main>
  );
}
