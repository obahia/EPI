-- Phase C closure-gate test: proves api.create_epi/api.update_epi actually accept and
-- persist default_lifespan_days and requires_return_on_replacement -- these two backend
-- columns had real downstream logic (lifecycle status, pending returns) but, before
-- 20260903130100's fix, NO RPC ever let requires_return_on_replacement become true at all.

create extension if not exists pgtap with schema extensions;

begin;

select plan(5);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01',
  'authenticated', 'authenticated', 'admin-n@tenant-n.test',
  extensions.crypt('x', extensions.gen_salt('bf')), now(),
  '{}', '{"full_name":"Admin N"}', now(), now(), '', '', '', '', false, false
);

create temporary table fixture_ids (label text primary key, id uuid not null);
grant all on fixture_ids to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant N LTDA', '11222333000781', 'Tenant N LTDA', '11222333000781', null);
  insert into fixture_ids values ('company_n', v_company_id);
  reset role;
end $$;

do $$
declare v_company_n uuid; v_epi_id uuid;
begin
  select id into v_company_n from fixture_ids where label = 'company_n';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01","role":"authenticated"}', true);
  select api.create_epi(
    (select organization_id from app.companies where id = v_company_n), v_company_n,
    'Luva Isolante', '99999', null, null, null, 'PAR', 180, true
  ) into v_epi_id;
  insert into fixture_ids values ('epi_n', v_epi_id);
  reset role;
end $$;

select is(
  (select default_lifespan_days::int from api.epis where id = (select id from fixture_ids where label = 'epi_n')),
  180,
  'api.create_epi persists default_lifespan_days (180)'
);
select is(
  (select requires_return_on_replacement from api.epis where id = (select id from fixture_ids where label = 'epi_n')),
  true,
  'api.create_epi persists requires_return_on_replacement=true -- previously IMPOSSIBLE through any RPC (real gap fixed in 20260903130100)'
);

-- update_epi can flip the flag back off, and change the lifespan, without disturbing the
-- fields it doesn't touch (name/CA stay the same as a control).
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01","role":"authenticated"}', true);
  perform api.update_epi(
    (select id from fixture_ids where label = 'epi_n'),
    'Luva Isolante', '99999', null, null, null, 'PAR', 200, false
  );
  reset role;
end $$;

select is(
  (select default_lifespan_days::int from api.epis where id = (select id from fixture_ids where label = 'epi_n')),
  200,
  'api.update_epi changes default_lifespan_days to 200 (new epi_version, SCD2)'
);
select is(
  (select requires_return_on_replacement from api.epis where id = (select id from fixture_ids where label = 'epi_n')),
  false,
  'api.update_epi flips requires_return_on_replacement back to false -- a plain app.epis UPDATE, not versioned'
);
select is(
  (select version::int from api.epis where id = (select id from fixture_ids where label = 'epi_n')),
  2,
  'exactly one new epi_version was opened by the update (version 2) -- requires_return_on_replacement''s change did NOT spuriously version twice'
);

select * from finish();

rollback;
