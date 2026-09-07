import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { createMachineClient } from "@/lib/supabase/machine-client";

/**
 * Daily cleanup. Expires idempotency records (24h TTL), settled webhook deliveries and
 * their attempts (30 days), fanned-out outbox rows with no remaining deliveries, and stale
 * quota counters.
 *
 * audit.audit_events is NEVER touched here. It is the source the outbox projects from, it
 * is append-only, and it has no retention policy -- purging the projection must never be
 * confused with purging the record.
 */
export const runtime = "nodejs";
export const maxDuration = 300;
export const preferredRegion = "gru1";

function isAuthorized(request: NextRequest): boolean {
  const provided = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const expected = process.env.CRON_SECRET ?? process.env.WEBHOOK_RUNNER_SECRET ?? "";
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const supabase = createMachineClient();
  const { data, error } = await supabase.schema("ops_rpc").rpc("purge_expired");

  if (error) {
    console.error("[maintenance] purge failed", error.message);
    return new Response(JSON.stringify({ error: "purge_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  return new Response(JSON.stringify({ purged: data }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
