-- FASE 3 Definition of Done (mvp-roadmap.md): the worker confirmation loop end-to-end --
-- link creation, anon open_link, CONFIRM (right and wrong identity attempts), CONTEST,
-- replay/nonce reuse rejected, cross-tenant isolation, audit trail append-only. The Node
-- layer's own CPF-decrypt-and-compare step (src/app/e/s/[id]/actions.ts) is NOT exercised
-- here -- from Postgres's side that step is just the p_identity_passed boolean parameter,
-- so pgTAP drives both outcomes directly without needing real CPF ciphertext.

create extension if not exists pgtap with schema extensions;

begin;

select plan(16);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '66666666-6666-6666-6666-666666666601',
   'authenticated', 'authenticated', 'admin-f@tenant-f.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin F"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '77777777-7777-7777-7777-777777777701',
   'authenticated', 'authenticated', 'admin-g@tenant-g.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin G"}', now(), now(), '', '', '', '', false, false);

create temporary table fixture_ids (label text primary key, id uuid, extra text);
grant all on fixture_ids to authenticated, anon;

-- extensions.digest computed BEFORE any role switch -- authenticated/anon have no USAGE on
-- the extensions schema (see the identical comment in 020_employee_isolation.sql).
do $$
declare
  v_company_id uuid; v_org_id uuid; v_cpf_hash_b64 text; v_cpf_enc_b64 text;
  v_company_id_g uuid;
begin
  v_cpf_hash_b64 := encode(extensions.digest('cpf-f', 'sha256'), 'base64');
  v_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-f'::bytea, 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666601","role":"authenticated"}', true);

  select organization_id, company_id into v_org_id, v_company_id
  from api.onboard_organization('Tenant F LTDA', '11222333000181', 'Tenant F LTDA', '11222333000181', null);
  insert into fixture_ids values ('org', v_org_id, null), ('company', v_company_id, null);

  insert into fixture_ids
    select 'employee', api.create_employee(v_company_id, 'Trabalhador F',
      v_cpf_hash_b64, v_cpf_enc_b64, '***.444.444-**'), null;

  insert into fixture_ids
    select 'epi', api.create_epi(v_org_id, v_company_id, 'Luva', '54321', null, null, null, 'UN'), null;

  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777701","role":"authenticated"}', true);
  select company_id into v_company_id_g
  from api.onboard_organization('Tenant G LTDA', '11222333000280', 'Tenant G LTDA', '11222333000280', null);
  insert into fixture_ids values ('company_g', v_company_id_g, null);
  reset role;
end $$;

-- Precomputed as superuser -- these are referenced later from throws_ok bodies that run as
-- anon, which (correctly) has no USAGE on the extensions schema.
insert into fixture_ids values
  ('unknown_hash', null, encode(extensions.digest('does-not-exist', 'sha256'), 'base64')),
  ('cross_tenant_hash', null, encode(extensions.digest('cross-tenant', 'sha256'), 'base64'));

select ok((select count(*) = 7 from fixture_ids), 'org/company/employee/epi/company_g/unknown_hash/cross_tenant_hash fixtures created');

-- Create + issue two deliveries (one for the CONFIRM path, one for CONTEST) as tenant F.
do $$
declare v_delivery_id uuid; v_delivery_id2 uuid; v_company_id uuid; v_employee_id uuid; v_epi_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666601","role":"authenticated"}', true);

  select id into v_company_id from fixture_ids where label = 'company';
  select id into v_employee_id from fixture_ids where label = 'employee';
  select id into v_epi_id from fixture_ids where label = 'epi';

  select api.create_delivery(v_company_id, v_employee_id, current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', v_epi_id, 'quantity', 2)))
  into v_delivery_id;
  perform api.issue_delivery(v_delivery_id);
  insert into fixture_ids values ('delivery', v_delivery_id, null);

  select api.create_delivery(v_company_id, v_employee_id, current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', v_epi_id, 'quantity', 1)))
  into v_delivery_id2;
  perform api.issue_delivery(v_delivery_id2);
  insert into fixture_ids values ('delivery2', v_delivery_id2, null);

  reset role;
end $$;

-- Manager (tenant F) creates a confirmation link for the first delivery.
do $$
declare v_cr_id uuid; v_hash_b64 text;
begin
  v_hash_b64 := encode(extensions.digest('test-token-1', 'sha256'), 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666601","role":"authenticated"}', true);

  select confirmation_request_id into v_cr_id
  from api.create_confirmation_link((select id from fixture_ids where label = 'delivery'), v_hash_b64, null);
  insert into fixture_ids values ('cr', v_cr_id, v_hash_b64);

  reset role;
end $$;

select ok((select id is not null from fixture_ids where label = 'cr'), 'manager creates a confirmation_request for the ISSUED delivery');

-- Cross-tenant: tenant G cannot create a confirmation link for tenant F's delivery.
set local role authenticated;
set local request.jwt.claims = '{"sub":"77777777-7777-7777-7777-777777777701","role":"authenticated"}';

select throws_ok(
  $$ select api.create_confirmation_link(
       (select id from fixture_ids where label = 'delivery2'),
       (select extra from fixture_ids where label = 'cross_tenant_hash'), null) $$,
  '42501',
  'tenant G cannot create a confirmation link for tenant F''s delivery'
);

reset role;

-- anon cannot read app.confirmation_requests directly (no grant at all).
set local role anon;

select throws_ok(
  $$ select 1 from app.confirmation_requests limit 1 $$,
  '42501',
  'anon has no grant to read app.confirmation_requests directly'
);

-- A nonexistent token hash gets the generic link_not_available response.
select throws_ok(
  $$ select worker.open_link((select extra from fixture_ids where label = 'unknown_hash'), null) $$,
  'P0002',
  'an unknown token hash returns the generic link_not_available error'
);

reset role;

-- anon opens the real link: SENT -> VIEWED. Passes a real IP (audit finding OBS-01: this
-- was `null` before) rather than issuing a SEPARATE open_link call for that -- open_link
-- reissues action_nonce on every call, viewed or not, and every later step in this file
-- (identity attempts, CONFIRM, CONTEST) submits against the ONE nonce captured here into
-- the 'nonce' fixture; a second call in between would silently invalidate it and fail
-- every one of those with stale_submission, for reasons that would have nothing to do
-- with whatever they actually test.
do $$
declare v_hash_b64 text; v_status text; v_nonce text;
begin
  select extra into v_hash_b64 from fixture_ids where label = 'cr';

  set local role anon;
  select view_status, action_nonce into v_status, v_nonce from worker.open_link(v_hash_b64, '203.0.113.7'::inet);
  reset role;

  insert into fixture_ids values ('nonce', null, v_nonce);
  perform is(v_status, 'VIEWED', 'worker.open_link transitions SENT -> VIEWED');
end $$;

select is(
  (select status::text from app.confirmation_requests where id = (select id from fixture_ids where label = 'cr')),
  'VIEWED',
  'confirmation_requests row is VIEWED after the anon open_link call'
);

select is(
  (
    select data->>'client_ip'
    from audit.audit_events
    where entity_id = (select id from fixture_ids where label = 'cr') and event_type = 'LINK_VIEWED'
    order by seq desc limit 1
  ),
  '203.0.113.7',
  'the most recent LINK_VIEWED event carries the client IP it was opened from'
);

-- Wrong identity attempt: returns normally (not an exception) with IDENTITY_MISMATCH, and
-- persists the IDENTITY_FAILED transition + incremented attempt count -- this is the exact
-- bug class fixed during local PGlite testing (an uncaught RAISE would have rolled the
-- update back).
do $$
declare v_hash_b64 text; v_nonce text; v_result text;
begin
  select extra into v_hash_b64 from fixture_ids where label = 'cr';
  select extra into v_nonce from fixture_ids where label = 'nonce';

  set local role anon;
  select result into v_result from worker.finish_confirmation(v_hash_b64, v_nonce, 'CONFIRM', false, null, null);
  reset role;

  perform is(v_result, 'IDENTITY_MISMATCH', 'a wrong identity attempt returns IDENTITY_MISMATCH, not an exception');
end $$;

select is(
  (select status::text from app.confirmation_requests where id = (select id from fixture_ids where label = 'cr')),
  'IDENTITY_FAILED',
  'the IDENTITY_FAILED transition actually persisted (survives the function returning)'
);

select is(
  (select identity_attempts from app.confirmation_requests where id = (select id from fixture_ids where label = 'cr')),
  1::smallint,
  'identity_attempts incremented to 1'
);

-- Replaying the SAME (now-consumed) nonce fails.
set local role anon;

select throws_ok(
  $$ select worker.finish_confirmation(
       (select extra from fixture_ids where label = 'cr'),
       (select extra from fixture_ids where label = 'nonce'),
       'CONFIRM', false, null, null) $$,
  '40001',
  'replaying a consumed nonce is rejected as a stale submission'
);

reset role;

-- Re-open to get a fresh nonce, then confirm for real.
do $$
declare v_hash_b64 text; v_nonce text; v_result text;
begin
  select extra into v_hash_b64 from fixture_ids where label = 'cr';

  set local role anon;
  select action_nonce into v_nonce from worker.open_link(v_hash_b64, null);
  select result into v_result from worker.finish_confirmation(v_hash_b64, v_nonce, 'CONFIRM', true, null, null);
  reset role;

  update fixture_ids set extra = v_nonce where label = 'nonce';
  perform is(v_result, 'CONFIRMED', 'a correct identity attempt confirms the delivery');
end $$;

select is(
  (select status::text from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery')),
  'CONFIRMED',
  'epi_deliveries reaches CONFIRMED via the worker RPC (REQUEST_CONFIRMED edge)'
);

select ok(
  (select frozen_at is not null from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery')),
  'the delivery is frozen once CONFIRMED'
);

select is(
  (select count(*)::int from app.identity_verifications where delivery_id = (select id from fixture_ids where label = 'delivery')),
  1,
  'exactly one identity_verifications row was recorded'
);

-- A second confirm attempt on the same (now-settled) confirmation_request must fail.
set local role anon;

select throws_ok(
  $$ select worker.finish_confirmation(
       (select extra from fixture_ids where label = 'cr'),
       (select extra from fixture_ids where label = 'nonce'),
       'CONFIRM', true, null, null) $$,
  'P0002',
  'a second confirm attempt on an already-CONFIRMED row is rejected'
);

reset role;

-- Contest path on the second delivery: never counts as a confirmation.
do $$
declare v_cr_id uuid; v_hash_b64 text; v_nonce text; v_result text;
begin
  v_hash_b64 := encode(extensions.digest('test-token-2', 'sha256'), 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666601","role":"authenticated"}', true);
  select confirmation_request_id into v_cr_id
  from api.create_confirmation_link((select id from fixture_ids where label = 'delivery2'), v_hash_b64, null);
  insert into fixture_ids values ('cr2', v_cr_id, v_hash_b64);
  reset role;

  set local role anon;
  select action_nonce into v_nonce from worker.open_link(v_hash_b64, null);
  select result into v_result from worker.finish_confirmation(v_hash_b64, v_nonce, 'CONTEST', null, 'NOT_RECEIVED', 'não recebi nada');
  reset role;

  perform is(v_result, 'CONTESTED', 'the contest path returns CONTESTED');
end $$;

select is(
  (select count(*)::int from app.identity_verifications where delivery_id = (select id from fixture_ids where label = 'delivery2')),
  0,
  'a contest never creates an identity_verifications row'
);

-- Audit trail is append-only even from an authenticated connection: no grant exists at all.
set local role authenticated;
set local request.jwt.claims = '{"sub":"66666666-6666-6666-6666-666666666601","role":"authenticated"}';

select throws_ok(
  $$ update audit.audit_events set event_type = 'HACKED' where organization_id = (select id from fixture_ids where label = 'org') $$,
  '42501',
  'authenticated has no UPDATE grant on audit.audit_events at all'
);

reset role;

select * from finish();

rollback;
