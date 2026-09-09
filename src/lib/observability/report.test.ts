import { describe, expect, it, vi, afterEach } from "vitest";
import { __testing, correlationIdFrom, reportFailure, reportDegraded } from "./report";

const { sanitiseValue, sanitiseContext, describeError } = __testing;

/**
 * The point of these tests is not that logging works -- it is that logging cannot become the
 * privacy incident. A log line leaves the database behind: it is copied to a host's log store,
 * possibly a third-party sink, and read by people who have no membership in the tenant. So the
 * assertions below are mostly about what must NOT come out.
 */
describe("sanitiseValue", () => {
  it("admits identifiers, machine signals and numbers", () => {
    expect(sanitiseValue("1944e2ae-e2d3-42c0-9af5-1879207fcb6e")).toBe("1944e2ae-e2d3-42c0-9af5-1879207fcb6e");
    expect(sanitiseValue("insufficient_stock")).toBe("insufficient_stock");
    expect(sanitiseValue("employees:read")).toBe("employees:read");
    expect(sanitiseValue(42)).toBe(42);
    expect(sanitiseValue("23514")).toBe("23514");
  });

  it("drops anything that could be a person", () => {
    for (const personal of [
      "João da Silva",
      "961.810.907-87",
      "96181090787961810907879618109078796181090787", // a long digit run, e.g. a concatenated CPF list
      "joao@example.com",
      "Rua das Flores, 100",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def",
    ]) {
      expect(sanitiseValue(personal), personal).toBeNull();
    }
  });

  it("drops structures rather than stringifying them", () => {
    expect(sanitiseValue({ cpf: "96181090787" })).toBeNull();
    expect(sanitiseValue(["96181090787"])).toBeNull();
    expect(sanitiseValue(Buffer.from("secret"))).toBeNull();
    expect(sanitiseValue(null)).toBeNull();
    expect(sanitiseValue(undefined)).toBeNull();
    expect(sanitiseValue(Number.NaN)).toBeNull();
  });

  it("does not truncate an unsafe value into a shorter unsafe value", () => {
    // Keeping a prefix of a CPF is still keeping part of a CPF.
    expect(sanitiseValue("961810907871234567890")).toBeNull();
  });
});

describe("sanitiseContext", () => {
  it("keeps the identifiers and silently drops the rest", () => {
    const out = sanitiseContext({
      organizationId: "1944e2ae-e2d3-42c0-9af5-1879207fcb6e",
      deliveryId: "601bbb92-4b78-4569-a921-cf8c2b894629",
      signal: "evidence_payload_required",
      code: 23514,
      // @ts-expect-error -- exactly the mistake this guard exists to survive
      employeeName: "João da Silva",
      cpf: "96181090787",
    });

    expect(out).toEqual({
      organizationId: "1944e2ae-e2d3-42c0-9af5-1879207fcb6e",
      deliveryId: "601bbb92-4b78-4569-a921-cf8c2b894629",
      signal: "evidence_payload_required",
      code: 23514,
    });
    expect(JSON.stringify(out)).not.toContain("João");
    expect(JSON.stringify(out)).not.toContain("96181090787");
  });
});

describe("describeError", () => {
  it("keeps a domain signal, because that is what a responder needs", () => {
    expect(describeError(new Error("insufficient_stock"))).toMatchObject({
      errorName: "Error",
      errorSignal: "insufficient_stock",
    });
  });

  it("drops a human-readable message, because a Postgres error can quote the offending row", () => {
    const out = describeError(
      new Error('duplicate key value violates unique constraint: Key (cpf_hash)=(João da Silva) already exists'),
    );
    expect(out).toEqual({ errorName: "Error" });
    expect(JSON.stringify(out)).not.toContain("João");
  });

  it("keeps a digest so the line can be matched against the host's own record", () => {
    const err = Object.assign(new Error("something went wrong at row 4"), { digest: "2379761994" });
    expect(describeError(err)).toMatchObject({ errorName: "Error", errorDigest: "2379761994" });
  });

  it("survives a thrown non-Error", () => {
    expect(describeError("boom")).toEqual({ errorName: "string" });
    expect(describeError(undefined)).toEqual({ errorName: "undefined" });
  });
});

describe("correlationIdFrom", () => {
  it("prefers the platform's own request id so the two logs can be joined", () => {
    expect(correlationIdFrom("iad1::abc123-1757000000000-deadbeef")).toBe("iad1::abc123-1757000000000-deadbeef");
  });

  it("generates one when there is none, or when the header is not a plausible id", () => {
    expect(correlationIdFrom(null)).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFrom("João da Silva")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("emitted events", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => spy.mockClear());

  it("writes exactly one JSON line per failure", () => {
    reportFailure("evidence.seal", new Error("evidence_payload_required"), {
      deliveryId: "601bbb92-4b78-4569-a921-cf8c2b894629",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line.includes("\n")).toBe(false);
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      level: "error",
      event: "operation_failed",
      operation: "evidence.seal",
      errorSignal: "evidence_payload_required",
      deliveryId: "601bbb92-4b78-4569-a921-cf8c2b894629",
    });
    expect(parsed.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("carries the caller's correlation id through unchanged", () => {
    const id = "d3f1a2b4-0000-4000-8000-00000000abcd";
    const returned = reportDegraded("job.webhook_runner", { correlationId: id, count: 3 });
    expect(returned).toBe(id);
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({
      level: "warn",
      operation: "job.webhook_runner",
      correlationId: id,
      count: 3,
    });
  });

  it("never lets an unsafe field reach the line, even passed straight in", () => {
    reportFailure("import.commit", new Error("Falha ao importar João da Silva, CPF 961.810.907-87"), {
      // @ts-expect-error -- the mistake, made on purpose
      employee: "João da Silva",
      importRunId: "601bbb92-4b78-4569-a921-cf8c2b894629",
    });
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("João");
    expect(line).not.toContain("961");
    expect(line).toContain("601bbb92-4b78-4569-a921-cf8c2b894629");
  });
});
