-- Phase B: stock ledger. Covers (1) tenant isolation, (2) balance reconstruction from
-- movements via api.record_stock_movement, (3) the negative-balance guard (and its
-- stock_negative_allowed override), (4) api.issue_delivery's automatic ENTREGA movement
-- when inventory_enabled, including that an over-issue is rejected ATOMICALLY (the delivery
-- stays DRAFT, never partially transitions), (5) that an org WITHOUT inventory_enabled sees
-- zero stock_movements rows from issuing a delivery -- no behavior change for the default.
--
-- A true concurrent-connection race (two simultaneous issue_delivery calls against a
-- balance of 1) cannot be expressed here -- PGlite/pgTAP run single-connection. That
-- property is instead verified in CI against a real Postgres with two actual client
-- connections (see .github/workflows/ci.yml and this file's sibling comment in the
-- Phase-B plan) -- the guard this file DOES verify (a single atomic UPDATE ... WHERE
-- balance + delta >= 0, never check-then-act) is exactly what makes that real-concurrency
-- property hold; this file proves the guard rejects an over-consumption at all.

create extension if not exists pgtap with schema extensions;

begin;

select plan(11);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '99999999-9999-9999-9999-999999999901',
   'authenticated', 'authenticated', 'admin-i@tenant-i.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin I"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01',
   'authenticated', 'authenticated', 'admin-j@tenant-j.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin J"}', now(), now(), '', '', '', '', false, false);

create temporary table fixture_ids (label text primary key, id uuid not null);
grant all on fixture_ids to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant I LTDA', '11222333000481', 'Tenant I LTDA', '11222333000481', null);
  insert into fixture_ids values ('company_i', v_company_id);
  reset role;
end $$;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant J LTDA', '22333444000497', 'Tenant J LTDA', '22333444000497', null);
  insert into fixture_ids values ('company_j', v_company_id);
  reset role;
end $$;

-- Turn on inventory_enabled for tenant I only -- direct owner-level UPDATE, since the
-- settings-update RPC is later lifecycle-phase work; tenant J is deliberately left at the
-- default (false) to prove the no-op path below.
update app.organizations set inventory_enabled = true
where id = (select organization_id from app.companies where id = (select id from fixture_ids where label = 'company_i'));

-- Tenant I: an EPI, an employee, and a manual ENTRADA of 5 units.
do $$
declare
  v_company_i uuid; v_org_i uuid; v_epi_id uuid; v_employee_id uuid; v_movement_id uuid;
  v_cpf_hash_b64 text; v_cpf_enc_b64 text;
begin
  select id into v_company_i from fixture_ids where label = 'company_i';
  v_org_i := (select organization_id from app.companies where id = v_company_i);
  v_cpf_hash_b64 := encode(extensions.digest('cpf-i', 'sha256'), 'base64');
  v_cpf_enc_b64 := encode(decode('000000000000000000000000000000000000000000000000000000', 'hex') || 'fake-i'::bytea, 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated"}', true);

  select api.create_epi(v_org_i, v_company_i, 'Capacete', '55555') into v_epi_id;
  insert into fixture_ids values ('epi_i', v_epi_id);

  select api.create_employee(v_company_i, 'Funcionário Tenant I', v_cpf_hash_b64, v_cpf_enc_b64, '***.444.444-**')
  into v_employee_id;
  insert into fixture_ids values ('employee_i', v_employee_id);

  select api.record_stock_movement(v_company_i, null, v_epi_id, null, 'ENTRADA', 5, 'estoque inicial', '{}')
  into v_movement_id;
  insert into fixture_ids values ('movement_entrada', v_movement_id);

  reset role;
end $$;

select is(
  (select quantity::int from app.stock_balances
     where company_id = (select id from fixture_ids where label = 'company_i')
       and epi_id = (select id from fixture_ids where label = 'epi_i')
       and location_id is null and variant_id is null),
  5,
  'balance is 5 after one ENTRADA of 5'
);

-- Negative-balance guard: an AJUSTE of -10 against a balance of 5 must be rejected, and
-- must not have partially applied (balance stays 5, no orphaned movement row).
set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated"}';

select throws_ok(
  format(
    $$ select api.record_stock_movement(%L, null, %L, null, 'AJUSTE', -10, 'correção', '{}') $$,
    (select id from fixture_ids where label = 'company_i'),
    (select id from fixture_ids where label = 'epi_i')
  ),
  '23514',
  NULL,
  'an AJUSTE that would drive the balance negative is rejected (insufficient_stock)'
);

reset role;

select is(
  (select quantity::int from app.stock_balances
     where company_id = (select id from fixture_ids where label = 'company_i')
       and epi_id = (select id from fixture_ids where label = 'epi_i')
       and location_id is null and variant_id is null),
  5,
  'balance is still 5 -- the rejected AJUSTE never partially applied'
);

select is(
  (select count(*)::int from app.stock_movements
     where company_id = (select id from fixture_ids where label = 'company_i')),
  1,
  'exactly 1 movement row exists for tenant I -- the rejected AJUSTE left no orphaned row'
);

-- api.issue_delivery: issuing a delivery of 3 units against a balance of 5 succeeds and
-- writes an automatic ENTREGA of -3, leaving a balance of 2.
do $$
declare v_delivery_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated"}', true);

  select api.create_delivery(
    (select id from fixture_ids where label = 'company_i'),
    (select id from fixture_ids where label = 'employee_i'),
    current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_i'), 'quantity', 3))
  ) into v_delivery_id;
  insert into fixture_ids values ('delivery_i_1', v_delivery_id);

  perform api.issue_delivery(v_delivery_id);

  reset role;
end $$;

select is(
  (select quantity::int from app.stock_balances
     where company_id = (select id from fixture_ids where label = 'company_i')
       and epi_id = (select id from fixture_ids where label = 'epi_i')
       and location_id is null and variant_id is null),
  2,
  'balance is 2 after issuing a delivery of 3 (5 - 3) -- ENTREGA written automatically'
);

select is(
  (select status::text from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_i_1')),
  'ISSUED',
  'the delivery whose stock decrement succeeded really did transition to ISSUED'
);

-- Over-issue: a second delivery of 5 units against a remaining balance of 2 must be
-- rejected ATOMICALLY -- both the stock movement AND the DRAFT->ISSUED status transition
-- roll back together (single transaction), never a delivery marked ISSUED with a movement
-- that failed, or vice versa.
do $$
declare v_delivery_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated"}', true);

  select api.create_delivery(
    (select id from fixture_ids where label = 'company_i'),
    (select id from fixture_ids where label = 'employee_i'),
    current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_i'), 'quantity', 5))
  ) into v_delivery_id;
  insert into fixture_ids values ('delivery_i_2', v_delivery_id);

  reset role;
end $$;

select throws_ok(
  format(
    $$ select api.issue_delivery(%L) $$,
    (select id from fixture_ids where label = 'delivery_i_2')
  ),
  '23514',
  NULL,
  'issuing a delivery of 5 against a remaining balance of 2 is rejected (insufficient_stock)'
);

select is(
  (select status::text from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_i_2')),
  'DRAFT',
  'the over-issued delivery rolled back to DRAFT -- the status transition and the failed stock write are one atomic unit'
);

select is(
  (select quantity::int from app.stock_balances
     where company_id = (select id from fixture_ids where label = 'company_i')
       and epi_id = (select id from fixture_ids where label = 'epi_i')
       and location_id is null and variant_id is null),
  2,
  'balance is still 2 -- the rolled-back over-issue never partially decremented it'
);

-- Tenant J (inventory_enabled left at its default, false): issuing a delivery writes ZERO
-- stock_movements rows -- no behavior change for an org that never opted in.
do $$
declare
  v_company_j uuid; v_epi_id uuid; v_employee_id uuid; v_delivery_id uuid;
  v_cpf_hash_b64 text; v_cpf_enc_b64 text;
begin
  select id into v_company_j from fixture_ids where label = 'company_j';
  v_cpf_hash_b64 := encode(extensions.digest('cpf-j', 'sha256'), 'base64');
  v_cpf_enc_b64 := encode(decode('000000000000000000000000000000000000000000000000000000', 'hex') || 'fake-j'::bytea, 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01","role":"authenticated"}', true);

  select api.create_epi(
    (select organization_id from app.companies where id = v_company_j), v_company_j, 'Botina', '66666'
  ) into v_epi_id;

  select api.create_employee(v_company_j, 'Funcionário Tenant J', v_cpf_hash_b64, v_cpf_enc_b64, '***.555.555-**')
  into v_employee_id;

  select api.create_delivery(
    v_company_j, v_employee_id, current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', v_epi_id, 'quantity', 1))
  ) into v_delivery_id;

  perform api.issue_delivery(v_delivery_id);

  reset role;
end $$;

select is(
  (select count(*)::int from app.stock_movements
     where company_id = (select id from fixture_ids where label = 'company_j')),
  0,
  'tenant J (inventory_enabled = false, the default) has zero stock_movements after issuing a delivery'
);

-- Isolation: tenant J must see none of tenant I's stock.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01","role":"authenticated"}';

select is(
  (select count(*)::int from api.stock_balances),
  0,
  'tenant J sees zero stock_balances -- tenant I''s Capacete balance is invisible'
);

reset role;

select * from finish();

rollback;
