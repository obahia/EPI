-- Phase F correction, before any of this shipped: fold the quota check INTO m2m.authorize
-- instead of exposing it as a separate m2m_rpc.check_quota the route handler had to call
-- first.
--
-- Two reasons, both concrete. (1) A separate pre-check doubles the database round trips on
-- every single API request, which is a real cost paid on the happy path to make the rejected
-- path slightly cheaper -- the wrong trade. (2) Two enforcement points is one too many: a
-- future endpoint that forgets the pre-check would silently have no quota at all. Folding it
-- in makes the quota unskippable, because there is no way to reach a domain operation
-- without passing through authorize.
--
-- The counter is consumed as soon as the principal resolves, BEFORE the scope check, so a
-- key probing endpoints it has no scope for still pays for the attempt.

drop function if exists m2m_rpc.check_quota(text, text, text, text, inet);
drop function if exists m2m.authorize(text, text, m2m.api_scope, uuid, inet);

create function m2m.authorize(
  p_key_id text,
  p_secret_hash_b64 text,
  p_scope m2m.api_scope,
  p_company_id uuid default null,
  p_client_ip inet default null,
  p_kind text default 'read'
)
returns m2m.auth_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_out m2m.auth_result;
  v_limit int;
begin
  select * into r from m2m.resolve_principal(p_key_id, p_secret_hash_b64);

  -- One indistinguishable failure for every authentication problem: unknown key, wrong
  -- secret, revoked key, expired key, revoked principal. Telling them apart would turn
  -- key_id into an enumeration oracle.
  if r.principal_id is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  v_limit := case when p_kind = 'write' then 60 else 600 end;

  if not m2m.check_quota('principal:' || r.principal_id::text || ':' || p_kind, v_limit, 60) then
    raise exception 'rate_limited' using errcode = '53400';
  end if;

  -- The per-organization ceiling exists because a per-principal limit alone lets a tenant
  -- multiply its own allowance by creating principals. The cap of 20 principals narrows
  -- that without closing it; this closes it.
  if not m2m.check_quota('org:' || r.organization_id::text, 1200, 60) then
    raise exception 'rate_limited' using errcode = '53400';
  end if;

  -- Scope is checked before any entity is read, so an under-scoped key cannot learn whether
  -- a given id exists.
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

comment on function m2m.authorize(text, text, m2m.api_scope, uuid, inet, text) is
  'The single authorization entry point for every machine call: resolve the principal from key material, spend quota, enforce the scope, then enforce the organization/company binding -- in that order, so nothing about a resource leaks before the caller has earned the right to ask about it, and no endpoint can accidentally bypass the quota.';

revoke all on function m2m.authorize(text, text, m2m.api_scope, uuid, inet, text) from public, anon, authenticated, service_role;

-- The two write endpoints must declare themselves as writes so they draw from the write
-- bucket. Same signatures, so CREATE OR REPLACE is correct and no overload can survive.
create or replace function m2m_rpc.create_employee(
  p_key_id text,
  p_secret_hash_b64 text,
  p_idempotency_key text,
  p_request_hash_b64 text,
  p_company_id uuid,
  p_full_name text,
  p_cpf_hash_b64 text,
  p_cpf_enc_b64 text,
  p_cpf_masked text,
  p_registration_number text default null,
  p_phone_e164 text default null,
  p_email text default null,
  p_position_id uuid default null,
  p_location_id uuid default null,
  p_external_source text default null,
  p_external_ref text default null,
  p_client_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth m2m.auth_result;
  v_claim record;
  v_employee_id uuid;
  v_body jsonb;
  c_endpoint constant text := 'POST /v1/employees';
begin
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, 'employees:write', p_company_id, p_client_ip, 'write');

  perform set_config('lock_timeout', '5s', true);

  v_claim := m2m.claim_idempotency(
    v_auth.principal_id, v_auth.organization_id, c_endpoint, p_idempotency_key, p_request_hash_b64
  );

  if v_claim.outcome = 'REPLAY' then
    return jsonb_build_object('replayed', true, 'status', v_claim.response_status,
                              'body', v_claim.response_body);
  end if;

  v_employee_id := app.create_employee_core(
    row('PROVIDER', null, v_auth.principal_id)::app.actor_context,
    p_company_id, p_full_name, p_cpf_hash_b64, p_cpf_enc_b64, p_cpf_masked,
    p_registration_number, p_phone_e164, p_email,
    null, null,
    'API', p_external_source, p_external_ref, p_position_id, p_location_id
  );

  v_body := m2m.employee_json(v_employee_id);

  perform m2m.complete_idempotency(v_auth.principal_id, c_endpoint, p_idempotency_key, 201, v_body);

  return jsonb_build_object('replayed', false, 'status', 201, 'body', v_body);
end;
$$;

create or replace function m2m_rpc.update_employee(
  p_key_id text,
  p_secret_hash_b64 text,
  p_idempotency_key text,
  p_request_hash_b64 text,
  p_employee_id uuid,
  p_full_name text,
  p_registration_number text,
  p_phone_e164 text,
  p_email text,
  p_status text,
  p_position_id uuid default null,
  p_location_id uuid default null,
  p_client_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth m2m.auth_result;
  v_claim record;
  v_company_id uuid;
  v_department text;
  v_position_title text;
  v_body jsonb;
  c_endpoint constant text := 'PATCH /v1/employees/{id}';
begin
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, 'employees:write', null, p_client_ip, 'write');

  select e.company_id, e.department, e.position_title
    into v_company_id, v_department, v_position_title
    from app.employees e
   where e.id = p_employee_id and e.archived_at is null
     and e.organization_id = v_auth.organization_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  perform m2m.assert_company(v_auth, v_company_id);
  perform set_config('lock_timeout', '5s', true);

  v_claim := m2m.claim_idempotency(
    v_auth.principal_id, v_auth.organization_id, c_endpoint, p_idempotency_key, p_request_hash_b64
  );

  if v_claim.outcome = 'REPLAY' then
    return jsonb_build_object('replayed', true, 'status', v_claim.response_status,
                              'body', v_claim.response_body);
  end if;

  perform app.update_employee_core(
    row('PROVIDER', null, v_auth.principal_id)::app.actor_context,
    p_employee_id, p_full_name, p_registration_number, p_phone_e164, p_email,
    v_position_title, v_department, p_status, p_position_id, p_location_id
  );

  v_body := m2m.employee_json(p_employee_id);

  perform m2m.complete_idempotency(v_auth.principal_id, c_endpoint, p_idempotency_key, 200, v_body);

  return jsonb_build_object('replayed', false, 'status', 200, 'body', v_body);
end;
$$;
