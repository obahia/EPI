import "server-only";
import { randomUUID } from "node:crypto";

/**
 * Minimum viable production observability, and deliberately nothing more.
 *
 * The Pilot Readiness audit found six logging call sites in the whole application and no
 * alerting: if a pilot customer hit an error, nobody would know. This module is the smallest
 * thing that fixes the part that does not need a vendor -- one structured event per failure,
 * on one line, with enough identity to find the row and none of the identity that would make
 * the log itself a privacy incident.
 *
 * WHAT THIS IS NOT: it is not a sink. Events go to stderr, which the host collects (Vercel
 * keeps them in Runtime Logs). Routing them somewhere that can page a human needs either a
 * paid plan or a third-party account, so that decision is left open rather than made here --
 * see docs/runbook-rollback.md §"Alerta".
 *
 * THE RULE THIS MODULE ENFORCES: an observability event may name WHAT failed and WHICH row it
 * failed on, never WHO the row is about. A CPF, a full name, a token, a signature, a payload
 * or a secret must never reach a log line, because logs are copied to places the database's
 * RLS does not reach. `context` is therefore not free-form: every value is passed through
 * sanitiseValue below, which admits identifiers and enums and drops everything else.
 */

/** The operations worth waking someone for. Deliberately a closed list: an event that cannot
 * be attributed to one of these is not a critical-path failure, and adding a member is a
 * decision rather than a typo. */
export type Operation =
  | "worker.open_link"
  | "worker.confirm"
  | "worker.contest"
  | "evidence.seal"
  | "evidence.verify"
  | "import.commit"
  | "job.webhook_runner"
  | "job.maintenance"
  | "api.v1"
  | "panel.action";

/** Values allowed to appear in an event. Anything else is dropped by name, so adding a field
 * cannot accidentally start logging a person. */
export type SafeContext = {
  /** Ties every event of one request or action together. */
  correlationId?: string;
  organizationId?: string;
  companyId?: string;
  deliveryId?: string;
  confirmationRequestId?: string;
  importRunId?: string;
  endpointId?: string;
  /** A domain signal like `insufficient_stock`, never a message written for a human. */
  signal?: string;
  /** Postgres SQLSTATE, HTTP status, or a count. */
  code?: string | number;
  count?: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A machine signal: starts with a LETTER, carries no dot, and is short.
 *
 * Each of those three came from a test that caught this module leaking. The first draft was
 * `/^[a-z0-9_.:-]{1,64}$/i`, which happily admitted "961.810.907-87" as a signal -- a CPF,
 * straight into a log line. Requiring a leading letter rejects a formatted CPF and any bare
 * digit run; banning the dot rejects a JWT ("eyJ….abc.def") and a dotted CPF; the 48-char cap
 * keeps a token or a base64 fragment out, since no real signal here is longer than
 * "evidence_payload_required" and the longest legitimate value is a platform request id.
 */
const SIGNAL_RE = /^[a-zA-Z][a-zA-Z0-9_:-]{0,47}$/;

/** SQLSTATE (23514), HTTP status (503). Short, and only ever digits or upper-case letters --
 * narrow enough that a CPF, which is eleven digits, cannot pass through it. */
const CODE_RE = /^[0-9A-Z]{3,5}$/;

/**
 * Admits an identifier, a short machine signal or a number. Anything else -- a name, a CPF, a
 * free-text note, a token, a base64 blob -- fails every shape and is dropped.
 *
 * Dropping silently is deliberate. Throwing would turn a logging mistake into an outage on the
 * very path that is already failing, and truncating would keep a prefix of exactly the thing
 * that must not be kept.
 */
function sanitiseValue(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  if (UUID_RE.test(value)) return value;
  if (CODE_RE.test(value)) return value;
  if (SIGNAL_RE.test(value)) return value;
  return null;
}

function sanitiseContext(context: SafeContext): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, raw] of Object.entries(context)) {
    const value = sanitiseValue(raw);
    if (value !== null) out[key] = value;
  }
  return out;
}

/**
 * An error reduced to what is safe and useful: its constructor name, and a message ONLY when
 * the message is a machine signal.
 *
 * A thrown message can carry anything -- a Postgres error can quote the offending row, and a
 * row here contains a person. So the message is admitted only if it looks like one of this
 * codebase's own domain signals (`insufficient_stock`, `no_live_platform_grant`, …); otherwise
 * the event carries the error's class and a digest that correlates it with the host's own
 * uncaught-error record, and the text stays out of the log.
 */
function describeError(error: unknown): Record<string, string | number> {
  if (error instanceof Error) {
    const named = SIGNAL_RE.test(error.message) ? error.message : null;
    const out: Record<string, string | number> = { errorName: error.name };
    if (named) out.errorSignal = named;
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string" || typeof digest === "number") out.errorDigest = digest;
    const code = (error as { code?: unknown }).code;
    const sanitisedCode = sanitiseValue(code);
    if (sanitisedCode !== null) out.errorCode = sanitisedCode;
    return out;
  }
  return { errorName: typeof error };
}

/** A correlation id for one request or one action. Prefers the platform's own request id so a
 * line here can be matched against the host's log for the same request. */
export function correlationIdFrom(headerValue: string | null | undefined): string {
  if (typeof headerValue === "string" && SIGNAL_RE.test(headerValue)) return headerValue;
  return randomUUID();
}

export type ObservabilityEvent = {
  ts: string;
  level: "error" | "warn";
  event: "operation_failed" | "operation_degraded";
  operation: Operation;
} & Record<string, string | number>;

/** Emitted as one line so a log search returns one hit per failure, not a stack fragment. */
function emit(event: ObservabilityEvent): void {
  // This IS the sink: every other module routes failures here rather than calling console.
  console.error(JSON.stringify(event));
}

/**
 * A critical-path operation failed. Use it where a failure means a worker could not confirm,
 * evidence could not be sealed, an import did not commit, or a scheduled job did not run --
 * the four places where silence is indistinguishable from success.
 */
export function reportFailure(operation: Operation, error: unknown, context: SafeContext = {}): string {
  const correlationId = context.correlationId ?? randomUUID();
  emit({
    ts: new Date().toISOString(),
    level: "error",
    event: "operation_failed",
    operation,
    ...sanitiseContext({ ...context, correlationId }),
    ...describeError(error),
  });
  return correlationId;
}

/** Something recoverable that should still be visible -- a retry, a partial import, a webhook
 * attempt that failed but will be tried again. */
export function reportDegraded(operation: Operation, context: SafeContext = {}): string {
  const correlationId = context.correlationId ?? randomUUID();
  emit({
    ts: new Date().toISOString(),
    level: "warn",
    event: "operation_degraded",
    operation,
    ...sanitiseContext({ ...context, correlationId }),
  });
  return correlationId;
}

/** Exported for the unit tests, which are the only reason to reach the redaction directly. */
export const __testing = { sanitiseValue, sanitiseContext, describeError };
