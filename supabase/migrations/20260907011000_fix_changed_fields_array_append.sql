-- URGENT Phase F bugfix. api.update_employee has been BROKEN for every update that changes
-- a field since 20260907005000 was applied -- which includes the epi-dev project, where it
-- was applied earlier today. The employee edit form in the panel fails outright.
--
-- The cause, in one line:
--
--     v_changed := v_changed || 'full_name';        -- v_changed is text[]
--
-- Postgres resolves `||` against `anyarray || anyarray` in preference to
-- `anyarray || anyelement` when the right operand is an untyped literal, so it tries to
-- parse 'full_name' AS AN ARRAY and raises:
--
--     malformed array literal: "full_name"
--     DETAIL: Array value must start with "{" or dimension information.
--
-- This is a genuine product regression, not a test artifact -- it was caught by
-- 140_employee_location_assignment.sql, an EXISTING suite from Phase B that had passed
-- unchanged through every phase until now. That is precisely what splitting the extraction
-- (20260907000000) from the event step (20260907005000) was designed to surface: the
-- extraction itself was neutral and 140 passed against it; the event step broke it. The
-- split did its job, and the two-migration structure is why the blame is unambiguous.
--
-- Why the live end-to-end run did not catch it: that run exercised create, not update.
-- A write path with no live coverage is a write path with no coverage.
--
-- The fix uses array_append rather than adding a ::text cast to each line. A cast would fix
-- the nine lines that exist today and leave the tenth line someone writes next year with the
-- same trap; array_append cannot be resolved the wrong way at all.

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
  -- the audit trail, and this same list is what a webhook consumer receives -- so one rule
  -- protects both surfaces from one place.
  if v_old.full_name is distinct from p_full_name then v_changed := array_append(v_changed, 'full_name'); end if;
  if v_old.registration_number is distinct from p_registration_number then v_changed := array_append(v_changed, 'registration_number'); end if;
  if v_old.phone_e164 is distinct from p_phone_e164 then v_changed := array_append(v_changed, 'phone_e164'); end if;
  if v_old.email::text is distinct from p_email then v_changed := array_append(v_changed, 'email'); end if;
  if v_old.position_title is distinct from p_position_title then v_changed := array_append(v_changed, 'position_title'); end if;
  if v_old.department is distinct from p_department then v_changed := array_append(v_changed, 'department'); end if;
  if v_old.status is distinct from p_status then v_changed := array_append(v_changed, 'status'); end if;
  if v_old.position_id is distinct from p_position_id then v_changed := array_append(v_changed, 'position_id'); end if;
  if v_old.location_id is distinct from p_location_id then v_changed := array_append(v_changed, 'location_id'); end if;

  -- A no-op UPDATE emits nothing. Without this, a client polling PATCH in a loop would
  -- generate an unbounded stream of events saying nothing happened -- and, once webhooks
  -- exist, deliver every one of them.
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
