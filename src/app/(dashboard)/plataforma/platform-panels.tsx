"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Panel, PanelTitle } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type {
  PlatformAdminRow,
  PlatformGrant,
  PlatformMember,
  PlatformOrganization,
} from "@/lib/supabase/dal";
import {
  grantPlatformAccess,
  promoteToOrgAdmin,
  revokePlatformAccess,
  type ActionState,
} from "./actions";

const inputClass = cn(
  "h-9 w-full rounded-full border border-input bg-transparent px-4 text-[13px] outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

function formatMoment(value: string | null): string {
  return value ? new Date(value).toLocaleString("pt-BR") : "—";
}

function grantState(grant: PlatformGrant): string {
  if (grant.revokedAt) return "Encerrada";
  if (new Date(grant.expiresAt) <= new Date()) return "Expirada";
  return "Ativa";
}

export function GrantAccessPanel({
  admins,
  currentUserId,
  organizations,
}: {
  admins: PlatformAdminRow[];
  currentUserId: string;
  organizations: PlatformOrganization[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(grantPlatformAccess, {
    error: null,
  });

  // Four eyes is enforced in Postgres; the form simply does not offer the one option that
  // would be refused, so the rule reads as a rule rather than as an error message.
  const grantees = admins.filter((a) => a.revokedAt === null && a.userId !== currentUserId);

  return (
    <Panel className="flex flex-col gap-3.5">
      <PanelTitle>Conceder acesso</PanelTitle>
      <p className="text-[13px] text-muted-foreground">
        Ninguém concede acesso a si mesmo. O motivo que você escrever aqui vai para a trilha de
        auditoria do próprio cliente, e ele pode lê-lo — escreva pensando nisso.
      </p>

      {grantees.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          Não há outra pessoa ativa na equipe de plataforma para conceder acesso. A regra dos
          quatro olhos precisa de duas pessoas.
        </p>
      ) : (
        <form action={action} className="flex max-w-md flex-col gap-3">
          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            Para quem
            <select name="adminUserId" required defaultValue="" className={inputClass}>
              <option value="" disabled>
                Selecione
              </option>
              {grantees.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.fullName} · {a.level}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            Organização
            <select name="organizationId" required defaultValue="" className={inputClass}>
              <option value="" disabled>
                Selecione
              </option>
              {organizations.map((o) => (
                <option key={o.organizationId} value={o.organizationId}>
                  {o.legalName}
                </option>
              ))}
            </select>
          </label>

          <input type="hidden" name="companyId" value="" />

          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            Motivo (o cliente vai ler)
            <textarea
              name="reason"
              required
              minLength={20}
              maxLength={1000}
              rows={3}
              className={cn(inputClass, "h-auto rounded-2xl py-2")}
            />
          </label>

          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            Chamado
            <input name="ticketRef" maxLength={120} className={inputClass} />
          </label>

          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            Duração
            <select name="ttlHours" defaultValue="4" className={inputClass}>
              <option value="1">1 hora</option>
              <option value="4">4 horas</option>
              <option value="24">24 horas</option>
              <option value="72">72 horas (máximo)</option>
            </select>
          </label>

          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          <Button type="submit" disabled={pending} className="self-start">
            Conceder
          </Button>
        </form>
      )}
    </Panel>
  );
}

export function MyGrantsPanel({ grants }: { grants: PlatformGrant[] }) {
  const [state, action] = useActionState<ActionState, FormData>(revokePlatformAccess, { error: null });

  return (
    <div className="flex flex-col gap-3.5">
      {state.error ? (
        <Panel tone="destructive">
          <p className="text-sm">{state.error}</p>
        </Panel>
      ) : null}

      <Panel className="flex flex-col gap-3">
        <PanelTitle>Meus acessos</PanelTitle>
        {grants.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            Nenhum acesso concedido a você. Ser da equipe não é acesso — cada organização exige
            uma concessão própria, de outra pessoa.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organização</TableHead>
                <TableHead>Motivo</TableHead>
                <TableHead>Expira</TableHead>
                <TableHead>Usos</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="text-right">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.map((g) => {
                const live = grantState(g) === "Ativa";
                return (
                  <TableRow key={g.grantId}>
                    <TableCell>
                      {live ? (
                        <Link
                          href={`/plataforma/${g.organizationId}`}
                          className="font-bold underline underline-offset-4"
                        >
                          {g.organizationName}
                        </Link>
                      ) : (
                        g.organizationName
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs text-muted-foreground">{g.reason}</TableCell>
                    <TableCell className="text-muted-foreground">{formatMoment(g.expiresAt)}</TableCell>
                    <TableCell>{g.useCount}</TableCell>
                    <TableCell>{grantState(g)}</TableCell>
                    <TableCell className="text-right">
                      {live ? (
                        <form action={action}>
                          <input type="hidden" name="grantId" value={g.grantId} />
                          <Button type="submit" variant="outline" size="sm">
                            Encerrar
                          </Button>
                        </form>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <p className="text-[12px] text-muted-foreground">
          Encerrar devolve o acesso imediatamente. Toda concessão morre sozinha no máximo em 72
          horas, mas devolver antes é o comportamento esperado quando o chamado termina.
        </p>
      </Panel>
    </div>
  );
}

export function RescuePanel({
  organizationId,
  members,
  liveOrgAdminCount,
}: {
  organizationId: string;
  members: PlatformMember[];
  liveOrgAdminCount: number;
}) {
  const [state, action] = useActionState<ActionState, FormData>(promoteToOrgAdmin, { error: null });

  return (
    <Panel tone={liveOrgAdminCount === 0 ? "warning" : "card"} className="flex flex-col gap-3">
      <PanelTitle>Acesso do cliente</PanelTitle>
      {liveOrgAdminCount === 0 ? (
        <p className="text-[13px] font-bold">
          Esta organização não tem nenhum administrador com acesso a toda a organização. Ninguém
          do lado do cliente consegue administrá-la até que alguém seja promovido.
        </p>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {liveOrgAdminCount} pessoa(s) com acesso total. Promover só é necessário quando esse
          número é zero.
        </p>
      )}

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Pessoa</TableHead>
            <TableHead>Perfil</TableHead>
            <TableHead>Escopo</TableHead>
            <TableHead className="text-right">Ação</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((m) => (
            <TableRow key={m.membershipId}>
              <TableCell>
                <span className="font-bold">{m.fullName}</span>
                <span className="block text-[12px] text-muted-foreground">{m.email}</span>
              </TableCell>
              <TableCell>{m.role}</TableCell>
              <TableCell className="text-muted-foreground">
                {m.companyId ? "Uma empresa" : "Toda a organização"}
              </TableCell>
              <TableCell className="text-right">
                {m.companyId === null && m.role === "ORG_ADMIN" ? (
                  <span className="text-[12px] text-muted-foreground">Já é administrador</span>
                ) : (
                  <form action={action}>
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="userId" value={m.userId} />
                    <Button type="submit" variant="outline" size="sm">
                      Promover a admin
                    </Button>
                  </form>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <p className="text-[12px] text-muted-foreground">
        Só é possível promover alguém que a organização já admitiu — o suporte nunca coloca uma
        pessoa nova dentro da conta de um cliente. A promoção fica registrada na trilha do
        cliente como ação da plataforma, não como algo que ele mesmo fez.
      </p>
    </Panel>
  );
}
