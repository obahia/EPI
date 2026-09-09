import { redirect } from "next/navigation";
import {
  getCurrentUser,
  getMyPlatformGrants,
  getMyPlatformLevel,
  getPlatformAdmins,
  searchPlatformOrganizations,
  verifySession,
} from "@/lib/supabase/dal";
import { Panel, PanelTitle } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { GrantAccessPanel, MyGrantsPanel } from "./platform-panels";

/**
 * The vendor's support console -- the code behind app.platform_admins and
 * app.platform_access_grants, which had existed since FASE 0 with nothing calling them.
 *
 * Being on the platform roster gets you THIS page and nothing else. It is not access to any
 * customer's data: every read of a tenant needs a live, time-boxed grant issued by a
 * different colleague, and the tenant sees each one in their own audit trail. That
 * separation is the whole design, so this page says so out loud rather than assuming
 * whoever opens it already knows.
 */
export default async function PlatformPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const level = await getMyPlatformLevel();
  if (!level) {
    // Same destination as any other page a user may not open. Nothing here hints that a
    // platform console exists.
    redirect("/dashboard");
  }

  const { q } = await searchParams;
  const [user, admins, grants, organizations] = await Promise.all([
    getCurrentUser(),
    getPlatformAdmins(),
    getMyPlatformGrants(),
    searchPlatformOrganizations(q ?? null),
  ]);

  if (!user) redirect("/login");

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <p className="text-[10.5px] font-bold tracking-[0.12em] text-muted-foreground uppercase">
          Plataforma · {level}
        </p>
        <h1 className="font-heading text-4xl font-extrabold tracking-tight">Suporte</h1>
        <p className="max-w-2xl text-[13.5px] text-muted-foreground">
          Estar nesta equipe não dá acesso a dado nenhum de cliente. Cada organização exige uma
          concessão própria, com prazo, concedida por outra pessoa da equipe — e o cliente vê
          cada uma delas, com o motivo, na própria trilha de auditoria dele.
        </p>
      </div>

      <div className="flex max-w-5xl flex-col gap-6">
        <MyGrantsPanel grants={grants} />

        <GrantAccessPanel admins={admins} currentUserId={user.id} organizations={organizations} />

        <Panel className="flex flex-col gap-3">
          <PanelTitle>Organizações</PanelTitle>
          <form className="flex max-w-md gap-2">
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Razão social ou CNPJ"
              className="h-9 w-full rounded-full border border-input bg-transparent px-4 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </form>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Razão social</TableHead>
                <TableHead>CNPJ</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Empresas</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {organizations.map((o) => (
                <TableRow key={o.organizationId}>
                  <TableCell className="font-bold">{o.legalName}</TableCell>
                  <TableCell className="font-mono text-[12px]">{o.cnpj}</TableCell>
                  <TableCell>{o.kind}</TableCell>
                  <TableCell>{o.companyCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-[12px] text-muted-foreground">
            Esta lista é a única leitura aqui que não exige concessão, e não pode exigir: não dá
            para pedir acesso a uma organização cujo id você não consegue descobrir. São dados
            comerciais nossos sobre o cliente — nada que pertença a um funcionário dele.
          </p>
        </Panel>
      </div>
    </main>
  );
}
