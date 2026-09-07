import { z } from "zod";
import type { NextRequest } from "next/server";
import { handleRpcError, withApiKey } from "@/lib/api/handler";

/**
 * /api/v1/positions -- spec §19's "roles". Also a hard dependency of employees:write: a
 * client cannot send a position_id it has no way to discover. company_id is optional here
 * because the position catalog legitimately has an org-wide tier (app.job_positions with
 * company_id IS NULL).
 */
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return withApiKey(request, "read", async (ctx) => {
    const companyId = ctx.url.searchParams.get("company_id");
    if (companyId !== null && !z.uuid().safeParse(companyId).success) {
      return { kind: "error", type: "invalid_request", details: { company_id: "uuid" } };
    }

    const { data, error } = await ctx.supabase.schema("m2m_rpc").rpc("list_positions", {
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
