import { z } from "zod";
import type { NextRequest } from "next/server";
import { handleRpcError, withApiKey } from "@/lib/api/handler";

/**
 * /api/v1/deliveries -- read only.
 *
 * There is no POST. Creating a delivery through the API was evaluated and left out of this
 * phase: it would only ever produce a DRAFT (issue is not exposed either), and §19 forbids
 * publishing an endpoint without a concrete requirement behind it. The deliveries:write
 * scope does not exist, so it cannot be granted by accident later without a migration.
 *
 * Nothing here exposes evidence: no canonical_bytes, no payload hash, no signature, no
 * identity factors. An API key must never be able to read -- let alone influence -- the
 * evidentiary record, which belongs to the worker path and the panel.
 */
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return withApiKey(request, "read", async (ctx) => {
    const companyId = ctx.url.searchParams.get("company_id");
    if (!companyId || !z.uuid().safeParse(companyId).success) {
      return { kind: "error", type: "invalid_request", details: { company_id: "required uuid" } };
    }

    const employeeId = ctx.url.searchParams.get("employee_id");
    if (employeeId !== null && !z.uuid().safeParse(employeeId).success) {
      return { kind: "error", type: "invalid_request", details: { employee_id: "uuid" } };
    }

    const limitRaw = ctx.url.searchParams.get("limit");
    const limit = limitRaw === null ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return { kind: "error", type: "invalid_request", details: { limit: "integer 1..100" } };
    }

    const { data, error } = await ctx.supabase.schema("m2m_rpc").rpc("list_deliveries", {
      p_key_id: ctx.keyId,
      p_secret_hash_b64: ctx.secretHashB64,
      p_company_id: companyId,
      p_employee_id: employeeId,
      p_status: ctx.url.searchParams.get("status"),
      p_since: ctx.url.searchParams.get("since"),
      p_cursor: ctx.url.searchParams.get("cursor"),
      p_limit: limit,
      p_client_ip: ctx.clientIp,
    });

    if (error) return handleRpcError(error, ctx.requestId, ctx.keyId);
    return { kind: "ok", status: 200, body: data };
  });
}
