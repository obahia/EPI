-- Phase B closure-gate test: proves api.create_employee/api.update_employee actually
-- accept and persist location_id (real gap fixed in 20260903130200 -- there was no RPC
-- path to ever assign an employee to a location before this).

create extension if not exists pgtap with schema extensions;

begin;

select plan(4);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffff01',
  'authenticated', 'authenticated', 'admin-o@tenant-o.test',
  extensions.crypt('x', extensions.gen_salt('bf')), now(),
  '{}', '{"full_name":"Admin O"}', now(), now(), '', '', '', '', false, false
);

-- A SEPARATE user for the foreign-company fixture below -- api.onboard_organization
-- refuses a second onboarding by a user who already has an org-wide membership.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', 'ffffffff-0002-ffff-ffff-ffffffffff02',
  'authenticated', 'authenticated', 'admin-o2@tenant-o2.test',
  extensions.crypt('x', extensions.gen_salt('bf')), now(),
  '{}', '{"full_name":"Admin O2"}', now(), now(), '', '', '', '', false, false
);

create temporary table fixture_ids (label text primary key, id uuid not null);
grant all on fixture_ids to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffff01","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant O LTDA', '11222333000881', 'Tenant O LTDA', '11222333000881', null);
  insert into fixture_ids values ('company_o', v_company_id);
  reset role;
end $$;

do $$
declare
  v_company_o uuid; v_loc_a uuid; v_loc_b uuid; v_employee_id uuid;
  v_cpf_hash_b64 text; v_cpf_enc_b64 text;
begin
  select id into v_company_o from fixture_ids where label = 'company_o';
  v_cpf_hash_b64 := encode(extensions.digest('cpf-o', 'sha256'), 'base64');
  v_cpf_enc_b64 := encode(decode('000000000000000000000000000000000000000000000000000000', 'hex') || 'fake-o'::bytea, 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffff01","role":"authenticated"}', true);

  select api.create_location(v_company_o, 'Sede A', 'A', '{}') into v_loc_a;
  select api.create_location(v_company_o, 'Sede B', 'B', '{}') into v_loc_b;
  insert into fixture_ids values ('loc_a', v_loc_a), ('loc_b', v_loc_b);

  select api.create_employee(
    v_company_o, 'Funcionário Tenant O', v_cpf_hash_b64, v_cpf_enc_b64, '***.111.222-**',
    null, null, null, null, null, 'MANUAL', null, null, null, v_loc_a
  ) into v_employee_id;
  insert into fixture_ids values ('employee_o', v_employee_id);

  reset role;
end $$;

select is(
  (select location_id from app.employees where id = (select id from fixture_ids where label = 'employee_o')),
  (select id from fixture_ids where label = 'loc_a'),
  'api.create_employee persists location_id (Sede A)'
);

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffff01","role":"authenticated"}', true);
  perform api.update_employee(
    (select id from fixture_ids where label = 'employee_o'),
    'Funcionário Tenant O', null, null, null, null, null, 'ACTIVE', null,
    (select id from fixture_ids where label = 'loc_b')
  );
  reset role;
end $$;

select is(
  (select location_id from app.employees where id = (select id from fixture_ids where label = 'employee_o')),
  (select id from fixture_ids where label = 'loc_b'),
  'api.update_employee reassigns location_id (Sede A -> Sede B)'
);

-- A location from a DIFFERENT company must be rejected, not silently linked.
do $$
declare v_company_o2 uuid; v_loc_foreign uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"ffffffff-0002-ffff-ffff-ffffffffff02","role":"authenticated"}', true);
  select company_id into v_company_o2 from api.onboard_organization('Tenant O2 LTDA', '22333444000695', 'Tenant O2 LTDA', '22333444000695', null);
  insert into fixture_ids values ('company_o2', v_company_o2);
  select api.create_location(v_company_o2, 'Sede Estranha', null, '{}') into v_loc_foreign;
  insert into fixture_ids values ('loc_foreign', v_loc_foreign);
  reset role;
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffff01","role":"authenticated"}';

select throws_ok(
  format(
    $$ select api.update_employee(%L, 'x', null, null, null, null, null, 'ACTIVE', null, %L) $$,
    (select id from fixture_ids where label = 'employee_o'),
    (select id from fixture_ids where label = 'loc_foreign')
  ),
  '23514',
  NULL,
  'assigning a location from a DIFFERENT company is rejected (location_out_of_scope)'
);

reset role;

select is(
  (select location_id from app.employees where id = (select id from fixture_ids where label = 'employee_o')),
  (select id from fixture_ids where label = 'loc_b'),
  'the rejected cross-company assignment left location_id unchanged (still Sede B)'
);

select * from finish();

rollback;
