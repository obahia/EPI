-- Blocker 3 (closure-audit follow-up): explicit cross-tenant tests for the two RPCs that
-- had no dedicated isolation test yet -- api.create_replacement_delivery and
-- api.update_organization_policy. Both already use the same has_permission/org-wide-admin
-- guard pattern as every other RPC in this codebase (already proven safe elsewhere), but
-- per the closure audit's own rule, "the same pattern elsewhere" is not a substitute for a
-- dedicated test on THESE specific RPCs -- this file is that test, plus the happy path for
-- each (proving the guard didn't make the RPC unusable for its rightful owner).

create extension if not exists pgtap with schema extensions;

begin;

select plan(10);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a101',
   'authenticated', 'authenticated', 'admin-p@tenant-p.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin P"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b202',
   'authenticated', 'authenticated', 'admin-q@tenant-q.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin Q"}', now(), now(), '', '', '', '', false, false);

create temporary table fixture_ids (label text primary key, id uuid not null);
grant all on fixture_ids to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a101","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant P LTDA', '11222333000991', 'Tenant P LTDA', '11222333000991', null);
  insert into fixture_ids values ('company_p', v_company_id);
  reset role;
end $$;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b202","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant Q LTDA', '22333444000497', 'Tenant Q LTDA', '22333444000497', null);
  insert into fixture_ids values ('company_q', v_company_id);
  reset role;
end $$;

-- Tenant P: an EPI, an employee, a delivery -- issued and confirmed (direct fixture, same
-- technique as 110_epi_lifecycle_troca.sql -- bypasses the worker OTP flow, not the RPC
-- under test here).
do $$
declare
  v_company_p uuid; v_org_p uuid; v_epi_id uuid; v_employee_id uuid; v_delivery_id uuid;
  v_cpf_hash_b64 text; v_cpf_enc_b64 text;
begin
  select id into v_company_p from fixture_ids where label = 'company_p';
  v_org_p := (select organization_id from app.companies where id = v_company_p);
  v_cpf_hash_b64 := encode(extensions.digest('cpf-p', 'sha256'), 'base64');
  v_cpf_enc_b64 := encode(decode('000000000000000000000000000000000000000000000000000000', 'hex') || 'fake-p'::bytea, 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a101","role":"authenticated"}', true);

  select api.create_epi(v_org_p, v_company_p, 'Capacete P', '31415') into v_epi_id;
  insert into fixture_ids values ('epi_p', v_epi_id);

  select api.create_employee(v_company_p, 'Funcionário Tenant P', v_cpf_hash_b64, v_cpf_enc_b64, '***.222.333-**')
  into v_employee_id;
  insert into fixture_ids values ('employee_p', v_employee_id);

  select api.create_delivery(
    v_company_p, v_employee_id, current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', v_epi_id, 'quantity', 1))
  ) into v_delivery_id;
  insert into fixture_ids values ('delivery_p', v_delivery_id);

  perform api.issue_delivery(v_delivery_id);

  reset role;
end $$;

select set_config('app.transition_ok', (select id::text from fixture_ids where label = 'delivery_p'), true);
update app.epi_deliveries
set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = clock_timestamp(), frozen_at = clock_timestamp()
where id = (select id from fixture_ids where label = 'delivery_p');

-- CROSS-TENANT ATTACK #1: tenant Q (a real authenticated user, zero membership in P's org)
-- tries to replace P's delivery.
set local role authenticated;
set local request.jwt.claims = '{"sub":"b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b202","role":"authenticated"}';

select throws_ok(
  format(
    $$ select api.create_replacement_delivery(%L, jsonb_build_array(jsonb_build_object('epi_id', %L, 'quantity', 1)), current_date, null, 'OTHER', null, false) $$,
    (select id from fixture_ids where label = 'delivery_p'),
    (select id from fixture_ids where label = 'epi_p')
  ),
  '42501',
  NULL,
  'tenant Q cannot replace tenant P''s delivery (insufficient_privilege) -- cross-tenant attack #1'
);

reset role;

select is(
  (select status::text from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_p')),
  'CONFIRMED',
  'tenant P''s delivery is UNCHANGED (still CONFIRMED, not SUPERSEDED) after the rejected cross-tenant attempt -- no side effect'
);
select is(
  (select count(*)::int from app.epi_deliveries where corrects_delivery_id = (select id from fixture_ids where label = 'delivery_p')),
  0,
  'no replacement delivery was ever created by the rejected attempt -- zero rows, not an orphaned/rolled-back one'
);
select is(
  (select count(*)::int from audit.audit_events where event_type = 'DELIVERY_REPLACED' and entity_id = (select id from fixture_ids where label = 'delivery_p')),
  0,
  'no DELIVERY_REPLACED audit event was logged for the rejected cross-tenant attempt'
);

-- CROSS-TENANT ATTACK #2: tenant Q tries to change tenant P's organization policy.
set local role authenticated;
set local request.jwt.claims = '{"sub":"b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b202","role":"authenticated"}';

select throws_ok(
  format(
    $$ select api.update_organization_policy(%L, 'block', 7, true, true, true, true) $$,
    (select organization_id from app.companies where id = (select id from fixture_ids where label = 'company_p'))
  ),
  '42501',
  NULL,
  'tenant Q cannot change tenant P''s organization policy (insufficient_privilege) -- cross-tenant attack #2'
);

reset role;

select is(
  (select early_replacement_policy from app.organizations where id = (select organization_id from app.companies where id = (select id from fixture_ids where label = 'company_p'))),
  'warn',
  'tenant P''s organization policy is UNCHANGED (still the default ''warn'') after the rejected cross-tenant attempt'
);
select is(
  (select inventory_enabled from app.organizations where id = (select organization_id from app.companies where id = (select id from fixture_ids where label = 'company_p'))),
  false,
  'tenant P''s inventory_enabled flag is UNCHANGED (still false) after the rejected cross-tenant attempt'
);

-- HAPPY PATH: the guard must not have made either RPC unusable for its rightful owner.
do $$
declare v_new_delivery_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a101","role":"authenticated"}', true);
  select api.create_replacement_delivery(
    (select id from fixture_ids where label = 'delivery_p'),
    jsonb_build_array(jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_p'), 'quantity', 1)),
    current_date, null, 'WEAR', null, false
  ) into v_new_delivery_id;
  insert into fixture_ids values ('delivery_p2', v_new_delivery_id);
  reset role;
end $$;

select is(
  (select status::text from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_p')),
  'SUPERSEDED',
  'tenant P itself CAN still replace its own delivery -- happy path #1 works after the guard'
);

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a101","role":"authenticated"}', true);
  perform api.update_organization_policy(
    (select organization_id from app.companies where id = (select id from fixture_ids where label = 'company_p')),
    'block', 15, true, true, false, false
  );
  reset role;
end $$;

select is(
  (select early_replacement_policy from app.organizations where id = (select organization_id from app.companies where id = (select id from fixture_ids where label = 'company_p'))),
  'block',
  'tenant P itself CAN change its own organization policy -- happy path #2 works after the guard'
);
select is(
  (select replacement_alert_days::int from app.organizations where id = (select organization_id from app.companies where id = (select id from fixture_ids where label = 'company_p'))),
  15,
  'the policy change actually persisted the new replacement_alert_days value'
);

select * from finish();

rollback;
