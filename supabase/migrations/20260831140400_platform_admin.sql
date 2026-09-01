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
