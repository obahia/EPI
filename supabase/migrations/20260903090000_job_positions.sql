-- Phase A (post-MVP expansion, see docs/mvp-roadmap.md and the Selo platform-expansion
-- plan): job positions ("cargo/função") + the position x EPI requirement matrix. Mirrors
-- app.epis's identity pattern exactly (org-wide-or-company-scoped catalog, RPC-only writes)
-- -- deliberately NOT SCD2-versioned like epis/epi_versions: a title/description edit in
-- place carries no legal-evidence weight the way a catalog CA/name correction does, so the
-- extra machinery would be unearned complexity here.

create table app.job_positions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete restrict,
  company_id      uuid,  -- NULL = shared across every company in the org, same convention as app.epis
  title           text not null check (length(btrim(title)) between 2 and 150),
  description     text check (length(description) <= 2000),
  status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  created_at      timestamptz not null default now(),
  created_by      uuid references app.users (id),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  constraint job_positions_org_id_key unique (organization_id, id)
);

comment on table app.job_positions is
  'A job position/role ("cargo") that drives the EPI requirement matrix. company_id NULL means the org-wide shared catalog (same convention as app.epis); non-null scopes it to one company. Not versioned -- an edit is a plain UPDATE, unlike the epi catalog''s SCD2 history.';

create unique index job_positions_scope_title_key on app.job_positions (organization_id, company_id, lower(title))
  nulls not distinct where status = 'ACTIVE';

alter table app.job_positions enable row level security;
alter table app.job_positions force row level security;

grant select on app.job_positions to authenticated;

create policy job_positions_select on app.job_positions
  for select to authenticated
  using (
    organization_id = any ((select auth_ctx.organization_ids())::uuid[])
    and (company_id is null or company_id = any ((select auth_ctx.company_ids())::uuid[]))
  );

-- Writes are RPC-only (api.create_job_position / api.update_job_position, below) -- same
-- reasoning as app.epis: an org-wide entry needs org-level ORG_ADMIN, which a per-table RLS
-- policy can't express cleanly against a nullable company_id.
revoke insert, update, delete on app.job_positions from authenticated;

-- The matriz cargo x EPI. company_id is a denormalized copy of the position's own scope
-- (not a second source of truth -- set once at insert time by the RPC below) so the RLS
-- policy can filter directly without joining out to app.job_positions, matching this
-- schema's convention that a policy only ever calls auth_ctx.* stable functions, never
-- joins another RLS-protected table (docs/architecture.md §7 performance rule).
create table app.position_epi_requirements (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  company_id         uuid,
  position_id        uuid not null,
  epi_id             uuid not null,
  required           boolean not null default true,
  quantity           integer not null default 1 check (quantity between 1 and 100),
  periodicity_days   integer check (periodicity_days is null or periodicity_days between 1 and 3650),
  substitution_notes text check (length(substitution_notes) <= 1000),
  created_at         timestamptz not null default now(),
  created_by         uuid references app.users (id),
  foreign key (position_id, organization_id) references app.job_positions (id, organization_id) on delete restrict,
  foreign key (epi_id, organization_id) references app.epis (id, organization_id) on delete restrict,
  constraint position_epi_requirements_key unique (position_id, epi_id)
);

comment on table app.position_epi_requirements is
  'One row per (position, epi) requirement -- the matriz cargo x EPI. Deterministic input to the compliance engine (a later phase): "to hold this position, these EPIs are expected." No PGR/legal-mandate inference lives here, only what the organization configured.';

create index position_epi_requirements_position_idx on app.position_epi_requirements (position_id);
create index position_epi_requirements_epi_idx on app.position_epi_requirements (epi_id);

alter table app.position_epi_requirements enable row level security;
alter table app.position_epi_requirements force row level security;

grant select on app.position_epi_requirements to authenticated;

create policy position_epi_requirements_select on app.position_epi_requirements
  for select to authenticated
  using (
    organization_id = any ((select auth_ctx.organization_ids())::uuid[])
    and (company_id is null or company_id = any ((select auth_ctx.company_ids())::uuid[]))
  );

revoke insert, update, delete on app.position_epi_requirements from authenticated;

-- New permission strings, INSERT-only into the existing role_permissions table -- same
-- convention 20260831200900_epi_returns.sql documents for 'delivery.return'. position.read
-- rides at the same tier as epi.read/employee.read (every existing role already has it);
-- position.write rides at the same tier epi.create/epi.update already sit at.
insert into authz.role_permissions (role, permission) values
  ('VIEWER', 'position.read'),
  ('SST_OPERATOR', 'position.read'), ('SST_OPERATOR', 'position.write'),
  ('COMPANY_ADMIN', 'position.read'), ('COMPANY_ADMIN', 'position.write'),
  ('ORG_ADMIN', 'position.read'), ('ORG_ADMIN', 'position.write');

-- RPCs -------------------------------------------------------------------------------

create function api.create_job_position(
  p_organization_id uuid,
  p_company_id uuid,  -- NULL = org-wide shared catalog entry
  p_title text,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_position_id uuid;
begin
  if p_company_id is null then
    if not exists (
      select 1 from authz.memberships m
      where m.user_id = v_uid and m.organization_id = p_organization_id
        and m.company_id is null and m.role = 'ORG_ADMIN' and m.revoked_at is null
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  else
    if not (select auth_ctx.has_permission(p_company_id, 'position.write')) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  insert into app.job_positions (organization_id, company_id, title, description, created_by)
  values (p_organization_id, p_company_id, p_title, p_description, v_uid)
  returning id into v_position_id;

  return v_position_id;
exception
  when unique_violation then
    raise exception 'position_title_already_exists' using errcode = '23505';
end;
$$;

comment on function api.create_job_position(uuid, uuid, text, text) is
  'Creates a job position. p_company_id NULL creates an org-wide shared entry (requires org-wide ORG_ADMIN); non-null scopes it to one company (requires position.write there).';

revoke execute on function api.create_job_position(uuid, uuid, text, text) from public, anon;
grant execute on function api.create_job_position(uuid, uuid, text, text) to authenticated;

create function api.update_job_position(
  p_position_id uuid,
  p_title text,
  p_description text,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_company_id uuid;
  v_org_id uuid;
begin
  select company_id, organization_id into v_company_id, v_org_id
  from app.job_positions where id = p_position_id;

  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_status not in ('ACTIVE', 'INACTIVE') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  if v_company_id is null then
    if not exists (
      select 1 from authz.memberships m
      where m.user_id = v_uid and m.organization_id = v_org_id
        and m.company_id is null and m.role = 'ORG_ADMIN' and m.revoked_at is null
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  else
    if not (select auth_ctx.has_permission(v_company_id, 'position.write')) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  update app.job_positions
  set title = p_title, description = p_description, status = p_status
  where id = p_position_id;
exception
  when unique_violation then
    raise exception 'position_title_already_exists' using errcode = '23505';
end;
$$;

comment on function api.update_job_position(uuid, text, text, text) is
  'Updates a job position in place (not versioned -- see table comment). Setting status=INACTIVE hides it from future employee/matrix pickers without affecting existing assignments.';

revoke execute on function api.update_job_position(uuid, text, text, text) from public, anon;
grant execute on function api.update_job_position(uuid, text, text, text) to authenticated;

-- Upsert one requirement row. Resolves and denormalizes company_id from the position
-- itself (never trusts a client-supplied value) and requires the EPI to be visible in the
-- same scope (org-wide or the position's own company) -- same "reject silently-mismatched
-- scope" discipline api.create_delivery already applies to epi_id.
create function api.set_position_epi_requirement(
  p_position_id uuid,
  p_epi_id uuid,
  p_required boolean default true,
  p_quantity integer default 1,
  p_periodicity_days integer default null,
  p_substitution_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_position_company_id uuid;
  v_org_id uuid;
  v_epi_company_id uuid;
  v_epi_org_id uuid;
  v_req_id uuid;
begin
  select company_id, organization_id into v_position_company_id, v_org_id
  from app.job_positions where id = p_position_id;
  if v_org_id is null then
    raise exception 'position_not_found' using errcode = 'P0002';
  end if;

  select company_id, organization_id into v_epi_company_id, v_epi_org_id
  from app.epis where id = p_epi_id and archived_at is null;
  if v_epi_org_id is null or v_epi_org_id <> v_org_id then
    raise exception 'epi_not_found' using errcode = 'P0002';
  end if;
  if v_epi_company_id is not null and v_epi_company_id <> v_position_company_id then
    raise exception 'epi_out_of_scope' using errcode = '23514';
  end if;

  if v_position_company_id is null then
    if not exists (
      select 1 from authz.memberships m
      where m.user_id = (select auth.uid()) and m.organization_id = v_org_id
        and m.company_id is null and m.role = 'ORG_ADMIN' and m.revoked_at is null
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  else
    if not (select auth_ctx.has_permission(v_position_company_id, 'position.write')) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  insert into app.position_epi_requirements (
    organization_id, company_id, position_id, epi_id,
    required, quantity, periodicity_days, substitution_notes, created_by
  ) values (
    v_org_id, v_position_company_id, p_position_id, p_epi_id,
    p_required, p_quantity, p_periodicity_days, p_substitution_notes, (select auth.uid())
  )
  on conflict (position_id, epi_id) do update set
    required = excluded.required,
    quantity = excluded.quantity,
    periodicity_days = excluded.periodicity_days,
    substitution_notes = excluded.substitution_notes
  returning id into v_req_id;

  return v_req_id;
end;
$$;

comment on function api.set_position_epi_requirement(uuid, uuid, boolean, integer, integer, text) is
  'Upserts one matriz cargo x EPI requirement row. epi_id must belong to the same organization and be either org-wide or scoped to the position''s own company.';

revoke execute on function api.set_position_epi_requirement(uuid, uuid, boolean, integer, integer, text) from public, anon;
grant execute on function api.set_position_epi_requirement(uuid, uuid, boolean, integer, integer, text) to authenticated;

create function api.remove_position_epi_requirement(p_requirement_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_org_id uuid;
begin
  select company_id, organization_id into v_company_id, v_org_id
  from app.position_epi_requirements where id = p_requirement_id;
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if v_company_id is null then
    if not exists (
      select 1 from authz.memberships m
      where m.user_id = (select auth.uid()) and m.organization_id = v_org_id
        and m.company_id is null and m.role = 'ORG_ADMIN' and m.revoked_at is null
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  else
    if not (select auth_ctx.has_permission(v_company_id, 'position.write')) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  delete from app.position_epi_requirements where id = p_requirement_id;
end;
$$;

comment on function api.remove_position_epi_requirement(uuid) is
  'Removes one matriz requirement row. Hard delete (not an event) -- the requirement matrix is current-state configuration, not an evidentiary history the way deliveries/evidence are.';

revoke execute on function api.remove_position_epi_requirement(uuid) from public, anon;
grant execute on function api.remove_position_epi_requirement(uuid) to authenticated;

-- Read-only projections ---------------------------------------------------------------

create view api.job_positions
  with (security_invoker = true) as
select id, organization_id, company_id, title, description, status, created_at
from app.job_positions;

comment on view api.job_positions is 'Read-only projection of app.job_positions. security_invoker means RLS applies for the caller.';

grant select on api.job_positions to authenticated;

create view api.position_epi_requirements
  with (security_invoker = true) as
select
  r.id, r.organization_id, r.company_id, r.position_id, r.epi_id,
  r.required, r.quantity, r.periodicity_days, r.substitution_notes, r.created_at,
  v.name as epi_name, v.ca_number
from app.position_epi_requirements r
join app.epi_versions v on v.epi_id = r.epi_id and v.valid_to is null;

comment on view api.position_epi_requirements is
  'Matriz cargo x EPI, joined to the epi''s current catalog version for display (name/CA). security_invoker means RLS on both underlying tables applies for the caller.';

grant select on api.position_epi_requirements to authenticated;
