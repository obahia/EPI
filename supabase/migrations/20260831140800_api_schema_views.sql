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
