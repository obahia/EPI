-- FASE 4: identity_profiles -- a narrow pointer to a provider's enrollment record for an
-- employee (provider name + their subject id), NEVER a biometric template (docs/architecture.md
-- §6/§9). Unused until a real biometric vendor is chosen (architecture.md §9/§20 -- pending
-- business decision, requires a paid service/credentials): AL0_LINK_ONLY and
-- AL1_LINK_KNOWLEDGE (the only methods FASE 3/4 actually produce) need no enrollment at
-- all. Created now as schema scaffold, same pattern as `evidence`/`audit` in FASE 0 and
-- `integ.*` for WOTY -- architecture ready, no fictional API surface: no enroll RPC exists
-- yet because nothing calls it yet.

create table app.identity_profiles (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  company_id         uuid not null,
  employee_id        uuid not null,
  provider           text not null,
  provider_subject_id text not null check (length(provider_subject_id) between 1 and 200),
  created_at         timestamptz not null default clock_timestamp(),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  foreign key (company_id, employee_id) references app.employees (company_id, id) on delete restrict,
  constraint identity_profiles_employee_provider_key unique (employee_id, provider)
);

comment on table app.identity_profiles is
  'Pointer only (provider, provider_subject_id) to an employee''s enrollment record at an identity provider -- never a biometric template or raw image. One row per (employee, provider): an employee could in principle be enrolled with more than one vendor over time. See docs/architecture.md §9 for why this is deliberately narrow.';

create index identity_profiles_employee_idx on app.identity_profiles (employee_id);

-- No INSERT/UPDATE/DELETE grant to anyone yet -- there is no enrollment RPC until a real
-- provider adapter exists (src/lib/identity/*). Read-only scaffold.
revoke insert, update, delete on app.identity_profiles from authenticated, anon;

alter table app.identity_profiles enable row level security;
alter table app.identity_profiles force row level security;

grant select on app.identity_profiles to authenticated;

create policy identity_profiles_select on app.identity_profiles
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('employee.read'))::uuid[]));
