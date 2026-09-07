import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { createMachineClient } from "@/lib/supabase/machine-client";
import { decryptWebhookSecret } from "@/lib/crypto/webhook-secret";
import { deliverWebhook } from "@/lib/webhooks/deliver";

/**
 * The webhook runner. Invoked by Vercel Cron (see vercel.json) once a minute.
 *
 * WHY THIS SHAPE. The runner does claim -> HTTP -> report as three separate short calls, so
 * no transaction is ever held open across network I/O. FOR UPDATE SKIP LOCKED runs entirely
 * inside ops_rpc.claim_webhook_batch, which means two overlapping cron invocations can never
 * pick up the same delivery -- and a stateless serverless function is therefore a perfectly
 * adequate host for a queue drainer, despite the usual assumption that it is not.
 *
 * The confirmation path is completely unaware of this route. If the runner is down, or this
 * deployment is missing entirely, deliveries still confirm and evidence still seals -- the
 * outbox simply accumulates durably and drains on recovery.
 */
export const runtime = "nodejs";
export const maxDuration = 300;
export const preferredRegion = "gru1";

/** 50 x 10s timeout / 8 concurrent = ~63s worst case, comfortably inside maxDuration. */
const BATCH_SIZE = 50;
const CONCURRENCY = 8;

type ClaimedDelivery = {
  delivery_id: string;
  endpoint_id: string;
  attempt_no: number;
  url: string;
  secret_enc_b64: string;
  secret_prev_enc_b64: string | null;
  envelope: { id: string; type: string } & Record<string, unknown>;
};

function isAuthorized(request: NextRequest): boolean {
  const provided = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const expected = process.env.CRON_SECRET ?? process.env.WEBHOOK_RUNNER_SECRET ?? "";
  // No secret configured means the route is closed, not open. Failing open here would
  // expose queue draining and DLQ state to anyone who guessed the path.
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function runBatch(): Promise<{ claimed: number; succeeded: number; failed: number }> {
  const supabase = createMachineClient();

  const { data: claim, error: claimError } = await supabase
    .schema("ops_rpc")
    .rpc("claim_webhook_batch", { p_limit: BATCH_SIZE });

  if (claimError) throw new Error(`claim failed: ${claimError.message}`);

  const deliveries = ((claim as { deliveries: ClaimedDelivery[] } | null)?.deliveries ?? []);
  if (deliveries.length === 0) return { claimed: 0, succeeded: 0, failed: 0 };

  let succeeded = 0;
  let failed = 0;

  // A fixed-size worker pool rather than Promise.all over the whole batch: one slow
  // subscriber must not be able to hold 50 sockets open at once.
  const queue = [...deliveries];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;

      const secrets = [decryptWebhookSecret(Buffer.from(item.secret_enc_b64, "base64"))];
      if (item.secret_prev_enc_b64) {
        // Rotation overlap: sign with both so a subscriber mid-migration can verify either.
        secrets.push(decryptWebhookSecret(Buffer.from(item.secret_prev_enc_b64, "base64")));
      }

      const outcome = await deliverWebhook({
        url: item.url,
        secrets,
        envelope: item.envelope,
        eventId: item.envelope.id,
        eventType: item.envelope.type,
        deliveryId: item.delivery_id,
      });

      if (outcome.httpStatus !== null && outcome.httpStatus >= 200 && outcome.httpStatus < 300) {
        succeeded += 1;
      } else {
        failed += 1;
      }

      const { error: reportError } = await supabase.schema("ops_rpc").rpc("report_webhook_result", {
        p_delivery_id: item.delivery_id,
        p_attempt_no: item.attempt_no,
        p_http_status: outcome.httpStatus,
        p_error_kind: outcome.errorKind,
        p_error_detail: outcome.errorDetail,
        p_latency_ms: outcome.latencyMs,
      });

      // A failed report leaves the delivery IN_FLIGHT. That is recoverable -- the next run
      // will not re-claim it, but an operator can see it in the panel -- and it is far
      // better than retrying the HTTP call and delivering twice.
      if (reportError) {
        console.error(
          `[webhook-runner] report failed delivery=${item.delivery_id} attempt=${item.attempt_no}: ${reportError.message}`,
        );
      }
    }
  });

  await Promise.all(workers);
  return { claimed: deliveries.length, succeeded, failed };
}

export async function GET(request: NextRequest) {
  // Vercel Cron issues GET. POST is accepted too so the route can be triggered manually
  // during an incident without pretending to be the scheduler.
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest): Promise<Response> {
  if (!isAuthorized(request)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  try {
    const result = await runBatch();
    const supabase = createMachineClient();
    const { data: health } = await supabase.schema("ops_rpc").rpc("webhook_health");

    // Surfaced so an uptime check can alert on it: a growing oldest_pending_seconds is the
    // signal that the runner has stopped, and nothing else in the product would fail.
    return new Response(JSON.stringify({ ...result, health }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[webhook-runner] batch failed", error);
    return new Response(JSON.stringify({ error: "runner_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}
