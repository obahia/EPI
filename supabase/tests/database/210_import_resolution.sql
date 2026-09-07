-- Phase F: import. The interesting assertions are not about parsing -- they are about the
-- two places the SCHEMA makes resolution genuinely ambiguous, and about a partial import
-- being legible afterwards.

create extension if not exists pgtap with schema extensions;

begin;

select plan(18);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-00000000000c',
   'authenticated', 'authenticated', 'admin-import@tenant.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Import Admin"}', now(), now(), '', '', '', '', false, false);

create temporary table fx (label text primary key, id uuid not null);
grant all on fx to authenticated;
create temporary table probe (label text primary key, val text);
grant all on probe to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
  select company_id into v_company_id
  from api.onboard_organization('Import LTDA', '88999000000177', 'Import LTDA', '88999000000177', null);
  insert into fx values ('company', v_company_id);
  reset role;
end $$;

insert into fx select 'org', organization_id from app.companies where id = (select id from fx where label = 'company');

-- The ambiguity the index does NOT prevent: app.job_positions is unique on
-- (organization_id, company_id, lower(title)) for ACTIVE rows, but company_id may be NULL,
-- so an org-wide "Soldador" and a company-scoped "Soldador" can both exist.
insert into app.job_positions (id, organization_id, company_id, title) values
  ('11111111-0000-4000-8000-000000000001', (select id from fx where label = 'org'), null, 'Soldador'),
  ('11111111-0000-4000-8000-000000000002', (select id from fx where label = 'org'),
   (select id from fx where label = 'company'), 'Soldador'),
  ('11111111-0000-4000-8000-000000000003', (select id from fx where label = 'org'),
   (select id from fx where label = 'company'), 'Eletricista'),
  ('11111111-0000-4000-8000-000000000004', (select id from fx where label = 'org'),
   (select id from fx where label = 'company'), 'Pintor');

update app.job_positions set status = 'INACTIVE' where id = '11111111-0000-4000-8000-000000000004';

-- app.locations has NO unique index on name or code, so two ACTIVE units of one company can
-- legitimately share a name today. That is the ambiguity the resolver has to refuse.
insert into app.locations (id, organization_id, company_id, name, code) values
  ('22222222-0000-4000-8000-000000000001', (select id from fx where label = 'org'),
   (select id from fx where label = 'company'), 'Unidade Norte', 'UN-N'),
  ('22222222-0000-4000-8000-000000000002', (select id from fx where label = 'org'),
   (select id from fx where label = 'company'), 'Matriz', null),
  ('22222222-0000-4000-8000-000000000003', (select id from fx where label = 'org'),
   (select id from fx where label = 'company'), 'Matriz', null);

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
  insert into probe
  select 'pos:' || lower(r.raw), coalesce(r.resolved_id::text, r.outcome)
    from api.resolve_import_references(
      (select id from fx where label = 'company'),
      array['Soldador', '  soldador ', 'Soldádor', 'Eletricista', 'Pintor', 'Inexistente'],
      array[]::text[]
    ) r
   where r.kind = 'POSITION';

  insert into probe
  select 'loc:' || lower(r.raw), coalesce(r.resolved_id::text, r.outcome)
    from api.resolve_import_references(
      (select id from fx where label = 'company'),
      array[]::text[],
      array['Unidade Norte', 'UN-N', 'Matriz', 'Nao Existe']
    ) r
   where r.kind = 'LOCATION';
  reset role;
end $$;

-- ---------------------------------------------------------------------------------------
-- Positions
-- ---------------------------------------------------------------------------------------
select is(
  (select val from probe where label = 'pos:soldador'),
  '11111111-0000-4000-8000-000000000002',
  'a company-scoped position wins over an org-wide one with the same title -- deterministic, not first-row-wins'
);

select is(
  (select val from probe where label = 'pos:  soldador '),
  '11111111-0000-4000-8000-000000000002',
  'matching is insensitive to case and surrounding whitespace'
);

select is(
  (select val from probe where label = 'pos:soldádor'),
  'NOT_FOUND',
  'accents are NOT folded -- "Soldádor" must not silently resolve to "Soldador"'
);

select is(
  (select val from probe where label = 'pos:eletricista'),
  '11111111-0000-4000-8000-000000000003',
  'an unambiguous title resolves'
);

select is(
  (select val from probe where label = 'pos:pintor'),
  'INACTIVE',
  'an INACTIVE position is reported as such, never silently reactivated'
);

select is(
  (select val from probe where label = 'pos:inexistente'),
  'NOT_FOUND',
  'an unknown cargo is NOT_FOUND -- nothing is created'
);

select is(
  (select count(*)::int from app.job_positions where organization_id = (select id from fx where label = 'org')),
  4,
  'resolving unknown labels created no positions whatsoever'
);

-- ---------------------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------------------
select is(
  (select val from probe where label = 'loc:unidade norte'),
  '22222222-0000-4000-8000-000000000001',
  'a location resolves by name'
);

select is(
  (select val from probe where label = 'loc:un-n'),
  '22222222-0000-4000-8000-000000000001',
  'code is tried first -- it is the identifier an external payroll file actually carries'
);

select is(
  (select val from probe where label = 'loc:matriz'),
  'AMBIGUOUS',
  'two active units sharing a name is AMBIGUOUS, never "pick the first" -- that would place people in the wrong stock bucket'
);

select is(
  (select val from probe where label = 'loc:nao existe'),
  'NOT_FOUND',
  'an unknown unidade is NOT_FOUND -- and creation is not offered at all, not even opt-in'
);

select is(
  (select count(*)::int from app.locations where company_id = (select id from fx where label = 'company')),
  3,
  'resolving unknown labels created no locations whatsoever'
);

-- ---------------------------------------------------------------------------------------
-- Import run + chunk bookkeeping
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_run uuid;
  v_company_id uuid := (select id from fx where label = 'company');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);

  select api.start_import_run(v_company_id, 'XLSX', 'quadro.xlsx', null, '{"cpf":"CPF"}'::jsonb,
                              10, 8, 2, 2000, 2) into v_run;
  insert into fx values ('run', v_run);

  perform api.import_employees_commit(
    v_company_id,
    jsonb_build_array(jsonb_build_object(
      'full_name', 'Importado Um',
      'cpf_hash_b64', encode(repeat('1', 32)::bytea, 'base64'),
      'cpf_enc_b64', encode(repeat('z', 40)::bytea, 'base64'),
      'cpf_masked', '***.111.111-**',
      'position_id', '11111111-0000-4000-8000-000000000003',
      'location_id', '22222222-0000-4000-8000-000000000001'
    )),
    v_run, 0, 2, 2);

  insert into probe values ('run_status_before', (select status from api.import_run_status(v_run)));
  reset role;
end $$;

select is(
  (select e.position_id from app.employees e where e.full_name = 'Importado Um'),
  '11111111-0000-4000-8000-000000000003'::uuid,
  'the import writes position_id, connecting an imported employee to the requirement matrix'
);

select is(
  (select e.location_id from app.employees e where e.full_name = 'Importado Um'),
  '22222222-0000-4000-8000-000000000001'::uuid,
  'the import writes location_id, placing the employee in a stock bucket'
);

select is(
  (select count(*)::int from app.import_run_chunks
    where import_run_id = (select id from fx where label = 'run') and status = 'COMMITTED'),
  1,
  'the chunk result is recorded in the same transaction as the rows it describes'
);

select is(
  (select count(*)::int from audit.audit_events a
    where a.event_type = 'EMPLOYEES_IMPORTED'
      and a.entity_id = (select id from fx where label = 'run')),
  1,
  'exactly ONE EMPLOYEES_IMPORTED per chunk -- never one per employee'
);

select is(
  (select count(*)::int from audit.audit_events a
    where a.event_type = 'EMPLOYEE_CREATED'
      and a.organization_id = (select id from fx where label = 'org')),
  0,
  'a bulk import emits NO per-employee events -- the declared semantics, not an oversight'
);

-- Only one of two chunks committed, so the run must say PARTIAL rather than complete.
do $$
declare v_status text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
  select api.finish_import_run((select id from fx where label = 'run')) into v_status;
  insert into probe values ('run_final', v_status);
  reset role;
end $$;

select is(
  (select val from probe where label = 'run_final'),
  'PARTIAL',
  'a run with 1 of 2 chunks committed is PARTIAL -- taken from what actually committed, never from what the client believed'
);

select * from finish();

rollback;
