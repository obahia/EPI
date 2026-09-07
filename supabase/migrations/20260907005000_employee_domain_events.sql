-- Phase F, step 2 of 2 of the core extraction (contract section D, "Event step").
--
-- This runs only after 20260907000000 proved neutral -- the A..E pgTAP suites pass with zero
-- edits against it. THIS migration deliberately changes behaviour: two audit event types
-- that did not exist before. That is why it is a separate migration: mixing it into the
-- extraction would have made the neutrality claim unprovable.
--
-- spec §20 asks for employee.created / employee.updated webhooks, and no employee lifecycle
-- event existed anywhere in the audit trail. Emitting them from inside the CORE (not from
-- the facades) means the panel and the public API produce identical events -- if they were
-- emitted per-facade, the two paths would drift the first time someone touched one of them.

-- ---------------------------------------------------------------------------------------
-- Attributing an event to a machine principal
-- ---------------------------------------------------------------------------------------
-- audit.audit_events already accepts actor_kind = 'PROVIDER' (20260831170100:25) and it has
-- never been used. But 'PROVIDER' alone cannot tell two integrations of the same
-- organization apart, which is exactly the question asked after a key leaks.
alter table audit.audit_events
  add column actor_principal_id uuid references m2m.integration_principals (id);

comment on column audit.audit_events.actor_principal_id is
  'Which machine principal produced this event, when actor_kind = ''PROVIDER''. DELIBERATELY OUTSIDE the event_hash computation: the chain hash is a fixed formula over a fixed set of fields, and changing it would invalidate the verifiability of every event already written. This column is attribution metadata, not part of the sealed record.';

create index audit_events_principal_idx on audit.audit_events (actor_principal_id)
  where actor_principal_id is not null;

-- app.log_audit_event is NOT modified -- it is the single most load-bearing function in the
-- schema and the one place the hash chain is computed. Instead the principal travels as a
-- transaction-local setting, the same mechanism app.enforce_state_transition already uses
-- for app.transition_ok, and a BEFORE INSERT trigger stamps it onto the row.
--
-- Because the trigger runs AFTER log_audit_event has already computed event_hash from its
-- own arguments, stamping this column cannot perturb the chain. That property is what makes
-- the approach safe, and it is the reason the column is not in the hash.
create function audit.stamp_actor_principal()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_principal text := current_setting('app.actor_principal_id', true);
begin
  if new.actor_kind = 'PROVIDER' and v_principal is not null and v_principal <> '' then
    new.actor_principal_id := v_principal::uuid;
  end if;
  return new;
end;
$$;

comment on function audit.stamp_actor_principal() is
  'Stamps actor_principal_id from the transaction-local app.actor_principal_id setting, which m2m.authorize sets once per machine request. Only ever applies to PROVIDER events, so a human transaction can never pick up a stale attribution.';

create trigger audit_events_stamp_principal
  before insert on audit.audit_events
  for each row execute function audit.stamp_actor_principal();

-- m2m.authorize gains the one line that publishes the principal for the rest of the
-- transaction. Same signature, so CREATE OR REPLACE is correct and no overload can survive.
create or replace function m2m.authorize(
  p_key_id text,
  p_secret_hash_b64 text,
  p_scope m2m.api_scope,
  p_company_id uuid default null,
  p_client_ip inet default null
)
returns m2m.auth_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_out m2m.auth_result;
begin
  select * into r from m2m.resolve_principal(p_key_id, p_secret_hash_b64);

  if r.principal_id is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  if not (p_scope = any (r.scopes)) then
    raise exception 'insufficient_scope' using errcode = '42501';
  end if;

  v_out.principal_id := r.principal_id;
  v_out.organization_id := r.organization_id;
  v_out.api_key_id := r.api_key_id;
  v_out.company_ids := r.company_ids;

  if p_company_id is not null then
    perform m2m.assert_company(v_out, p_company_id);
  end if;

  -- Transaction-local, so it cannot leak into a later request on a pooled connection.
  perform set_config('app.actor_principal_id', r.principal_id::text, true);

  update m2m.api_keys
     set last_used_at = now(),
         last_used_ip = coalesce(p_client_ip, last_used_ip)
   where id = r.api_key_id
     and (last_used_at is null or last_used_at < now() - interval '1 minute');

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- EMPLOYEE_CREATED
-- ---------------------------------------------------------------------------------------
create or replace function app.create_employee_core(
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

  -- Same transaction as the insert: if the caller rolls back, the event never existed and
  -- the chain has no gap. No name, no CPF, no phone, no email in `data` -- the audit trail
  -- is not a second copy of the employee record, and audit.audit_events' own comment
  -- forbids exactly this.
  perform app.log_audit_event(
    v_org_id, p_company_id, 'EMPLOYEE_CREATED', 'app.employees', v_employee_id,
    p_actor.actor_kind, p_actor.actor_user_id,
    jsonb_build_object(
      'data_origin', p_data_origin,
      'has_position', p_position_id is not null,
      'has_location', p_location_id is not null
    )
  );

  return v_employee_id;
exception
  when unique_violation then
    raise exception 'cpf_already_registered' using errcode = '23505';
end;
$$;

-- ---------------------------------------------------------------------------------------
-- EMPLOYEE_UPDATED
-- ---------------------------------------------------------------------------------------
create or replace function app.update_employee_core(
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
  v_old record;
  v_changed text[] := '{}';
begin
  select * into v_old
  from app.employees where id = p_employee_id and archived_at is null;
  if v_old.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_company_id := v_old.company_id;
  v_org_id := v_old.organization_id;

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

  -- Field NAMES only, never values. A phone-number change must not put the phone number in
  -- the audit trail, and this list is what a webhook consumer receives too -- so the same
  -- rule protects both surfaces from one place.
  if v_old.full_name is distinct from p_full_name then v_changed := v_changed || 'full_name'; end if;
  if v_old.registration_number is distinct from p_registration_number then v_changed := v_changed || 'registration_number'; end if;
  if v_old.phone_e164 is distinct from p_phone_e164 then v_changed := v_changed || 'phone_e164'; end if;
  if v_old.email::text is distinct from p_email then v_changed := v_changed || 'email'; end if;
  if v_old.position_title is distinct from p_position_title then v_changed := v_changed || 'position_title'; end if;
  if v_old.department is distinct from p_department then v_changed := v_changed || 'department'; end if;
  if v_old.status is distinct from p_status then v_changed := v_changed || 'status'; end if;
  if v_old.position_id is distinct from p_position_id then v_changed := v_changed || 'position_id'; end if;
  if v_old.location_id is distinct from p_location_id then v_changed := v_changed || 'location_id'; end if;

  -- A no-op UPDATE emits nothing. Without this, a client polling PATCH in a loop would
  -- generate an unbounded stream of events that say nothing happened -- and, once webhooks
  -- exist, would deliver every one of them.
  if array_length(v_changed, 1) is null then
    return;
  end if;

  perform app.log_audit_event(
    v_org_id, v_company_id, 'EMPLOYEE_UPDATED', 'app.employees', p_employee_id,
    p_actor.actor_kind, p_actor.actor_user_id,
    jsonb_build_object('changed_fields', to_jsonb(v_changed))
  );
end;
$$;
