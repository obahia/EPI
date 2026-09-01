"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { generateWorkerToken, hashWorkerToken } from "@/lib/crypto/worker-token";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

/**
 * Mass-delivery creation (docs/mvp-roadmap.md FASE 6). Node generates one worker token per
 * targeted employee -- fast, in-memory, no I/O -- and sends only the hashes to
 * api.create_delivery_batch, which creates every delivery/item/confirmation_request in ONE
 * set-based statement. The raw tokens exist only for this single response: returned to the
 * client as {employeeFullName, path}[] so the manager can copy/export them, never persisted
 * server-side beyond this call.
 */

export type CreateBatchState = {
  error: string | null;
  links: { employeeFullName: string; path: string }[] | null;
  batchId: string | null;
};

const itemSchema = z.object({
  epiId: z.uuid(),
  quantity: z.coerce.number().int().min(1).max(10000),
});

export async function createDeliveryBatch(
  _prevState: CreateBatchState,
  formData: FormData,
): Promise<CreateBatchState> {
  const t = getDictionary(await getLocale());
  const createBatchSchema = z.object({
    companyId: z.uuid(),
    deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, t.deliveries.invalidDate),
    note: z.string().trim().max(2000).optional(),
  });

  const parsed = createBatchSchema.safeParse({
    companyId: formData.get("companyId"),
    deliveryDate: formData.get("deliveryDate"),
    note: formData.get("note") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.deliveries.invalidData, links: null, batchId: null };
  }

  const epiIds = formData.getAll("epiId");
  const quantities = formData.getAll("quantity");
  if (epiIds.length === 0) {
    return { error: t.deliveries.batchSelectAtLeastOneEpi, links: null, batchId: null };
  }
  const items: { epi_id: string; quantity: number }[] = [];
  for (let i = 0; i < epiIds.length; i++) {
    const parsedItem = itemSchema.safeParse({ epiId: epiIds[i], quantity: quantities[i] });
    if (!parsedItem.success) {
      return { error: t.deliveries.batchInvalidItemLine, links: null, batchId: null };
    }
    items.push({ epi_id: parsedItem.data.epiId, quantity: parsedItem.data.quantity });
  }

  const employeeIds = formData.getAll("employeeId").map(String);
  const employeeNames = formData.getAll("employeeFullName").map(String);
  if (employeeIds.length === 0) {
    return { error: t.deliveries.batchSelectAtLeastOneEmployee, links: null, batchId: null };
  }
  if (employeeIds.length > 20000) {
    return { error: t.deliveries.batchMaxEmployees, links: null, batchId: null };
  }

  const tokensByEmployee = employeeIds.map((employeeId, i) => {
    const token = generateWorkerToken();
    return {
      employeeId,
      employeeFullName: employeeNames[i] ?? employeeId,
      token,
      tokenHashB64: hashWorkerToken(token).toString("base64"),
    };
  });

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .rpc("create_delivery_batch", {
      p_company_id: parsed.data.companyId,
      p_epi_items: items,
      p_confirmations: tokensByEmployee.map((tok) => ({ employee_id: tok.employeeId, token_hash_b64: tok.tokenHashB64 })),
      p_delivery_date: parsed.data.deliveryDate,
      p_note: parsed.data.note || null,
    })
    .single();

  if (error || !data) {
    return { error: describeRpcError(error!, t.deliveries.batchCreateFailed), links: null, batchId: null };
  }

  const row = data as { batch_id: string; delivery_count: number };

  revalidatePath("/deliveries");
  return {
    error: null,
    batchId: row.batch_id,
    links: tokensByEmployee.map((tok) => ({ employeeFullName: tok.employeeFullName, path: `/e/${tok.token}` })),
  };
}

export type ResendBatchState = {
  error: string | null;
  links: { employeeFullName: string; path: string }[] | null;
};

const resendBatchSchema = z.object({ batchId: z.uuid() });

/** Resends every STILL-PENDING delivery in a batch -- api.resend_batch_pending silently
 * skips anything already CONFIRMED/CONTESTED. Node re-generates a fresh token per delivery
 * (never reuses an old one), same discipline as api.create_confirmation_link's regenerate.
 * Returns the NEW links -- a resend whose fresh links nobody can then see would defeat its
 * own purpose, so this deliberately does NOT redirect away before handing them back. */
export async function resendBatchPending(_prevState: ResendBatchState, formData: FormData): Promise<ResendBatchState> {
  const t = getDictionary(await getLocale());
  const parsed = resendBatchSchema.safeParse({ batchId: formData.get("batchId") });
  if (!parsed.success) {
    return { error: t.deliveries.invalidData, links: null };
  }

  const supabase = await createClient();

  const { data: deliveries, error: listError } = await supabase
    .schema("api")
    .from("epi_deliveries")
    .select("id, employee_full_name")
    .eq("batch_id", parsed.data.batchId);

  if (listError || !deliveries) {
    return { error: t.deliveries.batchLoadFailed, links: null };
  }

  const tokensByDelivery = (deliveries as { id: string; employee_full_name: string }[]).map((d) => {
    const token = generateWorkerToken();
    return {
      deliveryId: d.id,
      employeeFullName: d.employee_full_name,
      token,
      tokenHashB64: hashWorkerToken(token).toString("base64"),
    };
  });

  const { data, error } = await supabase
    .schema("api")
    .rpc("resend_batch_pending", {
      p_batch_id: parsed.data.batchId,
      p_confirmations: tokensByDelivery.map((tok) => ({ delivery_id: tok.deliveryId, token_hash_b64: tok.tokenHashB64 })),
    });

  if (error) {
    return { error: describeRpcError(error, t.deliveries.batchResendFailed), links: null };
  }

  const resentDeliveryIds = new Set((data as { delivery_id: string }[]).map((r) => r.delivery_id));

  revalidatePath(`/deliveries/batches/${parsed.data.batchId}`);
  return {
    error: null,
    links: tokensByDelivery
      .filter((tok) => resentDeliveryIds.has(tok.deliveryId))
      .map((tok) => ({ employeeFullName: tok.employeeFullName, path: `/e/${tok.token}` })),
  };
}
