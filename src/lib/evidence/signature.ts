import "server-only";

const DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A signature-pad drawing on a few-hundred-px canvas is a handful of KB as PNG; this bounds
// it well above that while keeping a bad-faith client from stuffing an arbitrarily large blob
// into the sealed evidence payload.
const MAX_SIGNATURE_BYTES = 200_000;

export type EvidenceSignature = { format: "image/png"; data: string };

/**
 * Validates a worker-submitted signature (a `data:image/png;base64,...` string from the
 * confirm form's hidden input, see signature-pad.tsx) and returns the shape stored in the
 * evidence payload, or null if it isn't a well-formed PNG within size limits.
 *
 * Unlike every other evidence field -- built server-side from worker.get_evidence_source,
 * see payload.ts's own doc comment -- a signature is inherently drawn client-side and can
 * only ever be client-submitted. This is the one explicit trust boundary for that: the magic
 * bytes and size cap are the actual validation, not the shape check alone.
 */
export function parseSignatureDataUrl(raw: string): EvidenceSignature | null {
  if (!raw.startsWith(DATA_URL_PREFIX)) return null;

  const base64 = raw.slice(DATA_URL_PREFIX.length);
  if (!base64) return null;

  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_SIGNATURE_BYTES) return null;
  if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null;

  return { format: "image/png", data: base64 };
}
