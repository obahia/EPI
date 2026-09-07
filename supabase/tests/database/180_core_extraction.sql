-- Phase F, extraction step. Proves the two properties the extraction has to have:
--   (1) the extracted cores are unreachable by every client role -- catalog AND real call,
--       because a catalog-only assertion would pass even if the grant were wrong somewhere
--       the catalog does not model (lesson from the Phase E immutability assertions, which
--       ran as the suite owner and proved nothing);
--   (2) the api.* facades still behave exactly as before -- same permission gate, same
--       written values, same domain guards, same error codes.
--
-- The MAIN proof of neutrality is not in this file: it is that suites 020..170 pass with
-- zero edits. This file only covers what those suites could not see, because the cores did
-- not exist when they were written.

create extension if not exists pgtap with schema extensions;

begin;

select plan(19);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'f0000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'admin-f@tenant-f.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin F"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'f0000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'outsider-f@nowhere.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Outsider F"}', now(), now(), '', '', '', '', false, false);

create temporary table fixture_ids (label text primary key, id uuid not null);
grant all on fixture_ids to authenticated;

-- Outcomes captured while impersonating a restricted role. pgTAP's own assertion functions
-- cannot be called under `set local role authenticated` -- that role has no USAGE on the
-- `extensions` schema by design -- so the pattern is: probe inside the role, record the
-- SQLSTATE, reset role, then assert.
create temporary table probe (label text primary key, val text);
grant all on probe to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  select company_id into v_company_id
  from api.onboard_organization('Tenant F LTDA', '33444555000177', 'Tenant F LTDA', '33444555000177', null);
  insert into fixture_ids values ('company_f', v_company_id);
  reset role;
end $$;

select ok((select count(*) = 1 from fixture_ids), 'tenant F onboarded');

-- ---------------------------------------------------------------------------
-- 1. The cores exist exactly once. A second overload would mean a future
--    CREATE OR REPLACE silently forked the domain in two -- the same class of bug
--    20260903150000 had to clean up for api.return_epi_item.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'create_employee_core'),
  1, 'app.create_employee_core has exactly one signature'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'update_employee_core'),
  1, 'app.update_employee_core has exactly one signature'
);

-- ---------------------------------------------------------------------------
-- 2. Catalog: no client role may execute a core. Looked up by oid rather than by a
--    hand-typed signature string, so a typo cannot turn into a false PASS.
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('authenticated',
    (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'create_employee_core'), 'execute'),
  'authenticated cannot execute app.create_employee_core'
);

select ok(
  not has_function_privilege('anon',
    (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'create_employee_core'), 'execute'),
  'anon cannot execute app.create_employee_core'
);

select ok(
  not has_function_privilege('service_role',
    (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'create_employee_core'), 'execute'),
  'service_role cannot execute app.create_employee_core'
);

select ok(
  not has_function_privilege('authenticated',
    (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'update_employee_core'), 'execute'),
  'authenticated cannot execute app.update_employee_core'
);

select ok(
  not has_function_privilege('anon',
    (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'update_employee_core'), 'execute'),
  'anon cannot execute app.update_employee_core'
);

select ok(
  not has_function_privilege('service_role',
    (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'update_employee_core'), 'execute'),
  'service_role cannot execute app.update_employee_core'
);

-- ---------------------------------------------------------------------------
-- 3. Real call: an authenticated caller who tries to bypass the facade and reach the
--    core directly -- passing whatever actor_context it likes -- is refused by the
--    grant, not by anything the core itself checks.
-- ---------------------------------------------------------------------------
do $$
declare v_company_id uuid := (select id from fixture_ids where label = 'company_f');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  begin
    perform app.create_employee_core(
      row('USER', 'f0000000-0000-4000-8000-000000000001'::uuid, null)::app.actor_context,
      v_company_id, 'Bypass Attempt',
      encode(repeat('a',32)::bytea,'base64'), encode(repeat('z',40)::bytea,'base64'), '***.000.000-**'
    );
    insert into probe values ('core_direct_call', 'EXECUTED');
  exception when others then
    insert into probe values ('core_direct_call', sqlstate);
  end;
  reset role;
end $$;

select is(
  (select val from probe where label = 'core_direct_call'), '42501',
  'authenticated calling app.create_employee_core directly is refused (42501), not executed'
);

-- ---------------------------------------------------------------------------
-- 4. The facade still works, and created_by still carries the caller's auth.uid().
--    This is the assertion that proves the one substitution the extraction made --
--    `(select auth.uid())` became `p_actor.actor_user_id` -- is behaviour-identical.
-- ---------------------------------------------------------------------------
do $$
declare
  v_company_id uuid := (select id from fixture_ids where label = 'company_f');
  v_employee_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  select api.create_employee(
    v_company_id, 'Maria Extração',
    encode(repeat('b',32)::bytea,'base64'), encode(repeat('z',40)::bytea,'base64'), '***.982.247-**',
    'MAT-F-1'
  ) into v_employee_id;
  insert into fixture_ids values ('employee_f', v_employee_id);
  reset role;
end $$;

select ok(
  (select count(*) = 1 from app.employees e
    join fixture_ids f on f.label = 'employee_f' and f.id = e.id
   where e.full_name = 'Maria Extração'),
  'api.create_employee still creates the employee through the extracted core'
);

select is(
  (select e.created_by from app.employees e
    join fixture_ids f on f.label = 'employee_f' and f.id = e.id),
  'f0000000-0000-4000-8000-000000000001'::uuid,
  'created_by still records the calling user -- p_actor.actor_user_id equals auth.uid() on the user path'
);

-- ---------------------------------------------------------------------------
-- 5. The facade still updates.
-- ---------------------------------------------------------------------------
do $$
declare v_employee_id uuid := (select id from fixture_ids where label = 'employee_f');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  perform api.update_employee(
    v_employee_id, 'Maria Extração Silva', 'MAT-F-2', null, null, null, null, 'ACTIVE'
  );
  reset role;
end $$;

select is(
  (select e.full_name from app.employees e
    join fixture_ids f on f.label = 'employee_f' and f.id = e.id),
  'Maria Extração Silva',
  'api.update_employee still updates through the extracted core'
);

-- The two assertions below exist because of a real regression: `v_changed || 'full_name'`
-- with an untyped literal made Postgres resolve `anyarray || anyarray` and try to parse the
-- literal as an array, so EVERY field-changing update raised. It was caught by suite 140,
-- but only after the fact -- nothing here pinned the CONTENT of changed_fields, and that
-- content is the whole point of the event.
select is(
  (select a.data->'changed_fields' from audit.audit_events a
    join fixture_ids f on f.label = 'employee_f' and f.id = a.entity_id
   where a.event_type = 'EMPLOYEE_UPDATED'),
  '["full_name", "registration_number"]'::jsonb,
  'EMPLOYEE_UPDATED lists exactly the field NAMES that changed -- never their values, and never a field that did not change'
);

-- Repeating the identical call must emit nothing at all. Without this, a client polling
-- PATCH in a loop produces an unbounded stream of events saying nothing happened, and once
-- webhooks exist, delivers every one of them.
do $$
declare v_employee_id uuid := (select id from fixture_ids where label = 'employee_f');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  perform api.update_employee(
    v_employee_id, 'Maria Extração Silva', 'MAT-F-2', null, null, null, null, 'ACTIVE'
  );
  reset role;
end $$;

select is(
  (select count(*)::int from audit.audit_events a
    join fixture_ids f on f.label = 'employee_f' and f.id = a.entity_id
   where a.event_type = 'EMPLOYEE_UPDATED'),
  1,
  'a no-op update emits NO second event'
);

-- ---------------------------------------------------------------------------
-- 6. The permission gate is still in the facade, and still fires.
-- ---------------------------------------------------------------------------
do $$
declare v_company_id uuid := (select id from fixture_ids where label = 'company_f');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  begin
    perform api.create_employee(
      v_company_id, 'Intruso',
      encode(repeat('c',32)::bytea,'base64'), encode(repeat('z',40)::bytea,'base64'), '***.111.111-**'
    );
    insert into probe values ('outsider_create', 'EXECUTED');
  exception when others then
    insert into probe values ('outsider_create', sqlstate);
  end;
  reset role;
end $$;

select is(
  (select val from probe where label = 'outsider_create'), '42501',
  'api.create_employee still refuses a caller without employee.create on that company'
);

do $$
declare v_employee_id uuid := (select id from fixture_ids where label = 'employee_f');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  begin
    perform api.update_employee(v_employee_id, 'Sequestrado', null, null, null, null, null, 'ACTIVE');
    insert into probe values ('outsider_update', 'EXECUTED');
  exception when others then
    insert into probe values ('outsider_update', sqlstate);
  end;
  reset role;
end $$;

select is(
  (select val from probe where label = 'outsider_update'), '42501',
  'api.update_employee still refuses a caller without employee.update on that company'
);

-- ---------------------------------------------------------------------------
-- 7. The domain guards that live INSIDE the core still fire through the facade.
-- ---------------------------------------------------------------------------
do $$
declare v_company_id uuid := (select id from fixture_ids where label = 'company_f');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  begin
    perform api.create_employee(
      v_company_id, 'Cargo Fantasma',
      encode(repeat('d',32)::bytea,'base64'), encode(repeat('z',40)::bytea,'base64'), '***.222.222-**',
      null, null, null, null, null, 'MANUAL', null, null,
      '00000000-0000-4000-8000-0000000000ff'::uuid
    );
    insert into probe values ('phantom_position', 'EXECUTED');
  exception when others then
    insert into probe values ('phantom_position', sqlstate);
  end;
  reset role;
end $$;

select is(
  (select val from probe where label = 'phantom_position'), 'P0002',
  'position_not_found still raised from inside the core, surfaced through the facade'
);

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  begin
    perform api.update_employee(
      '00000000-0000-4000-8000-0000000000fe'::uuid, 'Ninguém', null, null, null, null, null, 'ACTIVE'
    );
    insert into probe values ('update_missing', 'EXECUTED');
  exception when others then
    insert into probe values ('update_missing', sqlstate);
  end;
  reset role;
end $$;

select is(
  (select val from probe where label = 'update_missing'), 'P0002',
  'api.update_employee still raises not_found for an unknown employee'
);

select * from finish();

rollback;
