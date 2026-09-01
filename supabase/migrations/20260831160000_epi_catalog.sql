-- FASE 2: PPE (EPI) catalog. Versioned (epis + epi_versions, SCD2) so a later correction
-- to a CA number or name can never retroactively change what a historical delivery
-- claims -- deliveries snapshot the values by copy into epi_delivery_items (next
-- migration), keyed to a specific epi_version_id. No stock, no purchasing (docs/mvp-roadmap.md
-- FASE 2 / original spec §10).

create table app.epis (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete restrict,
  company_id      uuid,  -- NULL = shared catalog entry across every company in the org
  is_active       boolean not null default true,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  created_by      uuid references app.users (id),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  constraint epis_org_id_key unique (organization_id, id)
);

comment on table app.epis is
  'PPE catalog item identity. company_id NULL means the org-wide/shared catalog (a partner clinic defines an item once for all its client companies); company_id set scopes it to one company. Evidence-relevant attributes live in epi_versions, never here.';

create table app.epi_versions (
  id              uuid primary key default gen_random_uuid(),
  epi_id          uuid not null references app.epis (id) on delete restrict,
  organization_id uuid not null,
  company_id      uuid,
  -- clock_timestamp(), not now(): now() is frozen at transaction START, so two versions
  -- opened/closed within the SAME transaction (e.g. create-then-immediately-update, or a
  -- future bulk edit) would get IDENTICAL valid_from/valid_to values -- violating the
  -- valid_to > valid_from CHECK below. Caught by actually running this against a real
  -- Postgres engine, not by inspection -- see the identical fix on issued_at/cancelled_at
  -- in epi_deliveries (next migration set).
  version         integer not null check (version >= 1),
  name            text not null check (length(btrim(name)) between 2 and 200),
  ca_number       text not null check (ca_number ~ '^[0-9]{3,8}$'),
  manufacturer    text check (length(manufacturer) <= 150),
  model           text check (length(model) <= 150),
  description     text check (length(description) <= 2000),
  default_unit    text not null default 'UN' check (default_unit in ('UN', 'PAR', 'CX', 'M', 'KG')),
  valid_from      timestamptz not null default clock_timestamp(),
  valid_to        timestamptz,
  created_by      uuid references app.users (id),
  foreign key (epi_id, organization_id) references app.epis (id, organization_id),
  constraint epi_versions_seq_key unique (epi_id, version),
  check (valid_to is null or valid_to > valid_from)
);

comment on table app.epi_versions is
  'Append-only attribute history for one epi. Exactly one row per epi has valid_to IS NULL (the current version) -- enforced by epi_versions_current below. A correction inserts a new row and closes the old one (valid_to = now()); it never UPDATEs name/ca_number/etc in place, so a delivery that snapshotted an old version keeps pointing at exactly what it said at delivery time.';

create unique index epi_versions_current on app.epi_versions (epi_id) where valid_to is null;

-- One live catalog entry per (scope, CA). NULLS NOT DISTINCT (PG15+) so two org-wide
-- entries (company_id IS NULL) with the same CA collide too, not just same-company ones.
create unique index epis_scope_ca_key on app.epi_versions (organization_id, company_id, ca_number)
  nulls not distinct where valid_to is null;

create index epi_versions_ca_search on app.epi_versions (ca_number) where valid_to is null;

alter table app.epis enable row level security;
alter table app.epis force row level security;
alter table app.epi_versions enable row level security;
alter table app.epi_versions force row level security;

grant select on app.epis, app.epi_versions to authenticated;

-- A company-scoped member sees the org's shared catalog (company_id IS NULL) plus their
-- own company's entries -- never a sibling company's private catalog items.
create policy epis_select on app.epis
  for select to authenticated
  using (
    organization_id = any ((select auth_ctx.organization_ids())::uuid[])
    and (company_id is null or company_id = any ((select auth_ctx.company_ids())::uuid[]))
  );

create policy epi_versions_select on app.epi_versions
  for select to authenticated
  using (
    organization_id = any ((select auth_ctx.organization_ids())::uuid[])
    and (company_id is null or company_id = any ((select auth_ctx.company_ids())::uuid[]))
  );

-- Writes are RPC-only (api.create_epi / api.update_epi, next migration) -- creating/
-- editing an org-wide catalog entry needs org-level ORG_ADMIN, which a per-table RLS
-- policy cannot express cleanly against a nullable company_id; the RPC does that check.
revoke insert, update, delete on app.epis, app.epi_versions from authenticated;
