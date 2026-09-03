-- EPI returns (devolução): per-item, manager-recorded only -- see the migration's own
-- header comment (20260831200900_epi_returns.sql) for the two product decisions this
-- shape follows. Proves: the RPC's guards (permission, delivery must be CONFIRMED, reason
-- code, one-return-per-item), that the return is actually readable back via api.epi_returns
-- and via the delivery's own audit timeline (the bug that migration's own second half
-- fixed), and cross-tenant isolation, following this whole suite's own convention: every
-- permission-denial proof here is cross-tenant, matching every other file, not a same-
-- tenant role downgrade.
--
-- Every throws_ok() below passes NULL as the third (errmsg) argument on purpose -- see the
-- long comment above the first throws_ok() in 010_tenant_isolation.sql for why: pgTAP's
-- 3-argument form compares that slot against the LITERAL raised message, not a free-text
-- description.

create extension if not exists pgtap with schema extensions;

begin;

select plan(14);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01',
   'authenticated', 'authenticated', 'admin-k@tenant-k.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin K"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01',
   'authenticated', 'authenticated', 'admin-l@tenant-l.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin L"}', now(), now(), '', '', '', '', false, false);

create temporary table fixture_ids (label text primary key, id uuid, extra text);
grant all on fixture_ids to authenticated, anon;

-- extensions.digest computed BEFORE any role switch -- authenticated has no USAGE on the
-- extensions schema (see the identical comment in 020_employee_isolation.sql).
do $$
declare
  v_company_id uuid; v_org_id uuid; v_cpf_hash_b64 text; v_cpf_enc_b64 text;
  v_company_id_l uuid;
begin
  v_cpf_hash_b64 := encode(extensions.digest('cpf-k', 'sha256'), 'base64');
  v_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-k'::bytea, 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01","role":"authenticated"}', true);

  select organization_id, company_id into v_org_id, v_company_id
  from api.onboard_organization('Tenant K LTDA', '11222333000181', 'Tenant K LTDA', '11222333000181', null);
  insert into fixture_ids values ('org', v_org_id, null), ('company', v_company_id, null);

  insert into fixture_ids
    select 'employee', api.create_employee(v_company_id, 'Trabalhador K',
      v_cpf_hash_b64, v_cpf_enc_b64, '***.666.666-**'), null;

  insert into fixture_ids
    select 'epi', api.create_epi(v_org_id, v_company_id, 'Luva nitrílica', '65432', null, null, null, 'UN'), null;

  reset role;

  -- Tenant L: exists only to prove cross-tenant isolation below, no employee/epi/delivery
  -- of its own needed.
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01","role":"authenticated"}', true);
  select company_id into v_company_id_l
  from api.onboard_organization('Tenant L LTDA', '11222333000280', 'Tenant L LTDA', '11222333000280', null);
  insert into fixture_ids values ('company_l', v_company_id_l, null);
  reset role;
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01","role":"authenticated"}';

select ok((select count(*) = 5 from fixture_ids), 'org/company/employee/epi/company_l fixtures created');

-- Create + issue a delivery, capture the delivery id AND its one item id (RPC return
-- values cannot feed directly into a later pgTAP call in the same statement).
do $$
declare v_delivery_id uuid; v_item_id uuid; v_company_id uuid; v_employee_id uuid; v_epi_id uuid;
begin
  select id into v_company_id from fixture_ids where label = 'company';
  select id into v_employee_id from fixture_ids where label = 'employee';
  select id into v_epi_id from fixture_ids where label = 'epi';

  select api.create_delivery(v_company_id, v_employee_id, current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', v_epi_id, 'quantity', 2)))
  into v_delivery_id;
  perform api.issue_delivery(v_delivery_id);
  insert into fixture_ids values ('delivery', v_delivery_id, null);

  select id into v_item_id from app.epi_delivery_items where delivery_id = v_delivery_id;
  insert into fixture_ids values ('item', v_item_id, null);
end $$;

-- An item on a merely-ISSUED (not yet CONFIRMED) delivery cannot be returned.
select throws_ok(
  $$ select api.return_epi_item(
       (select id from fixture_ids where label = 'item'), current_date, 'WORN_OUT', null
     ) $$,
  '23514',
  NULL,
  'an item on a delivery that is not yet CONFIRMED cannot be returned'
);

-- Bring the delivery to CONFIRMED via the real worker flow -- same self-consistent evidence
-- payload pattern as 050_evidence_sealing.sql.
insert into fixture_ids values
  ('canon_bytes', null, encode('{"_canon":"epi-canon/1","x":"fixture-070"}'::bytea, 'base64')),
  ('canon_sha256', null, encode(extensions.digest('{"_canon":"epi-canon/1","x":"fixture-070"}'::bytea, 'sha256'), 'base64'));

do $$
declare v_cr_id uuid; v_hash_b64 text; v_nonce text; v_result text;
begin
  v_hash_b64 := encode(extensions.digest('test-token-070', 'sha256'), 'base64');

  select confirmation_request_id into v_cr_id
  from api.create_confirmation_link((select id from fixture_ids where label = 'delivery'), v_hash_b64, null);
  insert into fixture_ids values ('cr', v_cr_id, v_hash_b64);

  set local role anon;
  select action_nonce into v_nonce from worker.open_link(v_hash_b64, null);
  select result into v_result from worker.finish_confirmation(
    v_hash_b64, v_nonce, 'CONFIRM', true, null, null,
    '{"_canon":"epi-canon/1","x":"fixture-070"}'::jsonb,
    (select extra from fixture_ids where label = 'canon_bytes'),
    (select extra from fixture_ids where label = 'canon_sha256'),
    clock_timestamp()
  );
  reset role;

  insert into fixture_ids values ('confirm_result', null, v_result);
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01","role":"authenticated"}';

select is(
  (select extra from fixture_ids where label = 'confirm_result'),
  'CONFIRMED',
  'the delivery reaches CONFIRMED (return_epi_item''s own precondition)'
);

-- OTHER without a note (< 3 chars after trimming) is rejected before any row is written.
select throws_ok(
  $$ select api.return_epi_item(
       (select id from fixture_ids where label = 'item'), current_date, 'OTHER', null
     ) $$,
  '23514',
  NULL,
  'reason_code OTHER without a note is rejected'
);

-- Tenant L cannot return tenant K's item: has delivery.return on its OWN company, but
-- auth_ctx.has_permission is checked against the ITEM's real owning company, not the
-- caller's.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01","role":"authenticated"}', true);
end $$;

select throws_ok(
  $$ select api.return_epi_item(
       (select id from fixture_ids where label = 'item'), current_date, 'WORN_OUT', null
     ) $$,
  '42501',
  NULL,
  'tenant L cannot return tenant K''s item'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01","role":"authenticated"}';

-- The real, valid return.
do $$
declare v_return_id uuid;
begin
  select api.return_epi_item(
    (select id from fixture_ids where label = 'item'), current_date, 'WORN_OUT', null
  ) into v_return_id;
  insert into fixture_ids values ('return', v_return_id, null);
end $$;

select ok(
  (select id is not null from fixture_ids where label = 'return'),
  'a valid return on a CONFIRMED item''s line succeeds'
);

select is(
  (select reason_code from api.epi_returns where id = (select id from fixture_ids where label = 'return')),
  'WORN_OUT',
  'the return is readable back via api.epi_returns with the right reason_code'
);

select is(
  (select delivery_item_id from api.epi_returns where id = (select id from fixture_ids where label = 'return')),
  (select id from fixture_ids where label = 'item'),
  'the return is linked to the correct delivery_item_id'
);

-- Returning the same item a second time is rejected -- one return per item, v1.
select throws_ok(
  $$ select api.return_epi_item(
       (select id from fixture_ids where label = 'item'), current_date, 'REPLACED', null
     ) $$,
  '23505',
  NULL,
  'returning the same item a second time is rejected as already_returned'
);

-- EPI_RETURNED shows up in the delivery's own audit timeline -- proves the
-- delivery_audit_events fix in the migration (entity_table 'epi_delivery_items' used to be
-- grouped under the confirmation_requests id subquery, so it could never have matched).
select is(
  (
    select count(*)::int from api.delivery_audit_events((select id from fixture_ids where label = 'delivery'))
    where event_type = 'EPI_RETURNED'
  ),
  1,
  'EPI_RETURNED appears exactly once in the delivery''s own audit timeline'
);

select is(
  (
    select (data->>'reason_code')
    from api.delivery_audit_events((select id from fixture_ids where label = 'delivery'))
    where event_type = 'EPI_RETURNED'
  ),
  'WORN_OUT',
  'the EPI_RETURNED audit event carries the reason_code it was recorded with'
);

-- authenticated has no direct write grant on app.epi_returns at all -- RPC-only, same
-- shape as every other write-guarded table in this schema.
select throws_ok(
  $$ insert into app.epi_returns (
       organization_id, company_id, delivery_id, delivery_item_id, returned_on, reason_code, created_by
     ) values (
       (select id from fixture_ids where label = 'org'), (select id from fixture_ids where label = 'company'),
       (select id from fixture_ids where label = 'delivery'), (select id from fixture_ids where label = 'item'),
       current_date, 'WORN_OUT', (select auth.uid())
     ) $$,
  '42501',
  NULL,
  'authenticated cannot INSERT into app.epi_returns directly (RPC-only)'
);

-- Tenant L cannot see tenant K's return via api.epi_returns either (RLS SELECT policy,
-- gated by delivery.read on the return's own company).
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01","role":"authenticated"}', true);
end $$;

select is(
  (select count(*)::int from api.epi_returns where id = (select id from fixture_ids where label = 'return')),
  0,
  'tenant L sees zero rows for tenant K''s return via api.epi_returns'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01","role":"authenticated"}';

select is(
  (select count(*)::int from api.epi_returns where id = (select id from fixture_ids where label = 'return')),
  1,
  'tenant K sees exactly its own return via api.epi_returns'
);

select * from finish();

rollback;
