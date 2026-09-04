"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { generateWorkerToken, hashWorkerToken } from "@/lib/crypto/worker-token";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

export type DeliveryFormState = { error: string | null };

const REASON_CODES = [
  "FIRST_ISSUE",
  "PERIODIC_REPLACEMENT",
  "WEAR",
  "DAMAGE",
  "LOSS",
  "SIZE_CHANGE",
  "ROLE_CHANGE",
  "EXPIRATION",
  "OTHER",
] as const;

const itemSchema = z.object({
  epiId: z.uuid(),
  quantity: z.coerce.number().int().min(1).max(10000),
  variantId: z.uuid().optional(),
});

/**
 * Creates a DRAFT delivery + its line items via api.create_delivery. Line items arrive as
 * repeated `epiId`/`quantity`/`variantId` form fields (one triplet per row in the repeatable
 * item UI -- see delivery-form.tsx) rather than a single JSON blob, so the browser's own
 * native form semantics (no JS required to keep them in sync) do the zipping; `unit` is
 * intentionally omitted from the payload so the RPC defaults each line to the EPI's own
 * default_unit. `variantId` is an empty string (never omitted -- see the form's comment)
 * when the row has no variant picker or none was chosen, and is dropped from the payload
 * in that case so the RPC sees no variant_id at all, same as every pre-Phase-A caller.
 */
export async function createDelivery(_prevState: DeliveryFormState, formData: FormData): Promise<DeliveryFormState> {
  const t = getDictionary(await getLocale());
  const createSchema = z.object({
    companyId: z.uuid(),
    employeeId: z.uuid(t.deliveries.selectEmployee),
    deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, t.deliveries.invalidDate),
    note: z.string().trim().max(2000).optional(),
    reasonCode: z.enum(REASON_CODES).default("FIRST_ISSUE"),
    reasonNote: z.string().trim().max(1000).optional(),
  });

  const parsed = createSchema.safeParse({
    companyId: formData.get("companyId"),
    employeeId: formData.get("employeeId"),
    deliveryDate: formData.get("deliveryDate"),
    note: formData.get("note") || undefined,
    reasonCode: formData.get("reasonCode") || undefined,
    reasonNote: formData.get("reasonNote") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.deliveries.invalidData };
  }

  const epiIds = formData.getAll("epiId");
  const quantities = formData.getAll("quantity");
  const variantIds = formData.getAll("variantId");

  if (epiIds.length === 0) {
    return { error: t.deliveries.atLeastOneItem };
  }

  const items: { epi_id: string; quantity: number; variant_id?: string }[] = [];
  for (let i = 0; i < epiIds.length; i++) {
    const parsedItem = itemSchema.safeParse({
      epiId: epiIds[i],
      quantity: quantities[i],
      variantId: variantIds[i] || undefined,
    });
    if (!parsedItem.success) {
      return { error: t.deliveries.invalidItemLine };
    }
    items.push({
      epi_id: parsedItem.data.epiId,
      quantity: parsedItem.data.quantity,
      ...(parsedItem.data.variantId ? { variant_id: parsedItem.data.variantId } : {}),
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema("api").rpc("create_delivery", {
    p_company_id: parsed.data.companyId,
    p_employee_id: parsed.data.employeeId,
    p_delivery_date: parsed.data.deliveryDate,
    p_note: parsed.data.note || null,
    p_items: items,
    p_reason_code: parsed.data.reasonCode,
    p_reason_note: parsed.data.reasonNote || null,
  });

  if (error) {
    return { error: describeRpcError(error, t.deliveries.createFailed) };
  }

  revalidatePath("/deliveries");
  redirect(`/deliveries/${data as string}`);
}

export type ReplaceDeliveryState = {
  error: string | null;
  /** Which specific early-replacement outcome the RPC returned, if any -- drives whether
   * ReplaceDeliveryForm shows its early-replacement warning panel (confirmation_required /
   * reason_note_required) or just the plain error banner with no override (blocked). Null
   * for every other error (validation, insufficient_privilege, not_found, etc.). */
  code: "confirmation_required" | "reason_note_required" | "blocked" | null;
};

const replaceItemSchema = z.object({
  epiId: z.uuid(),
  quantity: z.coerce.number().int().min(1).max(10000),
  variantId: z.uuid().optional(),
});

/**
 * The "troca" (replacement) RPC: supersedes a CONFIRMED/CONTESTED delivery and creates a new
 * DRAFT delivery in the same correction chain, via api.create_replacement_delivery. Same
 * item-triplet-per-row form encoding as createDelivery above (see that action's own comment).
 *
 * `confirmEarly` starts "false"; ReplaceDeliveryForm derives its hidden field's value from
 * this action's own last `code` (true once the RPC has said the organization's `warn` policy
 * requires it), so a plain resubmit of the SAME form carries it forward -- no separate
 * client-side confirmation step that could drift from what the RPC actually decided.
 */
export async function createReplacementDelivery(
  _prevState: ReplaceDeliveryState,
  formData: FormData,
): Promise<ReplaceDeliveryState> {
  const t = getDictionary(await getLocale());
  const schema = z.object({
    originalDeliveryId: z.uuid(),
    deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, t.deliveries.invalidDate),
    note: z.string().trim().max(2000).optional(),
    reasonCode: z.enum(REASON_CODES).default("FIRST_ISSUE"),
    reasonNote: z.string().trim().max(1000).optional(),
    confirmEarly: z.enum(["true", "false"]).default("false"),
  });

  const parsed = schema.safeParse({
    originalDeliveryId: formData.get("originalDeliveryId"),
    deliveryDate: formData.get("deliveryDate"),
    note: formData.get("note") || undefined,
    reasonCode: formData.get("reasonCode") || undefined,
    reasonNote: formData.get("reasonNote") || undefined,
    confirmEarly: formData.get("confirmEarly") || "false",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.deliveries.invalidData, code: null };
  }

  const epiIds = formData.getAll("epiId");
  const quantities = formData.getAll("quantity");
  const variantIds = formData.getAll("variantId");

  if (epiIds.length === 0) {
    return { error: t.deliveries.atLeastOneItem, code: null };
  }

  const items: { epi_id: string; quantity: number; variant_id?: string }[] = [];
  for (let i = 0; i < epiIds.length; i++) {
    const parsedItem = replaceItemSchema.safeParse({
      epiId: epiIds[i],
      quantity: quantities[i],
      variantId: variantIds[i] || undefined,
    });
    if (!parsedItem.success) {
      return { error: t.deliveries.invalidItemLine, code: null };
    }
    items.push({
      epi_id: parsedItem.data.epiId,
      quantity: parsedItem.data.quantity,
      ...(parsedItem.data.variantId ? { variant_id: parsedItem.data.variantId } : {}),
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema("api").rpc("create_replacement_delivery", {
    p_original_delivery_id: parsed.data.originalDeliveryId,
    p_items: items,
    p_delivery_date: parsed.data.deliveryDate,
    p_note: parsed.data.note || null,
    p_reason_code: parsed.data.reasonCode,
    p_reason_note: parsed.data.reasonNote || null,
    p_confirm_early: parsed.data.confirmEarly === "true",
  });

  if (error) {
    // early_replacement_confirmation_required carries no user-facing message of its own --
    // ReplaceDeliveryForm's warning panel explains it -- while the other two early-
    // replacement outcomes reuse describeRpcError's pt-BR text like every other RPC error.
    if (error.message?.includes("early_replacement_confirmation_required")) {
      return { error: null, code: "confirmation_required" };
    }
    return {
      error: describeRpcError(error, t.deliveries.replaceFailed),
      code: error.message?.includes("early_replacement_blocked")
        ? "blocked"
        : error.message?.includes("reason_note_required_for_early_replacement")
          ? "reason_note_required"
          : null,
    };
  }

  revalidatePath("/deliveries");
  revalidatePath(`/deliveries/${parsed.data.originalDeliveryId}`);
  redirect(`/deliveries/${data as string}`);
}

const idSchema = z.object({ deliveryId: z.uuid() });

/** DRAFT -> ISSUED. A distinct user action/RPC call from creation on purpose -- the DRAFT
 * state is real, not collapsed away, even if the UI moves through it quickly. */
export async function issueDelivery(_prevState: DeliveryFormState, formData: FormData): Promise<DeliveryFormState> {
  const t = getDictionary(await getLocale());
  const parsed = idSchema.safeParse({ deliveryId: formData.get("deliveryId") });
  if (!parsed.success) {
    return { error: t.deliveries.invalidData };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("issue_delivery", { p_delivery_id: parsed.data.deliveryId });

  if (error) {
    return { error: describeRpcError(error, t.deliveries.issueFailed) };
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
  const t = getDictionary(await getLocale());
  const parsed = cancelSchema.safeParse({
    deliveryId: formData.get("deliveryId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) {
    return { error: t.deliveries.invalidData };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("cancel_delivery", {
    p_delivery_id: parsed.data.deliveryId,
    p_reason: parsed.data.reason || null,
  });

  if (error) {
    return { error: describeRpcError(error, t.deliveries.cancelFailed) };
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
  const t = getDictionary(await getLocale());
  const parsed = createLinkSchema.safeParse({ deliveryId: formData.get("deliveryId") });
  if (!parsed.success) {
    return { error: t.deliveries.invalidData, path: null, expiresAt: null };
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
    return { error: describeRpcError(error!, t.deliveries.linkFailed), path: null, expiresAt: null };
  }

  revalidatePath(`/deliveries/${parsed.data.deliveryId}`);

  const row = data as { confirmation_request_id: string; expires_at: string };
  return { error: null, path: `/e/${token}`, expiresAt: row.expires_at };
}

export type ResolveContestState = { error: string | null };

/** Records the manager's written response to a contest (CONTEST_RESPONDED in the audit
 * trail) -- does not change the delivery's status, see api.resolve_contest's comment. */
export async function resolveContest(_prevState: ResolveContestState, formData: FormData): Promise<ResolveContestState> {
  const t = getDictionary(await getLocale());
  const resolveContestSchema = z.object({
    contestId: z.uuid(),
    deliveryId: z.uuid(),
    resolutionNote: z.string().trim().min(3, t.deliveries.resolveContestMin).max(2000),
  });

  const parsed = resolveContestSchema.safeParse({
    contestId: formData.get("contestId"),
    deliveryId: formData.get("deliveryId"),
    resolutionNote: formData.get("resolutionNote"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.deliveries.invalidData };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("resolve_contest", {
    p_contest_id: parsed.data.contestId,
    p_resolution_note: parsed.data.resolutionNote,
  });

  if (error) {
    return { error: describeRpcError(error, t.deliveries.resolveContestFailed) };
  }

  revalidatePath(`/deliveries/${parsed.data.deliveryId}`);
  return { error: null };
}

export type RecordReturnState = { error: string | null };

const RETURN_REASON_CODES = ["WORN_OUT", "REPLACED", "TERMINATION", "OTHER"] as const;
const RETURN_CONDITION_CODES = ["REUSABLE", "DAMAGED", "DISCARDED", "OTHER"] as const;

/**
 * Records a devolução (return) of one delivery line item via api.return_epi_item.
 * Manager-facing only -- no worker confirmation, no sealed evidence (product decision,
 * see the migration's own header comment). The RPC itself enforces the delivery being
 * CONFIRMED and rejects a second return of the same item (already_returned); this action
 * surfaces both as the ordinary error state rather than treating them as exceptional.
 */
export async function recordEpiReturn(
  _prevState: RecordReturnState,
  formData: FormData,
): Promise<RecordReturnState> {
  const t = getDictionary(await getLocale());
  const schema = z.object({
    deliveryItemId: z.uuid(),
    deliveryId: z.uuid(),
    returnedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, t.deliveries.invalidDate),
    reasonCode: z.enum(RETURN_REASON_CODES),
    conditionCode: z.enum(RETURN_CONDITION_CODES),
    note: z.string().trim().max(2000).optional(),
  });

  const parsed = schema.safeParse({
    deliveryItemId: formData.get("deliveryItemId"),
    deliveryId: formData.get("deliveryId"),
    returnedOn: formData.get("returnedOn"),
    reasonCode: formData.get("reasonCode"),
    conditionCode: formData.get("conditionCode"),
    note: formData.get("note") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.deliveries.invalidData };
  }
  if (parsed.data.reasonCode === "OTHER" && (!parsed.data.note || parsed.data.note.length < 3)) {
    return { error: t.deliveries.returnOtherNeedsNote };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("return_epi_item", {
    p_delivery_item_id: parsed.data.deliveryItemId,
    p_returned_on: parsed.data.returnedOn,
    p_reason_code: parsed.data.reasonCode,
    p_note: parsed.data.note || null,
    p_condition_code: parsed.data.conditionCode,
  });

  if (error) {
    return { error: describeRpcError(error, t.deliveries.returnFailed) };
  }

  revalidatePath(`/deliveries/${parsed.data.deliveryId}`);
  revalidatePath("/ficha", "layout");
  return { error: null };
}
