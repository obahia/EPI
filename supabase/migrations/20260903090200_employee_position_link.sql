-- Phase A: links app.employees to the new job_positions catalog. Additive and nullable --
-- existing free-text position_title/department columns are untouched, so an employee never
-- mapped to the catalog keeps displaying exactly as before. position_id is the
-- forward-looking primary input; position_title becomes a legacy fallback shown only when
-- position_id is null.

alter table app.employees
  add column position_id uuid references app.job_positions (id);

comment on column app.employees.position_id is
  'Optional FK into app.job_positions -- the structured cargo an employee holds, used by the compliance engine (a later phase). NULL means this employee predates the catalog or was never mapped; position_title (free text) remains the display fallback in that case.';

create index employees_position_idx on app.employees (position_id) where position_id is not null;

-- api.create_employee / api.update_employee both gain one new trailing DEFAULTed param.
-- A function's identity in Postgres is name + parameter TYPE LIST -- CREATE OR REPLACE
-- cannot change the argument count even when every new parameter has a default (verified
-- against a real Postgres engine: attempting it left BOTH the old and new signatures
-- installed as separate overloads, "is not unique" on any call). The old signature must be
-- dropped explicitly first -- same convention this schema already uses for worker.open_link
-- /worker.finish_confirmation whenever their signature changes across migrations.
drop function if exists api.create_employee(uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text);
drop function if exists api.update_employee(uuid, text, text, text, text, text, text, text);

create function api.create_employee(
  p_company_id uuid,
  p_full_name text,
  p_cpf_hash_b64 text,
  p_cpf_enc_b64 text,
  p_cpf_masked text,
  p_registration_number text default null,
  p_phone_e164 text default null,
  p_email text default null,
  p_position_title text default null,
  p_department text default null,
  p_data_origin app.data_origin default 'MANUAL',
  p_external_source text default null,
  p_external_ref text default null,
  p_position_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_employee_id uuid;
  v_position_org_id uuid;
  v_position_company_id uuid;
begin
  if not (select auth_ctx.has_permission(p_company_id, 'employee.create')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select organization_id into v_org_id from app.companies where id = p_company_id;

  if p_position_id is not null then
    select organization_id, company_id into v_position_org_id, v_position_company_id
    from app.job_positions where id = p_position_id;
    if v_position_org_id is null or v_position_org_id <> v_org_id then
      raise exception 'position_not_found' using errcode = 'P0002';
    end if;
    if v_position_company_id is not null and v_position_company_id <> p_company_id then
      raise exception 'position_out_of_scope' using errcode = '23514';
    end if;
  end if;

  insert into app.employees (
    organization_id, company_id, full_name, cpf_hash, cpf_enc, cpf_masked,
    registration_number, phone_e164, email, position_title, department,
    data_origin, external_source, external_ref, position_id, created_by
  ) values (
    v_org_id, p_company_id, p_full_name,
    decode(p_cpf_hash_b64, 'base64'), decode(p_cpf_enc_b64, 'base64'), p_cpf_masked,
    p_registration_number, p_phone_e164, p_email, p_position_title, p_department,
    p_data_origin, p_external_source, p_external_ref, p_position_id, (select auth.uid())
  )
  returning id into v_employee_id;

  return v_employee_id;
exception
  when unique_violation then
    raise exception 'cpf_already_registered' using errcode = '23505';
end;
$$;

comment on function api.create_employee(uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text, uuid) is
  'Manual (or import-row) employee creation. Never accepts a raw CPF. p_position_id (optional) must belong to the same organization and be either org-wide or scoped to this company.';

revoke execute on function api.create_employee(uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text, uuid) from public, anon;
grant execute on function api.create_employee(uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text, uuid) to authenticated;

create function api.update_employee(
  p_employee_id uuid,
  p_full_name text,
  p_registration_number text,
  p_phone_e164 text,
  p_email text,
  p_position_title text,
  p_department text,
  p_status text,
  p_position_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_org_id uuid;
  v_position_org_id uuid;
  v_position_company_id uuid;
begin
  select company_id, organization_id into v_company_id, v_org_id
  from app.employees where id = p_employee_id and archived_at is null;
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if not (select auth_ctx.has_permission(v_company_id, 'employee.update')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_position_id is not null then
    select organization_id, company_id into v_position_org_id, v_position_company_id
    from app.job_positions where id = p_position_id;
    if v_position_org_id is null or v_position_org_id <> v_org_id then
      raise exception 'position_not_found' using errcode = 'P0002';
    end if;
    if v_position_company_id is not null and v_position_company_id <> v_company_id then
      raise exception 'position_out_of_scope' using errcode = '23514';
    end if;
  end if;

  update app.employees set
    full_name = p_full_name,
    registration_number = p_registration_number,
    phone_e164 = p_phone_e164,
    email = p_email,
    position_title = p_position_title,
    department = p_department,
    status = p_status,
    position_id = p_position_id,
    terminated_on = case when p_status = 'TERMINATED' then coalesce(terminated_on, current_date) else null end
  where id = p_employee_id;
end;
$$;

comment on function api.update_employee(uuid, text, text, text, text, text, text, text, uuid) is
  'Updates editable employee fields. CPF is never editable through this RPC. p_position_id (optional) must belong to the employee''s own organization and be either org-wide or scoped to their company.';

revoke execute on function api.update_employee(uuid, text, text, text, text, text, text, text, uuid) from public, anon;
grant execute on function api.update_employee(uuid, text, text, text, text, text, text, text, uuid) to authenticated;

-- Existing view (20260831150300_employees_api_view.sql) gets position_id appended --
-- CREATE OR REPLACE VIEW adds the trailing column without a DROP, same precedent used
-- throughout this phase.
create or replace view api.employees
  with (security_invoker = true) as
select
  id, organization_id, company_id, full_name, cpf_masked, registration_number,
  phone_e164, email, position_title, department, status, terminated_on,
  data_origin, external_source, external_ref, created_at, updated_at,
  position_id
from app.employees
where archived_at is null;

comment on view api.employees is
  'Read-only projection of app.employees. Never selects cpf_hash/cpf_enc -- cpf_masked is the only CPF representation that ever crosses HTTP.';

grant select on api.employees to authenticated;
