import type { PostgrestError } from "@supabase/supabase-js";

/**
 * The /api/v1 error contract. `type` is a stable machine-readable slug and is part of the
 * v1 contract: it never changes meaning and is never removed while v1 exists. `message` is
 * guidance for a human reading a log, not contract, and never contains tenant data.
 */
export type ApiErrorType =
  | "invalid_request"
  | "unauthorized"
  | "insufficient_scope"
  | "tenant_forbidden"
  | "not_found"
  | "idempotency_key_reuse"
  | "conflict"
  | "validation_error"
  | "rate_limited"
  | "internal_error"
  | "service_unavailable";

export type ApiErrorShape = {
  status: number;
  type: ApiErrorType;
  message: string;
};

const ERRORS: Record<ApiErrorType, { status: number; message: string }> = {
  invalid_request: { status: 400, message: "The request could not be parsed." },
  unauthorized: { status: 401, message: "Invalid or missing API key." },
  insufficient_scope: { status: 403, message: "This API key lacks the required scope." },
  tenant_forbidden: { status: 403, message: "This API key is not bound to that company." },
  not_found: { status: 404, message: "Resource not found." },
  idempotency_key_reuse: {
    status: 409,
    message: "This Idempotency-Key was already used with a different request body.",
  },
  conflict: { status: 409, message: "The request conflicts with the current state." },
  validation_error: { status: 422, message: "One or more fields are invalid." },
  rate_limited: { status: 429, message: "Rate limit exceeded." },
  internal_error: { status: 500, message: "Internal error." },
  service_unavailable: { status: 503, message: "Service temporarily unavailable." },
};

export function apiErrorShape(type: ApiErrorType): ApiErrorShape {
  const { status, message } = ERRORS[type];
  return { status, type, message };
}

/**
 * Every failure mode of authentication maps to the SAME 401 -- missing header, malformed
 * key, unknown key_id, wrong secret, revoked key, expired key, revoked principal. A caller
 * with a valid key that merely lacks a scope gets 403 instead, because that is information
 * a legitimate integrator needs and that an attacker holding a valid key already has.
 */
const SIGNAL_MAP: ReadonlyArray<readonly [string, ApiErrorType]> = [
  ["unauthorized", "unauthorized"],
  ["insufficient_scope", "insufficient_scope"],
  ["tenant_forbidden", "tenant_forbidden"],
  ["rate_limited", "rate_limited"],
  ["not_found", "not_found"],
  ["idempotency_key_reuse", "idempotency_key_reuse"],
  ["idempotency_in_flight", "conflict"],
  ["invalid_request_hash", "invalid_request"],
  ["invalid_cursor", "invalid_request"],
  ["cpf_already_registered", "conflict"],
  ["position_not_found", "validation_error"],
  ["position_out_of_scope", "validation_error"],
  ["location_not_found", "validation_error"],
  ["location_out_of_scope", "validation_error"],
  ["unknown_scope", "validation_error"],
];

/**
 * Maps a signal raised by an m2m_rpc function to the public contract. An UNMAPPED signal is
 * deliberately 500, never passed through: without this rule, adding a new RAISE anywhere in
 * the database would silently publish an internal identifier as part of the public API.
 * `unmapped` is returned so the caller can raise an internal alert about it.
 */
export function mapRpcError(error: PostgrestError): { shape: ApiErrorShape; unmapped: boolean } {
  const message = error.message ?? "";

  // 55P03 is lock_timeout: a concurrent request with the same Idempotency-Key is still
  // running. Retrying is the correct client behaviour, so it is a conflict, not an error.
  if (error.code === "55P03") {
    return { shape: apiErrorShape("conflict"), unmapped: false };
  }

  for (const [signal, type] of SIGNAL_MAP) {
    if (message.includes(signal)) return { shape: apiErrorShape(type), unmapped: false };
  }

  return { shape: apiErrorShape("internal_error"), unmapped: true };
}

export type ApiErrorBody = {
  error: {
    type: ApiErrorType;
    message: string;
    request_id: string;
    details?: unknown;
  };
};

export function errorBody(shape: ApiErrorShape, requestId: string, details?: unknown): ApiErrorBody {
  return {
    error: {
      type: shape.type,
      message: shape.message,
      request_id: requestId,
      ...(details === undefined ? {} : { details }),
    },
  };
}
