/**
 * CPF (Cadastro de Pessoas Físicas) validation. Implemented inline rather than via a
 * dependency: the check-digit algorithm is ~15 lines, has zero supply-chain surface, and
 * (per the FASE 0 library research) is exactly the kind of trivial-but-security-relevant
 * logic worth owning outright. See docs/architecture.md §20 / mvp-roadmap.md FASE 1.
 */

/** Strips everything but digits. */
export function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

const KNOWN_INVALID_SEQUENCES = new Set(
  Array.from({ length: 10 }, (_, d) => String(d).repeat(11)),
);

function checkDigit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i]!, 0);
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/**
 * True iff `value` is a structurally valid CPF (11 digits, both check digits correct).
 * Does NOT verify the CPF actually exists at Receita Federal -- that requires an external
 * lookup, out of scope here. Accepts formatted ("123.456.789-09") or bare digit input.
 */
export function isValidCpf(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length !== 11) return false;
  if (KNOWN_INVALID_SEQUENCES.has(digits)) return false;

  const nums = digits.split("").map(Number);
  const d1 = checkDigit(nums.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (d1 !== nums[9]) return false;
  const d2 = checkDigit(nums.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (d2 !== nums[10]) return false;

  return true;
}

/** "123.456.789-09" from 11 bare digits. Throws on malformed input. */
export function formatCpf(value: string): string {
  const digits = onlyDigits(value);
  if (digits.length !== 11) throw new Error("CPF must have 11 digits to format");
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
}

/**
 * "***.456.789-**" -- the ONLY form of a CPF that may appear in the UI without an
 * explicit, permissioned, audited reveal. See docs/architecture.md §6/§16.
 */
export function maskCpf(value: string): string {
  const digits = onlyDigits(value);
  if (digits.length !== 11) throw new Error("CPF must have 11 digits to mask");
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}
