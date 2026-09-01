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

-- authz.memberships: the recursion-proofing table. RLS is ENABLED (for the CI invariant
-- that every table in these schemas has RLS on) but deliberately NEVER FORCED: FORCE ROW
-- LEVEL SECURITY would apply RLS even to the table owner, and the auth_ctx.* SECURITY
-- DEFINER functions (owned by that same owner) rely on being exempt from this table's own
-- policies to avoid the exact recursion this design otherwise prevents structurally -- see
-- docs/architecture.md §7, "why this cannot recurse". This table MUST ALSO NEVER receive a
-- grant to authenticated/anon and MUST NEVER receive a policy that queries itself. Read
-- exclusively through the auth_ctx.* SECURITY DEFINER functions.
alter table authz.memberships enable row level security;
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
