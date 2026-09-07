-- Phase F, step 1 of 2 of the core extraction (see the Phase F contract, section D).
--
-- THIS MIGRATION MUST NOT CHANGE ANY BEHAVIOR. It moves the domain body of
-- api.create_employee / api.update_employee into app.*_core functions and leaves the api.*
-- functions as thin authorizing facades. The proof of neutrality is that every existing
-- pgTAP suite (020..170) passes with ZERO edits. Domain events (EMPLOYEE_CREATED etc.) are
-- deliberately NOT added here -- that is step 2, in its own migration, after this one is
-- green. A single migration doing both would make the neutrality claim unprovable.
--
-- Why extract at all: the Phase F public API must run the SAME domain operation as the
-- panel, without forging auth.uid() and without duplicating invariants. The seam already
-- existed -- every api.* RPC is `authorize; then domain` -- so extraction is a cut along a
-- line the codebase already drew, not a redesign.

-- The actor is WHO, never WHERE. Tenant scoping stays in explicit parameters exactly as it
-- is today, so the extracted bodies stay verbatim; only the identity of the caller becomes
-- a value instead of an ambient auth.uid() lookup.
create type app.actor_context as (
  actor_kind    text,   -- 'USER' | 'PROVIDER' -- mirrors audit.audit_events.actor_kind
  actor_user_id uuid,   -- non-null iff actor_kind = 'USER'
  principal_id  uuid    -- non-null iff actor_kind = 'PROVIDER' (Phase F m2m.integration_principals)
);

comment on type app.actor_context is
  'Who is performing a domain operation, independent of how they authenticated. Built by an authorizing facade (api.* from auth_ctx, m2m_rpc.* from a verified API key) and passed into app.*_core. The core never derives identity on its own -- that is precisely what lets one domain implementation serve both the panel and the public API without forging auth.uid().';

-- The one substitution the extraction makes: `(select auth.uid())` becomes
-- `p_actor.actor_user_id`. On the user path the facade passes exactly `auth.uid()`, so the
-- written value is identical -- this is a rename of where the value comes from, not a
-- change to what it is.
create function app.create_employee_core(
  p_actor app.actor_context,
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
  p_position_id uuid default null,
  p_location_id uuid default null
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
  v_location_company_id uuid;
begin
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

  if p_location_id is not null then
    select company_id into v_location_company_id from app.locations where id = p_location_id;
    if v_location_company_id is null then
      raise exception 'location_not_found' using errcode = 'P0002';
    end if;
    if v_location_company_id <> p_company_id then
      raise exception 'location_out_of_scope' using errcode = '23514';
    end if;
  end if;

  insert into app.employees (
    organization_id, company_id, full_name, cpf_hash, cpf_enc, cpf_masked,
    registration_number, phone_e164, email, position_title, department,
    data_origin, external_source, external_ref, position_id, location_id, created_by
  ) values (
    v_org_id, p_company_id, p_full_name,
    decode(p_cpf_hash_b64, 'base64'), decode(p_cpf_enc_b64, 'base64'), p_cpf_masked,
    p_registration_number, p_phone_e164, p_email, p_position_title, p_department,
    p_data_origin, p_external_source, p_external_ref, p_position_id, p_location_id,
    p_actor.actor_user_id
  )
  returning id into v_employee_id;

  return v_employee_id;
exception
  when unique_violation then
    raise exception 'cpf_already_registered' using errcode = '23505';
end;
$$;

comment on function app.create_employee_core(app.actor_context, uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text, uuid, uuid) is
  'Domain core for employee creation. Performs NO authorization -- the caller must have already authorized. Unreachable by any client role: revoked from public/anon/authenticated/service_role, and app is not in PGRST_DB_SCHEMAS for anyone but authenticated (which has no EXECUTE here). Only api.create_employee and, from Phase F, m2m_rpc.create_employee call it.';

revoke all on function app.create_employee_core(app.actor_context, uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text, uuid, uuid) from public, anon, authenticated, service_role;

create function app.update_employee_core(
  p_actor app.actor_context,
  p_employee_id uuid,
  p_full_name text,
  p_registration_number text,
  p_phone_e164 text,
  p_email text,
  p_position_title text,
  p_department text,
  p_status text,
  p_position_id uuid default null,
  p_location_id uuid default null
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
  v_location_company_id uuid;
begin
  select company_id, organization_id into v_company_id, v_org_id
  from app.employees where id = p_employee_id and archived_at is null;
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
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

  if p_location_id is not null then
    select company_id into v_location_company_id from app.locations where id = p_location_id;
    if v_location_company_id is null then
      raise exception 'location_not_found' using errcode = 'P0002';
    end if;
    if v_location_company_id <> v_company_id then
      raise exception 'location_out_of_scope' using errcode = '23514';
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
    location_id = p_location_id,
    terminated_on = case when p_status = 'TERMINATED' then coalesce(terminated_on, current_date) else null end
  where id = p_employee_id;
end;
$$;

comment on function app.update_employee_core(app.actor_context, uuid, text, text, text, text, text, text, text, uuid, uuid) is
  'Domain core for employee update. Performs NO authorization. Same reachability rules as app.create_employee_core.';

revoke all on function app.update_employee_core(app.actor_context, uuid, text, text, text, text, text, text, text, uuid, uuid) from public, anon, authenticated, service_role;

-- The facades. Signatures are UNCHANGED (same arity, same types, same order, same defaults),
-- so `create or replace` is correct here and no stale overload can survive -- deliberately
-- avoiding the duplicate-overload class of bug that 20260903150000 had to clean up.
create or replace function api.create_employee(
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
  p_position_id uuid default null,
  p_location_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_permission(p_company_id, 'employee.create')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return app.create_employee_core(
    row('USER', (select auth.uid()), null)::app.actor_context,
    p_company_id, p_full_name, p_cpf_hash_b64, p_cpf_enc_b64, p_cpf_masked,
    p_registration_number, p_phone_e164, p_email, p_position_title, p_department,
    p_data_origin, p_external_source, p_external_ref, p_position_id, p_location_id
  );
end;
$$;

comment on function api.create_employee(uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text, uuid, uuid) is
  'Manual (or import-row) employee creation. Never accepts a raw CPF. p_position_id and p_location_id (both optional) must belong to the employee''s own company (or, for position_id, be org-wide). Phase F: authorization only -- the domain lives in app.create_employee_core, shared with the public API.';

revoke execute on function api.create_employee(uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text, uuid, uuid) from public, anon;
grant execute on function api.create_employee(uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text, uuid, uuid) to authenticated;

create or replace function api.update_employee(
  p_employee_id uuid,
  p_full_name text,
  p_registration_number text,
  p_phone_e164 text,
  p_email text,
  p_position_title text,
  p_department text,
  p_status text,
  p_position_id uuid default null,
  p_location_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  -- The permission check needs the employee's company, so the lookup necessarily happens
  -- before authorization here, exactly as it did before this migration. The core repeats
  -- the lookup; that duplicate read is the price of keeping the core body verbatim, and it
  -- is a single indexed primary-key hit.
  select company_id into v_company_id
  from app.employees where id = p_employee_id and archived_at is null;
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if not (select auth_ctx.has_permission(v_company_id, 'employee.update')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  perform app.update_employee_core(
    row('USER', (select auth.uid()), null)::app.actor_context,
    p_employee_id, p_full_name, p_registration_number, p_phone_e164, p_email,
    p_position_title, p_department, p_status, p_position_id, p_location_id
  );
end;
$$;

comment on function api.update_employee(uuid, text, text, text, text, text, text, text, uuid, uuid) is
  'Updates editable employee fields. CPF is never editable through this RPC. p_position_id/p_location_id (both optional) must belong to the employee''s own company (or, for position_id, be org-wide). Phase F: authorization only -- the domain lives in app.update_employee_core, shared with the public API.';

revoke execute on function api.update_employee(uuid, text, text, text, text, text, text, text, uuid, uuid) from public, anon;
grant execute on function api.update_employee(uuid, text, text, text, text, text, text, text, uuid, uuid) to authenticated;
