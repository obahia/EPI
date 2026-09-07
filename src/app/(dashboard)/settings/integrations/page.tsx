import { redirect } from "next/navigation";
import Link from "next/link";
import {
  getApiKeys,
  getIntegrationPrincipals,
  getMyMemberships,
  getWebhookEndpoints,
  verifySession,
  type ApiKeySummary,
} from "@/lib/supabase/dal";
import { PrincipalsPanel, WebhooksPanel } from "./integrations-panels";

/**
 * The integration plane's only management surface. ORG_ADMIN only, and gated the same way
 * /settings gates organization policy: an org-wide (company_id NULL) ORG_ADMIN membership,
 * which auth_ctx.has_org_permission also requires on the database side.
 *
 * Deliberately human-only. There is no API endpoint that creates keys or webhook endpoints,
 * because a key able to do either has escalated itself: one into minting more access, the
 * other into an exfiltration channel for every event of its tenant.
 */
export default async function IntegrationsPage() {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const memberships = await getMyMemberships();
  const orgAdmin = memberships.find((m) => m.companyId === null && m.role === "ORG_ADMIN");
  if (!orgAdmin) {
    redirect("/dashboard");
  }

  const [principals, endpoints] = await Promise.all([
    getIntegrationPrincipals(orgAdmin.organizationId),
    getWebhookEndpoints(orgAdmin.organizationId),
  ]);

  const keyLists = await Promise.all(principals.map((p) => getApiKeys(p.id)));
  const keysByPrincipal: Record<string, ApiKeySummary[]> = {};
  principals.forEach((p, index) => {
    keysByPrincipal[p.id] = keyLists[index] ?? [];
  });

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <Link href="/settings" className="text-[12.5px] font-bold text-muted-foreground hover:underline">
          ← Configurações
        </Link>
        <h1 className="font-heading text-4xl font-extrabold tracking-tight">Integrações</h1>
        <p className="max-w-2xl text-[13.5px] text-muted-foreground">
          Chaves de API e webhooks. Uma chave de API não é um usuário: ela não tem sessão, não
          aparece como pessoa na trilha de auditoria e nunca alcança a confirmação do trabalhador
          nem o comprovante selado.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 xl:items-start">
        <section className="flex flex-col gap-3.5">
          <h2 className="font-heading text-2xl font-extrabold tracking-tight">Chaves de API</h2>
          <PrincipalsPanel
            organizationId={orgAdmin.organizationId}
            principals={principals}
            keysByPrincipal={keysByPrincipal}
          />
        </section>

        <section className="flex flex-col gap-3.5">
          <h2 className="font-heading text-2xl font-extrabold tracking-tight">Webhooks</h2>
          <WebhooksPanel organizationId={orgAdmin.organizationId} endpoints={endpoints} />
        </section>
      </div>
    </main>
  );
}
