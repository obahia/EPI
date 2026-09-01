import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getSupabasePublishableKey, getSupabaseUrl } from "./env";

/**
 * The ONLY Supabase client the worker confirmation path (/e/*) may use -- never
 * src/lib/supabase/server.ts's createClient(). Deliberately carries no cookies at all (not
 * even the manager's own session, if the same browser happens to have one) -- every call
 * through this client authenticates as `anon`, which has zero table grants anywhere and can
 * only reach the token-gated SECURITY DEFINER functions in the `worker` schema (see
 * docs/architecture.md §7-8, and supabase/migrations/20260831170000_confirmation_schema.sql
 * for why a dedicated epi_worker_gw Postgres role was not built this phase -- this client is
 * the module-boundary half of that same defense-in-depth reasoning: even a stray import
 * mistake elsewhere in the worker route tree cannot smuggle an authenticated session into
 * this path, because this client never had one to begin with.
 */
export function createWorkerClient() {
  return createSupabaseClient(getSupabaseUrl(), getSupabasePublishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
