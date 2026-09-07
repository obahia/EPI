/**
 * Fails fast (at import time) if a required Supabase env var is missing, instead of
 * surfacing a confusing runtime error deep inside a client call. See .env.example and
 * docs/architecture.md §4 -- these are the NEW Supabase key names (sb_publishable_...,
 * sb_secret_...), never the legacy anon/service_role JWT names.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in from the Supabase dashboard (Settings > API).`,
    );
  }
  return value;
}

export function getSupabaseUrl(): string {
  return required("NEXT_PUBLIC_SUPABASE_URL");
}

export function getSupabasePublishableKey(): string {
  return required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
}

/**
 * Added in Phase F, which is the "if that admin path is ever built" this file previously
 * described. It is NOT an admin client and it is not RLS-bypassing in any useful sense:
 * service_role holds USAGE on no business schema of this project (verified -- the only
 * `grant usage on schema` statements in the migrations cover api -> anon/authenticated,
 * app+auth_ctx -> authenticated, worker -> anon), so the secret key can reach exactly two
 * schemas, m2m_rpc and ops_rpc, and every function in both refuses to do anything without
 * separately verified API-key material or the scheduler secret.
 *
 * In other words the secret key is a TRANSPORT credential here, not an authorization one --
 * which is the whole point of resolving the machine principal inside Postgres from the key
 * hash rather than trusting whoever holds the database credential. Only
 * src/lib/supabase/machine-client.ts may call this.
 */
export function getSupabaseSecretKey(): string {
  return required("SUPABASE_SECRET_KEY");
}
