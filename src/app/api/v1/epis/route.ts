import { z } from "zod";
import type { NextRequest } from "next/server";
import { handleRpcError, withApiKey } from "@/lib/api/handler";

/**
 * /api/v1/epis -- spec §19's "ppe". Returns the CURRENT catalog version only. The SCD2
 * history behind app.epi_versions is not exposed: nobody asked for it, and §19 is explicit
 * that endpoints must not exist merely because they are easy to build.
 */
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return withApiKey(request, "read", async (ctx) => {
    const companyId = ctx.url.searchParams.get("company_id");
    if (companyId !== null && !z.uuid().safeParse(companyId).success) {
      return { kind: "error", type: "invalid_request", details: { company_id: "uuid" } };
    }

    const { data, error } = await ctx.supabase.schema("m2m_rpc").rpc("list_epis", {
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
