import { z } from "zod";
import type { NextRequest } from "next/server";
import { handleRpcError, withApiKey } from "@/lib/api/handler";

export const runtime = "nodejs";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/deliveries/[id]">) {
  const { id } = await ctx.params;
  return withApiKey(request, "read", async (c) => {
    if (!z.uuid().safeParse(id).success) {
      return { kind: "error", type: "not_found" };
    }

    const { data, error } = await c.supabase.schema("m2m_rpc").rpc("get_delivery", {
      p_key_id: c.keyId,
      p_secret_hash_b64: c.secretHashB64,
      p_delivery_id: id,
      p_client_ip: c.clientIp,
    });

    if (error) return handleRpcError(error, c.requestId, c.keyId);
    return { kind: "ok", status: 200, body: data };
  });
}
