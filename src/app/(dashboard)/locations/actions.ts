"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

export type LocationFormState = { error: string | null };

/** Creates a location ("local/unidade") via api.create_location. Street/city are folded
 * into the jsonb p_address parameter -- see location-form.tsx's own comment on why this
 * stays two plain inputs rather than a full address builder. */
export async function createLocation(_prevState: LocationFormState, formData: FormData): Promise<LocationFormState> {
  const t = getDictionary(await getLocale());
  const createSchema = z.object({
    companyId: z.uuid(),
    name: z.string().trim().min(2, t.locations.nameTooShort).max(150),
    code: z.string().trim().max(40).optional(),
    street: z.string().trim().max(200).optional(),
    city: z.string().trim().max(120).optional(),
  });

  const parsed = createSchema.safeParse({
    companyId: formData.get("companyId"),
    name: formData.get("name"),
    code: formData.get("code") || undefined,
    street: formData.get("street") || undefined,
    city: formData.get("city") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.locations.invalidData };
  }

  const address: Record<string, string> = {};
  if (parsed.data.street) address.street = parsed.data.street;
  if (parsed.data.city) address.city = parsed.data.city;

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("create_location", {
    p_company_id: parsed.data.companyId,
    p_name: parsed.data.name,
    p_code: parsed.data.code || null,
    p_address: address,
  });

  if (error) {
    return { error: describeRpcError(error, t.locations.createFailed) };
  }

  revalidatePath("/locations");
  redirect(`/locations?company=${parsed.data.companyId}`);
}

/** Edits a location in place via api.update_location. */
export async function updateLocation(_prevState: LocationFormState, formData: FormData): Promise<LocationFormState> {
  const t = getDictionary(await getLocale());
  const updateSchema = z.object({
    locationId: z.uuid(),
    companyId: z.string().trim().optional(),
    name: z.string().trim().min(2, t.locations.nameTooShort).max(150),
    code: z.string().trim().max(40).optional(),
    street: z.string().trim().max(200).optional(),
    city: z.string().trim().max(120).optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]),
  });

  const parsed = updateSchema.safeParse({
    locationId: formData.get("locationId"),
    companyId: formData.get("companyId") || undefined,
    name: formData.get("name"),
    code: formData.get("code") || undefined,
    street: formData.get("street") || undefined,
    city: formData.get("city") || undefined,
    status: formData.get("status"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t.locations.invalidData };
  }

  const address: Record<string, string> = {};
  if (parsed.data.street) address.street = parsed.data.street;
  if (parsed.data.city) address.city = parsed.data.city;

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("update_location", {
    p_location_id: parsed.data.locationId,
    p_name: parsed.data.name,
    p_code: parsed.data.code || null,
    p_address: address,
    p_status: parsed.data.status,
  });

  if (error) {
    return { error: describeRpcError(error, t.locations.saveFailed) };
  }

  revalidatePath("/locations");
  revalidatePath(`/locations/${parsed.data.locationId}`);
  redirect(parsed.data.companyId ? `/locations?company=${parsed.data.companyId}` : "/locations");
}
