import { z } from "zod";
import type { NextRequest } from "next/server";
import { handleRpcError, withApiKey } from "@/lib/api/handler";

/**
 * /api/v1/locations. NOT in spec §19's list -- included solely because employees:write
 * accepts a location_id and a client has no other way to discover one. If employees:write
 * is ever withdrawn, this endpoint and the locations:read scope go with it.
 *
 * company_id is required, unlike positions: app.locations.company_id is NOT NULL, so there
 * is no org-wide tier to fall back to.
 */
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return withApiKey(request, "read", async (ctx) => {
    const companyId = ctx.url.searchParams.get("company_id");
    if (!companyId || !z.uuid().safeParse(companyId).success) {
      return { kind: "error", type: "invalid_request", details: { company_id: "required uuid" } };
    }

    const { data, error } = await ctx.supabase.schema("m2m_rpc").rpc("list_locations", {
      p_key_id: ctx.keyId,
      p_secret_hash_b64: ctx.secretHashB64,
      p_company_id: companyId,
      p_limit: 200,
      p_client_ip: ctx.clientIp,
    });

    if (error) return handleRpcError(error, ctx.requestId, ctx.keyId);
    return { kind: "ok", status: 200, body: data };
  });
}
