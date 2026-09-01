-- FASE 0: schemas and extensions.
--
-- Business tables live in `app`/`authz`/`evidence`/`audit`/`integ`, never in `public`.
-- Only the curated `api` schema (security_invoker views + RPCs) is exposed to PostgREST
-- (see supabase/config.toml: api.schemas = ["api", "graphql_public"]). A table added
-- without an explicit view in `api` is simply unreachable over HTTP -- see
-- docs/architecture.md §7, layer 1.

create schema if not exists app;
create schema if not exists authz;
create schema if not exists evidence;
create schema if not exists audit;
create schema if not exists integ;
create schema if not exists api;
create schema if not exists auth_ctx;

comment on schema app is 'Core business domain: organizations, companies, employees, epis, deliveries.';
comment on schema authz is 'Access control graph (memberships, role_permissions). No table here is ever granted to authenticated/anon -- see docs/architecture.md §7.';
comment on schema evidence is 'Append-only, hash-verified evidence of confirmed/contested deliveries. No INSERT/UPDATE/DELETE grant to any role, including service_role.';
comment on schema audit is 'Append-only, per-organization hash-chained audit trail.';
comment on schema integ is 'External system adapters (WOTY and future providers). Never a runtime dependency of the app -- see docs/architecture.md §11.';
comment on schema api is 'The only schema PostgREST exposes. security_invoker views and RPCs onto app/authz/evidence/audit/integ.';
comment on schema auth_ctx is 'SECURITY DEFINER helper functions used inside RLS policies (auth_ctx.company_ids(), etc). Owned by the table owner so they read authz.memberships without ever triggering that table''s own policy evaluation.';

-- pgcrypto: gen_random_bytes/digest/hmac for CPF hashing and evidence hashing.
-- Ships in the `extensions` schema on Supabase -- every SECURITY DEFINER function that
-- calls it (which must SET search_path = '') schema-qualifies as extensions.digest(...).
create extension if not exists pgcrypto with schema extensions;

-- pg_trgm + unaccent: accent-insensitive employee name search (FASE 1).
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

revoke all on schema app, authz, evidence, audit, integ, auth_ctx from anon, authenticated, public;
grant usage on schema api to anon, authenticated;

-- `app` and `auth_ctx` DO get USAGE granted to `authenticated` -- this is required, not
-- optional, for the architecture to actually work: the `api` schema's views are declared
-- `security_invoker = true` (docs/architecture.md §7) precisely so the CALLER's own RLS
-- policies apply instead of the view owner's, and Postgres checks invoker-mode privileges
-- against the underlying objects -- so authenticated needs USAGE on `app` (to read the
-- tables the views select from, still gated per-table by RLS + column grants) and on
-- `auth_ctx` (policies reference auth_ctx.company_ids() etc. in the CALLER's privilege
-- context, so resolving that schema-qualified name requires USAGE same as EXECUTE).
-- What this does NOT do: expose anything over HTTP. PostgREST's schema cache only
-- generates endpoints for schemas in config.toml's api.schemas ("api", "graphql_public"),
-- so `app`/`auth_ctx` remain completely absent from the REST API regardless of this
-- grant -- it only unblocks the invoker-mode views/functions that live in `api` and read
-- through them. `authz`, `evidence`, `audit` and `integ` get NO usage grant, ever: nothing
-- in `api` reads them via a plain view (see api.my_memberships() for how a
-- SECURITY DEFINER RPC is used instead, precisely to avoid ever granting USAGE on authz).
grant usage on schema app, auth_ctx to authenticated;
