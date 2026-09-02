import { parsePhoneNumberWithError } from "libphonenumber-js/max";

/**
 * Normalizes a Brazilian phone number (any common input shape) to E.164
 * ("+5511987654321"), or returns null if it isn't a valid number. Defaults the country to
 * BR since that is the only market this product serves, but accepts an explicit "+"
 * international number too. Uses the `/max` metadata (not the default `/min`) because the
 * `/min` build silently makes getType() return undefined -- a real gotcha found during
 * the FASE 0 library research.
 */
export function normalizePhoneE164(value: string): string | null {
  try {
    const parsed = parsePhoneNumberWithError(value, "BR");
    return parsed.isValid() ? parsed.number : null;
  } catch {
    return null;
  }
}

export function isValidPhone(value: string): boolean {
  return normalizePhoneE164(value) !== null;
}

/**
 * Display form for a stored E.164 number, masked the way the mockup's roster shows it:
 * "+55 11 9••••-4412" -- country and area intact, the first digit and the last four
 * kept, everything between them hidden. Enough to recognise a number at a glance
 * without putting every worker's full phone on a screen somebody may be sharing.
 * Falls back to the raw value for anything that isn't a +55 number.
 */
export function formatPhoneBr(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (!digits.startsWith("55") || digits.length < 12) return e164;
  const area = digits.slice(2, 4);
  const subscriber = digits.slice(4);
  const hidden = Math.max(0, subscriber.length - 5);
  return `+55 ${area} ${subscriber[0]}${"•".repeat(hidden)}-${subscriber.slice(-4)}`;
}
