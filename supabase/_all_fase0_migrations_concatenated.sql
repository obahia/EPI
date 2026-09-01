-- Concatenação de todas as migrations da FASE 0, em ordem, para colar no SQL Editor do Supabase.
-- Gerado a partir de supabase/migrations/*.sql -- não editar aqui, editar os arquivos originais.

-- ============================================================
-- 20260831140000_schemas_and_extensions.sql
-- ============================================================
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

-- ============================================================
-- 20260831140100_enums.sql
-- ============================================================
-- FASE 0: core enums.
--
-- Fixed value domains are Postgres enums (compact, indexable, impossible values excluded
-- at the type level). The RULES governing state MACHINES (from_state/event/to_state) are
-- kept as plain text in a data table instead (see the FASE 2/3 state_transitions
-- migration) so new transitions can be added by INSERT, without DDL -- see
-- docs/architecture.md §8.

create type app.org_kind as enum ('PARTNER', 'DIRECT');
comment on type app.org_kind is 'PARTNER = SST clinic/white-label reseller owning N client companies. DIRECT = a company that bought directly, owns exactly 1 company.';

create type app.role as enum ('VIEWER', 'SST_OPERATOR', 'COMPANY_ADMIN', 'ORG_ADMIN');
comment on type app.role is 'Ordered least -> most privileged. Employee is never a role here -- an employee is not an authenticated user (docs/architecture.md §3).';

-- Ordered so `achieved_assurance_level >= required_assurance_level` works natively as a
-- CHECK constraint once delivery/confirmation tables exist (FASE 2/3).
create type app.assurance_level as enum (
  'AL0_LINK_ONLY',
  'AL1_LINK_KNOWLEDGE',
  'AL2_SELFIE_LIVENESS',
  'AL3_FACE_MATCH_ENROLLED',
  'AL4_GOV_VERIFIED'
);
comment on type app.assurance_level is
  'Identity assurance ladder, docs/architecture.md §9/§16. AL1 (link + knowledge/OTP challenge, non-biometric) is the recommended default per the LGPD/ANPD research in §16 -- biometric levels (AL2+) are opt-in per organization, never the mandatory path.';

create type app.data_origin as enum ('MANUAL', 'IMPORT', 'SYNC_WOTY', 'API');
comment on type app.data_origin is 'Where an employee/company row''s data came from. SYNC_WOTY rows are provider-owned -- see docs/architecture.md §11.';

-- ============================================================
-- 20260831140200_organizations_companies.sql
-- ============================================================
-- FASE 0: tenancy root -- organizations and companies.
-- See docs/architecture.md §3 for the full definitions and the composite-FK anti-escape
-- mechanism this migration implements.

-- moddatetime: standard Postgres contrib extension providing an updated_at trigger
-- function. Enabled here since this migration is its first use.
create extension if not exists moddatetime with schema extensions;

create table app.organizations (
  id                          uuid primary key default gen_random_uuid(),
  kind                        app.org_kind not null,
  legal_name                  text not null check (length(btrim(legal_name)) between 2 and 200),
  cnpj                        text check (cnpj ~ '^[0-9A-Z]{14}$'),  -- alphanumeric CNPJ from ~jul/2026, see docs/architecture.md §20
  status                      text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  timezone                    text not null default 'America/Sao_Paulo',
  default_assurance_level     app.assurance_level not null default 'AL1_LINK_KNOWLEDGE',
  link_ttl_hours              integer not null default 168 check (link_ttl_hours between 1 and 720),
  identity_max_attempts       integer not null default 5 check (identity_max_attempts between 1 and 10),
  evidence_retention_months   integer not null default 240 check (evidence_retention_months between 24 and 480),
  retain_selfie               boolean not null default false,
  contest_requires_identity   boolean not null default false,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint organizations_cnpj_key unique (cnpj),
  -- composite-FK target: lets every child table pin (organization_id, kind) together so a
  -- row can never claim a kind that disagrees with its parent organization's actual kind.
  constraint organizations_id_kind_key unique (id, kind)
);

comment on table app.organizations is
  'The tenant. Isolation, billing, audit-chain and export boundary. PARTNER (SST clinic/white-label) or DIRECT (bought directly). The first customer (a clinic) is not a special case -- it is kind=PARTNER with N companies. No parent_organization_id: hierarchy is fixed at two levels by design, see docs/architecture.md §3.';
comment on column app.organizations.cnpj is 'Nullable: a PARTNER org itself may or may not have its own CNPJ on file; its client companies always do.';
comment on column app.organizations.default_assurance_level is 'Default identity assurance for new deliveries in this org. Non-biometric by product default -- see docs/architecture.md §16.';

create trigger organizations_set_updated_at
  before update on app.organizations
  for each row execute function extensions.moddatetime(updated_at);

create table app.companies (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  organization_kind  app.org_kind not null,
  cnpj               text not null check (cnpj ~ '^[0-9A-Z]{14}$'),
  legal_name         text not null check (length(btrim(legal_name)) between 2 and 200),
  trade_name         text,
  status             text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED')),
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- pins organization_id to a row that actually has that kind -- a company can never
  -- claim to belong to a PARTNER org's id while that org is secretly DIRECT (impossible
  -- by construction, not by application discipline).
  foreign key (organization_id, organization_kind) references app.organizations (id, kind) on delete restrict,
  constraint companies_org_cnpj_key unique (organization_id, cnpj),
  -- composite-FK target for every table that hangs off a company (employees, epis, deliveries, ...).
  constraint companies_id_org_key unique (id, organization_id)
);

comment on table app.companies is
  'The legal employer (CNPJ), owner of employees and deliveries, legal subject of the NR-6 evidence. Belongs to exactly one organization for its whole life -- there is no re-parenting operation in application code.';

-- A DIRECT organization has exactly one company. Enforced at the database, not by review.
create unique index companies_one_per_direct_org
  on app.companies (organization_id)
  where organization_kind = 'DIRECT';

create index companies_org_idx on app.companies (organization_id) where archived_at is null;

create trigger companies_set_updated_at
  before update on app.companies
  for each row execute function extensions.moddatetime(updated_at);

-- ============================================================
-- 20260831140300_users_memberships.sql
-- ============================================================
-- FASE 0: manager-side users, the membership grant table, and the static
-- role -> permission matrix. See docs/architecture.md §3/§5/§7.

create extension if not exists citext with schema extensions;

create table app.users (
  id          uuid primary key references auth.users (id) on delete restrict,
  full_name   text not null check (length(btrim(full_name)) between 1 and 150),
  email       extensions.citext not null unique,
  phone_e164  text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  disabled_at timestamptz,
  created_at  timestamptz not null default now()
);

comment on table app.users is
  'Mirror of auth.users for FK integrity and display data. A human who logs into the manager panel. Has no tenant of its own -- access comes only from authz.memberships. An employee (app.employees, FASE 1) never has a row here and never will.';

-- Auto-provision app.users on signup, mirroring auth.users. SECURITY DEFINER because
-- authenticated has no INSERT grant on app.users (see the grants migration).
create function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.users (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function app.handle_new_auth_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

create table authz.role_permissions (
  role       app.role not null,
  permission text not null check (permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  primary key (role, permission)
);

comment on table authz.role_permissions is
  'Static role -> permission matrix, seeded by migration only. Privilege escalation therefore requires a migration, not a runtime UPDATE. No grant to authenticated/anon -- read only via auth_ctx.has_perm().';

-- Seed baseline permissions for FASE 0-3 scope. VIEWER < SST_OPERATOR < COMPANY_ADMIN <
-- ORG_ADMIN -- each tier includes everything below it. Additional permission strings for
-- later phases are added by future migrations (INSERT only, no DDL needed).
insert into authz.role_permissions (role, permission) values
  -- VIEWER: read-only across the resources that exist so far.
  ('VIEWER', 'company.read'),
  ('VIEWER', 'employee.read'),
  ('VIEWER', 'epi.read'),
  ('VIEWER', 'delivery.read'),
  ('VIEWER', 'audit.read'),
  -- SST_OPERATOR: VIEWER + day-to-day operational writes.
  ('SST_OPERATOR', 'company.read'), ('SST_OPERATOR', 'employee.read'), ('SST_OPERATOR', 'epi.read'),
  ('SST_OPERATOR', 'delivery.read'), ('SST_OPERATOR', 'audit.read'),
  ('SST_OPERATOR', 'employee.create'), ('SST_OPERATOR', 'employee.update'), ('SST_OPERATOR', 'employee.import'),
  ('SST_OPERATOR', 'epi.create'), ('SST_OPERATOR', 'epi.update'),
  ('SST_OPERATOR', 'delivery.create'), ('SST_OPERATOR', 'delivery.issue'), ('SST_OPERATOR', 'delivery.cancel'),
  ('SST_OPERATOR', 'delivery.batch.create'), ('SST_OPERATOR', 'delivery.batch.resend'),
  ('SST_OPERATOR', 'contest.respond'),
  -- COMPANY_ADMIN: SST_OPERATOR + company-scoped administration.
  ('COMPANY_ADMIN', 'company.read'), ('COMPANY_ADMIN', 'employee.read'), ('COMPANY_ADMIN', 'epi.read'),
  ('COMPANY_ADMIN', 'delivery.read'), ('COMPANY_ADMIN', 'audit.read'),
  ('COMPANY_ADMIN', 'employee.create'), ('COMPANY_ADMIN', 'employee.update'), ('COMPANY_ADMIN', 'employee.import'),
  ('COMPANY_ADMIN', 'employee.cpf.reveal'),
  ('COMPANY_ADMIN', 'epi.create'), ('COMPANY_ADMIN', 'epi.update'),
  ('COMPANY_ADMIN', 'delivery.create'), ('COMPANY_ADMIN', 'delivery.issue'), ('COMPANY_ADMIN', 'delivery.cancel'),
  ('COMPANY_ADMIN', 'delivery.batch.create'), ('COMPANY_ADMIN', 'delivery.batch.resend'),
  ('COMPANY_ADMIN', 'contest.respond'),
  ('COMPANY_ADMIN', 'membership.manage'), ('COMPANY_ADMIN', 'company.settings.update'),
  -- ORG_ADMIN: everything, plus organization-wide and integration configuration.
  ('ORG_ADMIN', 'company.read'), ('ORG_ADMIN', 'employee.read'), ('ORG_ADMIN', 'epi.read'),
  ('ORG_ADMIN', 'delivery.read'), ('ORG_ADMIN', 'audit.read'),
  ('ORG_ADMIN', 'employee.create'), ('ORG_ADMIN', 'employee.update'), ('ORG_ADMIN', 'employee.import'),
  ('ORG_ADMIN', 'employee.cpf.reveal'),
  ('ORG_ADMIN', 'epi.create'), ('ORG_ADMIN', 'epi.update'),
  ('ORG_ADMIN', 'delivery.create'), ('ORG_ADMIN', 'delivery.issue'), ('ORG_ADMIN', 'delivery.cancel'),
  ('ORG_ADMIN', 'delivery.batch.create'), ('ORG_ADMIN', 'delivery.batch.resend'),
  ('ORG_ADMIN', 'contest.respond'),
  ('ORG_ADMIN', 'membership.manage'), ('ORG_ADMIN', 'company.settings.update'),
  ('ORG_ADMIN', 'company.create'), ('ORG_ADMIN', 'organization.settings.update'),
  ('ORG_ADMIN', 'integration.manage');

create table authz.memberships (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app.users (id) on delete restrict,
  organization_id uuid not null,
  company_id      uuid,   -- NULL = every current and future company of the organization
  role            app.role not null,
  invited_by      uuid references app.users (id),
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict
);

comment on table authz.memberships is
  'The ONLY grant of access a user ever has. company_id IS NULL means the role applies to every company in the organization, present and future -- this is how a Partner Admin covers 200 client companies with one row, without an N+1 policy. NEVER granted to authenticated/anon: read only through auth_ctx.* SECURITY DEFINER functions, so a policy on this table can never trigger evaluation of a policy on this table (see docs/architecture.md §7).';

-- At most one live org-wide membership and one live per-company membership per user.
create unique index memberships_org_scope_key on authz.memberships (user_id, organization_id)
  where company_id is null and revoked_at is null;
create unique index memberships_company_scope_key on authz.memberships (user_id, company_id)
  where company_id is not null and revoked_at is null;
create index memberships_org_idx on authz.memberships (organization_id) where revoked_at is null;
create index memberships_company_idx on authz.memberships (company_id) where revoked_at is null and company_id is not null;

-- ============================================================
-- 20260831140400_platform_admin.sql
-- ============================================================
-- FASE 0: platform super admin -- deliberately NOT an RLS bypass.
-- See docs/architecture.md §5. If our own staff could read customer data invisibly we
-- could not answer an ANPD question about who accessed what and when.

create table app.platform_admins (
  user_id    uuid primary key references app.users (id) on delete restrict,
  level      text not null check (level in ('SUPPORT', 'ENGINEER', 'SUPER')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

comment on table app.platform_admins is
  'Global super admins. A separate table, not an authz.memberships row, so an organization-level bug can never mint platform power.';

create table app.platform_access_grants (
  id              uuid primary key default gen_random_uuid(),
  admin_user_id   uuid not null references app.platform_admins (user_id),
  organization_id uuid not null references app.organizations (id),
  company_id      uuid,  -- NULL = whole organization
  reason          text not null check (length(btrim(reason)) >= 20),
  ticket_ref      text,
  granted_by      uuid not null references app.users (id),
  granted_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  check (expires_at > granted_at and expires_at <= granted_at + interval '72 hours'),
  check (granted_by <> admin_user_id)  -- four-eyes: a grant cannot approve itself
);

comment on table app.platform_access_grants is
  'Time-boxed (max 72h), four-eyes (granter != grantee) break-glass support access. Every grant is written into the AFFECTED TENANT''s own audit chain (PLATFORM_ACCESS_GRANTED) once audit.audit_events exists in FASE 5, so a customer can see who at the vendor accessed their data and why.';

create index platform_access_grants_live_idx on app.platform_access_grants (admin_user_id, organization_id)
  where revoked_at is null;
create index platform_access_grants_org_idx on app.platform_access_grants (organization_id) where revoked_at is null;

-- ============================================================
-- 20260831140500_auth_ctx_helpers.sql
-- ============================================================
-- FASE 0: RLS helper functions. This is the single most performance- and
-- security-load-bearing migration in the schema -- see docs/architecture.md §7 for the
-- full reasoning. Read the comments on each function; they are not decorative.

-- auth_ctx.company_ids(): every company id the CURRENT caller can act on, optionally
-- filtered by a specific permission. SECURITY DEFINER + owned by the table owner is what
-- lets this read authz.memberships (which has zero grants to authenticated/anon) without
-- ever triggering evaluation of a policy on that table -- the recursion the classic
-- Supabase RLS bug is made of is structurally impossible here, not merely avoided.
create function auth_ctx.company_ids(p_permission text default null)
returns uuid[]
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct c.id), '{}'::uuid[])
  from authz.memberships m
  join app.companies c
    on c.organization_id = m.organization_id
   and (m.company_id is null or c.id = m.company_id)
  where m.user_id = (select auth.uid())
    and m.revoked_at is null
    and c.archived_at is null
    and (
      p_permission is null
      or exists (
        select 1 from authz.role_permissions rp
        where rp.role = m.role and rp.permission = p_permission
      )
    );
$$;

comment on function auth_ctx.company_ids(text) is
  'Every company_id the current auth.uid() can act on (optionally requiring a specific permission), expanding a company_id IS NULL membership into every company of that organization. ALWAYS call as (select auth_ctx.company_ids()) inside a policy -- the (select ...) wrapper is what turns this into a once-per-statement InitPlan instead of a once-per-row re-evaluation. Enforced by a CI grep, not by memory.';

create function auth_ctx.organization_ids()
returns uuid[]
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct m.organization_id), '{}'::uuid[])
  from authz.memberships m
  where m.user_id = (select auth.uid())
    and m.revoked_at is null;
$$;

comment on function auth_ctx.organization_ids() is
  'Every organization_id the current auth.uid() belongs to. Used for org-scoped tables (organizations itself, future integration_connections, epis with company_id IS NULL, etc).';

create function auth_ctx.has_permission(p_company_id uuid, p_permission text)
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select p_company_id is not null and exists (
    select 1
    from authz.memberships m
    join app.companies c
      on c.organization_id = m.organization_id
     and (m.company_id is null or c.id = m.company_id)
    join authz.role_permissions rp on rp.role = m.role and rp.permission = p_permission
    where m.user_id = (select auth.uid())
      and m.revoked_at is null
      and c.id = p_company_id
      and c.archived_at is null
  );
$$;

comment on function auth_ctx.has_permission(uuid, text) is
  'True iff the current user holds p_permission for p_company_id. Used in WITH CHECK clauses for writes, e.g. (select auth_ctx.has_permission(company_id, ''delivery.issue'')).';

create function auth_ctx.co_member_user_ids()
returns uuid[]
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct theirs.user_id), '{}'::uuid[])
  from authz.memberships mine
  join authz.memberships theirs on theirs.organization_id = mine.organization_id
  where mine.user_id = (select auth.uid())
    and mine.revoked_at is null
    and theirs.revoked_at is null;
$$;

comment on function auth_ctx.co_member_user_ids() is
  'Every user_id sharing at least one live organization membership with the caller. Exists specifically so app.users RLS policies never reference authz.memberships directly -- a policy''s USING clause runs with the CALLER''s own privileges on referenced tables, so a direct join there would require granting authenticated a read on authz.memberships, which is never done (see docs/architecture.md §7).';

create function auth_ctx.is_platform_admin()
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.platform_admins pa
    where pa.user_id = (select auth.uid()) and pa.revoked_at is null
  );
$$;

comment on function auth_ctx.is_platform_admin() is
  'True iff the current user is an active platform admin. NOT used to bypass RLS -- see docs/architecture.md §5. Used only to gate the break-glass grant UI and the platform_access_grants policies.';

revoke execute on function auth_ctx.company_ids(text) from public, anon;
revoke execute on function auth_ctx.organization_ids() from public, anon;
revoke execute on function auth_ctx.has_permission(uuid, text) from public, anon;
revoke execute on function auth_ctx.co_member_user_ids() from public, anon;
revoke execute on function auth_ctx.is_platform_admin() from public, anon;

grant execute on function auth_ctx.company_ids(text) to authenticated;
grant execute on function auth_ctx.organization_ids() to authenticated;
grant execute on function auth_ctx.has_permission(uuid, text) to authenticated;
grant execute on function auth_ctx.co_member_user_ids() to authenticated;
grant execute on function auth_ctx.is_platform_admin() to authenticated;

-- ============================================================
-- 20260831140600_rls_policies.sql
-- ============================================================
-- FASE 0: enable + force RLS and define policies for every table created so far.
-- Layer 4 of docs/architecture.md §7 -- the last line of defence, not the first. Layers
-- 1-3 (schema exposure, privilege absence, composite FKs) are already in place from the
-- earlier migrations in this phase.
--
-- MANDATORY PATTERN for any array-returning auth_ctx helper used in a policy:
--   col = any ((select auth_ctx.foo())::sometype[])
-- Both the `(select ...)` wrapper AND the trailing `::sometype[]` cast are required, not
-- one or the other:
--   - without the (select ...) wrapper, the STABLE function can be re-evaluated per row
--     instead of once per statement (verified against the official Supabase RLS
--     performance guidance -- see docs/architecture.md §7);
--   - WITHOUT the `::sometype[]` cast, `x = ANY((SELECT f()))` is parsed by Postgres as
--     the "= ANY(subquery)" form (compare x against each ROW the subquery returns),
--     not the "= ANY(array)" form -- and a subquery returning one row of an array-typed
--     column is not a set of scalars, so Postgres raises "operator does not exist:
--     uuid = uuid[]". This is EASY to get wrong (it silently type-checks as valid SQL
--     grammar right up until CREATE POLICY rejects it) and was caught only by actually
--     executing these migrations against a real Postgres engine (PGlite) rather than by
--     inspection -- verified with `EXPLAIN` that the cast form still produces a genuine
--     InitPlan (evaluated once per statement), not a per-row re-evaluation.

alter table app.organizations enable row level security;
alter table app.organizations force row level security;

-- The base GRANT is not optional: a policy only ever FILTERS rows a role is already
-- privileged to see. Without this, every query from `authenticated` fails at 42501
-- (permission denied) before RLS is ever evaluated -- this line and the policy below are
-- two independent, both-required halves of "authenticated can read its own orgs".
grant select on app.organizations to authenticated;

create policy organizations_select on app.organizations
  for select to authenticated
  using (id = any ((select auth_ctx.organization_ids())::uuid[]));

-- No insert/update/delete policy for `authenticated`: organizations are created by a
-- platform/onboarding SECURITY DEFINER RPC (FASE 1), never by a direct table write.
-- Column-level UPDATE is additionally revoked in full below so even a future permissive
-- policy could not let a tenant rewrite its own identity.
revoke update on app.organizations from authenticated;

alter table app.companies enable row level security;
alter table app.companies force row level security;

grant select on app.companies to authenticated;

-- Deliberately auth_ctx.company_ids(), NOT organization_ids(): a company-scoped member
-- (e.g. an SST_OPERATOR at a partner clinic assigned to one client company) must see only
-- that company, never sibling client companies of the same partner organization.
-- auth_ctx.company_ids() already encodes that distinction (it expands a company_id IS
-- NULL membership to every company of the org, but leaves a company-scoped membership
-- restricted to that one row) -- using organization_ids() here would silently leak every
-- company in the organization to a member scoped to just one of them.
create policy companies_select on app.companies
  for select to authenticated
  using (id = any ((select auth_ctx.company_ids())::uuid[]));

-- Company creation/update also flows through RPCs in later phases (FASE 1). No
-- insert/update policy for `authenticated` yet; revisit when app.create_company() lands.
revoke insert, update, delete on app.companies from authenticated;

-- app.users: a user sees themself and co-members of their organizations (via the
-- membership-derived company set -- there is no direct policy join against
-- authz.memberships, consistent with that table never being reachable by RLS policies).
alter table app.users enable row level security;
alter table app.users force row level security;

grant select on app.users to authenticated;

create policy users_select_self on app.users
  for select to authenticated
  using (id = (select auth.uid()));

-- Uses auth_ctx.co_member_user_ids() rather than joining authz.memberships directly in
-- the policy body -- a policy's USING clause runs with the CALLER's own privileges on
-- whatever it references, and authenticated is never granted a read on authz.memberships.
create policy users_select_co_members on app.users
  for select to authenticated
  using (id = any ((select auth_ctx.co_member_user_ids())::uuid[]));

-- Users update only their own display fields, never their id or email (email changes go
-- through Supabase Auth, not a direct table write). Both the column-restricted GRANT and
-- the UPDATE policy are required -- RLS has no default-allow, an UPDATE with no policy at
-- all is simply refused for every row.
revoke update on app.users from authenticated;
grant update (full_name, phone_e164) on app.users to authenticated;

create policy users_update_self on app.users
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- authz.role_permissions: platform metadata, no tenant dimension, static (migration-only).
-- No grant to authenticated/anon at all -- read only via auth_ctx.has_permission().
alter table authz.role_permissions enable row level security;
alter table authz.role_permissions force row level security;
-- (No policies: with RLS forced and zero grants, this table is unreachable via PostgREST
-- regardless. Enabling RLS anyway keeps the CI invariant check in §7/§18 uniform across
-- every table in these schemas.)

-- authz.memberships: the recursion-proofing table. Enabled and forced for the CI
-- invariant, but MUST NEVER receive a grant to authenticated/anon and MUST NEVER receive
-- a policy that queries itself -- see docs/architecture.md §7. Read exclusively through
-- the auth_ctx.* SECURITY DEFINER functions.
alter table authz.memberships enable row level security;
alter table authz.memberships force row level security;
revoke all on authz.memberships from authenticated, anon;

-- app.platform_admins / app.platform_access_grants: visible to the granting platform
-- admins AND to the ORG_OWNER-equivalent (ORG_ADMIN) of the affected organization -- a
-- customer can see who at the vendor had access to their data and why.
alter table app.platform_admins enable row level security;
alter table app.platform_admins force row level security;

grant select on app.platform_admins to authenticated;

create policy platform_admins_select_self on app.platform_admins
  for select to authenticated
  using (user_id = (select auth.uid()));

alter table app.platform_access_grants enable row level security;
alter table app.platform_access_grants force row level security;

grant select on app.platform_access_grants to authenticated;

create policy platform_access_grants_select on app.platform_access_grants
  for select to authenticated
  using (
    admin_user_id = (select auth.uid())
    or organization_id = any ((select auth_ctx.organization_ids())::uuid[])
  );

-- No insert/update policy for `authenticated` on either table: grants are created only
-- through app.grant_platform_access() (FASE 5, once audit.audit_events exists so every
-- grant can be written into the target tenant's own audit chain).
revoke insert, update, delete on app.platform_admins, app.platform_access_grants from authenticated;

-- ============================================================
-- 20260831140700_state_transitions.sql
-- ============================================================
-- FASE 0: the state-machine RULE TABLE, created empty. Populated by data-only migrations
-- in FASE 2 (delivery machine) and FASE 3 (confirmation_request machine) -- see
-- docs/architecture.md §8. Kept as plain text columns (not enums) for from_state/event/
-- to_state so a new transition is a one-row INSERT, never a DDL change; the STATUS
-- columns on the actual entity tables (added in FASE 2/3) are enums, giving impossible
-- values as well as impossible transitions.

create table app.state_transitions (
  machine          text not null check (machine in ('DELIVERY', 'CONFIRMATION_REQUEST')),
  machine_version  integer not null default 1,
  from_state       text not null,
  event            text not null check (event ~ '^[A-Z][A-Z0-9_]{2,49}$'),
  to_state         text not null,
  actor_kinds      text[] not null,  -- who may fire it: {'USER'}, {'WORKER'}, {'SYSTEM'}, {'PROVIDER'}
  required_permission text,
  is_terminal      boolean not null default false,
  introduced_in    text not null,    -- migration filename, for provenance
  primary key (machine, machine_version, from_state, event)
);

comment on table app.state_transitions is
  'The two state machines (DELIVERY, CONFIRMATION_REQUEST) as DATA, not as a CASE statement buried in a trigger. The primary key makes non-determinism (two different to_states for the same from_state+event) a key violation, not a code-review finding. See docs/architecture.md §8 for the full transition tables, added by migration in FASE 2/3.';

alter table app.state_transitions enable row level security;
alter table app.state_transitions force row level security;
-- No tenant dimension, no grant to authenticated/anon: read only by the transition RPCs
-- (SECURITY DEFINER, FASE 2/3) and by migrations. Enabling RLS keeps the CI invariant
-- check uniform.
revoke all on app.state_transitions from authenticated, anon;

-- ============================================================
-- 20260831140800_api_schema_views.sql
-- ============================================================
-- FASE 0: the `api` schema -- the ONLY thing PostgREST can see (config.toml api.schemas =
-- ["api", "graphql_public"]). Every view is `security_invoker = true` so the CALLER's own
-- RLS policies apply, not the view owner's -- a view is a convenience projection here,
-- never a privilege escalation. A table with no view in this file is simply absent from
-- the HTTP API, not "exposed and hopefully policied" -- see docs/architecture.md §7.

create view api.organizations
  with (security_invoker = true) as
select id, kind, legal_name, cnpj, status, timezone, default_assurance_level,
       link_ttl_hours, identity_max_attempts, evidence_retention_months,
       retain_selfie, contest_requires_identity, created_at, updated_at
from app.organizations;

grant select on api.organizations to authenticated;

create view api.companies
  with (security_invoker = true) as
select id, organization_id, organization_kind, cnpj, legal_name, trade_name, status,
       archived_at, created_at, updated_at
from app.companies;

grant select on api.companies to authenticated;

create view api.users
  with (security_invoker = true) as
select id, full_name, email, phone_e164, disabled_at, created_at
from app.users;

grant select on api.users to authenticated;
-- The underlying table grant already restricts writable columns to (full_name,
-- phone_e164) for `authenticated` -- see the RLS migration. A simple 1:1 view over a
-- single table is automatically updatable in Postgres, so this GRANT is sufficient
-- without an INSTEAD OF trigger.
grant update on api.users to authenticated;

-- NOTE: this is deliberately an RPC function, not a `security_invoker` view. A
-- security_invoker view checks the CALLER's own privileges against the underlying table,
-- and authenticated has (by design) zero grant on authz.memberships -- so a view here
-- would either fail for every caller or force a grant that reopens the exact recursion
-- risk auth_ctx.* exists to close. A SECURITY DEFINER function, hard-scoped to
-- `where user_id = auth.uid()`, gives the same "see only your own memberships" result
-- without ever granting broad table access.
create function api.my_memberships()
returns table (
  id uuid, organization_id uuid, company_id uuid, role app.role,
  accepted_at timestamptz, created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.organization_id, m.company_id, m.role, m.accepted_at, m.created_at
  from authz.memberships m
  where m.user_id = (select auth.uid())
    and m.revoked_at is null;
$$;

comment on function api.my_memberships() is
  'The current user''s own live memberships. This is how the panel discovers "which organizations/companies am I in and with what role" without ever granting authenticated a read on authz.memberships itself.';

revoke execute on function api.my_memberships() from public, anon;
grant execute on function api.my_memberships() to authenticated;

