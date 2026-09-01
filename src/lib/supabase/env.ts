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

export function getSupabaseSecretKey(): string {
  return required("SUPABASE_SECRET_KEY");
}
