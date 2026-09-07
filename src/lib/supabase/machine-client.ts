import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getSupabaseSecretKey, getSupabaseUrl } from "./env";

/**
 * The ONLY client the public API (/api/v1/*) and the webhook runner may use. Never
 * src/lib/supabase/server.ts (which carries the manager's cookie session) and never
 * worker-client.ts (which is the anonymous worker path).
 *
 * It authenticates as `service_role`, which in THIS schema layout reaches almost nothing:
 * service_role has USAGE on no business schema, so it cannot touch app.*, authz.*,
 * evidence.*, audit.*, integ.*, m2m.* or hooks.*, and it is not granted the `api` or
 * `worker` schemas either. Its entire reachable surface is m2m_rpc and ops_rpc.
 *
 * That matters because every m2m_rpc function requires verified API-key material as
 * arguments and resolves the principal itself. Holding this credential therefore does NOT
 * let anyone act as a tenant, read a tenant's data, or forge a principal -- a property the
 * original custom-Postgres-role design was meant to provide and which this arrangement
 * provides just as well, because the authorization anchor is the API key rather than the
 * database role.
 *
 * ops_rpc is the exception: it operates on our own webhook queue, where there is no tenant
 * to impersonate, and the internal route that calls it validates the scheduler secret first.
 *
 * DEPLOYMENT NOTE. Both m2m_rpc and ops_rpc must be listed in the project's exposed schemas
 * or every call here fails with PGRST106. supabase/config.toml covers the LOCAL and CI
 * stacks only -- the hosted project's list is a dashboard setting (Settings > API > Exposed
 * schemas) that applying migrations does not touch. Verified the hard way against epi-dev:
 * with all ten Phase F migrations applied, PostgREST still answered
 * "Only the following schemas are exposed: graphql_public, api, worker".
 */
export function createMachineClient() {
  return createSupabaseClient(getSupabaseUrl(), getSupabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
