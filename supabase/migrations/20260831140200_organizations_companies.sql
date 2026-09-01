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
