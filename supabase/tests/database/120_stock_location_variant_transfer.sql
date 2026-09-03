-- Phase B closure-gate test: the three gaps fixed in 20260903130000 --
-- (1) stock balance is genuinely independent per LOCATION and per VARIANT (Botina 40 != 41,
--     Lisboa != Porto), and api.issue_delivery/api.return_epi_item actually consume/restock
--     the EMPLOYEE'S OWN location rather than a single company-wide bucket;
-- (2) api.transfer_stock atomically moves stock between two locations, including that an
--     insufficient source balance rolls back BOTH sides, never crediting the destination
--     without debiting the source;
-- (3) idempotency: retrying api.issue_delivery on an already-ISSUED delivery, and retrying
--     api.return_epi_item on an already-returned item, are both rejected -- never a second
--     stock movement, never a duplicate return row.

create extension if not exists pgtap with schema extensions;

begin;

select plan(16);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', 'dddddddd-dddd-dddd-dddd-dddddddddd01',
  'authenticated', 'authenticated', 'admin-m@tenant-m.test',
  extensions.crypt('x', extensions.gen_salt('bf')), now(),
  '{}', '{"full_name":"Admin M"}', now(), now(), '', '', '', '', false, false
);

create temporary table fixture_ids (label text primary key, id uuid not null);
grant all on fixture_ids to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant M LTDA', '11222333000682', 'Tenant M LTDA', '11222333000682', null);
  insert into fixture_ids values ('company_m', v_company_id);
  reset role;
end $$;

update app.organizations set inventory_enabled = true
where id = (select organization_id from app.companies where id = (select id from fixture_ids where label = 'company_m'));

-- Two locations, one EPI with two variants, an employee assigned to Lisboa, entrada into
-- both variants at Lisboa only.
do $$
declare
  v_company_m uuid; v_org_m uuid; v_lisboa uuid; v_porto uuid;
  v_epi_id uuid; v_variant_40 uuid; v_variant_41 uuid; v_employee_id uuid;
  v_cpf_hash_b64 text; v_cpf_enc_b64 text;
begin
  select id into v_company_m from fixture_ids where label = 'company_m';
  v_org_m := (select organization_id from app.companies where id = v_company_m);
  v_cpf_hash_b64 := encode(extensions.digest('cpf-m', 'sha256'), 'base64');
  v_cpf_enc_b64 := encode(decode('000000000000000000000000000000000000000000000000000000', 'hex') || 'fake-m'::bytea, 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);

  select api.create_location(v_company_m, 'Lisboa', 'LIS', '{}') into v_lisboa;
  select api.create_location(v_company_m, 'Porto', 'PRT', '{}') into v_porto;
  insert into fixture_ids values ('loc_lisboa', v_lisboa), ('loc_porto', v_porto);

  select api.create_epi(v_org_m, v_company_m, 'Botina', '88888') into v_epi_id;
  insert into fixture_ids values ('epi_m', v_epi_id);
  select api.create_epi_variant(v_epi_id, '40', null, '{}') into v_variant_40;
  select api.create_epi_variant(v_epi_id, '41', null, '{}') into v_variant_41;
  insert into fixture_ids values ('variant_40', v_variant_40), ('variant_41', v_variant_41);

  perform api.record_stock_movement(v_company_m, v_lisboa, v_epi_id, v_variant_40, 'ENTRADA', 5, 'estoque inicial', '{}');
  perform api.record_stock_movement(v_company_m, v_lisboa, v_epi_id, v_variant_41, 'ENTRADA', 1, 'estoque inicial', '{}');

  select api.create_employee(v_company_m, 'João Silva', v_cpf_hash_b64, v_cpf_enc_b64, '***.777.777-**')
  into v_employee_id;
  insert into fixture_ids values ('employee_m', v_employee_id);

  reset role;
end $$;

-- João has no location_id yet (create_employee doesn't take one) -- assign it directly.
update app.employees set location_id = (select id from fixture_ids where label = 'loc_lisboa')
where id = (select id from fixture_ids where label = 'employee_m');

select is(
  (select quantity::int from app.stock_balances where company_id = (select id from fixture_ids where label = 'company_m')
     and location_id = (select id from fixture_ids where label = 'loc_lisboa') and epi_id = (select id from fixture_ids where label = 'epi_m') and variant_id = (select id from fixture_ids where label = 'variant_40')),
  5,
  'Lisboa/Botina 40 balance is 5'
);
select is(
  (select quantity::int from app.stock_balances where company_id = (select id from fixture_ids where label = 'company_m')
     and location_id = (select id from fixture_ids where label = 'loc_lisboa') and epi_id = (select id from fixture_ids where label = 'epi_m') and variant_id = (select id from fixture_ids where label = 'variant_41')),
  1,
  'Lisboa/Botina 41 balance is 1 -- independent from Botina 40''s 5'
);
select is(
  (select count(*)::int from app.stock_balances where location_id = (select id from fixture_ids where label = 'loc_porto')),
  0,
  'Porto has zero balances -- nothing was ever entered there'
);

-- Deliver Botina 41 to João (assigned to Lisboa): must decrement LISBOA's Botina-41
-- balance specifically, leaving Botina-40 and Porto untouched.
do $$
declare v_delivery_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);

  select api.create_delivery(
    (select id from fixture_ids where label = 'company_m'),
    (select id from fixture_ids where label = 'employee_m'),
    current_date, null,
    jsonb_build_array(jsonb_build_object(
      'epi_id', (select id from fixture_ids where label = 'epi_m'), 'quantity', 1,
      'variant_id', (select id from fixture_ids where label = 'variant_41')
    ))
  ) into v_delivery_id;
  insert into fixture_ids values ('delivery_m1', v_delivery_id);

  perform api.issue_delivery(v_delivery_id);

  reset role;
end $$;

select is(
  (select quantity::int from app.stock_balances where company_id = (select id from fixture_ids where label = 'company_m')
     and location_id = (select id from fixture_ids where label = 'loc_lisboa') and epi_id = (select id from fixture_ids where label = 'epi_m') and variant_id = (select id from fixture_ids where label = 'variant_41')),
  0,
  'after delivering 1x Botina-41 to João (Lisboa), Lisboa/41 balance drops to 0 -- issue_delivery consumed the EMPLOYEE''S OWN location, not a company-wide bucket'
);
select is(
  (select quantity::int from app.stock_balances where company_id = (select id from fixture_ids where label = 'company_m')
     and location_id = (select id from fixture_ids where label = 'loc_lisboa') and epi_id = (select id from fixture_ids where label = 'epi_m') and variant_id = (select id from fixture_ids where label = 'variant_40')),
  5,
  'Lisboa/Botina 40 balance is untouched (still 5) -- the delivery only affected the 41 variant'
);

-- Idempotency #1: retrying issue_delivery on the now-ISSUED delivery must be rejected, and
-- must NOT write a second ENTREGA movement.
select throws_ok(
  format($$ select api.issue_delivery(%L) $$, (select id from fixture_ids where label = 'delivery_m1')),
  '23514',
  NULL,
  'retrying issue_delivery on an already-ISSUED delivery is rejected (delivery_not_draft)'
);
select is(
  (select count(*)::int from app.stock_movements where movement_type = 'ENTREGA'
     and reference_delivery_item_id in (select id from app.epi_delivery_items where delivery_id = (select id from fixture_ids where label = 'delivery_m1'))),
  1,
  'exactly 1 ENTREGA movement exists for this delivery''s item -- the rejected retry never wrote a second one'
);

-- transfer_stock: move 2 units of Botina-40 from Lisboa to Porto.
do $$
declare v_transfer_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);
  select api.transfer_stock(
    (select id from fixture_ids where label = 'company_m'),
    (select id from fixture_ids where label = 'loc_lisboa'),
    (select id from fixture_ids where label = 'loc_porto'),
    (select id from fixture_ids where label = 'epi_m'),
    (select id from fixture_ids where label = 'variant_40'),
    2, 'redistribuição'
  ) into v_transfer_id;
  reset role;
end $$;

select is(
  (select quantity::int from app.stock_balances where company_id = (select id from fixture_ids where label = 'company_m')
     and location_id = (select id from fixture_ids where label = 'loc_lisboa') and epi_id = (select id from fixture_ids where label = 'epi_m') and variant_id = (select id from fixture_ids where label = 'variant_40')),
  3,
  'after transferring 2 units, Lisboa/Botina 40 drops from 5 to 3'
);
select is(
  (select quantity::int from app.stock_balances where company_id = (select id from fixture_ids where label = 'company_m')
     and location_id = (select id from fixture_ids where label = 'loc_porto') and epi_id = (select id from fixture_ids where label = 'epi_m') and variant_id = (select id from fixture_ids where label = 'variant_40')),
  2,
  'and Porto/Botina 40 is credited with exactly those 2 units'
);

-- Insufficient-source transfer: Porto has only 2 units of Botina-40; try to move 10 to
-- Lisboa. Must reject and leave BOTH sides untouched (neither debited nor credited).
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}';

select throws_ok(
  format(
    $$ select api.transfer_stock(%L, %L, %L, %L, %L, 10, null) $$,
    (select id from fixture_ids where label = 'company_m'),
    (select id from fixture_ids where label = 'loc_porto'),
    (select id from fixture_ids where label = 'loc_lisboa'),
    (select id from fixture_ids where label = 'epi_m'),
    (select id from fixture_ids where label = 'variant_40')
  ),
  '23514',
  NULL,
  'a transfer exceeding the source location''s balance is rejected (insufficient_stock)'
);

reset role;

select is(
  (select quantity::int from app.stock_balances where company_id = (select id from fixture_ids where label = 'company_m')
     and location_id = (select id from fixture_ids where label = 'loc_porto') and epi_id = (select id from fixture_ids where label = 'epi_m') and variant_id = (select id from fixture_ids where label = 'variant_40')),
  2,
  'Porto/Botina 40 is still 2 -- the rejected transfer''s SAIDA side never applied'
);
select is(
  (select quantity::int from app.stock_balances where company_id = (select id from fixture_ids where label = 'company_m')
     and location_id = (select id from fixture_ids where label = 'loc_lisboa') and epi_id = (select id from fixture_ids where label = 'epi_m') and variant_id = (select id from fixture_ids where label = 'variant_40')),
  3,
  'Lisboa/Botina 40 is still 3 -- the rejected transfer''s ENTRADA side never applied either (no lopsided credit)'
);

-- DESCARTE: discard the 1 remaining Botina-41 unit... there is none (0 balance) -- discard
-- 1 unit of Botina-40 at Lisboa instead (3 -> 2), a straightforward manual outbound movement.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);
  perform api.record_stock_movement(
    (select id from fixture_ids where label = 'company_m'),
    (select id from fixture_ids where label = 'loc_lisboa'),
    (select id from fixture_ids where label = 'epi_m'),
    (select id from fixture_ids where label = 'variant_40'),
    'DESCARTE', 1, 'unidade danificada', '{}'
  );
  reset role;
end $$;

select is(
  (select quantity::int from app.stock_balances where company_id = (select id from fixture_ids where label = 'company_m')
     and location_id = (select id from fixture_ids where label = 'loc_lisboa') and epi_id = (select id from fixture_ids where label = 'epi_m') and variant_id = (select id from fixture_ids where label = 'variant_40')),
  2,
  'DESCARTE of 1 unit drops Lisboa/Botina 40 from 3 to 2'
);

-- Idempotency #2: confirm delivery_m1 (direct fixture, bypassing the worker flow -- same
-- technique as 110_epi_lifecycle_troca.sql), record a REUSABLE return, then retry the SAME
-- return -- must be rejected (already_returned), never a duplicate epi_returns row or a
-- second DEVOLUCAO movement.
select set_config('app.transition_ok', (select id::text from fixture_ids where label = 'delivery_m1'), true);
update app.epi_deliveries
set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = clock_timestamp(), frozen_at = clock_timestamp()
where id = (select id from fixture_ids where label = 'delivery_m1');

do $$
declare v_item_id uuid;
begin
  select id into v_item_id from app.epi_delivery_items where delivery_id = (select id from fixture_ids where label = 'delivery_m1');
  insert into fixture_ids values ('delivery_m1_item', v_item_id);
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}';

do $$
begin
  perform api.return_epi_item(
    (select id from fixture_ids where label = 'delivery_m1_item'),
    current_date, 'WORN_OUT', null, 'REUSABLE'
  );
end $$;

select is(
  (select quantity::int from app.stock_balances where company_id = (select id from fixture_ids where label = 'company_m')
     and location_id = (select id from fixture_ids where label = 'loc_lisboa') and epi_id = (select id from fixture_ids where label = 'epi_m') and variant_id = (select id from fixture_ids where label = 'variant_41')),
  1,
  'REUSABLE return credits Lisboa/Botina 41 back from 0 to 1 -- the employee''s own location, matching where it was issued from'
);

select throws_ok(
  format($$ select api.return_epi_item(%L, current_date, 'WORN_OUT', null, 'REUSABLE') $$, (select id from fixture_ids where label = 'delivery_m1_item')),
  '23505',
  NULL,
  'retrying return_epi_item on the same item is rejected (already_returned)'
);

reset role;

select is(
  (select count(*)::int from app.epi_returns where delivery_item_id = (select id from fixture_ids where label = 'delivery_m1_item')),
  1,
  'exactly 1 return row exists -- the rejected retry never created a duplicate'
);

select * from finish();

rollback;
