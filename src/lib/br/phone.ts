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
