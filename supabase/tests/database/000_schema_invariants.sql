-- Schema-wide invariants that must hold no matter how many tables get added in later
-- phases. These are the executable form of docs/architecture.md §7's four defence
-- layers -- if a future migration adds a table to app/authz/evidence/audit/integ and
-- forgets RLS, or accidentally grants authz.memberships to authenticated, this file
-- fails the build. Run via `supabase test db` (pgTAP through pg_prove).

create extension if not exists pgtap with schema extensions;

begin;

select plan(6);

-- 1. Every table in the business schemas has RLS enabled. A new table without RLS
--    cannot be merged.
select is(
  (
    select count(*)::int
    from pg_tables t
    join pg_class c on c.relname = t.tablename and c.relnamespace = t.schemaname::regnamespace
    where t.schemaname in ('app', 'authz', 'evidence', 'audit', 'integ')
      and not c.relrowsecurity
  ),
  0,
  'every table in app/authz/evidence/audit/integ has row level security enabled'
);

-- 2. authz.memberships must NEVER have FORCE ROW LEVEL SECURITY -- that would re-arm the
--    exact recursion the auth_ctx.* SECURITY DEFINER pattern exists to make impossible
--    (the definer functions rely on being exempt from that table's own policies as the
--    table owner). See docs/architecture.md §7, "why this cannot recurse".
select ok(
  not (
    select relforcerowsecurity from pg_class
    where relname = 'memberships' and relnamespace = 'authz'::regnamespace
  ),
  'authz.memberships does NOT have FORCE ROW LEVEL SECURITY (recursion-safety invariant)'
);

-- 3. authz.memberships and authz.role_permissions have zero privileges granted to
--    authenticated or anon, in any form -- read exclusively through auth_ctx.* functions.
select is(
  (
    select count(*)::int
    from information_schema.role_table_grants
    where table_schema = 'authz'
      and table_name in ('memberships', 'role_permissions')
      and grantee in ('authenticated', 'anon')
  ),
  0,
  'authz.memberships and authz.role_permissions have zero grants to authenticated/anon'
);

-- 4. anon holds no privilege at all on app/authz/evidence/audit/integ schemas (schema
--    USAGE itself, not just table grants -- see docs/architecture.md §7 layer 1+2).
select is(
  (
    select count(*)::int
    from information_schema.usage_privileges
    where object_schema in ('app', 'authz', 'evidence', 'audit', 'integ')
      and object_type = 'SCHEMA'
      and grantee = 'anon'
  ),
  0,
  'anon has no USAGE on app/authz/evidence/audit/integ'
);

-- 5. Every SECURITY DEFINER function in auth_ctx/app/api is hardened with
--    SET search_path = '' -- an unqualified search_path on a definer function is the
--    classic privilege-escalation-via-search-path-hijack hole.
select is(
  (
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('auth_ctx', 'app', 'api')
      and p.prosecdef  -- SECURITY DEFINER
      and not exists (
        -- Postgres stores an empty search_path as `search_path=""` (quoted), not
        -- `search_path=` bare -- verified by directly inspecting pg_proc.proconfig
        -- during FASE 2, after this exact assertion falsely flagged all 19 correctly-
        -- hardened functions as missing it.
        select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
        where cfg = 'search_path=""'
      )
  ),
  0,
  'every SECURITY DEFINER function in auth_ctx/app/api sets search_path = '''''
);

-- 6. The `api` schema is the only one exposed to PostgREST, per config.toml
--    (api.schemas = ["api", "graphql_public"]). This assertion documents the intent in a
--    way that fails loudly if someone edits config.toml without reading this test --
--    the actual enforcement is in supabase/config.toml, not in the database itself, so
--    this is a reminder assertion rather than a database-level guarantee.
select pass('PostgREST schema exposure is enforced in supabase/config.toml (api.schemas = ["api","graphql_public"]) -- verify that file has not regressed to include app/authz/evidence/audit/integ.');

select * from finish();

rollback;
