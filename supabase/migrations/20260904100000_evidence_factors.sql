-- Phase E (spec §16): multi-factor evidence. Formal contract negotiated and approved before
-- this file was written; this comment records only the load-bearing decisions.
--
-- APPROVED ARCHITECTURE: app.identity_verifications EVOLVES into the accepted-factor table
-- (no new evidence.evidence_factors table), and the sealed payload gains a `factors` array
-- under a NEW canonical version, epi-canon/2. epi-canon/1 stays byte-for-byte untouched:
-- this migration performs NO backfill, rewrites NO sealed row, and changes NO existing
-- verification code. evidence.evidence_versions itself is not altered at all.
--
-- ACCEPTED FACTORS ONLY. A failed identity attempt is NOT a factor: it already has a durable,
-- hash-chained record in audit.audit_events ('IDENTITY_FAILED', with attempts/exhausted) plus
-- the persisted counter app.confirmation_requests.identity_attempts. Persisting FAIL rows
-- here would add brute-force telemetry readable by every delivery.read holder, unbounded
-- growth per attacked link, and -- worst -- rows that a reader could mistake for evidence
-- backing the seal. So this phase produces result='PASS' exclusively; the pre-existing
-- CHECK (result in ('PASS','FAIL')) is left alone (narrowing it would be a destructive change
-- with no gain), but no code path emits FAIL.
--
-- DETERMINISM: the factor id, occurred_at, type, method, provider, result and metadata that
-- reach the canonical payload are generated ONCE in Node, hashed there, and passed to this
-- RPC as p_factors so the persisted row carries the SAME values. Postgres never generates a
-- competing uuid/timestamp for a factor that is already inside a sealed payload.
--
-- OTP / PRESENCIAL: model support only (the enum can represent them). There is deliberately
-- no producer, no provider, no UI and no reachable path -- worker.finish_confirmation rejects
-- any factor_type other than the two this phase actually implements, with errcode 0A000,
-- exactly mirroring how unsupported_assurance_level already guards AL2-AL4.

-- 1. The accepted-factor columns -------------------------------------------------------------

alter table app.identity_verifications
  add column factor_type text not null default 'IDENTITY_KNOWLEDGE'
    check (factor_type in ('IDENTITY_KNOWLEDGE', 'IDENTITY_OTP', 'IDENTITY_PRESENCIAL', 'DECLARATION_SIGNATURE')),
  add column occurred_at timestamptz not null default clock_timestamp(),
  add column metadata jsonb;

comment on column app.identity_verifications.factor_type is
  'What KIND of accepted evidence this row is. IDENTITY_KNOWLEDGE and DECLARATION_SIGNATURE are the only two produced in Phase E; IDENTITY_OTP/IDENTITY_PRESENCIAL exist so the model can REPRESENT them (spec §16 lists both) and are rejected at runtime by worker.finish_confirmation -- a value in this list never means the flow exists.';
comment on column app.identity_verifications.occurred_at is
  'When the observation happened, generated in Node and passed in verbatim so it matches the value inside the sealed canonical payload byte-for-byte. Defaulted to clock_timestamp() only for the legacy single-factor path.';
comment on column app.identity_verifications.metadata is
  'Non-sensitive context only. worker.finish_confirmation rejects a denylisted key (cpf, otp, token, secret, password, signature, image, biometric...) -- a raw OTP, token, full CPF or biometric sample must never reach a jsonb column that ends up in a sealed payload.';

-- The default above exists solely so the ALTER is safe against existing rows (all of which
-- are knowledge/link identity checks). New rows always receive an explicit value.
alter table app.identity_verifications alter column factor_type drop default;

-- A DECLARATION_SIGNATURE is not an identity check: it carries no method and no assurance
-- level (the contract is explicit that a drawn signature never raises identity assurance).
-- Both columns therefore become nullable -- widening only, existing rows stay valid.
alter table app.identity_verifications alter column method drop not null;
alter table app.identity_verifications alter column achieved_assurance_level drop not null;

alter table app.identity_verifications
  add constraint identity_verifications_factor_shape_ck check (
    case
      when factor_type = 'DECLARATION_SIGNATURE'
        then method is null and achieved_assurance_level is null
      else method is not null and achieved_assurance_level is not null
    end
  );

-- provider stops being free text (threat: provider spoofing). Closed allowlist, extended by a
-- one-line migration when a real provider is actually integrated. Being on the list is NOT
-- permission to use it -- the runtime guard below still applies.
alter table app.identity_verifications
  add constraint identity_verifications_provider_ck check (provider in ('INTERNAL'));

comment on table app.identity_verifications is
  'Accepted evidence factors for a confirmation -- never attempts (a failed identity check lives in audit.audit_events + confirmation_requests.identity_attempts, never here). One row per factor: Phase E produces IDENTITY_KNOWLEDGE and DECLARATION_SIGNATURE. The RESULT of a check, never the raw biometric (docs/architecture.md §9/§16). AUTHORITY NOTE: for a sealed confirmation the canonical_bytes in evidence.evidence_versions are the historical authority -- this table is an operational index, and /ficha must render sealed factors from the payload, never from here.';

-- 2. worker.finish_confirmation gains p_factors ---------------------------------------------
-- Signature change = argument count change, which CREATE OR REPLACE cannot do (it would
-- install a second overload and PostgREST would resolve the old one -- exactly the bug this
-- session already hit with api.return_epi_item). Drop the current signature explicitly first,
-- same convention this schema already uses for every worker.* signature change.

drop function if exists worker.finish_confirmation(text, text, text, boolean, text, text, jsonb, text, text, timestamptz);

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
  p_confirmed_at_utc timestamptz default null,
  p_factors jsonb default null
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
  v_factor jsonb;
  v_key text;
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

  -- Accepted factors. p_factors carries the EXACT ids/timestamps already hashed into the
  -- canonical payload (epi-canon/2). When it is absent the legacy single-row behaviour is
  -- kept verbatim, so an epi-canon/1 caller keeps working unchanged.
  if p_factors is null then
    insert into app.identity_verifications (
      organization_id, company_id, delivery_id, confirmation_request_id,
      provider, method, result, achieved_assurance_level, factor_type
    ) values (
      v_req.organization_id, v_req.company_id, v_req.delivery_id, v_req.id,
      'INTERNAL', case when v_achieved = 'AL0_LINK_ONLY' then 'LINK_ONLY' else 'LINK_KNOWLEDGE' end,
      'PASS', v_achieved, 'IDENTITY_KNOWLEDGE'
    );
  else
    if jsonb_typeof(p_factors) <> 'array' or jsonb_array_length(p_factors) = 0 then
      raise exception 'factors_must_be_non_empty_array' using errcode = '22023';
    end if;

    for v_factor in select * from jsonb_array_elements(p_factors) loop
      -- Only the two factor types this phase actually implements are accepted. OTP and
      -- PRESENCIAL are representable by the model but have no operational flow -- letting one
      -- through here would be exactly the "usable-looking path with no rate limit, expiry,
      -- brute-force or replay protection" the contract forbids.
      if v_factor->>'type' not in ('IDENTITY_KNOWLEDGE', 'DECLARATION_SIGNATURE') then
        raise exception 'unsupported_factor_type' using errcode = '0A000';
      end if;
      if v_factor->>'result' <> 'PASS' then
        raise exception 'only_accepted_factors_are_persisted' using errcode = '23514';
      end if;
      if coalesce(v_factor->>'provider', 'INTERNAL') <> 'INTERNAL' then
        raise exception 'unsupported_provider' using errcode = '0A000';
      end if;

      -- Metadata denylist: a raw OTP/token/secret/CPF/biometric sample must never land in a
      -- jsonb column that is about to be sealed into the canonical payload.
      if v_factor ? 'metadata' then
        if jsonb_typeof(v_factor->'metadata') <> 'object' then
          raise exception 'factor_metadata_must_be_object' using errcode = '22023';
        end if;
        for v_key in select jsonb_object_keys(v_factor->'metadata') loop
          if lower(v_key) ~ '(cpf|otp|token|secret|password|senha|signature|assinatura|image|imagem|biometric|biometria|face|selfie)' then
            raise exception 'forbidden_metadata_key' using errcode = '23514';
          end if;
        end loop;
      end if;

      insert into app.identity_verifications (
        id, organization_id, company_id, delivery_id, confirmation_request_id,
        provider, method, result, achieved_assurance_level, factor_type, occurred_at, metadata
      ) values (
        (v_factor->>'id')::uuid,
        v_req.organization_id, v_req.company_id, v_req.delivery_id, v_req.id,
        'INTERNAL',
        v_factor->>'method',
        'PASS',
        case when v_factor->>'type' = 'DECLARATION_SIGNATURE' then null else v_achieved end,
        v_factor->>'type',
        (v_factor->>'occurred_at_utc')::timestamptz,
        v_factor->'metadata'
      );
    end loop;
  end if;

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

comment on function worker.finish_confirmation(text, text, text, boolean, text, text, jsonb, text, text, timestamptz, jsonb) is
  'CONTEST never seals evidence -- only a genuine CONFIRMED receipt does. p_confirmed_at_utc is generated once in Node and used for the payload AND every DB timestamp. p_factors (Phase E) carries the accepted factors with the SAME ids/timestamps already hashed into the epi-canon/2 payload, so the persisted rows can never drift from the sealed bytes; omitting it keeps the pre-Phase-E single-factor behaviour byte-for-byte. Only accepted (PASS) factors are ever persisted -- a failed identity attempt stays in audit.audit_events.';

revoke execute on function worker.finish_confirmation(text, text, text, boolean, text, text, jsonb, text, text, timestamptz, jsonb) from public, authenticated;
grant execute on function worker.finish_confirmation(text, text, text, boolean, text, text, jsonb, text, text, timestamptz, jsonb) to anon;

-- 3. Manager-facing read of the accepted factors ---------------------------------------------
-- Operational index only. The sealed payload remains the historical authority for anything
-- already confirmed -- see api.get_evidence_summary, which /ficha uses for sealed factors.

create view api.evidence_factors
  with (security_invoker = true) as
select
  f.id, f.organization_id, f.company_id, f.delivery_id, f.confirmation_request_id,
  f.factor_type, f.method, f.provider, f.result, f.achieved_assurance_level,
  f.occurred_at, f.metadata, f.created_at
from app.identity_verifications f;

comment on view api.evidence_factors is
  'Read-only projection of the accepted evidence factors. security_invoker means the existing identity_verifications RLS policy (delivery.read on the company) applies to the caller. NOT the authority for a sealed confirmation -- read the sealed payload for that.';

grant select on api.evidence_factors to authenticated;
