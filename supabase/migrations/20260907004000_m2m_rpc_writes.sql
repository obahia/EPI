-- Phase F: the write half of /api/v1, and the idempotency contract.
--
-- THE ORDER IS NORMATIVE (contract section C):
--    BEGIN -> claim the idempotency row -> run the domain core -> capture the result
--          -> mark COMPLETED with the response -> COMMIT
-- all in ONE transaction. COMPLETED is never written before the domain operation.
--
-- What that buys, precisely: if the process dies AFTER the commit but BEFORE the client
-- reads the response, the domain change and the stored response committed together, so the
-- retry replays the original answer and writes nothing twice. If it dies BEFORE the commit,
-- everything rolls back including the claim row, so the retry executes cleanly. The
-- dangerous middle state -- domain committed, idempotency record missing -- cannot exist,
-- because they are the same transaction.
--
-- Two consequences that simplify the design, and are easy to get wrong by carrying over
-- habits from a two-transaction implementation:
--   * A committed IN_FLIGHT row is impossible. It only ever exists uncommitted, so there is
--     no orphaned-lease problem and no expiry sweeper is needed for crashes.
--   * A failed domain operation leaves NO record. Errors are re-executable, not replayable.
--     Input validation therefore has to happen before the transaction (in the route
--     handler), so a malformed request never burns a key.

create function m2m.employee_json(p_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', e.id, 'company_id', e.company_id, 'full_name', e.full_name,
    'cpf_masked', e.cpf_masked, 'registration_number', e.registration_number,
    'phone_e164', e.phone_e164, 'email', e.email::text,
    'position_id', e.position_id, 'position_title', e.position_title,
    'location_id', e.location_id, 'department', e.department,
    'status', e.status, 'data_origin', e.data_origin,
    'external_source', e.external_source, 'external_ref', e.external_ref,
    'created_at', e.created_at, 'updated_at', e.updated_at)
  from app.employees e where e.id = p_employee_id;
$$;

comment on function m2m.employee_json(uuid) is
  'The single response shape for an employee across every /api/v1 endpoint. cpf_masked only -- no endpoint and no scope ever exposes the full CPF, its hash, or its ciphertext.';

revoke all on function m2m.employee_json(uuid) from public, anon, authenticated, service_role;

-- Claims the idempotency row, or reports what the existing one says. Returns:
--   ('CLAIMED',  null, null)              -> caller proceeds with the domain operation
--   ('REPLAY',   status, body)            -> caller returns the stored response verbatim
-- and raises for the conflict cases, which are never recoverable inside this transaction.
create function m2m.claim_idempotency(
  p_principal_id uuid,
  p_organization_id uuid,
  p_endpoint_key text,
  p_idempotency_key text,
  p_request_hash_b64 text,
  out outcome text,
  out response_status int,
  out response_body jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash bytea := decode(p_request_hash_b64, 'base64');
  v_existing record;
  v_claimed text;
begin
  if octet_length(v_hash) <> 32 then
    raise exception 'invalid_request_hash' using errcode = '22P02';
  end if;

  -- A concurrent identical request BLOCKS here on the unique index rather than reading a
  -- status: the mutual exclusion comes from the index, not from the status column. If the
  -- first transaction commits, this insert affects zero rows and we fall through to the
  -- replay branch; if it rolls back, this insert proceeds. lock_timeout (set by the caller)
  -- turns an unusually slow first request into a clean 409 instead of a hang.
  insert into m2m.idempotency_records (
    principal_id, organization_id, endpoint_key, idempotency_key,
    request_hash, status, expires_at
  ) values (
    p_principal_id, p_organization_id, p_endpoint_key, p_idempotency_key,
    v_hash, 'IN_FLIGHT', now() + interval '24 hours'
  )
  on conflict (principal_id, endpoint_key, idempotency_key) do nothing
  returning status into v_claimed;

  if found then
    outcome := 'CLAIMED';
    return;
  end if;

  select * into v_existing from m2m.idempotency_records r
   where r.principal_id = p_principal_id
     and r.endpoint_key = p_endpoint_key
     and r.idempotency_key = p_idempotency_key;

  if v_existing.request_hash is distinct from v_hash then
    raise exception 'idempotency_key_reuse' using errcode = '23505';
  end if;

  if v_existing.status = 'COMPLETED' then
    outcome := 'REPLAY';
    response_status := v_existing.response_status;
    response_body := v_existing.response_body;
    return;
  end if;

  -- Reaching here means a COMMITTED IN_FLIGHT row, which the single-transaction design
  -- makes impossible. Treated as a conflict rather than silently re-running, because
  -- guessing wrong here is how duplicate writes happen.
  raise exception 'idempotency_in_flight' using errcode = '40001';
end;
$$;

revoke all on function m2m.claim_idempotency(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;

create function m2m.complete_idempotency(
  p_principal_id uuid,
  p_endpoint_key text,
  p_idempotency_key text,
  p_status int,
  p_body jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  update m2m.idempotency_records
     set status = 'COMPLETED',
         response_status = p_status,
         response_body = p_body,
         completed_at = clock_timestamp()
   where principal_id = p_principal_id
     and endpoint_key = p_endpoint_key
     and idempotency_key = p_idempotency_key;
$$;

revoke all on function m2m.complete_idempotency(uuid, text, text, int, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- POST /api/v1/employees
-- ---------------------------------------------------------------------------------------
create function m2m_rpc.create_employee(
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
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, 'employees:write', p_company_id, p_client_ip);

  -- A duplicate that arrives while the first request is still running waits at most this
  -- long before being told to retry, instead of holding a connection open indefinitely.
  perform set_config('lock_timeout', '5s', true);

  v_claim := m2m.claim_idempotency(
    v_auth.principal_id, v_auth.organization_id, c_endpoint, p_idempotency_key, p_request_hash_b64
  );

  if v_claim.outcome = 'REPLAY' then
    return jsonb_build_object('replayed', true, 'status', v_claim.response_status,
                              'body', v_claim.response_body);
  end if;

  -- Same domain implementation the panel uses. Every invariant it enforces -- CPF
  -- uniqueness, position/location scope, tenant binding -- applies here without being
  -- restated, which is the entire point of the extraction.
  v_employee_id := app.create_employee_core(
    row('PROVIDER', null, v_auth.principal_id)::app.actor_context,
    p_company_id, p_full_name, p_cpf_hash_b64, p_cpf_enc_b64, p_cpf_masked,
    p_registration_number, p_phone_e164, p_email,
    null, null,                       -- position_title / department: the API uses ids, not free text
    'API', p_external_source, p_external_ref, p_position_id, p_location_id
  );

  v_body := m2m.employee_json(v_employee_id);

  perform m2m.complete_idempotency(v_auth.principal_id, c_endpoint, p_idempotency_key, 201, v_body);

  return jsonb_build_object('replayed', false, 'status', 201, 'body', v_body);
end;
$$;

revoke all on function m2m_rpc.create_employee(text, text, text, text, uuid, text, text, text, text, text, text, text, uuid, uuid, text, text, inet) from public, anon, authenticated;
grant execute on function m2m_rpc.create_employee(text, text, text, text, uuid, text, text, text, text, text, text, text, uuid, uuid, text, text, inet) to service_role;

-- ---------------------------------------------------------------------------------------
-- PATCH /api/v1/employees/{id}
-- ---------------------------------------------------------------------------------------
-- CPF is deliberately not updatable through any API path. The identity of the worker is the
-- anchor of every receipt already issued for them; letting a machine rewrite it has no
-- legitimate use case that outweighs that.
create function m2m_rpc.update_employee(
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
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, 'employees:write', null, p_client_ip);

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

  -- position_title and department are carried through unchanged: they are the legacy
  -- free-text fields the panel still shows for rows not yet mapped to the catalog, and the
  -- API has no way to express them. Passing them back preserves them; passing null would
  -- silently erase data the caller never mentioned.
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

revoke all on function m2m_rpc.update_employee(text, text, text, text, uuid, text, text, text, text, text, uuid, uuid, inet) from public, anon, authenticated;
grant execute on function m2m_rpc.update_employee(text, text, text, text, uuid, text, text, text, text, text, uuid, uuid, inet) to service_role;

-- ---------------------------------------------------------------------------------------
-- Quota check, callable on its own so the route handler can reject before doing any work.
-- ---------------------------------------------------------------------------------------
create function m2m_rpc.check_quota(
  p_key_id text,
  p_secret_hash_b64 text,
  p_scope text,
  p_kind text,
  p_client_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth m2m.auth_result;
  v_limit int;
  v_ok boolean;
begin
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, p_scope::m2m.api_scope, null, p_client_ip);

  v_limit := case when p_kind = 'write' then 60 else 600 end;

  v_ok := m2m.check_quota('principal:' || v_auth.principal_id::text || ':' || p_kind, v_limit, 60);
  if v_ok then
    -- The per-organization bucket exists because limiting only per principal would let a
    -- tenant multiply its own ceiling by creating principals (capped at 20, which narrows
    -- the problem without removing it).
    v_ok := m2m.check_quota('org:' || v_auth.organization_id::text, 1200, 60);
  end if;

  return jsonb_build_object('allowed', v_ok, 'limit', v_limit, 'window_seconds', 60);
end;
$$;

revoke all on function m2m_rpc.check_quota(text, text, text, text, inet) from public, anon, authenticated;
grant execute on function m2m_rpc.check_quota(text, text, text, text, inet) to service_role;
