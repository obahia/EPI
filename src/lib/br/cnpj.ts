/**
 * CNPJ (Cadastro Nacional da Pessoa Jurídica) validation, including the ALPHANUMERIC
 * format Receita Federal rolls out from ~July 2026 (IN RFB 2.229/2024) -- existing
 * numeric CNPJs stay valid forever, but new registrations may contain letters in the
 * first 12 positions. The check-digit ALGORITHM is unchanged; only the character-to-value
 * mapping is extended: 'A'-'Z' map to (charCode - 48), which happens to also correctly
 * map '0'-'9' to 0-9 since '0'.charCodeAt(0) === 48 -- one formula covers both. The two
 * check digits themselves are always numeric.
 *
 * Verified against Receita Federal's own published example during the FASE 0 library
 * research: base "12ABC34501DE" -> check digits "35" (12.ABC.345/01DE-35), reproduced
 * exactly by this implementation. Also verified against the classic numeric case
 * "112223330001" -> "81". Do NOT trust a third-party validator library without checking
 * it handles the alphanumeric case -- one popular one (@brazilian-utils) does not.
 */

export function onlyAlnum(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

function charValue(char: string): number {
  return char.charCodeAt(0) - 48;
}

function checkDigit(chars: string[], weights: number[]): number {
  const offset = weights.length - chars.length;
  const sum = chars.reduce((acc, c, i) => acc + charValue(c) * weights[offset + i]!, 0);
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

// Canonical 13-weight sequence; DV1 uses it right-aligned (drops the leading 6), DV2 uses
// it in full. See module doc comment for why this single sequence covers both digits.
const CNPJ_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * True iff `value` is a structurally valid CNPJ (14 characters: 12 alphanumeric + 2
 * numeric check digits). Accepts formatted ("12.345.678/0001-95") or bare input, and
 * both numeric and alphanumeric CNPJs.
 */
export function isValidCnpj(value: string): boolean {
  const raw = onlyAlnum(value);
  if (raw.length !== 14) return false;

  const base = raw.slice(0, 12).split("");
  const dv = raw.slice(12);
  if (!/^[0-9]{2}$/.test(dv)) return false; // check digits are always numeric
  if (!/^[0-9A-Z]{12}$/.test(raw.slice(0, 12))) return false;

  const d1 = checkDigit(base, CNPJ_WEIGHTS);
  if (d1 !== Number(dv[0])) return false;
  const d2 = checkDigit([...base, dv[0]!], CNPJ_WEIGHTS);
  if (d2 !== Number(dv[1])) return false;

  return true;
}

/** "12.ABC.345/01DE-35" from 14 bare characters. Throws on malformed input. */
export function formatCnpj(value: string): string {
  const raw = onlyAlnum(value);
  if (raw.length !== 14) throw new Error("CNPJ must have 14 characters to format");
  return `${raw.slice(0, 2)}.${raw.slice(2, 5)}.${raw.slice(5, 8)}/${raw.slice(8, 12)}-${raw.slice(12, 14)}`;
}

/** Normalized storage form: uppercase, unformatted, 14 characters. Matches the `cnpj`
 * column CHECK constraint in app.organizations/app.companies. */
export function normalizeCnpj(value: string): string {
  return onlyAlnum(value);
}
