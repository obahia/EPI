/**
 * CA (Certificado de Aprovação) number format check -- digits only, 3 to 8 of them. Mirrors
 * the DB CHECK constraint on app.epi_versions.ca_number (`^[0-9]{3,8}$`, see
 * supabase/migrations/20260831160000_epi_catalog.sql) so the form can give fast feedback;
 * the RPC re-validates via the CHECK constraint regardless, so this is UX only, never the
 * source of truth.
 */
export function isValidCaNumber(value: string): boolean {
  return /^[0-9]{3,8}$/.test(value.trim());
}
