"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel, PanelKicker, PanelTitle } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { ApiKeySummary, IntegrationPrincipal, WebhookEndpointSummary } from "@/lib/supabase/dal";
import {
  createApiKey,
  createIntegrationPrincipal,
  createWebhookEndpoint,
  revokeApiKey,
  rotateWebhookSecret,
  setWebhookEndpointStatus,
  type ActionState,
  type CreateEndpointState,
  type CreateKeyState,
  type RotateSecretState,
} from "./actions";

const SCOPES = [
  "employees:read",
  "employees:write",
  "positions:read",
  "locations:read",
  "epis:read",
  "deliveries:read",
] as const;

const EVENT_TYPES = [
  "delivery.created",
  "delivery.issued",
  "delivery.confirmed",
  "delivery.contested",
  "delivery.cancelled",
  "ppe.replaced",
  "ppe.returned",
  "employee.created",
  "employee.updated",
  "employee.import_completed",
] as const;

const inputClass = cn(
  "h-9 w-full rounded-full border border-input bg-transparent px-4 text-[13px] outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

/**
 * Renders a secret exactly once, with no way to retrieve it afterwards -- there is no "show
 * again" affordance anywhere in this file because the value genuinely does not exist on the
 * server after this render. The panel says so explicitly rather than letting the user assume
 * they can come back for it.
 */
function OneTimeSecret({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Panel tone="success" className="flex flex-col items-start gap-2">
      <PanelKicker>{label}</PanelKicker>
      <code className="w-full overflow-x-auto rounded-lg bg-foreground/6 px-3 py-2 font-mono text-[12px] break-all">
        {value}
      </code>
      <p className="text-[12.5px] font-bold">
        Copie agora. Este valor não é armazenado e não pode ser recuperado depois — nem por você,
        nem pelo suporte.
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? "Copiado" : "Copiar"}
      </Button>
    </Panel>
  );
}

export function PrincipalsPanel({
  organizationId,
  principals,
  keysByPrincipal,
}: {
  organizationId: string;
  principals: IntegrationPrincipal[];
  keysByPrincipal: Record<string, ApiKeySummary[]>;
}) {
  const [createState, createAction, creating] = useActionState<ActionState, FormData>(
    createIntegrationPrincipal,
    { error: null },
  );
  const [keyState, keyAction] = useActionState<CreateKeyState, FormData>(createApiKey, {
    error: null,
    secret: null,
    keyId: null,
  });
  const [revokeState, revokeAction] = useActionState<ActionState, FormData>(revokeApiKey, {
    error: null,
  });

  return (
    <div className="flex flex-col gap-3.5">
      <Panel className="flex flex-col gap-3.5">
        <PanelTitle>Nova integração</PanelTitle>
        <p className="text-[13px] text-muted-foreground">
          Uma integração é uma identidade de máquina — nunca um usuário. Ela vale para toda a
          organização e só pode fazer o que os escopos marcados permitirem.
        </p>
        <form action={createAction} className="flex flex-col gap-3">
          <input type="hidden" name="organizationId" value={organizationId} />
          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            Nome
            <input name="name" required minLength={2} maxLength={120} className={inputClass} />
          </label>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-[12.5px] font-bold">Escopos</legend>
            <p className="text-[12px] text-muted-foreground">
              Não há hierarquia: <code>employees:write</code> não concede{" "}
              <code>employees:read</code>. Marque exatamente o que a integração precisa.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-1.5 text-[12.5px]">
                  <input type="checkbox" name="scopes" value={scope} />
                  <code>{scope}</code>
                </label>
              ))}
            </div>
          </fieldset>
          {createState.error ? (
            <p className="text-sm text-destructive">{createState.error}</p>
          ) : null}
          <Button type="submit" disabled={creating} className="self-start">
            Criar integração
          </Button>
        </form>
      </Panel>

      {keyState.secret ? <OneTimeSecret label="Chave de API criada" value={keyState.secret} /> : null}
      {keyState.error ? (
        <Panel tone="destructive">
          <p className="text-sm">{keyState.error}</p>
        </Panel>
      ) : null}
      {revokeState.error ? (
        <Panel tone="destructive">
          <p className="text-sm">{revokeState.error}</p>
        </Panel>
      ) : null}

      {principals.length === 0 ? (
        <Panel>
          <p className="text-[13px] text-muted-foreground">Nenhuma integração criada ainda.</p>
        </Panel>
      ) : null}

      {principals.map((principal) => (
        <Panel key={principal.id} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <PanelTitle>{principal.name}</PanelTitle>
            <span className="text-[12px] font-bold text-muted-foreground">
              {principal.status === "ACTIVE" ? "Ativa" : "Revogada"} · {principal.activeKeyCount}{" "}
              chave(s) ativa(s)
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {principal.scopes.length === 0 ? (
              <span className="text-[12.5px] text-muted-foreground">Sem escopos — não autoriza nada.</span>
            ) : (
              principal.scopes.map((scope) => (
                <code key={scope} className="rounded-full bg-foreground/6 px-2.5 py-0.5 text-[11.5px]">
                  {scope}
                </code>
              ))
            )}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chave</TableHead>
                <TableHead>Último uso</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="text-right">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(keysByPrincipal[principal.id] ?? []).map((key) => (
                <TableRow key={key.id}>
                  <TableCell>
                    <code className="text-[12px]">
                      selo_{key.env}_{key.keyId}
                    </code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString("pt-BR") : "nunca"}
                  </TableCell>
                  <TableCell>{key.revokedAt ? "Revogada" : "Ativa"}</TableCell>
                  <TableCell className="text-right">
                    {key.revokedAt ? null : (
                      <form action={revokeAction}>
                        <input type="hidden" name="apiKeyId" value={key.id} />
                        <Button type="submit" variant="outline" size="sm">
                          Revogar
                        </Button>
                      </form>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {principal.status === "ACTIVE" ? (
            <form action={keyAction}>
              <input type="hidden" name="principalId" value={principal.id} />
              <Button type="submit" variant="outline">
                Gerar nova chave
              </Button>
            </form>
          ) : null}
          <p className="text-[12px] text-muted-foreground">
            Para girar sem interrupção: gere a nova chave, migre o cliente e só então revogue a
            antiga. As duas funcionam ao mesmo tempo.
          </p>
        </Panel>
      ))}
    </div>
  );
}

export function WebhooksPanel({
  organizationId,
  endpoints,
}: {
  organizationId: string;
  endpoints: WebhookEndpointSummary[];
}) {
  const [createState, createAction, creating] = useActionState<CreateEndpointState, FormData>(
    createWebhookEndpoint,
    { error: null, secret: null },
  );
  const [rotateState, rotateAction] = useActionState<RotateSecretState, FormData>(
    rotateWebhookSecret,
    { error: null, secret: null },
  );
  const [statusState, statusAction] = useActionState<ActionState, FormData>(
    setWebhookEndpointStatus,
    { error: null },
  );

  return (
    <div className="flex flex-col gap-3.5">
      <Panel className="flex flex-col gap-3.5">
        <PanelTitle>Novo endpoint de webhook</PanelTitle>
        <p className="text-[13px] text-muted-foreground">
          Somente <code>https://</code> na porta 443, com nome de domínio público. Endereços IP,
          redes internas e redirecionamentos são recusados — inclusive no momento da entrega, não
          apenas aqui.
        </p>
        <form action={createAction} className="flex flex-col gap-3">
          <input type="hidden" name="organizationId" value={organizationId} />
          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            URL
            <input
              name="url"
              type="url"
              required
              placeholder="https://exemplo.com/webhooks/selo"
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12.5px] font-bold">
            Descrição
            <input name="description" maxLength={200} className={inputClass} />
          </label>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-[12.5px] font-bold">Eventos</legend>
            <p className="text-[12px] text-muted-foreground">
              Nenhum marcado = todos os eventos publicáveis.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {EVENT_TYPES.map((type) => (
                <label key={type} className="flex items-center gap-1.5 text-[12.5px]">
                  <input type="checkbox" name="eventTypes" value={type} />
                  <code>{type}</code>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" name="orderedDelivery" />
            Entrega estritamente ordenada (uma por vez — um assinante lento trava a fila)
          </label>
          {createState.error ? <p className="text-sm text-destructive">{createState.error}</p> : null}
          <Button type="submit" disabled={creating} className="self-start">
            Criar endpoint
          </Button>
        </form>
      </Panel>

      {createState.secret ? (
        <OneTimeSecret label="Segredo de assinatura" value={createState.secret} />
      ) : null}
      {rotateState.secret ? (
        <OneTimeSecret label="Novo segredo de assinatura" value={rotateState.secret} />
      ) : null}
      {rotateState.error ? (
        <Panel tone="destructive">
          <p className="text-sm">{rotateState.error}</p>
        </Panel>
      ) : null}
      {statusState.error ? (
        <Panel tone="destructive">
          <p className="text-sm">{statusState.error}</p>
        </Panel>
      ) : null}

      {endpoints.length === 0 ? (
        <Panel>
          <p className="text-[13px] text-muted-foreground">Nenhum endpoint configurado.</p>
        </Panel>
      ) : null}

      {endpoints.map((endpoint) => (
        <Panel
          key={endpoint.id}
          tone={endpoint.status === "ACTIVE" ? undefined : "destructive"}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <code className="text-[13px] font-bold break-all">{endpoint.url}</code>
            <span className="text-[12px] font-bold">{endpoint.status}</span>
          </div>
          {endpoint.description ? (
            <p className="text-[12.5px] text-muted-foreground">{endpoint.description}</p>
          ) : null}
          <p className="text-[12.5px] tabular-nums">
            Na fila: {endpoint.pendingCount} · DLQ: {endpoint.dlqCount} · Falhas permanentes
            consecutivas: {endpoint.consecutiveFailures}
            {endpoint.lastSuccessAt
              ? ` · Último sucesso: ${new Date(endpoint.lastSuccessAt).toLocaleString("pt-BR")}`
              : " · Nenhuma entrega bem-sucedida ainda"}
          </p>
          {endpoint.consecutiveFailures >= 15 && endpoint.status === "ACTIVE" ? (
            <p className="text-[12.5px] font-bold text-destructive">
              Este endpoint será desativado automaticamente em {20 - endpoint.consecutiveFailures}{" "}
              falha(s) permanente(s).
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {endpoint.eventTypes.length === 0 ? (
              <span className="text-[12px] text-muted-foreground">Todos os eventos</span>
            ) : (
              endpoint.eventTypes.map((type) => (
                <code key={type} className="rounded-full bg-foreground/6 px-2.5 py-0.5 text-[11.5px]">
                  {type}
                </code>
              ))
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <form action={rotateAction}>
              <input type="hidden" name="endpointId" value={endpoint.id} />
              <Button type="submit" variant="outline" size="sm">
                Girar segredo
              </Button>
            </form>
            <form action={statusAction}>
              <input type="hidden" name="endpointId" value={endpoint.id} />
              <input
                type="hidden"
                name="status"
                value={endpoint.status === "ACTIVE" ? "DISABLED" : "ACTIVE"}
              />
              <Button type="submit" variant="outline" size="sm">
                {endpoint.status === "ACTIVE" ? "Desativar" : "Reativar"}
              </Button>
            </form>
          </div>
          <p className="text-[12px] text-muted-foreground">
            Ao girar, o segredo anterior continua válido por 24 h e as duas assinaturas são
            enviadas juntas — o assinante migra sem perder eventos.
          </p>
        </Panel>
      ))}
    </div>
  );
}
