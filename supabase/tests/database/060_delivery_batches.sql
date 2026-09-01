-- FASE 6 Definition of Done (mvp-roadmap.md): a batch creates every delivery/item/
-- confirmation_request in ONE set-based statement, exactly ONE audit event regardless of
-- batch size, cross-tenant isolation holds, and resend-pending-only never touches an
-- already-settled delivery. The full 5000-row load test lives in a scratchpad PGlite
-- script (too slow for a CI-facing pgTAP file) -- this proves correctness at a small,
-- fast-to-run scale; docs/mvp-roadmap.md records the load test's own result.

create extension if not exists pgtap with schema extensions;

begin;

select plan(11);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', '99999999-9999-9999-9999-999999999901',
  'authenticated', 'authenticated', 'admin-i@tenant-i.test',
  extensions.crypt('x', extensions.gen_salt('bf')), now(),
  '{}', '{"full_name":"Admin I"}', now(), now(), '', '', '', '', false, false
);

create temporary table fixture_ids (label text primary key, id uuid, extra text);
grant all on fixture_ids to authenticated, anon;

do $$
declare v_company_id uuid; v_org_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated"}', true);

  select organization_id, company_id into v_org_id, v_company_id
  from api.onboard_organization('Tenant I LTDA', '11222333000181', 'Tenant I LTDA', '11222333000181', null);
  insert into fixture_ids values ('org', v_org_id, null), ('company', v_company_id, null);

  insert into fixture_ids
    select 'epi', api.create_epi(v_org_id, v_company_id, 'Bota', '33333', null, null, null, 'UN'), null;

  reset role;
end $$;

-- 5 employees. cpf_hash_b64 precomputed into a fixture table BEFORE any role switch --
-- authenticated has no USAGE on the extensions schema (see 020/040/050 for the same
-- convention and why it matters); computing extensions.digest INSIDE the role-switched loop
-- was a real bug caught only by running this against PGlite.
create temporary table cpf_fixtures (idx int primary key, cpf_hash_b64 text);
grant all on cpf_fixtures to authenticated;
insert into cpf_fixtures
  select gs, encode(extensions.digest('cpf-batch-' || gs, 'sha256'), 'base64')
  from generate_series(1, 5) as gs;

do $$
declare v_company_id uuid; v_emp_id uuid;
begin
  select id into v_company_id from fixture_ids where label = 'company';

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated"}', true);

  for i in 1..5 loop
    select api.create_employee(
      v_company_id, 'Funcionario Lote ' || i,
      (select cpf_hash_b64 from cpf_fixtures where cpf_fixtures.idx = i),
      encode(decode(repeat('00', 28), 'hex') || ('fk' || i)::bytea, 'base64'),
      '***.666.666-**'
    ) into v_emp_id;
    insert into fixture_ids values ('employee_' || i, v_emp_id, null);
  end loop;

  reset role;
end $$;

select ok((select count(*) = 5 from fixture_ids where label like 'employee_%'), '5 employees created');

-- Build p_confirmations as superuser (needs extensions.digest for the token hashes).
do $$
declare v_confirmations jsonb := '[]'::jsonb;
begin
  for i in 1..5 loop
    v_confirmations := v_confirmations || jsonb_build_object(
      'employee_id', (select id from fixture_ids where label = 'employee_' || i),
      'token_hash_b64', encode(extensions.digest('token-batch-' || i, 'sha256'), 'base64')
    );
  end loop;
  insert into fixture_ids values ('confirmations_json', null, v_confirmations::text);
end $$;

do $$
declare v_company_id uuid; v_epi_id uuid; v_batch_id uuid; v_count int;
begin
  select id into v_company_id from fixture_ids where label = 'company';
  select id into v_epi_id from fixture_ids where label = 'epi';

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated"}', true);

  select batch_id, delivery_count into v_batch_id, v_count
  from api.create_delivery_batch(
    v_company_id,
    jsonb_build_array(jsonb_build_object('epi_id', v_epi_id, 'quantity', 1)),
    (select extra::jsonb from fixture_ids where label = 'confirmations_json'),
    current_date, 'Lote pgTAP'
  );
  reset role;

  insert into fixture_ids values ('batch', v_batch_id, v_count::text);
end $$;

select is((select extra from fixture_ids where label = 'batch')::int, 5, 'delivery_count is 5');

select is(
  (select count(*)::int from app.epi_deliveries where batch_id = (select id from fixture_ids where label = 'batch')),
  5,
  'exactly 5 epi_deliveries rows created'
);

select is(
  (select count(*)::int from app.epi_deliveries where batch_id = (select id from fixture_ids where label = 'batch') and status = 'ISSUED'),
  5,
  'all 5 deliveries are ISSUED'
);

select is(
  (select count(*)::int from app.confirmation_requests where delivery_id in (
     select id from app.epi_deliveries where batch_id = (select id from fixture_ids where label = 'batch')
   )),
  5,
  'exactly 5 confirmation_requests rows created'
);

select is(
  (select total_count from app.delivery_batches where id = (select id from fixture_ids where label = 'batch')),
  5,
  'delivery_batches.total_count is 5'
);

select is(
  (select count(*)::int from audit.audit_events where event_type = 'BATCH_CREATED' and entity_id = (select id from fixture_ids where label = 'batch')),
  1,
  'exactly ONE BATCH_CREATED audit event, not one per delivery'
);

-- Cross-tenant: a second org/user cannot create a batch for tenant I's company.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', '99999999-9999-9999-9999-999999999902',
  'authenticated', 'authenticated', 'admin-j@tenant-j.test',
  extensions.crypt('x', extensions.gen_salt('bf')), now(),
  '{}', '{"full_name":"Admin J"}', now(), now(), '', '', '', '', false, false
);
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999902","role":"authenticated"}', true);
  perform api.onboard_organization('Tenant J LTDA', '22333444000199', 'Tenant J LTDA', '22333444000199', null);
  reset role;
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999902","role":"authenticated"}';

select throws_ok(
  $$ select api.create_delivery_batch(
       (select id from fixture_ids where label = 'company'),
       jsonb_build_array(jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi'), 'quantity', 1)),
       jsonb_build_array(jsonb_build_object('employee_id', (select id from fixture_ids where label = 'employee_1'), 'token_hash_b64', 'AAAA')),
       current_date, null) $$,
  '42501',
  'tenant J cannot create a batch for tenant I''s company'
);

reset role;

-- Resend-pending-only: confirm ONE delivery via the worker path (AL0 org default would
-- simplify this, but the seeded default is AL1_LINK_KNOWLEDGE -- use identity_passed=true
-- with a trivial self-consistent evidence payload, same technique as 050's own test).
do $$
declare
  v_delivery_id uuid;
  v_token_hash bytea;
  v_nonce text;
  v_bytes bytea := '{"_canon":"epi-canon/1","x":"fixture"}'::bytea;
  v_bytes_sha256_b64 text;
begin
  -- Computed BEFORE the role switch below -- anon has no USAGE on extensions either.
  v_bytes_sha256_b64 := encode(extensions.digest(v_bytes, 'sha256'), 'base64');

  select id into v_delivery_id from app.epi_deliveries where batch_id = (select id from fixture_ids where label = 'batch') order by created_at limit 1;
  select token_hash into v_token_hash from app.confirmation_requests where delivery_id = v_delivery_id;
  insert into fixture_ids values ('first_delivery', v_delivery_id, encode(v_token_hash, 'base64'));

  set local role anon;
  select action_nonce into v_nonce from worker.open_link(encode(v_token_hash, 'base64'), null);
  perform worker.finish_confirmation(
    encode(v_token_hash, 'base64'), v_nonce, 'CONFIRM', true, null, null,
    '{"_canon":"epi-canon/1","x":"fixture"}'::jsonb,
    encode(v_bytes, 'base64'), v_bytes_sha256_b64,
    clock_timestamp()
  );
  reset role;
end $$;

select is(
  (select status::text from app.epi_deliveries where id = (select id from fixture_ids where label = 'first_delivery')),
  'CONFIRMED',
  'one delivery in the batch is now CONFIRMED'
);

-- Resend all 5 -- the confirmed one must be silently skipped, not touched.
do $$
declare
  v_resend_input jsonb := '[]'::jsonb;
  v_delivery_id uuid;
  v_touched int;
  r record;
begin
  for r in (select id from app.epi_deliveries where batch_id = (select id from fixture_ids where label = 'batch')) loop
    v_resend_input := v_resend_input || jsonb_build_object(
      'delivery_id', r.id,
      'token_hash_b64', encode(extensions.digest('resend-' || r.id::text, 'sha256'), 'base64')
    );
  end loop;

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated"}', true);
  select count(*)::int into v_touched from api.resend_batch_pending((select id from fixture_ids where label = 'batch'), v_resend_input);
  reset role;

  insert into fixture_ids values ('resend_touched', null, v_touched::text);
end $$;

select is((select extra from fixture_ids where label = 'resend_touched')::int, 4, 'resend touches exactly 4 (5 - 1 already confirmed)');

select is(
  (select count(*)::int from app.confirmation_requests
     where delivery_id = (select id from fixture_ids where label = 'first_delivery') and status = 'CONFIRMED'),
  1,
  'the confirmed delivery''s confirmation_request is untouched by the resend'
);

select * from finish();

rollback;
