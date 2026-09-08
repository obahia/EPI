import { describe, expect, it } from "vitest";
import { canonicalRequestHash } from "./handler";
import { apiErrorShape, errorBody, mapRpcError } from "./errors";

/**
 * The request hash decides whether a retry replays or conflicts, so its stability is part
 * of the idempotency contract rather than an implementation detail.
 */
describe("canonicalRequestHash", () => {
  it("is stable regardless of key order", () => {
    expect(canonicalRequestHash({ a: 1, b: 2 })).toBe(canonicalRequestHash({ b: 2, a: 1 }));
  });

  it("is stable for nested objects and arrays", () => {
    const a = { outer: { z: [1, 2, { k: "v" }], a: true } };
    const b = { outer: { a: true, z: [1, 2, { k: "v" }] } };
    expect(canonicalRequestHash(a)).toBe(canonicalRequestHash(b));
  });

  it("changes when any value changes", () => {
    expect(canonicalRequestHash({ a: 1 })).not.toBe(canonicalRequestHash({ a: 2 }));
  });

  it("treats array ORDER as significant -- [1,2] is not the same request as [2,1]", () => {
    expect(canonicalRequestHash({ a: [1, 2] })).not.toBe(canonicalRequestHash({ a: [2, 1] }));
  });

  it("ignores undefined values, so an omitted optional field and an explicit undefined agree", () => {
    expect(canonicalRequestHash({ a: 1, b: undefined })).toBe(canonicalRequestHash({ a: 1 }));
  });

  it("distinguishes null from omitted -- null is an explicit instruction, absence is not", () => {
    expect(canonicalRequestHash({ a: 1, b: null })).not.toBe(canonicalRequestHash({ a: 1 }));
  });
});

describe("error contract", () => {
  it("maps every documented signal, and nothing else", () => {
    const cases: [string, string, number][] = [
      ["unauthorized", "unauthorized", 401],
      ["insufficient_scope", "insufficient_scope", 403],
      ["tenant_forbidden", "tenant_forbidden", 403],
      ["not_found", "not_found", 404],
      ["idempotency_key_reuse", "idempotency_key_reuse", 409],
      ["idempotency_in_flight", "conflict", 409],
      ["rate_limited", "rate_limited", 429],
      ["cpf_already_registered", "conflict", 409],
      ["position_not_found", "validation_error", 422],
      ["invalid_cursor", "invalid_request", 400],
      // The pair that broke: both CONTAIN "not_found", which is also a signal in its own
      // right, so a substring match in list order sent them to 404 instead of 422.
      ["location_not_found", "validation_error", 422],
      ["position_out_of_scope", "validation_error", 422],
    ];
    for (const [signal, type, status] of cases) {
      const { shape, unmapped } = mapRpcError({ message: signal, code: "P0001" } as never);
      expect(shape.type, signal).toBe(type);
      expect(shape.status, signal).toBe(status);
      expect(unmapped, signal).toBe(false);
    }
  });

  it("turns an UNMAPPED database signal into an opaque 500 and flags it", () => {
    // Without this rule, adding a RAISE anywhere in the database would silently publish an
    // internal identifier as part of the public API contract.
    const { shape, unmapped } = mapRpcError({
      message: 'some_internal_signal_nobody_documented',
      code: "P0001",
    } as never);
    expect(shape.type).toBe("internal_error");
    expect(shape.status).toBe(500);
    expect(unmapped).toBe(true);
  });

  it("maps lock_timeout (55P03) to a conflict a client should retry", () => {
    const { shape } = mapRpcError({ message: "canceling statement", code: "55P03" } as never);
    expect(shape.type).toBe("conflict");
    expect(shape.status).toBe(409);
  });

  it("never leaks the Postgres message into the response body", () => {
    const { shape } = mapRpcError({
      message: 'relation "m2m.api_keys" does not exist',
      code: "42P01",
    } as never);
    const body = JSON.stringify(errorBody(shape, "req-1"));
    expect(body).not.toContain("m2m.api_keys");
    expect(body).not.toContain("42P01");
  });

  it("carries the request id in every error body", () => {
    const body = errorBody(apiErrorShape("rate_limited"), "req-42");
    expect(body.error.request_id).toBe("req-42");
  });

  it("service_unavailable is 503 -- the deployment-problem answer, distinct from 500", () => {
    // A missing env var fails every request identically and is a deployment problem, not a
    // code defect. Reporting it as 500 sent an operator hunting for a bug that did not exist.
    expect(apiErrorShape("service_unavailable").status).toBe(503);
    expect(apiErrorShape("internal_error").status).toBe(500);
  });
});
