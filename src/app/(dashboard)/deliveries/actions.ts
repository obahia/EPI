"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { generateWorkerToken, hashWorkerToken } from "@/lib/crypto/worker-token";

export type DeliveryFormState = { error: string | null };

const itemSchema = z.object({
  epiId: z.uuid(),
  quantity: z.coerce.number().int().min(1).max(10000),
});

const createSchema = z.object({
  companyId: z.uuid(),
  employeeId: z.uuid("Selecione um funcionário."),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida."),
  note: z.string().trim().max(2000).optional(),
});

/**
 * Creates a DRAFT delivery + its line items via api.create_delivery. Line items arrive as
 * repeated `epiId`/`quantity` form fields (one pair per row in the repeatable item UI --
 * see delivery-form.tsx) rather than a single JSON blob, so the browser's own native form
 * semantics (no JS required to keep them in sync) do the zipping; `unit` is intentionally
 * omitted from the payload so the RPC defaults each line to the EPI's own default_unit.
 */
export async function createDelivery(_prevState: DeliveryFormState, formData: FormData): Promise<DeliveryFormState> {
  const parsed = createSchema.safeParse({
    companyId: formData.get("companyId"),
    employeeId: formData.get("employeeId"),
    deliveryDate: formData.get("deliveryDate"),
    note: formData.get("note") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const epiIds = formData.getAll("epiId");
  const quantities = formData.getAll("quantity");

  if (epiIds.length === 0) {
    return { error: "A entrega precisa de pelo menos um item." };
  }

  const items: { epi_id: string; quantity: number }[] = [];
  for (let i = 0; i < epiIds.length; i++) {
    const parsedItem = itemSchema.safeParse({ epiId: epiIds[i], quantity: quantities[i] });
    if (!parsedItem.success) {
      return { error: "Selecione um EPI e uma quantidade válida (1 a 10.000) em cada item." };
    }
    items.push({ epi_id: parsedItem.data.epiId, quantity: parsedItem.data.quantity });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema("api").rpc("create_delivery", {
    p_company_id: parsed.data.companyId,
    p_employee_id: parsed.data.employeeId,
    p_delivery_date: parsed.data.deliveryDate,
    p_note: parsed.data.note || null,
    p_items: items,
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível criar a entrega.") };
  }

  revalidatePath("/deliveries");
  redirect(`/deliveries/${data as string}`);
}

const idSchema = z.object({ deliveryId: z.uuid() });

/** DRAFT -> ISSUED. A distinct user action/RPC call from creation on purpose -- the DRAFT
 * state is real, not collapsed away, even if the UI moves through it quickly. */
export async function issueDelivery(_prevState: DeliveryFormState, formData: FormData): Promise<DeliveryFormState> {
  const parsed = idSchema.safeParse({ deliveryId: formData.get("deliveryId") });
  if (!parsed.success) {
    return { error: "Dados inválidos." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("issue_delivery", { p_delivery_id: parsed.data.deliveryId });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível emitir a entrega.") };
  }

  revalidatePath("/deliveries");
  redirect(`/deliveries/${parsed.data.deliveryId}`);
}

const cancelSchema = z.object({
  deliveryId: z.uuid(),
  reason: z.string().trim().max(500).optional(),
});

/** DRAFT or ISSUED -> CANCELLED. Never callable once the delivery is frozen
 * (CONFIRMED/CONTESTED/SUPERSEDED) -- the RPC itself is the enforcement, this is just the
 * button that's only rendered for the two statuses where it can legally succeed. */
export async function cancelDelivery(_prevState: DeliveryFormState, formData: FormData): Promise<DeliveryFormState> {
  const parsed = cancelSchema.safeParse({
    deliveryId: formData.get("deliveryId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) {
    return { error: "Dados inválidos." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("cancel_delivery", {
    p_delivery_id: parsed.data.deliveryId,
    p_reason: parsed.data.reason || null,
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível cancelar a entrega.") };
  }

  revalidatePath("/deliveries");
  redirect(`/deliveries/${parsed.data.deliveryId}`);
}

export type ConfirmationLinkState = { error: string | null; path: string | null; expiresAt: string | null };

const createLinkSchema = z.object({ deliveryId: z.uuid() });

/** Generates (or regenerates -- api.create_confirmation_link revokes any still-live one for
 * this delivery first, see docs/architecture.md §8) the worker confirmation link for an
 * ISSUED/CONTESTED delivery. The raw token is generated here, in Node, and only its HMAC
 * hash ever reaches Postgres (src/lib/crypto/worker-token.ts) -- returned as a relative
 * PATH, never a full URL with the token embedded in a redirect/query string, so it never
 * touches Next.js routing/logs. The client component builds the absolute link (using its
 * own window.location.origin) purely for display/copy. */
export async function createConfirmationLink(
  _prevState: ConfirmationLinkState,
  formData: FormData,
): Promise<ConfirmationLinkState> {
  const parsed = createLinkSchema.safeParse({ deliveryId: formData.get("deliveryId") });
  if (!parsed.success) {
    return { error: "Dados inválidos.", path: null, expiresAt: null };
  }

  const token = generateWorkerToken();
  const tokenHash = hashWorkerToken(token);

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .rpc("create_confirmation_link", {
      p_delivery_id: parsed.data.deliveryId,
      p_token_hash_b64: tokenHash.toString("base64"),
      p_ttl_hours: null,
    })
    .single();

  if (error || !data) {
    return { error: describeRpcError(error!, "Não foi possível gerar o link de confirmação."), path: null, expiresAt: null };
  }

  revalidatePath(`/deliveries/${parsed.data.deliveryId}`);

  const row = data as { confirmation_request_id: string; expires_at: string };
  return { error: null, path: `/e/${token}`, expiresAt: row.expires_at };
}

export type ResolveContestState = { error: string | null };

const resolveContestSchema = z.object({
  contestId: z.uuid(),
  deliveryId: z.uuid(),
  resolutionNote: z.string().trim().min(3, "Escreva uma resposta com pelo menos 3 caracteres.").max(2000),
});

/** Records the manager's written response to a contest (CONTEST_RESPONDED in the audit
 * trail) -- does not change the delivery's status, see api.resolve_contest's comment. */
export async function resolveContest(_prevState: ResolveContestState, formData: FormData): Promise<ResolveContestState> {
  const parsed = resolveContestSchema.safeParse({
    contestId: formData.get("contestId"),
    deliveryId: formData.get("deliveryId"),
    resolutionNote: formData.get("resolutionNote"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("resolve_contest", {
    p_contest_id: parsed.data.contestId,
    p_resolution_note: parsed.data.resolutionNote,
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível registrar a resposta.") };
  }

  revalidatePath(`/deliveries/${parsed.data.deliveryId}`);
  return { error: null };
}
