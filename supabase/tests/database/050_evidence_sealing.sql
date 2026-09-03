-- FASE 5 Definition of Done (mvp-roadmap.md): evidence sealing is atomic with confirmation,
-- the payload_sha256/canonical_bytes pair is enforced at the DB level, evidence is
-- append-only in every layer, and the public verification path discloses only the minimum.
-- Real RFC 8785 canonicalization lives in Node (src/lib/evidence/canon.ts, covered by its
-- own golden-vector Vitest suite) -- this file proves the Postgres-side mechanics with a
-- self-consistent (bytes, hash) pair, which is all the DB layer needs to be correct about.

create extension if not exists pgtap with schema extensions;

begin;

-- 16, not 15: the earlier count missed the one `perform is(...)` call inside a
-- `do $$ ... end $$` block (the real-CONFIRM-with-payload assertion below), which is a
-- real TAP assertion and counts toward the plan the same as every top-level `select`.
select plan(16);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', '88888888-8888-8888-8888-888888888801',
  'authenticated', 'authenticated', 'admin-h@tenant-h.test',
  extensions.crypt('x', extensions.gen_salt('bf')), now(),
  '{}', '{"full_name":"Admin H"}', now(), now(), '', '', '', '', false, false
);

create temporary table fixture_ids (label text primary key, id uuid, extra text);
grant all on fixture_ids to authenticated, anon;

-- extensions.digest computed BEFORE any role switch (see 040_confirmation_flow.sql).
do $$
declare v_company_id uuid; v_org_id uuid; v_cpf_hash_b64 text; v_cpf_enc_b64 text;
begin
  v_cpf_hash_b64 := encode(extensions.digest('cpf-h', 'sha256'), 'base64');
  v_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-h'::bytea, 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888801","role":"authenticated"}', true);

  select organization_id, company_id into v_org_id, v_company_id
  from api.onboard_organization('Tenant H LTDA', '11222333000181', 'Tenant H LTDA', '11222333000181', null);
  insert into fixture_ids values ('org', v_org_id, null), ('company', v_company_id, null);

  insert into fixture_ids
    select 'employee', api.create_employee(v_company_id, 'Trabalhador H',
      v_cpf_hash_b64, v_cpf_enc_b64, '***.555.555-**'), null;

  insert into fixture_ids
    select 'epi', api.create_epi(v_org_id, v_company_id, 'Capacete', '77777', null, null, null, 'UN'), null;

  reset role;
end $$;

do $$
declare v_delivery_id uuid; v_company_id uuid; v_employee_id uuid; v_epi_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888801","role":"authenticated"}', true);

  select id into v_company_id from fixture_ids where label = 'company';
  select id into v_employee_id from fixture_ids where label = 'employee';
  select id into v_epi_id from fixture_ids where label = 'epi';

  select api.create_delivery(v_company_id, v_employee_id, current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', v_epi_id, 'quantity', 1)))
  into v_delivery_id;
  perform api.issue_delivery(v_delivery_id);
  insert into fixture_ids values ('delivery', v_delivery_id, null);

  reset role;
end $$;

do $$
declare v_cr_id uuid; v_hash_b64 text;
begin
  v_hash_b64 := encode(extensions.digest('test-token-h', 'sha256'), 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888801","role":"authenticated"}', true);
  select confirmation_request_id into v_cr_id
  from api.create_confirmation_link((select id from fixture_ids where label = 'delivery'), v_hash_b64, null);
  insert into fixture_ids values ('cr', v_cr_id, v_hash_b64);
  reset role;
end $$;

select ok((select id is not null from fixture_ids where label = 'cr'), 'confirmation link created');

-- A self-consistent (bytes, hash) pair, precomputed as superuser -- anon has no USAGE on
-- extensions, so this must exist before any role switch, same as everywhere else in this file.
insert into fixture_ids values
  ('canon_bytes', null, encode('{"_canon":"epi-canon/1","x":"fixture"}'::bytea, 'base64')),
  ('canon_sha256', null, encode(extensions.digest('{"_canon":"epi-canon/1","x":"fixture"}'::bytea, 'sha256'), 'base64')),
  ('canon_sha256_wrong', null, encode(extensions.digest('not-the-same-bytes'::bytea, 'sha256'), 'base64'));

do $$
declare v_hash_b64 text; v_nonce text;
begin
  select extra into v_hash_b64 from fixture_ids where label = 'cr';
  set local role anon;
  select action_nonce into v_nonce from worker.open_link(v_hash_b64, null);
  reset role;
  insert into fixture_ids values ('nonce', null, v_nonce);
end $$;

-- CONFIRM without any of the four evidence parameters must be rejected: there is no code
-- path that reaches CONFIRMED without sealing (docs/mvp-roadmap.md FASE 5).
set local role anon;

-- NULL as the third (errmsg) arg throughout this file: pgTAP's 3-arg throws_ok(sql,
-- errcode, X) compares X against the ACTUAL raised message, not a free-text description --
-- see the longer comment above the first throws_ok() in 010_tenant_isolation.sql.
select throws_ok(
  $$ select worker.finish_confirmation(
       (select extra from fixture_ids where label = 'cr'),
       (select extra from fixture_ids where label = 'nonce'),
       'CONFIRM', true, null, null) $$,
  '23514',
  NULL,
  'CONFIRM without an evidence payload is rejected (evidence_payload_required)'
);

reset role;

-- That rejected attempt must not have consumed the nonce or changed status -- an early
-- guard-clause raise, not a partial write.
select is(
  (select status::text from app.confirmation_requests where id = (select id from fixture_ids where label = 'cr')),
  'VIEWED',
  'the rejected no-payload attempt left the confirmation_request in VIEWED, not partially advanced'
);

-- Re-open (fresh nonce, since the previous nonce was consumed by the rejected attempt's own
-- nonce-consumption step, which runs BEFORE the payload check).
do $$
declare v_hash_b64 text; v_nonce text;
begin
  select extra into v_hash_b64 from fixture_ids where label = 'cr';
  set local role anon;
  select action_nonce into v_nonce from worker.open_link(v_hash_b64, null);
  reset role;
  update fixture_ids set extra = v_nonce where label = 'nonce';
end $$;

-- Now confirm for real, with a self-consistent evidence payload.
do $$
declare v_hash_b64 text; v_nonce text; v_result text; v_code text;
begin
  select extra into v_hash_b64 from fixture_ids where label = 'cr';
  select extra into v_nonce from fixture_ids where label = 'nonce';

  set local role anon;
  select result, verification_code into v_result, v_code
  from worker.finish_confirmation(
    v_hash_b64, v_nonce, 'CONFIRM', true, null, null,
    '{"_canon":"epi-canon/1","x":"fixture"}'::jsonb,
    (select extra from fixture_ids where label = 'canon_bytes'),
    (select extra from fixture_ids where label = 'canon_sha256'),
    clock_timestamp()
  );
  reset role;

  insert into fixture_ids values ('verification_code', null, v_code);
  perform is(v_result, 'CONFIRMED', 'confirmation with a valid evidence payload succeeds');
end $$;

select ok(
  (select extra from fixture_ids where label = 'verification_code') is not null,
  'a verification_code was returned'
);

select is(
  (select length(extra) from fixture_ids where label = 'verification_code'),
  12,
  'the verification_code is exactly 12 characters'
);

select is(
  (select count(*)::int from evidence.evidence_versions where delivery_id = (select id from fixture_ids where label = 'delivery')),
  1,
  'exactly one evidence_versions row was sealed'
);

select is(
  (select count(*)::int from evidence.documents doc
     join evidence.evidence_versions ev on ev.id = doc.evidence_version_id
     where ev.delivery_id = (select id from fixture_ids where label = 'delivery')
       and doc.verification_code = (select extra from fixture_ids where label = 'verification_code')),
  1,
  'the evidence.documents row exists and matches the returned code'
);

-- The (audit_seq, audit_event_hash) binding matches the real DELIVERY_CONFIRMED event.
select is(
  (select audit_seq from evidence.evidence_versions where delivery_id = (select id from fixture_ids where label = 'delivery')),
  (select seq from audit.audit_events where event_type = 'DELIVERY_CONFIRMED' and entity_id = (select id from fixture_ids where label = 'delivery')),
  'evidence_versions.audit_seq matches the DELIVERY_CONFIRMED audit event''s own seq'
);

select is(
  (select count(*)::int from audit.audit_events where event_type = 'EVIDENCE_SEALED' and entity_id = (select id from fixture_ids where label = 'delivery')),
  1,
  'an EVIDENCE_SEALED audit event was logged'
);

-- Immutability, layer 1: no grant at all for authenticated.
set local role authenticated;
set local request.jwt.claims = '{"sub":"88888888-8888-8888-8888-888888888801","role":"authenticated"}';

select throws_ok(
  $$ update evidence.evidence_versions set sealed_at = clock_timestamp() where delivery_id = (select id from fixture_ids where label = 'delivery') $$,
  '42501',
  NULL,
  'evidence_versions has no UPDATE grant for authenticated -- fails on privilege first'
);

reset role;

-- Immutability, layer 2: as the unrestricted owner role (bypasses grants, so this actually
-- reaches the trigger, independent of the privilege layer just proven above).
select throws_ok(
  $$ update evidence.evidence_versions set sealed_at = clock_timestamp() where delivery_id = (select id from fixture_ids where label = 'delivery') $$,
  '42501',
  NULL,
  'even the owner role cannot UPDATE evidence_versions -- the append-only trigger fires regardless of grants'
);

-- CHECK constraint: a mismatched (canonical_bytes, payload_sha256) pair is rejected even for
-- the owner role, independent of the grant restriction above.
select throws_ok(
  $$ insert into evidence.evidence_versions (
       organization_id, company_id, delivery_id, confirmation_request_id, chain_id, chain_version,
       payload, canonical_bytes, payload_sha256, audit_seq, audit_event_hash, sealed_at
     ) values (
       (select id from fixture_ids where label = 'org'), (select id from fixture_ids where label = 'company'),
       (select id from fixture_ids where label = 'delivery'), (select id from fixture_ids where label = 'cr'),
       gen_random_uuid(), 99, '{}'::jsonb,
       decode((select extra from fixture_ids where label = 'canon_bytes'), 'base64'),
       decode((select extra from fixture_ids where label = 'canon_sha256_wrong'), 'base64'),
       1, extensions.digest('x', 'sha256'), clock_timestamp()
     ) $$,
  '23514',
  NULL,
  'a mismatched (canonical_bytes, payload_sha256) pair violates evidence_versions_payload_hash_ck'
);

-- Public verification: minimal disclosure, no auth. The result is captured into a fixture
-- and asserted AFTER switching back to the owner role -- is()/ok() themselves need to
-- resolve, which (like extensions.digest earlier in this file) is safest done outside a
-- restricted role, not because the assertion is about privilege.
do $$
declare v_status text;
begin
  set local role anon;
  select status into v_status from worker.verify_document((select extra from fixture_ids where label = 'verification_code'));
  reset role;
  insert into fixture_ids values ('verify_status', null, v_status);
end $$;

select is(
  (select extra from fixture_ids where label = 'verify_status'),
  'CONFIRMADO',
  'worker.verify_document resolves the real code to CONFIRMADO'
);

set local role anon;

select throws_ok(
  $$ select worker.verify_document('ZZZZZZZZZZZZ') $$,
  'P0002',
  NULL,
  'an unknown verification code returns a generic not_found, not a distinguishable error'
);

reset role;

-- Manager-facing summary matches what the worker's own code shows.
do $$
declare v_code text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888801","role":"authenticated"}', true);
  select verification_code into v_code from api.get_evidence_summary((select id from fixture_ids where label = 'delivery'));
  reset role;
  insert into fixture_ids values ('summary_code', null, v_code);
end $$;

select is(
  (select extra from fixture_ids where label = 'summary_code'),
  (select extra from fixture_ids where label = 'verification_code'),
  'api.get_evidence_summary returns the same verification_code as the sealed document'
);

reset role;

select * from finish();

rollback;
