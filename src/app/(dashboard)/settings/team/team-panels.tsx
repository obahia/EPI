"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel, PanelKicker, PanelTitle } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Company, Membership, OrgInvitation, OrgMember } from "@/lib/supabase/dal";
import {
  inviteMember,
  revokeInvitation,
  revokeMembership,
  updateMembershipRole,
  type ActionState,
  type InviteState,
} from "./actions";

const ROLE_LABELS: Record<Membership["role"], string> = {
  VIEWER: "Somente leitura",
  SST_OPERATOR: "Operador de SST",
  COMPANY_ADMIN: "Administrador da empresa",
  ORG_ADMIN: "Administrador da organização",
};

const ROLE_ORDER: Membership["role"][] = ["VIEWER", "SST_OPERATOR", "COMPANY_ADMIN", "ORG_ADMIN"];

const STATUS_LABELS: Record<OrgInvitation["status"], string> = {
  OPEN: "Aguardando",
  ACCEPTED: "Aceito",
  REVOKED: "Cancelado",
  EXPIRED: "Expirado",
};

const inputClass = cn(
  "h-9 w-full rounded-full border border-input bg-transparent px-4 text-[13px] outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString("pt-BR") : "—";
}

/**
 * The invitation link, shown exactly once. Unlike the API key secret this value COULD be
 * regenerated (a new invitation for the same address), but the token behind this particular
 * link is only stored as a hash, so this render is the last time it exists in readable form.
 * The copy says to send it through a channel the person already trusts, because whoever holds
 * the link and the invited mailbox can take the seat.
 */
function OneTimeInviteLink({ email, link }: { email: string; link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Panel tone="success" className="flex flex-col items-start gap-2">
      <PanelKicker>Convite criado para {email}</PanelKicker>
      <code className="w-full overflow-x-auto rounded-lg bg-foreground/6 px-3 py-2 font-mono text-[12px] break-all">
        {link}
      </code>
      <p className="text-[12.5px] font-bold">
        O Selo ainda não envia e-mails: copie este link e mande você mesmo, por um canal em que
        vocês dois já confiam. Ele não pode ser recuperado depois desta tela.
      </p>
      <p className="text-[12px]">
        Só serve para <strong>{email}</strong> — quem abrir o link logado com outra conta é
        recusado.
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          void navigator.clipboard.writeText(link).then(() => setCopied(true));
        }}
      >
        {copied ? "Copiado" : "Copiar link"}
      </Button>
    </Panel>
  );
}

export function InvitePanel({
  organizationId,
  companies,
  grantableRoles,
  canInviteOrgWide,
  invitations,
}: {
  organizationId: string;
  companies: Company[];
  /** What THIS user may grant, computed from their own membership. The database decides
   * again in auth_ctx.can_grant_role -- this only keeps the form from offering what would
   * be refused. */
  grantableRoles: Membership["role"][];
  canInviteOrgWide: boolean;
  invitations: OrgInvitation[];
}) {
  const [inviteState, inviteAction, inviting] = useActionState<InviteState, FormData>(inviteMember, {
    error: null,
    link: null,
    email: null,
  });
  const [revokeState, revokeAction] = useActionState<ActionState, FormData>(revokeInvitation, {
    error: null,
  });

  return (
    <div className="flex flex-col gap-3.5">
      <Panel className="flex flex-col gap-3.5">
        <PanelTitle>Convidar alguém</PanelTitle>
        <p className="text-[13px] text-muted-foreground">
          O acesso vem sempre de um convite aceito — não existe cadastrar outra pessoa por ela.
          Quem aceita entra exatamente no perfil e no escopo definidos aqui.
        </p>
        <form action={inviteAction} className="flex flex-col gap-3">
          <input type="hidden" name="organizationId" value={organizationId} />
          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            E-mail
            <input name="email" type="email" required maxLength={254} className={inputClass} />
          </label>

          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            Perfil de acesso
            <select name="role" required defaultValue="" className={inputClass}>
              <option value="" disabled>
                Selecione
              </option>
              {ROLE_ORDER.filter((r) => grantableRoles.includes(r)).map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            Escopo
            <select name="companyId" defaultValue={canInviteOrgWide ? "" : (companies[0]?.id ?? "")} className={inputClass}>
              {canInviteOrgWide ? (
                <option value="">Toda a organização (todas as empresas, inclusive futuras)</option>
              ) : null}
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.legalName}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            Validade do link
            <select name="ttlHours" defaultValue="168" className={inputClass}>
              <option value="24">24 horas</option>
              <option value="72">3 dias</option>
              <option value="168">7 dias</option>
              <option value="720">30 dias</option>
            </select>
          </label>

          {inviteState.error ? <p className="text-sm text-destructive">{inviteState.error}</p> : null}
          <Button type="submit" disabled={inviting} className="self-start">
            Gerar convite
          </Button>
        </form>
      </Panel>

      {inviteState.link && inviteState.email ? (
        <OneTimeInviteLink email={inviteState.email} link={inviteState.link} />
      ) : null}
      {revokeState.error ? (
        <Panel tone="destructive">
          <p className="text-sm">{revokeState.error}</p>
        </Panel>
      ) : null}

      <Panel className="flex flex-col gap-3">
        <PanelTitle>Convites</PanelTitle>
        {invitations.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nenhum convite ainda.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>E-mail</TableHead>
                <TableHead>Perfil</TableHead>
                <TableHead>Escopo</TableHead>
                <TableHead>Expira</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="text-right">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invitation) => (
                <TableRow key={invitation.invitationId}>
                  <TableCell>{invitation.email}</TableCell>
                  <TableCell>{ROLE_LABELS[invitation.role]}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {invitation.companyName ?? "Toda a organização"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(invitation.expiresAt)}</TableCell>
                  <TableCell>{STATUS_LABELS[invitation.status]}</TableCell>
                  <TableCell className="text-right">
                    {invitation.status === "OPEN" ? (
                      <form action={revokeAction}>
                        <input type="hidden" name="invitationId" value={invitation.invitationId} />
                        <Button type="submit" variant="outline" size="sm">
                          Cancelar
                        </Button>
                      </form>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-[12px] text-muted-foreground">
          Cancelar um convite invalida o link imediatamente, mesmo que alguém já o tenha em mãos.
          Um convite já aceito não pode ser cancelado — remova o acesso na lista da equipe.
        </p>
      </Panel>
    </div>
  );
}

export function MembersPanel({
  members,
  grantableRoles,
  currentUserId,
}: {
  members: OrgMember[];
  grantableRoles: Membership["role"][];
  currentUserId: string;
}) {
  const [roleState, roleAction] = useActionState<ActionState, FormData>(updateMembershipRole, {
    error: null,
  });
  const [revokeState, revokeAction] = useActionState<ActionState, FormData>(revokeMembership, {
    error: null,
  });

  return (
    <div className="flex flex-col gap-3.5">
      {roleState.error ? (
        <Panel tone="destructive">
          <p className="text-sm">{roleState.error}</p>
        </Panel>
      ) : null}
      {revokeState.error ? (
        <Panel tone="destructive">
          <p className="text-sm">{revokeState.error}</p>
        </Panel>
      ) : null}

      <Panel className="flex flex-col gap-3">
        <PanelTitle>Equipe</PanelTitle>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pessoa</TableHead>
              <TableHead>Escopo</TableHead>
              <TableHead>Perfil</TableHead>
              <TableHead>Desde</TableHead>
              <TableHead className="text-right">Ação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              // Both of these are enforced in Postgres too -- authz.is_last_org_admin gates
              // the revoke and the demotion, and can_grant_role gates the role list. What is
              // disabled here is exactly what the database would refuse, computed by the same
              // function, so the UI never offers a button that cannot work.
              const editable = grantableRoles.includes(member.role);
              const locked = member.isLastOrgAdmin;

              return (
                <TableRow key={member.membershipId}>
                  <TableCell>
                    <span className="font-bold">{member.fullName}</span>
                    <span className="block text-[12px] text-muted-foreground">{member.email}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {member.companyName ?? "Toda a organização"}
                  </TableCell>
                  <TableCell>
                    {editable && !locked ? (
                      <form action={roleAction} className="flex items-center gap-2">
                        <input type="hidden" name="membershipId" value={member.membershipId} />
                        <select
                          name="role"
                          defaultValue={member.role}
                          className="h-8 rounded-full border border-input bg-transparent px-3 text-[12.5px]"
                        >
                          {ROLE_ORDER.filter((r) => grantableRoles.includes(r) || r === member.role).map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role]}
                            </option>
                          ))}
                        </select>
                        <Button type="submit" variant="outline" size="sm">
                          Salvar
                        </Button>
                      </form>
                    ) : (
                      ROLE_LABELS[member.role]
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(member.acceptedAt)}</TableCell>
                  <TableCell className="text-right">
                    {locked ? (
                      <span className="text-[12px] text-muted-foreground">Último administrador</span>
                    ) : editable ? (
                      <form action={revokeAction}>
                        <input type="hidden" name="membershipId" value={member.membershipId} />
                        <Button type="submit" variant="outline" size="sm">
                          {member.userId === currentUserId ? "Sair da organização" : "Remover acesso"}
                        </Button>
                      </form>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <p className="text-[12px] text-muted-foreground">
          Remover não apaga nada: o acesso é encerrado e o histórico de quem teve acesso, e
          quando, continua na trilha de auditoria. A última pessoa com acesso total à
          organização não pode ser removida nem rebaixada — não há como recuperar uma
          organização sem administrador.
        </p>
      </Panel>
    </div>
  );
}
