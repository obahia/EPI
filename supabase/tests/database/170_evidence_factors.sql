-- Phase E (spec §16): multi-factor evidence. Proves the approved contract against a real
-- Postgres: accepted factors only (a failed identity attempt is never a factor), the
-- deterministic values that reached the sealed payload are the ones persisted, the closed
-- provider allowlist, the metadata denylist, unimplemented factor types rejected at runtime,
-- post-seal immutability, retry/idempotency, cross-tenant isolation, and epi-canon/1 seals
-- left untouched.
--
-- Fixture technique matches 040_confirmation_flow.sql: the manager creates the link through
-- the real api.create_confirmation_link, then the worker path runs as `anon` through
-- worker.open_link / worker.finish_confirmation. Canonical bytes here are a fixture string --
-- the byte-exact canonicalization itself is proven by the golden vectors in
-- src/lib/evidence/factors.test.ts, which run in the App job; what this file proves is what
-- the DATABASE does with them.

create extension if not exists pgtap with schema extensions;

begin;

select plan(28);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '88888888-8888-8888-8888-888888888801',
   'authenticated', 'authenticated', 'admin-r@tenant-r.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin R"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '99999999-9999-9999-9999-999999999901',
   'authenticated', 'authenticated', 'admin-s@tenant-s.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin S"}', now(), now(), '', '', '', '', false, false);

create temporary table fixture_ids (label text primary key, id uuid, extra text);
grant all on fixture_ids to authenticated, anon;

-- Two tenants: R is the subject, S is the cross-tenant probe.
do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888801","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant R LTDA', '55666777000829', 'Tenant R LTDA', '55666777000829', null);
  insert into fixture_ids values ('company_r', v_company_id, null);
  reset role;
end $$;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant S LTDA', '66777888000930', 'Tenant S LTDA', '66777888000930', null);
  insert into fixture_ids values ('company_s', v_company_id, null);
  reset role;
end $$;

-- Catalog + employee + an ISSUED delivery for tenant R.
do $$
declare
  v_company uuid; v_org uuid; v_epi uuid; v_employee uuid; v_delivery uuid;
begin
  select id into v_company from fixture_ids where label = 'company_r';
  v_org := (select organization_id from app.companies where id = v_company);

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888801","role":"authenticated"}', true);

  select api.create_epi(v_org, v_company, 'Capacete Evidência', '70001') into v_epi;
  select api.create_employee(
    p_company_id := v_company, p_full_name := 'Funcionário Evidência',
    p_cpf_hash_b64 := encode(extensions.digest('cpf-e-01', 'sha256'), 'base64'),
    p_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-e-01'::bytea, 'base64'),
    p_cpf_masked := '***.111.222-**'
  ) into v_employee;

  select api.create_delivery(
    v_company, v_employee, current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', v_epi, 'quantity', 1))
  ) into v_delivery;
  perform api.issue_delivery(v_delivery);
  insert into fixture_ids values ('delivery', v_delivery, null);

  reset role;
end $$;

-- Manager creates the confirmation link.
do $$
declare v_cr_id uuid; v_hash_b64 text;
begin
  v_hash_b64 := encode(extensions.digest('evidence-token-e1', 'sha256'), 'base64');
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888801","role":"authenticated"}', true);
  select confirmation_request_id into v_cr_id
  from api.create_confirmation_link((select id from fixture_ids where label = 'delivery'), v_hash_b64, null);
  insert into fixture_ids values ('cr', v_cr_id, v_hash_b64);
  reset role;
end $$;

-- Fixture canonical bytes/hash. The CHECK on evidence_versions requires
-- payload_sha256 = digest(canonical_bytes), so these must be genuinely consistent.
insert into fixture_ids values
  ('canon_bytes', null, encode('{"_canon":"epi-canon/2","fixture":"170"}'::bytea, 'base64')),
  ('canon_sha256', null, encode(extensions.digest('{"_canon":"epi-canon/2","fixture":"170"}'::bytea, 'sha256'), 'base64')),
  ('factor_identity', gen_random_uuid(), null),
  ('factor_signature', gen_random_uuid(), null);

-- ===========================================================================================
-- 1. A failed identity attempt produces NO factor and NO seal
-- ===========================================================================================

do $$
declare v_hash_b64 text; v_nonce text; v_result text;
begin
  select extra into v_hash_b64 from fixture_ids where label = 'cr';
  set local role anon;
  select action_nonce into v_nonce from worker.open_link(v_hash_b64, null);
  select result into v_result from worker.finish_confirmation(v_hash_b64, v_nonce, 'CONFIRM', false, null, null);
  reset role;
  insert into fixture_ids values ('failed_result', null, v_result);
end $$;

select is(
  (select extra from fixture_ids where label = 'failed_result'),
  'IDENTITY_MISMATCH',
  'a wrong identity attempt is rejected'
);
select is(
  (select count(*)::int from app.identity_verifications where delivery_id = (select id from fixture_ids where label = 'delivery')),
  0,
  'a failed attempt creates NO evidence factor -- accepted factors only'
);
select is(
  (select count(*)::int from evidence.evidence_versions where delivery_id = (select id from fixture_ids where label = 'delivery')),
  0,
  'a failed attempt creates no seal'
);
select ok(
  (select count(*) > 0 from audit.audit_events
   where entity_id = (select id from fixture_ids where label = 'cr') and event_type = 'IDENTITY_FAILED'),
  'the failed attempt IS recorded, in the hash-chained audit log where attempts belong'
);

-- ===========================================================================================
-- 2. Runtime guards: unimplemented factor type, provider, metadata denylist, non-PASS
-- ===========================================================================================
-- worker.finish_confirmation consumes the action_nonce BEFORE it validates factors, so every
-- rejected call below burns its nonce and the next one must re-open the link for a fresh one
-- (open_link reissues action_nonce on every call). The nonce also has to travel base64 --
-- that is what open_link returns and what the RPC decodes; passing the raw bytea's text form
-- would fail as stale_submission long before reaching the guard under test.

insert into fixture_ids values ('nonce_fresh', null, null);

create or replace function pg_temp.refresh_nonce() returns void language plpgsql as $$
declare v_nonce text;
begin
  set local role anon;
  select action_nonce into v_nonce from worker.open_link((select extra from fixture_ids where label = 'cr'), null);
  reset role;
  update fixture_ids set extra = v_nonce where label = 'nonce_fresh';
end $$;

select pg_temp.refresh_nonce();
select throws_ok(
  format($$ select worker.finish_confirmation(%L, %L,
    'CONFIRM', true, null, null, '{"_canon":"epi-canon/2"}'::jsonb, %L, %L, clock_timestamp(),
    '[{"id":"11111111-1111-4111-8111-111111111111","type":"IDENTITY_OTP","provider":"INTERNAL","result":"PASS","occurred_at_utc":"2026-09-04T00:00:00.000Z"}]'::jsonb) $$,
    (select extra from fixture_ids where label = 'cr'),
    (select extra from fixture_ids where label = 'nonce_fresh'),
    (select extra from fixture_ids where label = 'canon_bytes'),
    (select extra from fixture_ids where label = 'canon_sha256')),
  '0A000', 'unsupported_factor_type',
  'IDENTITY_OTP is representable by the model but rejected at runtime -- no usable OTP path exists'
);

select pg_temp.refresh_nonce();
select throws_ok(
  format($$ select worker.finish_confirmation(%L, %L,
    'CONFIRM', true, null, null, '{"_canon":"epi-canon/2"}'::jsonb, %L, %L, clock_timestamp(),
    '[{"id":"11111111-1111-4111-8111-111111111112","type":"IDENTITY_KNOWLEDGE","provider":"ACME_VENDOR","result":"PASS","occurred_at_utc":"2026-09-04T00:00:00.000Z","method":"LINK_KNOWLEDGE"}]'::jsonb) $$,
    (select extra from fixture_ids where label = 'cr'),
    (select extra from fixture_ids where label = 'nonce_fresh'),
    (select extra from fixture_ids where label = 'canon_bytes'),
    (select extra from fixture_ids where label = 'canon_sha256')),
  '0A000', 'unsupported_provider',
  'a provider outside the closed allowlist is refused (provider spoofing)'
);

select pg_temp.refresh_nonce();
select throws_ok(
  format($$ select worker.finish_confirmation(%L, %L,
    'CONFIRM', true, null, null, '{"_canon":"epi-canon/2"}'::jsonb, %L, %L, clock_timestamp(),
    '[{"id":"11111111-1111-4111-8111-111111111113","type":"IDENTITY_KNOWLEDGE","provider":"INTERNAL","result":"PASS","occurred_at_utc":"2026-09-04T00:00:00.000Z","method":"LINK_KNOWLEDGE","metadata":{"otp_code":"123456"}}]'::jsonb) $$,
    (select extra from fixture_ids where label = 'cr'),
    (select extra from fixture_ids where label = 'nonce_fresh'),
    (select extra from fixture_ids where label = 'canon_bytes'),
    (select extra from fixture_ids where label = 'canon_sha256')),
  '23514', 'forbidden_metadata_key',
  'a denylisted metadata key (otp) is refused before it can reach a sealed payload'
);

select pg_temp.refresh_nonce();
select throws_ok(
  format($$ select worker.finish_confirmation(%L, %L,
    'CONFIRM', true, null, null, '{"_canon":"epi-canon/2"}'::jsonb, %L, %L, clock_timestamp(),
    '[{"id":"11111111-1111-4111-8111-111111111114","type":"IDENTITY_KNOWLEDGE","provider":"INTERNAL","result":"FAIL","occurred_at_utc":"2026-09-04T00:00:00.000Z","method":"LINK_KNOWLEDGE"}]'::jsonb) $$,
    (select extra from fixture_ids where label = 'cr'),
    (select extra from fixture_ids where label = 'nonce_fresh'),
    (select extra from fixture_ids where label = 'canon_bytes'),
    (select extra from fixture_ids where label = 'canon_sha256')),
  '23514', 'only_accepted_factors_are_persisted',
  'a FAIL factor is refused -- this table holds accepted factors only'
);

-- ===========================================================================================
-- 3. The real confirmation: two accepted factors, persisted with the values that were sealed
-- ===========================================================================================

do $$
declare v_hash_b64 text; v_nonce text; v_result text; v_code text;
begin
  select extra into v_hash_b64 from fixture_ids where label = 'cr';
  set local role anon;
  select action_nonce into v_nonce from worker.open_link(v_hash_b64, null);
  select result, verification_code into v_result, v_code from worker.finish_confirmation(
    v_hash_b64, v_nonce, 'CONFIRM', true, null, null,
    '{"_canon":"epi-canon/2","fixture":"170"}'::jsonb,
    (select extra from fixture_ids where label = 'canon_bytes'),
    (select extra from fixture_ids where label = 'canon_sha256'),
    clock_timestamp(),
    jsonb_build_array(
      jsonb_build_object(
        'id', (select id from fixture_ids where label = 'factor_identity'),
        'type', 'IDENTITY_KNOWLEDGE', 'provider', 'INTERNAL', 'result', 'PASS',
        'occurred_at_utc', '2026-09-04T12:00:00.000Z', 'method', 'LINK_KNOWLEDGE'),
      jsonb_build_object(
        'id', (select id from fixture_ids where label = 'factor_signature'),
        'type', 'DECLARATION_SIGNATURE', 'provider', 'INTERNAL', 'result', 'PASS',
        'occurred_at_utc', '2026-09-04T12:00:01.000Z')
    )
  );
  reset role;
  insert into fixture_ids values ('confirm_result', null, v_result), ('code', null, v_code);
end $$;

select is(
  (select extra from fixture_ids where label = 'confirm_result'),
  'CONFIRMED',
  'the confirmation succeeds with two accepted factors'
);
select is(
  (select count(*)::int from app.identity_verifications where delivery_id = (select id from fixture_ids where label = 'delivery')),
  2,
  'exactly the two accepted factors are persisted'
);
select results_eq(
  $$ select factor_type::text from app.identity_verifications
     where delivery_id = (select id from fixture_ids where label = 'delivery') order by factor_type $$,
  $$ values ('DECLARATION_SIGNATURE'::text), ('IDENTITY_KNOWLEDGE'::text) $$,
  'IDENTITY_KNOWLEDGE and DECLARATION_SIGNATURE are both accepted'
);
select is(
  (select occurred_at from app.identity_verifications where id = (select id from fixture_ids where label = 'factor_identity')),
  '2026-09-04T12:00:00.000Z'::timestamptz,
  'the persisted occurred_at is the exact instant that went into the sealed payload -- no competing clock'
);
select ok(
  (select id is not null from app.identity_verifications where id = (select id from fixture_ids where label = 'factor_signature')),
  'the persisted factor id is the exact uuid that went into the sealed payload -- no competing uuid'
);
select is(
  (select achieved_assurance_level::text from app.identity_verifications
   where id = (select id from fixture_ids where label = 'factor_signature')),
  null::text,
  'the signature factor carries no assurance level -- a drawn signature never raises identity confidence'
);
select is(
  (select method from app.identity_verifications where id = (select id from fixture_ids where label = 'factor_signature')),
  null::text,
  'the signature factor carries no identity method either'
);
select is(
  (select achieved_assurance_level::text from app.confirmation_requests where id = (select id from fixture_ids where label = 'cr')),
  'AL1_LINK_KNOWLEDGE',
  'assurance stays an attribute of the confirmation, derived server-side'
);
select is(
  (select count(*)::int from app.identity_verifications
   where delivery_id = (select id from fixture_ids where label = 'delivery') and result <> 'PASS'),
  0,
  'only PASS factors exist -- Phase E never emits FAIL'
);

-- ===========================================================================================
-- 4. The seal itself
-- ===========================================================================================

select is(
  (select count(*)::int from evidence.evidence_versions where delivery_id = (select id from fixture_ids where label = 'delivery')),
  1,
  'exactly one evidence version is sealed'
);
select ok(
  (select payload_sha256 = extensions.digest(canonical_bytes, 'sha256')
   from evidence.evidence_versions where delivery_id = (select id from fixture_ids where label = 'delivery')),
  'the stored hash corresponds exactly to the stored canonical bytes'
);
select is(
  (select payload->>'_canon' from evidence.evidence_versions where delivery_id = (select id from fixture_ids where label = 'delivery')),
  'epi-canon/2',
  'the new seal declares epi-canon/2'
);
select ok(
  (select audit_seq is not null and audit_event_hash is not null
   from evidence.evidence_versions where delivery_id = (select id from fixture_ids where label = 'delivery')),
  'the seal stays anchored to the hash-chained audit log'
);
select ok(
  (select count(*) = 1 from evidence.documents d
   join evidence.evidence_versions ev on ev.id = d.evidence_version_id
   where ev.delivery_id = (select id from fixture_ids where label = 'delivery')),
  'a public verification code is issued for the sealed evidence'
);

-- ===========================================================================================
-- 5. Post-seal immutability of factors and evidence
-- ===========================================================================================

-- As the TENANT, not as the owner: this suite runs as the unrestricted owner by default, and
-- an owner bypasses grants entirely -- asserting immutability without impersonating
-- `authenticated` would prove nothing about what a real caller can do.
set local role authenticated;
set local request.jwt.claims = '{"sub":"88888888-8888-8888-8888-888888888801","role":"authenticated"}';

select throws_ok(
  format($$ update app.identity_verifications set result = 'FAIL' where id = %L $$,
    (select id from fixture_ids where label = 'factor_identity')),
  '42501', NULL,
  'a factor cannot be altered after the seal (no UPDATE grant outside the RPC)'
);
select throws_ok(
  format($$ insert into app.identity_verifications (organization_id, company_id, delivery_id, confirmation_request_id, provider, method, result, achieved_assurance_level, factor_type)
     values ((select organization_id from app.companies where id = %L), %L, %L, %L, 'INTERNAL', 'LINK_KNOWLEDGE', 'PASS', 'AL1_LINK_KNOWLEDGE', 'IDENTITY_KNOWLEDGE') $$,
    (select id from fixture_ids where label = 'company_r'),
    (select id from fixture_ids where label = 'company_r'),
    (select id from fixture_ids where label = 'delivery'),
    (select id from fixture_ids where label = 'cr')),
  '42501', NULL,
  'a factor cannot be appended after the seal either'
);

reset role;

-- ===========================================================================================
-- 6. Retry / idempotency -- the consumed nonce blocks a replayed submission
-- ===========================================================================================

do $$
declare v_hash_b64 text; v_old_nonce text; v_result text;
begin
  select extra into v_hash_b64 from fixture_ids where label = 'cr';
  select encode(action_nonce, 'base64') into v_old_nonce from app.confirmation_requests where id = (select id from fixture_ids where label = 'cr');
  set local role anon;
  begin
    select result into v_result from worker.finish_confirmation(
      v_hash_b64, v_old_nonce, 'CONFIRM', true, null, null,
      '{"_canon":"epi-canon/2","fixture":"170-retry"}'::jsonb,
      (select extra from fixture_ids where label = 'canon_bytes'),
      (select extra from fixture_ids where label = 'canon_sha256'),
      clock_timestamp(), '[]'::jsonb);
  exception when others then
    v_result := 'REJECTED:' || sqlstate;
  end;
  reset role;
  insert into fixture_ids values ('retry_result', null, v_result);
end $$;

select alike(
  (select extra from fixture_ids where label = 'retry_result'),
  'REJECTED:%',
  'a replayed submission after the seal is rejected, never processed again'
);
select is(
  (select count(*)::int from app.identity_verifications where delivery_id = (select id from fixture_ids where label = 'delivery')),
  2,
  'the retry did not duplicate factors'
);
select is(
  (select count(*)::int from evidence.evidence_versions where delivery_id = (select id from fixture_ids where label = 'delivery')),
  1,
  'the retry did not duplicate the evidence version'
);

-- ===========================================================================================
-- 7. Cross-tenant
-- ===========================================================================================

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated"}';

select is(
  (select count(*)::int from api.evidence_factors where delivery_id = (select id from fixture_ids where label = 'delivery')),
  0,
  'tenant S cannot read tenant R''s evidence factors through the api view (RLS)'
);

reset role;

select * from finish();

rollback;
