-- Phase A: job positions (cargo) + the matriz cargo x EPI. Mirrors 020_employee_isolation.sql's
-- shape: two tenants bootstrap themselves through the real onboarding RPC, each creates its
-- own data through the real api.* RPCs, and isolation is asserted through api.* views/RPCs,
-- never a raw superuser read.

create extension if not exists pgtap with schema extensions;

begin;

select plan(8);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '55555555-5555-5555-5555-555555555501',
   'authenticated', 'authenticated', 'admin-e@tenant-e.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin E"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '66666666-6666-6666-6666-666666666601',
   'authenticated', 'authenticated', 'admin-f@tenant-f.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin F"}', now(), now(), '', '', '', '', false, false);

create temporary table fixture_ids (label text primary key, id uuid not null);
grant all on fixture_ids to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555501","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant E LTDA', '11222333000281', 'Tenant E LTDA', '11222333000281', null);
  insert into fixture_ids values ('company_e', v_company_id);
  reset role;
end $$;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666601","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant F LTDA', '22333444000299', 'Tenant F LTDA', '22333444000299', null);
  insert into fixture_ids values ('company_f', v_company_id);
  reset role;
end $$;

select ok((select count(*) = 2 from fixture_ids), 'both tenants onboarded');

-- Tenant E: creates a position, an EPI, and a matrix requirement linking them.
do $$
declare v_company_e uuid; v_position_id uuid; v_epi_id uuid; v_req_id uuid;
begin
  select id into v_company_e from fixture_ids where label = 'company_e';

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555501","role":"authenticated"}', true);

  select api.create_job_position(
    (select organization_id from app.companies where id = v_company_e), v_company_e, 'Eletricista', null
  ) into v_position_id;
  insert into fixture_ids values ('position_e', v_position_id);

  select api.create_epi(
    (select organization_id from app.companies where id = v_company_e), v_company_e, 'Capacete', '12345'
  ) into v_epi_id;
  insert into fixture_ids values ('epi_e', v_epi_id);

  select api.set_position_epi_requirement(v_position_id, v_epi_id, true, 1, 365, null) into v_req_id;
  insert into fixture_ids values ('requirement_e', v_req_id);

  reset role;
end $$;

select ok(
  (select count(*) = 3 from fixture_ids where label in ('position_e', 'epi_e', 'requirement_e')),
  'tenant E created a position, an epi, and a matrix requirement linking them'
);

-- Isolation: tenant F must see none of tenant E's positions/matrix rows.
set local role authenticated;
set local request.jwt.claims = '{"sub":"66666666-6666-6666-6666-666666666601","role":"authenticated"}';

select is(
  (select count(*)::int from api.job_positions),
  0,
  'tenant F sees zero job positions -- tenant E''s Eletricista is invisible'
);

select is(
  (select count(*)::int from api.position_epi_requirements),
  0,
  'tenant F sees zero matrix requirements'
);

select throws_ok(
  $$ select api.set_position_epi_requirement(
       (select id from fixture_ids where label = 'position_e'),
       (select id from fixture_ids where label = 'epi_e'),
       true, 1, null, null
     ) $$,
  '42501',
  NULL,
  'tenant F cannot write a requirement onto tenant E''s position (insufficient_privilege)'
);

reset role;

-- Tenant E itself: confirm the requirement round-trips through the joined read view.
set local role authenticated;
set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555501","role":"authenticated"}';

select results_eq(
  $$ select epi_name, ca_number, quantity, periodicity_days from api.position_epi_requirements $$,
  $$ values ('Capacete'::text, '12345'::text, 1, 365) $$,
  'tenant E reads its own matrix requirement joined to the epi''s current name/CA'
);

-- A mismatched-scope requirement (EPI from a different org) must be rejected server-side,
-- not merely hidden -- exercises the epi_not_found guard in api.set_position_epi_requirement.
select throws_ok(
  $$ select api.set_position_epi_requirement(
       (select id from fixture_ids where label = 'position_e'),
       gen_random_uuid(),
       true, 1, null, null
     ) $$,
  'P0002',
  NULL,
  'a non-existent/foreign epi_id is rejected (epi_not_found), never silently linked'
);

reset role;

select is(
  (select count(*)::int from app.position_epi_requirements),
  1,
  'exactly 1 matrix requirement exists in total -- the rejected cross-tenant/foreign-epi attempts never persisted'
);

select * from finish();

rollback;
