import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PostgrestError } from "@supabase/supabase-js";
import { hashApiKeySecret, parseAuthorizationHeader, publicKeyPrefix } from "@/lib/crypto/api-key";
import { createMachineClient } from "@/lib/supabase/machine-client";
import { apiErrorShape, errorBody, mapRpcError, type ApiErrorType } from "./errors";

/**
 * The single entry path for every /api/v1 route handler. Everything that must happen on
 * every request -- request id, key parsing, hashing, error mapping, header discipline --
 * happens here exactly once, so no endpoint can forget a step.
 *
 * What this file must never do: log the Authorization header, echo a submitted value back
 * in an error, or let a Postgres message reach the client. Those are enforced by
 * construction below and asserted by the API integration tests.
 */

export type MachineRequestContext = {
  requestId: string;
  keyId: string;
  secretHashB64: string;
  /** Public half of the key, safe to log and to correlate with an audit event. */
  keyPrefix: string;
  clientIp: string | null;
  supabase: ReturnType<typeof createMachineClient>;
  url: URL;
};

export type HandlerResult =
  | { kind: "ok"; status: number; body: unknown; extraHeaders?: Record<string, string> }
  | { kind: "error"; type: ApiErrorType; details?: unknown };

/**
 * Only the FIRST entry of X-Forwarded-For is meaningful, and only because the platform
 * appends the true peer address. Used for the usage stamp and for the auth-failure throttle
 * -- never for authorization, which is why a spoofed value here cannot grant anything.
 */
function readClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip");
}

/** Rate-limit ceilings, mirroring m2m.authorize. Kept in sync deliberately by being stated
 * in both places rather than plumbed through a response field: see the note on
 * X-RateLimit-Remaining below. */
const LIMITS = { read: 600, write: 60 } as const;

function rateLimitHeaders(kind: "read" | "write", remaining?: number): Record<string, string> {
  const now = Date.now();
  const resetSeconds = Math.ceil((Math.floor(now / 60_000) + 1) * 60_000 / 1000);
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(LIMITS[kind]),
    "X-RateLimit-Reset": String(resetSeconds),
  };
  // X-RateLimit-Remaining is emitted only when it is actually known -- on a 429, where it is
  // zero. On a successful call the exact remaining count lives inside the single RPC
  // transaction and surfacing it would cost either a second round trip per request or a
  // composite-type change threaded through every m2m_rpc function. Reporting an
  // approximation would be worse than omitting it, so it is omitted.
  if (remaining !== undefined) headers["X-RateLimit-Remaining"] = String(remaining);
  return headers;
}

export function canonicalRequestHash(payload: unknown): string {
  // Stable key order so an identical logical request always hashes the same, and a body
  // that differs in any value does not. This is NOT epi-canon -- it never touches evidence,
  // and its only job is to answer "is this the same request as before".
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("base64");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export async function withApiKey(
  request: Request,
  kind: "read" | "write",
  handler: (ctx: MachineRequestContext) => Promise<HandlerResult>,
): Promise<Response> {
  const requestId = randomUUID();
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
    "Cache-Control": "no-store",
  };

  const parsed = parseAuthorizationHeader(request.headers.get("authorization"));
  if (!parsed) {
    const shape = apiErrorShape("unauthorized");
    return new Response(JSON.stringify(errorBody(shape, requestId)), {
      status: shape.status,
      headers: { ...baseHeaders, "WWW-Authenticate": "Bearer" },
    });
  }

  let result: HandlerResult;
  try {
    result = await handler({
      requestId,
      keyId: parsed.keyId,
      secretHashB64: hashApiKeySecret(parsed.secret).toString("base64"),
      keyPrefix: publicKeyPrefix(parsed),
      clientIp: readClientIp(request),
      supabase: createMachineClient(),
      url: new URL(request.url),
    });
  } catch (error) {
    // An exception that escapes a handler is a bug in our code, not a client error. It is
    // reported as an opaque 500 with the request id, and the detail stays in our logs.
    console.error(`[api/v1] unhandled error request_id=${requestId} key=${parsed.keyId}`, error);
    const shape = apiErrorShape("internal_error");
    return new Response(JSON.stringify(errorBody(shape, requestId)), {
      status: shape.status,
      headers: baseHeaders,
    });
  }

  if (result.kind === "error") {
    const shape = apiErrorShape(result.type);
    const extra = result.type === "rate_limited" ? rateLimitHeaders(kind, 0) : {};
    if (result.type === "rate_limited") extra["Retry-After"] = "60";
    return new Response(JSON.stringify(errorBody(shape, requestId, result.details)), {
      status: shape.status,
      headers: { ...baseHeaders, ...extra },
    });
  }

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...baseHeaders, ...rateLimitHeaders(kind), ...(result.extraHeaders ?? {}) },
  });
}

/** Translates a Postgrest failure into the public contract, alerting on anything unmapped. */
export function handleRpcError(error: PostgrestError, requestId: string, keyId: string): HandlerResult {
  const { shape, unmapped } = mapRpcError(error);
  if (unmapped) {
    console.error(
      `[api/v1] unmapped database signal request_id=${requestId} key=${keyId} code=${error.code} message=${error.message}`,
    );
  }
  return { kind: "error", type: shape.type };
}
