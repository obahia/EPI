import { z } from "zod";
import type { NextRequest } from "next/server";
import { normalizePhoneE164 } from "@/lib/br/phone";
import { canonicalRequestHash, handleRpcError, withApiKey } from "@/lib/api/handler";

export const runtime = "nodejs";

// CPF is absent from this schema and there is no path that adds it. A worker's CPF is the
// anchor of every receipt already sealed for them; letting a machine rewrite it has no
// legitimate use case that outweighs that.
const patchSchema = z.object({
  full_name: z.string().trim().min(2).max(150),
  registration_number: z.string().trim().max(40).nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.email().max(254).nullish(),
  status: z.enum(["ACTIVE", "ON_LEAVE", "TERMINATED"]),
  position_id: z.uuid().nullish(),
  location_id: z.uuid().nullish(),
});

export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/employees/[id]">) {
  const { id } = await ctx.params;
  return withApiKey(request, "read", async (c) => {
    if (!z.uuid().safeParse(id).success) {
      // A malformed id is answered as not_found rather than invalid_request, so probing with
      // junk cannot be distinguished from probing with a well-formed id that belongs to
      // someone else.
      return { kind: "error", type: "not_found" };
    }

    const { data, error } = await c.supabase.schema("m2m_rpc").rpc("get_employee", {
      p_key_id: c.keyId,
      p_secret_hash_b64: c.secretHashB64,
      p_employee_id: id,
      p_client_ip: c.clientIp,
    });

    if (error) return handleRpcError(error, c.requestId, c.keyId);
    return { kind: "ok", status: 200, body: data };
  });
}

export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/v1/employees/[id]">) {
  const { id } = await ctx.params;
  return withApiKey(request, "write", async (c) => {
    if (!z.uuid().safeParse(id).success) {
      return { kind: "error", type: "not_found" };
    }

    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 255) {
      return {
        kind: "error",
        type: "invalid_request",
        details: { "Idempotency-Key": "required header, 8..255 characters" },
      };
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return { kind: "error", type: "invalid_request" };
    }

    const parsed = patchSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        kind: "error",
        type: "validation_error",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
      };
    }

    let phoneE164: string | null = null;
    if (parsed.data.phone) {
      phoneE164 = normalizePhoneE164(parsed.data.phone);
      if (!phoneE164) {
        return { kind: "error", type: "validation_error", details: [{ path: "phone", code: "invalid_phone" }] };
      }
    }

    // The employee id is part of the hash: the same Idempotency-Key aimed at a different
    // employee is a different request and must conflict rather than silently replay the
    // first one's response.
    const requestHash = canonicalRequestHash({ id, ...parsed.data });

    const { data, error } = await c.supabase.schema("m2m_rpc").rpc("update_employee", {
      p_key_id: c.keyId,
      p_secret_hash_b64: c.secretHashB64,
      p_idempotency_key: idempotencyKey,
      p_request_hash_b64: requestHash,
      p_employee_id: id,
      p_full_name: parsed.data.full_name,
      p_registration_number: parsed.data.registration_number ?? null,
      p_phone_e164: phoneE164,
      p_email: parsed.data.email ?? null,
      p_status: parsed.data.status,
      p_position_id: parsed.data.position_id ?? null,
      p_location_id: parsed.data.location_id ?? null,
      p_client_ip: c.clientIp,
    });

    if (error) return handleRpcError(error, c.requestId, c.keyId);

    const result = data as { replayed: boolean; status: number; body: unknown };
    return {
      kind: "ok",
      status: result.status,
      body: result.body,
      extraHeaders: result.replayed ? { "Idempotency-Replayed": "true" } : {},
    };
  });
}
