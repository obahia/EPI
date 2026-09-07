"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { generateApiKey, hashApiKeySecret } from "@/lib/crypto/api-key";
import { encryptWebhookSecret, generateWebhookSecret } from "@/lib/crypto/webhook-secret";
import { checkWebhookUrl } from "@/lib/webhooks/ssrf";

/**
 * Panel management of the integration plane. Human-only, ORG_ADMIN-only, and deliberately
 * with no API equivalent: a key that can mint keys, or point a webhook somewhere new, has
 * escalated itself into an exfiltration channel for its whole tenant.
 *
 * Both secrets here are generated in Node and shown to the user exactly once. The API key
 * secret is peppered and hashed before it reaches Postgres and is unrecoverable afterwards
 * by anyone, including a database reader. The webhook secret is encrypted rather than hashed
 * because the runner has to read it back to sign each delivery -- but the key that decrypts
 * it never enters the database either.
 */

const SCOPES = [
  "employees:read",
  "employees:write",
  "positions:read",
  "locations:read",
  "epis:read",
  "deliveries:read",
] as const;

export type ActionState = { error: string | null };

const principalSchema = z.object({
  organizationId: z.uuid(),
  name: z.string().trim().min(2).max(120),
  scopes: z.array(z.enum(SCOPES)).max(SCOPES.length),
});

export async function createIntegrationPrincipal(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = principalSchema.safeParse({
    organizationId: formData.get("organizationId"),
    name: formData.get("name"),
    scopes: formData.getAll("scopes"),
  });
  if (!parsed.success) return { error: "Dados inválidos." };

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("create_integration_principal", {
    p_organization_id: parsed.data.organizationId,
    p_name: parsed.data.name,
    p_company_ids: null,
    p_scopes: parsed.data.scopes,
  });

  if (error) return { error: describeRpcError(error, "Não foi possível criar a integração.") };
  revalidatePath("/settings/integrations");
  return { error: null };
}

export type CreateKeyState = { error: string | null; secret: string | null; keyId: string | null };

/**
 * The ONLY moment the full key exists. It is returned to the page, rendered once, and never
 * stored anywhere -- not in the database, not in a log, not in the audit event (which records
 * only the public key_id).
 */
export async function createApiKey(_prev: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  const principalId = formData.get("principalId");
  if (typeof principalId !== "string" || !z.uuid().safeParse(principalId).success) {
    return { error: "Integração inválida.", secret: null, keyId: null };
  }

  const generated = generateApiKey("live");
  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("create_api_key", {
    p_principal_id: principalId,
    p_key_id: generated.keyId,
    p_secret_hash_b64: hashApiKeySecret(generated.secret).toString("base64"),
    p_env: generated.env,
    p_expires_at: null,
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível criar a chave."), secret: null, keyId: null };
  }

  revalidatePath("/settings/integrations");
  return { error: null, secret: generated.full, keyId: generated.keyId };
}

export async function revokeApiKey(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const apiKeyId = formData.get("apiKeyId");
  if (typeof apiKeyId !== "string" || !z.uuid().safeParse(apiKeyId).success) {
    return { error: "Chave inválida." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("revoke_api_key", {
    p_api_key_id: apiKeyId,
    p_reason: (formData.get("reason") as string | null)?.slice(0, 500) ?? null,
  });

  if (error) return { error: describeRpcError(error, "Não foi possível revogar a chave.") };
  revalidatePath("/settings/integrations");
  return { error: null };
}

export type CreateEndpointState = { error: string | null; secret: string | null };

export async function createWebhookEndpoint(
  _prev: CreateEndpointState,
  formData: FormData,
): Promise<CreateEndpointState> {
  const organizationId = formData.get("organizationId");
  const url = formData.get("url");
  if (typeof organizationId !== "string" || !z.uuid().safeParse(organizationId).success) {
    return { error: "Organização inválida.", secret: null };
  }
  if (typeof url !== "string") return { error: "URL inválida.", secret: null };

  // Checked here as well as at delivery time. This one gives the user a clear reason now;
  // the delivery-time check is the one that actually protects us, because DNS can change
  // between the two.
  const checked = checkWebhookUrl(url);
  if (!checked.ok) {
    const reasons: Record<string, string> = {
      not_https: "A URL precisa usar https://.",
      bad_port: "Somente a porta 443 é aceita.",
      has_userinfo: "A URL não pode conter usuário e senha.",
      ip_literal: "Informe um nome de domínio, não um endereço IP.",
      internal_hostname: "Este host não é público.",
      too_long: "URL longa demais.",
      unparseable: "URL inválida.",
    };
    return { error: reasons[checked.reason] ?? "URL inválida.", secret: null };
  }

  const secret = generateWebhookSecret();
  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("create_webhook_endpoint", {
    p_organization_id: organizationId,
    p_url: checked.url.toString(),
    p_secret_enc_b64: encryptWebhookSecret(secret).toString("base64"),
    p_event_types: formData.getAll("eventTypes").map(String),
    p_description: (formData.get("description") as string | null) || null,
    p_ordered_delivery: formData.get("orderedDelivery") === "on",
  });

  if (error) return { error: describeRpcError(error, "Não foi possível criar o endpoint."), secret: null };

  revalidatePath("/settings/integrations");
  return { error: null, secret };
}

export type RotateSecretState = { error: string | null; secret: string | null };

export async function rotateWebhookSecret(
  _prev: RotateSecretState,
  formData: FormData,
): Promise<RotateSecretState> {
  const endpointId = formData.get("endpointId");
  if (typeof endpointId !== "string" || !z.uuid().safeParse(endpointId).success) {
    return { error: "Endpoint inválido.", secret: null };
  }

  const secret = generateWebhookSecret();
  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("rotate_webhook_secret", {
    p_endpoint_id: endpointId,
    p_new_secret_enc_b64: encryptWebhookSecret(secret).toString("base64"),
  });

  if (error) return { error: describeRpcError(error, "Não foi possível girar o segredo."), secret: null };

  revalidatePath("/settings/integrations");
  return { error: null, secret };
}

export async function setWebhookEndpointStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const endpointId = formData.get("endpointId");
  const status = formData.get("status");
  if (typeof endpointId !== "string" || !z.uuid().safeParse(endpointId).success) {
    return { error: "Endpoint inválido." };
  }
  if (status !== "ACTIVE" && status !== "DISABLED" && status !== "REVOKED") {
    return { error: "Status inválido." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("set_webhook_endpoint_status", {
    p_endpoint_id: endpointId,
    p_status: status,
    p_reason: null,
  });

  if (error) return { error: describeRpcError(error, "Não foi possível alterar o endpoint.") };
  revalidatePath("/settings/integrations");
  return { error: null };
}

export async function replayWebhookDelivery(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const deliveryId = formData.get("deliveryId");
  if (typeof deliveryId !== "string" || !z.uuid().safeParse(deliveryId).success) {
    return { error: "Entrega inválida." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("replay_webhook_delivery", {
    p_delivery_id: deliveryId,
  });

  if (error) return { error: describeRpcError(error, "Não foi possível reenviar.") };
  revalidatePath("/settings/integrations");
  return { error: null };
}
