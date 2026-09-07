import "server-only";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { buildSignatureHeader } from "@/lib/crypto/webhook-secret";
import { BlockedAddressError, checkWebhookUrl, createPinnedLookup } from "./ssrf";

/**
 * One webhook HTTP attempt.
 *
 * Uses node:https rather than fetch for one specific reason: `https.request` accepts a
 * `lookup` hook, which lets us resolve DNS ourselves, validate EVERY returned address, and
 * connect to a validated address -- while TLS still uses the original hostname for SNI and
 * certificate verification. fetch has no equivalent hook, and the usual workaround
 * (rewriting the URL to an IP) breaks certificate validation, which would trade one security
 * property for another. See ssrf.ts for why validating at creation time alone is not enough.
 */

export const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2048;

export type DeliveryOutcome = {
  httpStatus: number | null;
  errorKind: "TIMEOUT" | "DNS" | "TLS" | "CONNECTION" | "BLOCKED" | "HTTP" | "REDIRECT" | null;
  errorDetail: string | null;
  latencyMs: number;
};

export type DeliveryInput = {
  url: string;
  /** Current secret first. During a rotation window the previous secret is included too, so
   * a subscriber that has not migrated yet can still verify. */
  secrets: readonly string[];
  envelope: unknown;
  eventId: string;
  eventType: string;
  deliveryId: string;
  timeoutMs?: number;
};

function classifyNetworkError(error: NodeJS.ErrnoException): DeliveryOutcome["errorKind"] {
  if (error instanceof BlockedAddressError) return "BLOCKED";
  const code = error.code ?? "";
  if (code === "EBLOCKED") return "BLOCKED";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA") return "DNS";
  if (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code === "EPROTO" ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT") return "TLS";
  return "CONNECTION";
}

export async function deliverWebhook(input: DeliveryInput): Promise<DeliveryOutcome> {
  const started = Date.now();

  // Re-validated on every attempt, not just at creation: an endpoint row could have been
  // written before a policy tightened, and the runner is the last gate before egress.
  const checked = checkWebhookUrl(input.url);
  if (!checked.ok) {
    return {
      httpStatus: null,
      errorKind: "BLOCKED",
      errorDetail: `url rejected: ${checked.reason}`,
      latencyMs: Date.now() - started,
    };
  }

  // Serialised ONCE. The exact bytes signed are the exact bytes sent -- re-serialising for
  // transmission would let key order or escaping differ from what was signed, and the
  // subscriber's verification would fail for reasons neither side could see.
  const body = JSON.stringify(input.envelope);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = buildSignatureHeader(input.secrets, body, timestamp);

  const pinnedLookup = createPinnedLookup(async (hostname) => {
    const entries = await dnsLookup(hostname, { all: true, verbatim: true });
    return entries.map((e) => ({ address: e.address, family: e.family }));
  });

  return new Promise<DeliveryOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: DeliveryOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: checked.url.hostname,
        port: 443,
        path: `${checked.url.pathname}${checked.url.search}`,
        method: "POST",
        lookup: pinnedLookup as never,
        // Redirects are never followed (see below), so no agent-level redirect config exists
        // to get wrong.
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "Selo-Webhooks/1.0",
          "Selo-Signature": signature,
          "Selo-Event-Id": input.eventId,
          "Selo-Event-Type": input.eventType,
          "Selo-Delivery": input.deliveryId,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let received = 0;

        res.on("data", (chunk: Buffer) => {
          // A hostile subscriber must not be able to fill our storage or memory with its
          // response, so everything past the cap is discarded rather than buffered.
          if (received < MAX_RESPONSE_BYTES) {
            chunks.push(chunk);
            received += chunk.length;
          }
        });

        res.on("end", () => {
          const preview = Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString("utf8");
          // 3xx is a permanent failure, never a hop. Following a redirect would re-open SSRF
          // after every address check has already passed -- the attacker points a public
          // host at 169.254.169.254 and the pinned lookup never sees it.
          const kind = status >= 300 && status < 400 ? "REDIRECT" : status >= 200 && status < 300 ? null : "HTTP";
          finish({
            httpStatus: status,
            errorKind: kind,
            errorDetail: kind === null ? null : preview.slice(0, 2000),
            latencyMs: Date.now() - started,
          });
        });
      },
    );

    req.setTimeout(input.timeoutMs ?? WEBHOOK_TIMEOUT_MS, () => {
      req.destroy();
      finish({
        httpStatus: null,
        errorKind: "TIMEOUT",
        errorDetail: `no response within ${input.timeoutMs ?? WEBHOOK_TIMEOUT_MS}ms`,
        latencyMs: Date.now() - started,
      });
    });

    req.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        httpStatus: null,
        errorKind: classifyNetworkError(error),
        errorDetail: (error.message ?? "network error").slice(0, 2000),
        latencyMs: Date.now() - started,
      });
    });

    req.end(body);
  });
}
