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

// No getSupabaseSecretKey() here on purpose. Both src/lib/supabase/server.ts and
// client.ts say explicitly that the secret key (RLS-bypassing) is reserved for a future
// admin/cross-tenant client that FASE 3+ never actually built -- every real query in this
// app goes through the publishable key plus the caller's own session, with RLS enforcing
// tenancy. A getter with no caller is still a secret loaded into every environment for
// nothing; add it back here, next to the client that will actually call it, if that
// admin path is ever built.
