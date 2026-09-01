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
