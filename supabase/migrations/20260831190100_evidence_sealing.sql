-- FASE 5: evidence sealing. Canonicalization happens in Node (src/lib/evidence/canon.ts) --
-- RFC 8785 key-ordering/number-formatting has real edge cases, and PL/pgSQL has no JCS
-- implementation to lean on. So the flow is: Node fetches the AUTHORITATIVE source data via
-- worker.get_evidence_source (read-only, no side effects), builds+hashes the canonical
-- payload, then passes the already-sealed bytes/hash into worker.finish_confirmation, which
-- still does everything atomically in ONE transaction: revalidate, transition
-- confirmation_requests + epi_deliveries, verify identity, THEN insert the evidence row --
-- never a window where CONFIRMED exists without evidence (docs/architecture.md §12). The
-- read step has no side effects, so a crash between it and finish_confirmation just leaves
-- the delivery un-confirmed (fails closed), never a partial/inconsistent state.

create function app.generate_verification_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(
    substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (get_byte(extensions.gen_random_bytes(1), 0) % 32) + 1, 1),
    ''
  )
  from generate_series(1, 12);
$$;

comment on function app.generate_verification_code() is
  'A 12-character Crockford base32 code (0-9, A-Z minus I/L/O/U), one fresh random byte per character -- 256 % 32 = 0, so the modulo introduces no bias.';

-- Read-only: the authoritative source Node canonicalizes from. Same alive-request checks as
-- worker.begin_confirmation, but does not touch nonce_consumed_at -- calling this twice (or
-- calling it and then NOT calling finish_confirmation) has no effect on anything.
create function worker.get_evidence_source(p_token_hash_b64 text, p_nonce text)
returns table (
  delivery_id        uuid,
  company_legal_name text,
  company_cnpj       text,
  employee_full_name text,
  employee_cpf_masked text,
  delivery_date       date,
  note                 text,
  items                jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req app.confirmation_requests%rowtype;
  v_token_hash bytea := decode(p_token_hash_b64, 'base64');
begin
  if not app.check_rate_limit('evsrc:' || encode(v_token_hash, 'hex'), 20, 300) then
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

  return query
  select
    d.id, c.legal_name, c.cnpj, e.full_name, e.cpf_masked, d.delivery_date, d.note,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'line_no', i.line_no, 'epi_name', i.epi_name, 'ca_number', i.ca_number,
        'manufacturer', i.manufacturer, 'model', i.model, 'quantity', i.quantity, 'unit', i.unit
      ) order by i.line_no), '[]'::jsonb)
      from app.epi_delivery_items i where i.delivery_id = d.id
    )
  from app.epi_deliveries d
  join app.companies c on c.id = d.company_id
  join app.employees e on e.id = d.employee_id
  where d.id = v_req.delivery_id;
end;
$$;

comment on function worker.get_evidence_source(text, text) is
  'The ONLY source Node trusts for canonicalization -- never client-submitted form data, which a tampered request could forge. Read-only, no state change.';

revoke execute on function worker.get_evidence_source(text, text) from public, authenticated;
grant execute on function worker.get_evidence_source(text, text) to anon;

-- Internal only -- never exposed to PostgREST, never granted to anyone. Called from inside
-- worker.finish_confirmation's own transaction (owner-privileged call, no grant needed).
create function app.seal_evidence(
  p_organization_id uuid,
  p_company_id uuid,
  p_delivery_id uuid,
  p_confirmation_request_id uuid,
  p_chain_id uuid,
  p_chain_version int,
  p_payload jsonb,
  p_canonical_bytes bytea,
  p_payload_sha256 bytea,
  p_sealed_at timestamptz,
  p_audit_seq bigint,
  p_audit_event_hash bytea
)
returns table (evidence_version_id uuid, verification_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evidence_id uuid;
  v_code text;
begin
  insert into evidence.evidence_versions (
    organization_id, company_id, delivery_id, confirmation_request_id,
    chain_id, chain_version, payload, canonical_bytes, payload_sha256,
    audit_seq, audit_event_hash, sealed_at
  ) values (
    p_organization_id, p_company_id, p_delivery_id, p_confirmation_request_id,
    p_chain_id, p_chain_version, p_payload, p_canonical_bytes, p_payload_sha256,
    p_audit_seq, p_audit_event_hash, p_sealed_at
  ) returning id into v_evidence_id;

  loop
    v_code := app.generate_verification_code();
    begin
      insert into evidence.documents (organization_id, company_id, evidence_version_id, verification_code)
      values (p_organization_id, p_company_id, v_evidence_id, v_code);
      exit;
    exception when unique_violation then
      -- Collision on the code itself (32^12 combinations -- astronomically unlikely):
      -- retry with a fresh one rather than failing the whole seal.
    end;
  end loop;

  return query select v_evidence_id, v_code;
end;
$$;

comment on function app.seal_evidence(uuid, uuid, uuid, uuid, uuid, int, jsonb, bytea, bytea, timestamptz, bigint, bytea) is
  'Inserts the evidence_versions row and its evidence.documents pointer (with a fresh verification code) in one call. Only ever invoked from inside worker.finish_confirmation''s own transaction -- never exposed to PostgREST.';

-- Re-declared with the FASE 3 signature plus evidence-sealing parameters. FASE 3's version
-- (supabase/migrations/20260831170300_worker_rpcs.sql) is already applied live and is never
-- edited retroactively -- this DROP+CREATE is how a later phase changes an already-shipped
-- function's signature.
drop function if exists worker.finish_confirmation(text, text, text, boolean, text, text);

create function worker.finish_confirmation(
  p_token_hash_b64 text,
  p_nonce text,
  p_action text,
  p_identity_passed boolean default null,
  p_contest_reason_code text default null,
  p_contest_comment text default null,
  p_payload jsonb default null,
  p_canonical_bytes_b64 text default null,
  p_payload_sha256_b64 text default null,
  p_confirmed_at_utc timestamptz default null
)
returns table (result text, delivery_status app.delivery_status, verification_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req app.confirmation_requests%rowtype;
  v_achieved app.assurance_level;
  v_attempts int;
  v_token_hash bytea := decode(p_token_hash_b64, 'base64');
  v_chain_id uuid;
  v_chain_version int;
  v_audit_event_id uuid;
  v_audit_seq bigint;
  v_audit_event_hash bytea;
  v_evidence_id uuid;
  v_verification_code text;
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

    return query select 'CONTESTED'::text, 'CONTESTED'::app.delivery_status, null::text;
    return;
  end if;

  -- p_action = 'CONFIRM'.
  if v_req.required_assurance_level = 'AL0_LINK_ONLY' then
    v_achieved := 'AL0_LINK_ONLY';
  elsif v_req.required_assurance_level = 'AL1_LINK_KNOWLEDGE' then
    if p_identity_passed is null then
      raise exception 'identity_result_required' using errcode = '23514';
    end if;

    if not p_identity_passed then
      v_attempts := v_req.identity_attempts + 1;
      if v_attempts >= v_req.identity_max_attempts then
        perform set_config('app.transition_ok', v_req.id::text, true);
        update app.confirmation_requests
        set status = 'EXPIRED', last_event = 'ATTEMPTS_EXHAUSTED', identity_attempts = v_attempts
        where id = v_req.id;
        perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'IDENTITY_FAILED', 'confirmation_requests', v_req.id, 'WORKER', null,
          jsonb_build_object('attempts', v_attempts, 'exhausted', true));
        return query select 'ATTEMPTS_EXHAUSTED'::text, null::app.delivery_status, null::text;
        return;
      end if;

      perform set_config('app.transition_ok', v_req.id::text, true);
      update app.confirmation_requests
      set status = 'IDENTITY_FAILED', last_event = 'IDENTITY_FAIL', identity_attempts = v_attempts
      where id = v_req.id;
      perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'IDENTITY_FAILED', 'confirmation_requests', v_req.id, 'WORKER', null,
        jsonb_build_object('attempts', v_attempts, 'exhausted', false));
      return query select 'IDENTITY_MISMATCH'::text, null::app.delivery_status, null::text;
      return;
    end if;

    v_achieved := 'AL1_LINK_KNOWLEDGE';
  else
    raise exception 'unsupported_assurance_level' using errcode = '0A000';
  end if;

  if p_payload is null or p_canonical_bytes_b64 is null or p_payload_sha256_b64 is null or p_confirmed_at_utc is null then
    raise exception 'evidence_payload_required' using errcode = '23514';
  end if;

  perform set_config('app.transition_ok', v_req.id::text, true);
  update app.confirmation_requests
  set status = 'CONFIRMED', last_event = 'CONFIRM', confirmed_at = p_confirmed_at_utc,
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
  set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = p_confirmed_at_utc, frozen_at = p_confirmed_at_utc
  where id = v_req.delivery_id
  returning chain_id, chain_version into v_chain_id, v_chain_version;

  v_audit_event_id := app.log_audit_event(v_req.organization_id, v_req.company_id, 'DELIVERY_CONFIRMED', 'epi_deliveries', v_req.delivery_id, 'WORKER', null, '{}'::jsonb);
  select seq, event_hash into v_audit_seq, v_audit_event_hash from audit.audit_events where id = v_audit_event_id;

  select ev.evidence_version_id, ev.verification_code into v_evidence_id, v_verification_code
  from app.seal_evidence(
    v_req.organization_id, v_req.company_id, v_req.delivery_id, v_req.id,
    v_chain_id, v_chain_version, p_payload,
    decode(p_canonical_bytes_b64, 'base64'), decode(p_payload_sha256_b64, 'base64'),
    p_confirmed_at_utc, v_audit_seq, v_audit_event_hash
  ) ev;

  perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'EVIDENCE_SEALED', 'epi_deliveries', v_req.delivery_id, 'SYSTEM', null,
    jsonb_build_object('evidence_version_id', v_evidence_id, 'verification_code', v_verification_code));

  return query select 'CONFIRMED'::text, 'CONFIRMED'::app.delivery_status, v_verification_code;
end;
$$;

comment on function worker.finish_confirmation(text, text, text, boolean, text, text, jsonb, text, text, timestamptz) is
  'CONTEST never seals evidence -- only a genuine CONFIRMED receipt does (docs/mvp-roadmap.md FASE 5). p_confirmed_at_utc is generated once in Node and used for BOTH the payload''s own confirmed_at_utc field and every DB timestamp this call writes (confirmed_at/frozen_at/sealed_at) -- one clock, not several independently-taken ones. evidence_payload_required fires if any of the four evidence parameters is missing on a CONFIRM call -- there is no code path that reaches CONFIRMED without sealing.';

revoke execute on function worker.finish_confirmation(text, text, text, boolean, text, text, jsonb, text, text, timestamptz) from public, authenticated;
grant execute on function worker.finish_confirmation(text, text, text, boolean, text, text, jsonb, text, text, timestamptz) to anon;

-- Public verification, no auth at all -- minimal disclosure (docs/architecture.md §8): code,
-- status, company display name, emission date, and a short hash PREFIX (never the full
-- hash -- enough for a human to visually spot-check against a printed receipt, not enough
-- to be useful for anything else).
create function worker.verify_document(p_code text)
returns table (
  verification_code text,
  status             text,
  company_name       text,
  sealed_at          timestamptz,
  hash_prefix        text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc evidence.documents%rowtype;
begin
  if not app.check_rate_limit('verify:' || upper(p_code), 30, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;

  select * into v_doc from evidence.documents d where d.verification_code = upper(p_code);
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  return query
  select
    v_doc.verification_code,
    'CONFIRMADO'::text,
    coalesce(c.trade_name, c.legal_name),
    ev.sealed_at,
    left(encode(ev.payload_sha256, 'hex'), 12)
  from evidence.evidence_versions ev
  join app.companies c on c.id = ev.company_id
  where ev.id = v_doc.evidence_version_id;
end;
$$;

comment on function worker.verify_document(text) is
  'The /verify/<code> page''s only data source. Never returns the worker''s name, CPF (masked or not), items, or CA -- docs/architecture.md §8''s minimal-disclosure list for this exact endpoint.';

revoke execute on function worker.verify_document(text) from public, authenticated;
grant execute on function worker.verify_document(text) to anon;

-- Manager-facing: the full evidence summary for a delivery's detail page (not the public
-- minimal-disclosure view above).
create function api.get_evidence_summary(p_delivery_id uuid)
returns table (
  evidence_version_id uuid,
  verification_code    text,
  payload_sha256_hex   text,
  sealed_at             timestamptz,
  payload               jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id from app.epi_deliveries where id = p_delivery_id;
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.read')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select d.id, doc.verification_code, encode(ev.payload_sha256, 'hex'), ev.sealed_at, ev.payload
  from evidence.evidence_versions ev
  join evidence.documents doc on doc.evidence_version_id = ev.id
  join app.epi_deliveries d on d.id = ev.delivery_id
  where ev.delivery_id = p_delivery_id
  order by ev.chain_version desc
  limit 1;
end;
$$;

comment on function api.get_evidence_summary(uuid) is
  'The manager-facing counterpart to worker.verify_document -- full payload, not minimal disclosure, gated by delivery.read on the delivery''s own company.';

revoke execute on function api.get_evidence_summary(uuid) from public, anon;
grant execute on function api.get_evidence_summary(uuid) to authenticated;

-- Re-declared with an added verification_code column, so a worker's own post-confirmation
-- receipt screen (src/app/e/s/[id]/receipt-view.tsx) can show/link the same code the
-- manager and the public /verify page see -- null for every non-CONFIRMED view_status
-- (nothing to show yet, and CONTESTED never seals evidence at all).
drop function if exists worker.open_link(text, inet);

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
  items                      jsonb,
  verification_code         text
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
      ),
      (
        select doc.verification_code
        from evidence.evidence_versions ev
        join evidence.documents doc on doc.evidence_version_id = ev.id
        where ev.delivery_id = d.id
        order by ev.chain_version desc
        limit 1
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
    ),
    null::text
  from app.epi_deliveries d
  join app.companies c on c.id = d.company_id
  join app.employees e on e.id = d.employee_id
  where d.id = v_req.delivery_id;
end;
$$;

comment on function worker.open_link(text, inet) is
  'Every load of /e/<token> and /e/s/<view-id> calls this. Repeatable (viewing never consumes anything) -- reissues action_nonce every call so an old rendered page can never submit. Never reveals the CPF challenge material -- see worker.begin_confirmation. verification_code is populated only in the CONFIRMED read-only branch (evidence is only ever sealed for a genuine confirmation, never a contest).';

revoke execute on function worker.open_link(text, inet) from public, authenticated;
grant execute on function worker.open_link(text, inet) to anon;
