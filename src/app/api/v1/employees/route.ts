import { z } from "zod";
import type { NextRequest } from "next/server";
import { isValidCpf, maskCpf, onlyDigits } from "@/lib/br/cpf";
import { normalizePhoneE164 } from "@/lib/br/phone";
import { encryptCpf, hashCpf } from "@/lib/crypto/cpf-secrets";
import { canonicalRequestHash, handleRpcError, withApiKey } from "@/lib/api/handler";

/**
 * /api/v1/employees -- the anchor endpoint of the public API (spec §19).
 *
 * Node runtime, never Edge: this route touches CPF_HASH_PEPPER / CPF_ENCRYPTION_KEY /
 * API_KEY_PEPPER, and docs/architecture.md §19 requires Node for anything that does.
 */
export const runtime = "nodejs";

const createSchema = z.object({
  company_id: z.uuid(),
  full_name: z.string().trim().min(2).max(150),
  cpf: z.string().min(11).max(14),
  registration_number: z.string().trim().max(40).nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.email().max(254).nullish(),
  position_id: z.uuid().nullish(),
  location_id: z.uuid().nullish(),
  external_source: z.string().trim().max(120).nullish(),
  external_ref: z.string().trim().max(120).nullish(),
});

export async function GET(request: NextRequest) {
  return withApiKey(request, "read", async (ctx) => {
    const companyId = ctx.url.searchParams.get("company_id");
    if (!companyId || !z.uuid().safeParse(companyId).success) {
      // company_id is required rather than defaulting to "every company this key can see".
      // An implicit tenant scope is where cross-tenant leaks come from.
      return { kind: "error", type: "invalid_request", details: { company_id: "required uuid" } };
    }

    const limitRaw = ctx.url.searchParams.get("limit");
    const limit = limitRaw === null ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return { kind: "error", type: "invalid_request", details: { limit: "integer 1..100" } };
    }

    const { data, error } = await ctx.supabase.schema("m2m_rpc").rpc("list_employees", {
      p_key_id: ctx.keyId,
      p_secret_hash_b64: ctx.secretHashB64,
      p_company_id: companyId,
      p_cursor: ctx.url.searchParams.get("cursor"),
      p_limit: limit,
      p_updated_since: ctx.url.searchParams.get("updated_since"),
      p_status: ctx.url.searchParams.get("status"),
      p_client_ip: ctx.clientIp,
    });

    if (error) return handleRpcError(error, ctx.requestId, ctx.keyId);
    return { kind: "ok", status: 200, body: data };
  });
}

export async function POST(request: NextRequest) {
  return withApiKey(request, "write", async (ctx) => {
    const idempotencyKey = request.headers.get("idempotency-key");
    // Mandatory, not optional. An optional idempotency key is one nobody sends, and the
    // duplicate-write problem it exists to solve is silent when it happens.
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

    // Validation happens BEFORE the transaction on purpose: a malformed request must never
    // consume an Idempotency-Key, because the client will legitimately retry the corrected
    // request with the same key.
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        kind: "error",
        type: "validation_error",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
      };
    }

    const cpfDigits = onlyDigits(parsed.data.cpf);
    if (!isValidCpf(cpfDigits)) {
      return { kind: "error", type: "validation_error", details: [{ path: "cpf", code: "invalid_cpf" }] };
    }

    let phoneE164: string | null = null;
    if (parsed.data.phone) {
      phoneE164 = normalizePhoneE164(parsed.data.phone);
      if (!phoneE164) {
        return { kind: "error", type: "validation_error", details: [{ path: "phone", code: "invalid_phone" }] };
      }
    }

    // Hashed over the PARSED payload, not the raw bytes: two requests that differ only in
    // key order or whitespace are the same request, and should replay rather than conflict.
    const requestHash = canonicalRequestHash(parsed.data);

    const { data, error } = await ctx.supabase.schema("m2m_rpc").rpc("create_employee", {
      p_key_id: ctx.keyId,
      p_secret_hash_b64: ctx.secretHashB64,
      p_idempotency_key: idempotencyKey,
      p_request_hash_b64: requestHash,
      p_company_id: parsed.data.company_id,
      p_full_name: parsed.data.full_name,
      p_cpf_hash_b64: hashCpf(cpfDigits).toString("base64"),
      p_cpf_enc_b64: encryptCpf(cpfDigits).toString("base64"),
      p_cpf_masked: maskCpf(cpfDigits),
      p_registration_number: parsed.data.registration_number ?? null,
      p_phone_e164: phoneE164,
      p_email: parsed.data.email ?? null,
      p_position_id: parsed.data.position_id ?? null,
      p_location_id: parsed.data.location_id ?? null,
      p_external_source: parsed.data.external_source ?? null,
      p_external_ref: parsed.data.external_ref ?? null,
      p_client_ip: ctx.clientIp,
    });

    if (error) return handleRpcError(error, ctx.requestId, ctx.keyId);

    const result = data as { replayed: boolean; status: number; body: unknown };
    return {
      kind: "ok",
      status: result.status,
      body: result.body,
      extraHeaders: result.replayed ? { "Idempotency-Replayed": "true" } : {},
    };
  });
}
