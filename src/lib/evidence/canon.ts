import "server-only";
import { createHash } from "node:crypto";
import canonicalizeJson from "canonicalize";

/**
 * The `epi-canon/1` canonicalization rules (docs/architecture.md §12). Base: RFC 8785 (JSON
 * Canonicalization Scheme), via the `canonicalize` package -- one of the two reference
 * implementations linked from the RFC itself, chosen over a hand-rolled implementation
 * because JCS's key-ordering and number-formatting rules have real edge cases, and "cite a
 * published standard, don't invent one" extends to not inventing an implementation of it.
 *
 * Rules ADDED on top of JCS (all restrict it, never contradict it -- see §12):
 * 1. Every string NFC-normalized before serializing; unpaired surrogates and control/bidi
 *    characters are rejected (thrown), never silently fixed.
 * 2. No floating point numbers -- every decimal quantity is a fixed-decimal STRING. This
 *    sidesteps JCS's trickiest area (ECMA-262 double-to-string edge cases) entirely: this
 *    module simply refuses any non-integer JS number.
 * 3. `null` is forbidden -- absence of a value is an absent key, never `null`.
 * 4. Instants use a `_utc`-suffixed key, RFC 3339 UTC with a literal `Z` and exactly 3
 *    decimal digits (formatTimestampUtc below). Local/display dates are opaque strings.
 * 5. Arrays must already be in the order the schema defines (e.g. items by line_no asc) --
 *    this module does not sort arrays, only object keys (which is JCS's job).
 * 6. `_canon` (this version identifier) lives INSIDE the hashed document, never reassigned
 *    after the fact -- a rule change is `epi-canon/2`, this implementation is never deleted,
 *    and the golden vectors below are a permanent CI fixture.
 */

export const EPI_CANON_VERSION = "epi-canon/1";

// Character codes forbidden inside any string this module hashes -- checked by numeric
// charCode comparison, never by embedding the literal (often invisible) characters in a
// regex source, which is both unreviewable in a diff and fragile to editor/encoding
// mangling. A bidi override in particular can make DISPLAYED text lie about its own content
// without changing the underlying bytes -- none of these can legitimately appear inside a
// declaration a court would be shown.
const FORBIDDEN_CODES = new Set<number>([
  // C0 controls: U+0000-U+001F
  ...Array.from({ length: 0x20 }, (_, i) => i),
  0x7f, // DELETE
  // C1 controls: U+0080-U+009F
  ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i),
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x200d, // ZERO WIDTH JOINER
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  0x202a, // LEFT-TO-RIGHT EMBEDDING
  0x202b, // RIGHT-TO-LEFT EMBEDDING
  0x202c, // POP DIRECTIONAL FORMATTING
  0x202d, // LEFT-TO-RIGHT OVERRIDE
  0x202e, // RIGHT-TO-LEFT OVERRIDE
  0x2066, // LEFT-TO-RIGHT ISOLATE
  0x2067, // RIGHT-TO-LEFT ISOLATE
  0x2068, // FIRST STRONG ISOLATE
  0x2069, // POP DIRECTIONAL ISOLATE
  0xfeff, // ZERO WIDTH NO-BREAK SPACE / BOM
]);

function hasForbiddenChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (FORBIDDEN_CODES.has(s.charCodeAt(i))) return true;
  }
  return false;
}

function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    if (isHighSurrogate) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (isLowSurrogate) {
      return true;
    }
  }
  return false;
}

/** Recursively validates + NFC-normalizes a value tree. Throws on anything the epi-canon/1
 * rules forbid (float, null, invalid string) rather than silently coercing it -- a rejected
 * seal attempt is always safer than a seal built from a value nobody meant to hash. */
function normalize(value: unknown, path: string): unknown {
  if (value === null) {
    throw new Error(`epi-canon/1: null is forbidden at ${path} -- omit the key instead`);
  }
  if (value === undefined) {
    throw new Error(`epi-canon/1: undefined is forbidden at ${path} -- omit the key instead`);
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`epi-canon/1: non-integer or unsafe number at ${path} -- use a fixed-decimal string instead`);
    }
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) {
      throw new Error(`epi-canon/1: unpaired UTF-16 surrogate at ${path}`);
    }
    const nfc = value.normalize("NFC");
    if (hasForbiddenChar(nfc)) {
      throw new Error(`epi-canon/1: control, bidi-override, or zero-width character at ${path}`);
    }
    return nfc;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => normalize(v, `${path}[${i}]`));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalize(v, `${path}.${k}`);
    }
    return out;
  }
  throw new Error(`epi-canon/1: unsupported value type at ${path}`);
}

/** RFC 3339 UTC instant, always exactly 3 fractional-second digits and a literal `Z` --
 * matches the `_utc`-suffixed-key convention. Never reprocessed once used in a sealed
 * document -- callers pass the SAME formatted string to both the payload and the DB row it
 * seals alongside, so there is exactly one source of truth for "when," not two independently
 * computed clocks. */
export function formatTimestampUtc(date: Date): string {
  return date.toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
}

export type CanonicalizedPayload = { canonicalBytes: Buffer; sha256: Buffer };

/** Validates, NFC-normalizes, and RFC-8785-serializes `payload` (which must already include
 * `_canon: EPI_CANON_VERSION`), then SHA-256-hashes the resulting UTF-8 bytes. Deterministic:
 * the same logical payload always produces the same bytes and hash, in any process, forever
 * (see canon.test.ts's golden vectors). */
export function canonicalizeEvidencePayload(payload: Record<string, unknown>): CanonicalizedPayload {
  if (payload["_canon"] !== EPI_CANON_VERSION) {
    throw new Error(`epi-canon/1: payload._canon must be exactly "${EPI_CANON_VERSION}"`);
  }
  const normalized = normalize(payload, "$");
  const json = canonicalizeJson(normalized);
  if (json === undefined) {
    throw new Error("epi-canon/1: canonicalize() returned undefined -- payload was not a plain serializable object");
  }
  const canonicalBytes = Buffer.from(json, "utf8");
  const sha256 = createHash("sha256").update(canonicalBytes).digest();
  return { canonicalBytes, sha256 };
}
