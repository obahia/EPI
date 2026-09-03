-- Phase B: locations ("unidades/locais"), sitting between company and employee. Company
-- stays the CNPJ/legal-entity tenant boundary, unchanged -- a location is a physical site
-- WITHIN one company (e.g. a São Paulo unit and a Campinas unit of the same legal entity),
-- and is the level stock gets tracked at.

create table app.locations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  company_id      uuid not null,
  name            text not null check (length(btrim(name)) between 2 and 150),
  code            text check (length(code) <= 40),
  address         jsonb not null default '{}',
  status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  created_at      timestamptz not null default now(),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  constraint locations_id_company_key unique (id, company_id)
);

comment on table app.locations is
  'A site/unit within one company -- NOT a rename of company, which stays the CNPJ/legal-entity tenant boundary. Stock is tracked per (company_id, location_id), with a null location_id meaning a company-wide bucket not tied to a specific site.';

create index locations_company_idx on app.locations (company_id) where status = 'ACTIVE';

alter table app.locations enable row level security;
alter table app.locations force row level security;

grant select on app.locations to authenticated;

create policy locations_select on app.locations
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('location.read'))::uuid[]));

revoke insert, update, delete on app.locations from authenticated;

alter table app.employees
  add column location_id uuid;

alter table app.employees
  add constraint employees_location_company_fk
    foreign key (location_id, company_id) references app.locations (id, company_id) on delete restrict;

comment on column app.employees.location_id is
  'Optional FK into app.locations -- must belong to the employee''s own company (enforced by the composite FK). NULL means unassigned to a specific site.';

create index employees_location_idx on app.employees (location_id) where location_id is not null;

create function api.create_location(
  p_company_id uuid,
  p_name text,
  p_code text default null,
  p_address jsonb default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_location_id uuid;
begin
  if not (select auth_ctx.has_permission(p_company_id, 'location.write')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select organization_id into v_org_id from app.companies where id = p_company_id;

  insert into app.locations (organization_id, company_id, name, code, address)
  values (v_org_id, p_company_id, p_name, p_code, coalesce(p_address, '{}'::jsonb))
  returning id into v_location_id;

  return v_location_id;
end;
$$;

comment on function api.create_location(uuid, text, text, jsonb) is
  'Creates a location (site/unit) within one company.';

revoke execute on function api.create_location(uuid, text, text, jsonb) from public, anon;
grant execute on function api.create_location(uuid, text, text, jsonb) to authenticated;

create function api.update_location(p_location_id uuid, p_name text, p_code text, p_address jsonb, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id from app.locations where id = p_location_id;
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'location.write')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_status not in ('ACTIVE', 'INACTIVE') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  update app.locations
  set name = p_name, code = p_code, address = coalesce(p_address, '{}'::jsonb), status = p_status
  where id = p_location_id;
end;
$$;

comment on function api.update_location(uuid, text, text, jsonb, text) is 'Updates a location in place.';

revoke execute on function api.update_location(uuid, text, text, jsonb, text) from public, anon;
grant execute on function api.update_location(uuid, text, text, jsonb, text) to authenticated;

insert into authz.role_permissions (role, permission) values
  ('VIEWER', 'location.read'),
  ('SST_OPERATOR', 'location.read'), ('SST_OPERATOR', 'location.write'),
  ('COMPANY_ADMIN', 'location.read'), ('COMPANY_ADMIN', 'location.write'),
  ('ORG_ADMIN', 'location.read'), ('ORG_ADMIN', 'location.write');

create view api.locations
  with (security_invoker = true) as
select id, organization_id, company_id, name, code, address, status, created_at
from app.locations;

comment on view api.locations is 'Read-only projection of app.locations. security_invoker means RLS applies for the caller.';

grant select on api.locations to authenticated;

-- Existing employees view gains the new column at the end.
create or replace view api.employees
  with (security_invoker = true) as
select
  id, organization_id, company_id, full_name, cpf_masked, registration_number,
  phone_e164, email, position_title, department, status, terminated_on,
  data_origin, external_source, external_ref, created_at, updated_at,
  position_id, location_id
from app.employees
where archived_at is null;

comment on view api.employees is
  'Read-only projection of app.employees. Never selects cpf_hash/cpf_enc -- cpf_masked is the only CPF representation that ever crosses HTTP.';

grant select on api.employees to authenticated;
