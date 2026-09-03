"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

export type StockFormState = { error: string | null };

/** The only movement_type values this form ever offers. api.record_stock_movement's own
 * signature technically also accepts TRANSFERENCIA_SAIDA/TRANSFERENCIA_ENTRADA as manual
 * entry values, but this UI never sends them -- api.transfer_stock (transferStock, below)
 * is the only path this app ever uses to write those, always as an atomic pair. */
const MANUAL_MOVEMENT_TYPES = ["ENTRADA", "AJUSTE", "DESCARTE"] as const;

/**
 * Records a manual entrada/ajuste/descarte via api.record_stock_movement. ENTRADA/DESCARTE
 * are auto-signed by the RPC regardless of the sign submitted here; AJUSTE carries the
 * caller's own signed quantity (can be negative) -- see that migration's own comment, which
 * is why `quantity` here allows a negative value unlike every other quantity field in this
 * app (deliveries, transfers).
 */
export async function recordStockMovement(_prevState: StockFormState, formData: FormData): Promise<StockFormState> {
  const t = getDictionary(await getLocale());
  const schema = z.object({
    companyId: z.uuid(),
    locationId: z.uuid().optional(),
    epiId: z.uuid(),
    variantId: z.uuid().optional(),
    movementType: z.enum(MANUAL_MOVEMENT_TYPES),
    quantity: z.coerce
      .number()
      .int()
      .min(-100000)
      .max(100000)
      .refine((value) => value !== 0, { message: t.stock.invalidData }),
    reason: z.string().trim().max(500).optional(),
  });

  const parsed = schema.safeParse({
    companyId: formData.get("companyId"),
    locationId: formData.get("locationId") || undefined,
    epiId: formData.get("epiId"),
    variantId: formData.get("variantId") || undefined,
    movementType: formData.get("movementType"),
    quantity: formData.get("quantity"),
    reason: formData.get("reason") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.stock.invalidData };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("record_stock_movement", {
    p_company_id: parsed.data.companyId,
    p_location_id: parsed.data.locationId ?? null,
    p_epi_id: parsed.data.epiId,
    p_variant_id: parsed.data.variantId ?? null,
    p_movement_type: parsed.data.movementType,
    p_quantity: parsed.data.quantity,
    p_reason: parsed.data.reason || null,
  });

  if (error) {
    return { error: describeRpcError(error, t.stock.recordFailed) };
  }

  revalidatePath("/stock");
  redirect(`/stock?company=${parsed.data.companyId}`);
}

export type TransferFormState = { error: string | null };

/**
 * Transfers stock between two locations atomically via api.transfer_stock -- the only path
 * that ever writes TRANSFERENCIA_SAIDA/TRANSFERENCIA_ENTRADA rows. A blank from/to location
 * means the company-wide bucket (location_id NULL), same convention as everywhere else in
 * this file; the RPC itself rejects same-bucket transfers (including NULL vs NULL, via `is
 * not distinct from`), surfaced here as the ordinary error state rather than a client-side
 * pre-check -- same discipline as cancelDelivery's own comment about letting the RPC be the
 * enforcement.
 */
export async function transferStock(_prevState: TransferFormState, formData: FormData): Promise<TransferFormState> {
  const t = getDictionary(await getLocale());
  const schema = z.object({
    companyId: z.uuid(),
    fromLocationId: z.uuid().optional(),
    toLocationId: z.uuid().optional(),
    epiId: z.uuid(),
    variantId: z.uuid().optional(),
    quantity: z.coerce.number().int().min(1).max(100000),
    reason: z.string().trim().max(500).optional(),
  });

  const parsed = schema.safeParse({
    companyId: formData.get("companyId"),
    fromLocationId: formData.get("fromLocationId") || undefined,
    toLocationId: formData.get("toLocationId") || undefined,
    epiId: formData.get("epiId"),
    variantId: formData.get("variantId") || undefined,
    quantity: formData.get("quantity"),
    reason: formData.get("reason") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.stock.invalidData };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("transfer_stock", {
    p_company_id: parsed.data.companyId,
    p_from_location_id: parsed.data.fromLocationId ?? null,
    p_to_location_id: parsed.data.toLocationId ?? null,
    p_epi_id: parsed.data.epiId,
    p_variant_id: parsed.data.variantId ?? null,
    p_quantity: parsed.data.quantity,
    p_reason: parsed.data.reason || null,
  });

  if (error) {
    return { error: describeRpcError(error, t.stock.transferFailed) };
  }

  revalidatePath("/stock");
  redirect(`/stock?company=${parsed.data.companyId}`);
}
