-- FASE 3: the anon-callable worker path. Every function here takes a token HASH (never an
-- id) as its sole means of identifying "which confirmation_request" -- see
-- docs/architecture.md §7-8. Raw tokens are hashed in Node (src/lib/crypto/worker-token.ts)
-- before ever reaching Postgres.
--
-- Every p_token_hash_b64 parameter below is base64 TEXT, not `bytea` directly -- same
-- reasoning as api.create_confirmation_link and 20260831150200_employee_rpcs.sql: a
-- PostgREST JSON-RPC call would otherwise have to send Postgres's own hex-text bytea wire
-- format, a needless coupling to a Postgres-internal detail.

create function worker.open_link(p_token_hash_b64 text, p_client_ip inet default null)
returns table (
  confirmation_request_id  uuid,
  view_status               app.confirmation_request_status,
  action_nonce              text,
  company_name              text,
  employee_full_name        text,
  delivery_date              date,
  note                       text,
  required_assurance_level  app.assurance_level,
  identity_attempts          smallint,
  identity_max_attempts     smallint,
  items                      jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req app.confirmation_requests%rowtype;
  v_token_hash bytea := decode(p_token_hash_b64, 'base64');
begin
  if not app.check_rate_limit('open:' || encode(v_token_hash, 'hex'), 20, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;
  if p_client_ip is not null and not app.check_rate_limit('open_ip:' || host(p_client_ip), 60, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;

  select * into v_req from app.confirmation_requests where token_hash = v_token_hash;

  -- Same generic outcome for "does not exist", "expired" and "revoked" -- only a request
  -- that WAS live and has just now lapsed gets the side effect of being flipped to EXPIRED
  -- below (lazy expiry, docs/architecture.md §8). CONFIRMED/CONTESTED are NOT an error --
  -- "depois do desfecho, a mesma URL passa a renderizar um recibo somente-leitura... nunca
  -- um erro" (§8): a worker who bookmarks/reopens the link after confirming finds their
  -- receipt, not a broken page. Token possession is already proven by the hash match at
  -- that point, so there is no anti-enumeration reason left to hide which terminal state.
  if not found or v_req.status in ('EXPIRED', 'REVOKED') then
    raise exception 'link_not_available' using errcode = 'P0002';
  end if;

  if v_req.status in ('CONFIRMED', 'CONTESTED') then
    perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'LINK_VIEWED', 'confirmation_requests', v_req.id, 'WORKER', null, jsonb_build_object('read_only', true));
    return query
    select
      v_req.id, v_req.status, null::text,
      coalesce(c.trade_name, c.legal_name), e.full_name, d.delivery_date, d.note,
      v_req.required_assurance_level, v_req.identity_attempts, v_req.identity_max_attempts,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'epi_name', i.epi_name, 'ca_number', i.ca_number, 'manufacturer', i.manufacturer,
          'model', i.model, 'quantity', i.quantity, 'unit', i.unit
        ) order by i.line_no), '[]'::jsonb)
        from app.epi_delivery_items i where i.delivery_id = d.id
      )
    from app.epi_deliveries d
    join app.companies c on c.id = d.company_id
    join app.employees e on e.id = d.employee_id
    where d.id = v_req.delivery_id;
    return;
  end if;

  if v_req.expires_at <= clock_timestamp() then
    perform set_config('app.transition_ok', v_req.id::text, true);
    update app.confirmation_requests set status = 'EXPIRED', last_event = 'EXPIRE' where id = v_req.id;
    perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'CONFIRMATION_EXPIRED', 'confirmation_requests', v_req.id, 'SYSTEM', null, '{}'::jsonb);
    raise exception 'link_not_available' using errcode = 'P0002';
  end if;

  if v_req.status = 'SENT' then
    perform set_config('app.transition_ok', v_req.id::text, true);
    update app.confirmation_requests
    set status = 'VIEWED', last_event = 'VIEW', viewed_at = clock_timestamp(),
        action_nonce = extensions.gen_random_bytes(16), nonce_consumed_at = null
    where id = v_req.id
    returning * into v_req;
  else
    -- Already VIEWED or IDENTITY_FAILED: re-viewing is legitimate and repeatable (a worker
    -- who lost signal reopens the link) -- same-status update, no transition-table lookup
    -- fires (see app.enforce_state_transition's early-exit branch). A fresh nonce is still
    -- issued so a stale earlier render of this same page can never submit successfully.
    update app.confirmation_requests
    set action_nonce = extensions.gen_random_bytes(16), nonce_consumed_at = null
    where id = v_req.id
    returning * into v_req;
  end if;

  perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'LINK_VIEWED', 'confirmation_requests', v_req.id, 'WORKER', null, '{}'::jsonb);

  return query
  select
    v_req.id,
    v_req.status,
    encode(v_req.action_nonce, 'base64'),
    coalesce(c.trade_name, c.legal_name),
    e.full_name,
    d.delivery_date,
    d.note,
    v_req.required_assurance_level, v_req.identity_attempts, v_req.identity_max_attempts,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'epi_name', i.epi_name, 'ca_number', i.ca_number, 'manufacturer', i.manufacturer,
        'model', i.model, 'quantity', i.quantity, 'unit', i.unit
      ) order by i.line_no), '[]'::jsonb)
      from app.epi_delivery_items i where i.delivery_id = d.id
    )
  from app.epi_deliveries d
  join app.companies c on c.id = d.company_id
  join app.employees e on e.id = d.employee_id
  where d.id = v_req.delivery_id;
end;
$$;

comment on function worker.open_link(text, inet) is
  'Every load of /e/<token> and /e/s/<view-id> calls this. Repeatable (viewing never consumes anything) -- reissues action_nonce every call so an old rendered page can never submit. Never reveals the CPF challenge material -- see worker.begin_confirmation.';

revoke execute on function worker.open_link(text, inet) from public, authenticated;
grant execute on function worker.open_link(text, inet) to anon;

-- Returns the encrypted CPF ciphertext so Node can decrypt it (CPF_ENCRYPTION_KEY lives
-- only in the Next.js server environment, never in Postgres) and compare the worker's typed
-- last 3 digits -- see docs/mvp-roadmap.md FASE 3 for why this is the chosen AL1 challenge.
-- The ciphertext is used once, in the same request, and discarded -- never sent to the
-- browser, never persisted anywhere beyond app.employees.cpf_enc itself.
--
-- Returned as base64 TEXT, not `bytea` -- PostgREST serializes a `bytea` OUTPUT column as
-- Postgres's own `\x...` hex-text wire format, not base64; src/app/e/s/[id]/actions.ts
-- decodes this value as base64 (matching src/lib/crypto/cpf-secrets.ts's own convention),
-- so returning raw bytea here silently fed the wrong bytes into AES-GCM decryption and
-- failed with "Unsupported state or unable to authenticate data" -- a real bug caught only
-- by live E2E testing against the actual Supabase client, not by local PGlite (which
-- returns bytea columns as raw bytes, not through PostgREST's JSON serialization at all).
create function worker.begin_confirmation(p_token_hash_b64 text, p_nonce text)
returns table (cpf_enc_b64 text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req app.confirmation_requests%rowtype;
  v_token_hash bytea := decode(p_token_hash_b64, 'base64');
begin
  if not app.check_rate_limit('begin:' || encode(v_token_hash, 'hex'), 20, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;

  select * into v_req from app.confirmation_requests where token_hash = v_token_hash;
  if not found or v_req.status not in ('VIEWED', 'IDENTITY_FAILED')
     or v_req.expires_at <= clock_timestamp()
     or v_req.nonce_consumed_at is not null
     or v_req.action_nonce is distinct from decode(p_nonce, 'base64')
  then
    raise exception 'link_not_available' using errcode = 'P0002';
  end if;
  if v_req.required_assurance_level <> 'AL1_LINK_KNOWLEDGE' then
    raise exception 'no_challenge_required' using errcode = '23514';
  end if;

  return query
  select encode(em.cpf_enc, 'base64')
  from app.epi_deliveries d
  join app.employees em on em.id = d.employee_id
  where d.id = v_req.delivery_id;
end;
$$;

comment on function worker.begin_confirmation(text, text) is
  'Read-only -- does NOT consume the nonce (worker.finish_confirmation does). Only called when required_assurance_level is AL1_LINK_KNOWLEDGE; an AL0_LINK_ONLY org''s worker flow never calls this at all, so cpf_enc is only ever fetched when a challenge is actually about to happen.';

revoke execute on function worker.begin_confirmation(text, text) from public, authenticated;
grant execute on function worker.begin_confirmation(text, text) to anon;

create function worker.finish_confirmation(
  p_token_hash_b64 text,
  p_nonce text,
  p_action text,
  p_identity_passed boolean default null,
  p_contest_reason_code text default null,
  p_contest_comment text default null
)
returns table (result text, delivery_status app.delivery_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req app.confirmation_requests%rowtype;
  v_achieved app.assurance_level;
  v_attempts int;
  v_token_hash bytea := decode(p_token_hash_b64, 'base64');
begin
  if p_action not in ('CONFIRM', 'CONTEST') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  if not app.check_rate_limit('finish:' || encode(v_token_hash, 'hex'), 20, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;

  select * into v_req from app.confirmation_requests where token_hash = v_token_hash for update;
  if not found or v_req.status not in ('VIEWED', 'IDENTITY_FAILED') or v_req.expires_at <= clock_timestamp() then
    raise exception 'link_not_available' using errcode = 'P0002';
  end if;

  -- One-time nonce, consumed here regardless of outcome (confirm, contest, or a failed
  -- identity attempt) -- a replayed/stale submission (same nonce twice) always fails from
  -- here on, forcing a fresh worker.open_link call and a fresh nonce.
  if v_req.nonce_consumed_at is not null or v_req.action_nonce is distinct from decode(p_nonce, 'base64') then
    raise exception 'stale_submission' using errcode = '40001';
  end if;
  update app.confirmation_requests set nonce_consumed_at = clock_timestamp() where id = v_req.id;

  if p_action = 'CONTEST' then
    if p_contest_reason_code is null then
      raise exception 'contest_reason_required' using errcode = '23514';
    end if;

    perform set_config('app.transition_ok', v_req.id::text, true);
    update app.confirmation_requests
    set status = 'CONTESTED', last_event = 'CONTEST', contested_at = clock_timestamp(),
        consumed_at = clock_timestamp(), frozen_at = clock_timestamp()
    where id = v_req.id;

    insert into app.delivery_contests (
      organization_id, company_id, delivery_id, confirmation_request_id,
      reason_code, comment, raised_assurance_level
    ) values (
      v_req.organization_id, v_req.company_id, v_req.delivery_id, v_req.id,
      p_contest_reason_code, p_contest_comment, coalesce(v_req.achieved_assurance_level, 'AL0_LINK_ONLY')
    );

    perform set_config('app.transition_ok', v_req.delivery_id::text, true);
    update app.epi_deliveries
    set status = 'CONTESTED', last_event = 'REQUEST_CONTESTED', contested_at = clock_timestamp(), frozen_at = clock_timestamp()
    where id = v_req.delivery_id;

    perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'DELIVERY_CONTESTED', 'epi_deliveries', v_req.delivery_id, 'WORKER', null,
      jsonb_build_object('reason_code', p_contest_reason_code));

    return query select 'CONTESTED'::text, 'CONTESTED'::app.delivery_status;
    return;
  end if;

  -- p_action = 'CONFIRM'. Não existe aresta para CONFIRMED que não passe por uma verificação
  -- de identidade registrada (docs/architecture.md §8) -- mesmo AL0_LINK_ONLY grava uma
  -- linha em identity_verifications, só que sem desafio nenhum.
  if v_req.required_assurance_level = 'AL0_LINK_ONLY' then
    v_achieved := 'AL0_LINK_ONLY';
  elsif v_req.required_assurance_level = 'AL1_LINK_KNOWLEDGE' then
    if p_identity_passed is null then
      raise exception 'identity_result_required' using errcode = '23514';
    end if;

    if not p_identity_passed then
      -- A wrong-digits attempt is an ordinary, expected OUTCOME of a successful call, not
      -- an error -- it must return normally, not RAISE. An uncaught RAISE EXCEPTION aborts
      -- the entire enclosing transaction in Postgres, which would silently undo the
      -- IDENTITY_FAILED update and the audit_event insert made just before it (a real bug,
      -- caught only by actually running this against PGlite and checking the row
      -- afterwards -- the earlier version of this function raised here and looked correct
      -- on inspection, but nothing it wrote ever actually persisted).
      v_attempts := v_req.identity_attempts + 1;
      if v_attempts >= v_req.identity_max_attempts then
        perform set_config('app.transition_ok', v_req.id::text, true);
        update app.confirmation_requests
        set status = 'EXPIRED', last_event = 'ATTEMPTS_EXHAUSTED', identity_attempts = v_attempts
        where id = v_req.id;
        perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'IDENTITY_FAILED', 'confirmation_requests', v_req.id, 'WORKER', null,
          jsonb_build_object('attempts', v_attempts, 'exhausted', true));
        return query select 'ATTEMPTS_EXHAUSTED'::text, null::app.delivery_status;
        return;
      end if;

      perform set_config('app.transition_ok', v_req.id::text, true);
      update app.confirmation_requests
      set status = 'IDENTITY_FAILED', last_event = 'IDENTITY_FAIL', identity_attempts = v_attempts
      where id = v_req.id;
      perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'IDENTITY_FAILED', 'confirmation_requests', v_req.id, 'WORKER', null,
        jsonb_build_object('attempts', v_attempts, 'exhausted', false));
      return query select 'IDENTITY_MISMATCH'::text, null::app.delivery_status;
      return;
    end if;

    v_achieved := 'AL1_LINK_KNOWLEDGE';
  else
    raise exception 'unsupported_assurance_level' using errcode = '0A000';
  end if;

  perform set_config('app.transition_ok', v_req.id::text, true);
  update app.confirmation_requests
  set status = 'CONFIRMED', last_event = 'CONFIRM', confirmed_at = clock_timestamp(),
      consumed_at = clock_timestamp(), frozen_at = clock_timestamp(), achieved_assurance_level = v_achieved
  where id = v_req.id;

  insert into app.identity_verifications (
    organization_id, company_id, delivery_id, confirmation_request_id,
    provider, method, result, achieved_assurance_level
  ) values (
    v_req.organization_id, v_req.company_id, v_req.delivery_id, v_req.id,
    'INTERNAL', case when v_achieved = 'AL0_LINK_ONLY' then 'LINK_ONLY' else 'LINK_KNOWLEDGE' end,
    'PASS', v_achieved
  );

  perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'IDENTITY_VERIFIED', 'confirmation_requests', v_req.id, 'WORKER', null,
    jsonb_build_object('achieved_assurance_level', v_achieved));

  perform set_config('app.transition_ok', v_req.delivery_id::text, true);
  update app.epi_deliveries
  set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = clock_timestamp(), frozen_at = clock_timestamp()
  where id = v_req.delivery_id;

  perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'DELIVERY_CONFIRMED', 'epi_deliveries', v_req.delivery_id, 'WORKER', null, '{}'::jsonb);

  return query select 'CONFIRMED'::text, 'CONFIRMED'::app.delivery_status;
end;
$$;

comment on function worker.finish_confirmation(text, text, text, boolean, text, text) is
  'The only mutating call on the worker path. CONTEST never requires identity (docs/architecture.md §8 -- blocking it would let an org suppress contestation by configuring a check the worker cannot pass). CONFIRM with AL1_LINK_KNOWLEDGE requires p_identity_passed, computed by Node from worker.begin_confirmation''s ciphertext -- Postgres only ever sees the boolean RESULT, never the CPF digits either party compared.';

revoke execute on function worker.finish_confirmation(text, text, text, boolean, text, text) from public, authenticated;
grant execute on function worker.finish_confirmation(text, text, text, boolean, text, text) to anon;
