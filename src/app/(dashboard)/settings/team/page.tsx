import { redirect } from "next/navigation";
import Link from "next/link";
import {
  getCurrentUser,
  getMyCompanies,
  getMyMemberships,
  getOrgInvitations,
  getOrgMembers,
  verifySession,
  type Membership,
} from "@/lib/supabase/dal";
import { InvitePanel, MembersPanel } from "./team-panels";

/**
 * Team management -- the capability the product has been missing since FASE 0. Until Phase G
 * there was exactly one `insert into authz.memberships` in the whole codebase, inside
 * api.onboard_organization, so an organization could never have a second person: not a
 * colleague, not a backup admin, and above all not a second member of staff at an SST clinic
 * with N client companies, which is precisely the customer the tenancy model was designed for.
 *
 * Reachable by ORG_ADMIN and COMPANY_ADMIN, matching who holds `membership.manage`
 * (20260831140300:80,90). What each of them may actually grant differs sharply, and the
 * difference is enforced in Postgres by auth_ctx.can_grant_role -- a COMPANY_ADMIN can only
 * grant strictly below itself, and only into a company it already covers. The role list this
 * page builds is the same rule expressed for the form, not a second, softer copy of it.
 */
export default async function TeamPage() {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const [user, memberships, companies] = await Promise.all([
    getCurrentUser(),
    getMyMemberships(),
    getMyCompanies(),
  ]);

  const orgAdmin = memberships.find((m) => m.companyId === null && m.role === "ORG_ADMIN");
  const companyAdmin = memberships.find((m) => m.role === "COMPANY_ADMIN");
  const admin = orgAdmin ?? companyAdmin;

  if (!user || !admin) {
    redirect("/dashboard");
  }

  const grantableRoles: Membership["role"][] = orgAdmin
    ? ["VIEWER", "SST_OPERATOR", "COMPANY_ADMIN", "ORG_ADMIN"]
    : ["VIEWER", "SST_OPERATOR"];

  const [members, invitations] = await Promise.all([
    getOrgMembers(admin.organizationId),
    getOrgInvitations(admin.organizationId),
  ]);

  // A COMPANY_ADMIN may only invite into a company it already covers, so the scope select
  // offers exactly the companies it can see -- which RLS on api.companies already limits.
  const scopeCompanies = companies.filter((c) => c.organizationId === admin.organizationId);

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <Link href="/settings" className="text-[12.5px] font-bold text-muted-foreground hover:underline">
          ← Configurações
        </Link>
        <h1 className="font-heading text-4xl font-extrabold tracking-tight">Equipe</h1>
        <p className="max-w-2xl text-[13.5px] text-muted-foreground">
          Quem administra o Selo nesta organização. O acesso vem sempre de um convite aceito pela
          própria pessoa — nunca de um cadastro feito por outra — e cada convite define o perfil e
          o escopo exatos que ela terá.
        </p>
      </div>

      {/* Stacked, not the two-column grid /settings/integrations uses. Both tables here
          carry five or six columns -- person, scope, role, dates, action -- and at half the
          content width they overflowed their panel: the action column, with the only remove
          and cancel buttons on the page, sat outside the visible area behind a horizontal
          scrollbar nobody would think to look for. Caught by looking at a screenshot; every
          text assertion passed, because innerText contains clipped text just the same. */}
      <div className="flex max-w-5xl flex-col gap-6">
        <section className="flex flex-col gap-3.5">
          <MembersPanel members={members} grantableRoles={grantableRoles} currentUserId={user.id} />
        </section>

        <section className="flex flex-col gap-3.5">
          <InvitePanel
            organizationId={admin.organizationId}
            companies={scopeCompanies}
            grantableRoles={grantableRoles}
            canInviteOrgWide={Boolean(orgAdmin)}
            invitations={invitations}
          />
        </section>
      </div>
    </main>
  );
}
