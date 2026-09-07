-- Phase F: the machine-to-machine plane. These are the assertions that decide whether an
-- API key can be trusted at all -- authentication indistinguishability, scope enforcement,
-- tenant binding, and idempotency under replay.
--
-- Everything here runs as the suite owner, which is exactly why the grant assertions
-- impersonate the target role explicitly: an assertion executed as the owner would pass
-- even if the grants were wrong, which is how the Phase E immutability assertions initially
-- proved nothing.

create extension if not exists pgtap with schema extensions;

begin;

select plan(24);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-00000000000a',
   'authenticated', 'authenticated', 'admin-m2m-a@tenant.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin A"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-4000-8000-00000000000b',
   'authenticated', 'authenticated', 'admin-m2m-b@tenant.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin B"}', now(), now(), '', '', '', '', false, false);

create temporary table fx (label text primary key, id uuid not null);
grant all on fx to authenticated;
create temporary table probe (label text primary key, val text);
grant all on probe to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  select company_id into v_company_id
  from api.onboard_organization('M2M A LTDA', '44555666000155', 'M2M A LTDA', '44555666000155', null);
  insert into fx values ('company_a', v_company_id);
  reset role;
end $$;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
  select company_id into v_company_id
  from api.onboard_organization('M2M B LTDA', '55666777000133', 'M2M B LTDA', '55666777000133', null);
  insert into fx values ('company_b', v_company_id);
  reset role;
end $$;

insert into fx
select 'org_a', organization_id from app.companies where id = (select id from fx where label = 'company_a');
insert into fx
select 'org_b', organization_id from app.companies where id = (select id from fx where label = 'company_b');

-- Principals and keys, inserted directly: api.create_integration_principal is exercised in
-- its own assertion below, but the bulk of the fixture should not depend on it.
insert into m2m.integration_principals (id, organization_id, name, scopes)
values
  ('c0000000-0000-4000-8000-000000000001', (select id from fx where label = 'org_a'), 'Full A',
   array['employees:read','employees:write','deliveries:read']::m2m.api_scope[]),
  ('c0000000-0000-4000-8000-000000000002', (select id from fx where label = 'org_a'), 'Read-only A',
   array['employees:read']::m2m.api_scope[]),
  ('c0000000-0000-4000-8000-000000000003', (select id from fx where label = 'org_b'), 'Full B',
   array['employees:read','employees:write']::m2m.api_scope[]);

insert into m2m.api_keys (principal_id, key_id, secret_hash, env) values
  ('c0000000-0000-4000-8000-000000000001', 'AAAAAAAAAAAAAAAA', extensions.digest('secret-a', 'sha256'), 'live'),
  ('c0000000-0000-4000-8000-000000000002', 'BBBBBBBBBBBBBBBB', extensions.digest('secret-ro', 'sha256'), 'live'),
  ('c0000000-0000-4000-8000-000000000003', 'CCCCCCCCCCCCCCCC', extensions.digest('secret-b', 'sha256'), 'live'),
  ('c0000000-0000-4000-8000-000000000001', 'DDDDDDDDDDDDDDDD', extensions.digest('secret-rev', 'sha256'), 'live'),
  ('c0000000-0000-4000-8000-000000000001', 'EEEEEEEEEEEEEEEE', extensions.digest('secret-exp', 'sha256'), 'live');

update m2m.api_keys set revoked_at = now() where key_id = 'DDDDDDDDDDDDDDDD';
update m2m.api_keys set expires_at = now() - interval '1 day' where key_id = 'EEEEEEEEEEEEEEEE';

-- ---------------------------------------------------------------------------------------
-- 1. Authentication: every failure mode is indistinguishable
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_company_id uuid := (select id from fx where label = 'company_a');
  v_cases text[][] := array[
    array['unknown_key',   'ZZZZZZZZZZZZZZZZ', 'secret-a'],
    array['wrong_secret',  'AAAAAAAAAAAAAAAA', 'wrong'],
    array['revoked_key',   'DDDDDDDDDDDDDDDD', 'secret-rev'],
    array['expired_key',   'EEEEEEEEEEEEEEEE', 'secret-exp']
  ];
  c text[];
begin
  foreach c slice 1 in array v_cases loop
    begin
      perform m2m_rpc.list_employees(
        c[2], encode(extensions.digest(c[3], 'sha256'), 'base64'), v_company_id);
      insert into probe values (c[1], 'ALLOWED');
    exception when others then
      insert into probe values (c[1], sqlerrm);
    end;
  end loop;
end $$;

select is((select val from probe where label = 'unknown_key'), 'unauthorized', 'unknown key_id is unauthorized');
select is((select val from probe where label = 'wrong_secret'), 'unauthorized', 'wrong secret is unauthorized');
select is((select val from probe where label = 'revoked_key'), 'unauthorized', 'revoked key is unauthorized');
select is((select val from probe where label = 'expired_key'), 'unauthorized', 'expired key is unauthorized');

select is(
  (select count(distinct val)::int from probe
    where label in ('unknown_key', 'wrong_secret', 'revoked_key', 'expired_key')),
  1,
  'all four authentication failures produce the IDENTICAL signal -- key_id is not an enumeration oracle'
);

-- Revoking the principal revokes its keys, with no separate step to forget.
do $$
begin
  update m2m.integration_principals set status = 'REVOKED', revoked_at = now()
   where id = 'c0000000-0000-4000-8000-000000000002';
  begin
    perform m2m_rpc.list_employees('BBBBBBBBBBBBBBBB',
      encode(extensions.digest('secret-ro', 'sha256'), 'base64'),
      (select id from fx where label = 'company_a'));
    insert into probe values ('revoked_principal', 'ALLOWED');
  exception when others then
    insert into probe values ('revoked_principal', sqlerrm);
  end;
  update m2m.integration_principals set status = 'ACTIVE', revoked_at = null
   where id = 'c0000000-0000-4000-8000-000000000002';
end $$;

select is((select val from probe where label = 'revoked_principal'), 'unauthorized',
  'a revoked principal cannot authenticate, immediately and with no cache to wait out');

-- ---------------------------------------------------------------------------------------
-- 2. Scope
-- ---------------------------------------------------------------------------------------
do $$
declare v_company_id uuid := (select id from fx where label = 'company_a');
begin
  begin
    perform m2m_rpc.create_employee(
      'BBBBBBBBBBBBBBBB', encode(extensions.digest('secret-ro', 'sha256'), 'base64'),
      'idem-scope-test-1', encode(extensions.digest('req', 'sha256'), 'base64'),
      v_company_id, 'Sem Escopo',
      encode(repeat('q', 32)::bytea, 'base64'), encode(repeat('z', 40)::bytea, 'base64'), '***.999.999-**');
    insert into probe values ('no_scope_write', 'ALLOWED');
  exception when others then
    insert into probe values ('no_scope_write', sqlerrm);
  end;

  begin
    perform m2m_rpc.list_deliveries(
      'BBBBBBBBBBBBBBBB', encode(extensions.digest('secret-ro', 'sha256'), 'base64'), v_company_id);
    insert into probe values ('no_scope_read', 'ALLOWED');
  exception when others then
    insert into probe values ('no_scope_read', sqlerrm);
  end;
end $$;

select is((select val from probe where label = 'no_scope_write'), 'insufficient_scope',
  'employees:read does NOT imply employees:write -- there is no scope hierarchy');
select is((select val from probe where label = 'no_scope_read'), 'insufficient_scope',
  'a scope the principal does not hold is refused before any row is read');

-- ---------------------------------------------------------------------------------------
-- 3. Tenant binding
-- ---------------------------------------------------------------------------------------
do $$
begin
  begin
    perform m2m_rpc.list_employees('AAAAAAAAAAAAAAAA',
      encode(extensions.digest('secret-a', 'sha256'), 'base64'),
      (select id from fx where label = 'company_b'));
    insert into probe values ('cross_tenant_list', 'ALLOWED');
  exception when others then
    insert into probe values ('cross_tenant_list', sqlerrm);
  end;
end $$;

select is((select val from probe where label = 'cross_tenant_list'), 'tenant_forbidden',
  'a key of org A cannot name a company of org B');

-- A company restriction narrows further, and is re-checked against the organization every
-- time -- a stale id in the array can never widen access.
do $$
begin
  update m2m.integration_principals
     set company_ids = array[(select id from fx where label = 'company_b')]
   where id = 'c0000000-0000-4000-8000-000000000001';
  begin
    perform m2m_rpc.list_employees('AAAAAAAAAAAAAAAA',
      encode(extensions.digest('secret-a', 'sha256'), 'base64'),
      (select id from fx where label = 'company_a'));
    insert into probe values ('company_restriction', 'ALLOWED');
  exception when others then
    insert into probe values ('company_restriction', sqlerrm);
  end;
  update m2m.integration_principals set company_ids = null
   where id = 'c0000000-0000-4000-8000-000000000001';
end $$;

select is((select val from probe where label = 'company_restriction'), 'tenant_forbidden',
  'company_ids narrows access even inside the principal''s own organization');

-- ---------------------------------------------------------------------------------------
-- 4. Writes go through the shared domain core
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_company_id uuid := (select id from fx where label = 'company_a');
  v_result jsonb;
begin
  v_result := m2m_rpc.create_employee(
    'AAAAAAAAAAAAAAAA', encode(extensions.digest('secret-a', 'sha256'), 'base64'),
    'idem-create-employee-1', encode(extensions.digest('body-v1', 'sha256'), 'base64'),
    v_company_id, 'API Criado',
    encode(repeat('m', 32)::bytea, 'base64'), encode(repeat('z', 40)::bytea, 'base64'),
    '***.333.333-**');
  insert into probe values ('create_replayed', (v_result->>'replayed'));
  insert into probe values ('create_status', (v_result->>'status'));
  insert into fx values ('employee_api', (v_result->'body'->>'id')::uuid);
end $$;

select is((select val from probe where label = 'create_status'), '201',
  'POST /v1/employees creates through app.create_employee_core');

select is(
  (select e.data_origin::text from app.employees e
    join fx f on f.label = 'employee_api' and f.id = e.id),
  'API',
  'a machine-created employee is marked data_origin = API -- the enum value provisioned in FASE 0 and unused until now'
);

select is(
  (select e.created_by from app.employees e
    join fx f on f.label = 'employee_api' and f.id = e.id),
  null::uuid,
  'created_by is NULL for a machine write -- auth.uid() was never consulted and no human is invented'
);

select is(
  (select a.actor_kind from audit.audit_events a
    join fx f on f.label = 'employee_api' and f.id = a.entity_id
   where a.event_type = 'EMPLOYEE_CREATED'),
  'PROVIDER',
  'the audit event records actor_kind = PROVIDER'
);

select is(
  (select a.actor_principal_id from audit.audit_events a
    join fx f on f.label = 'employee_api' and f.id = a.entity_id
   where a.event_type = 'EMPLOYEE_CREATED'),
  'c0000000-0000-4000-8000-000000000001'::uuid,
  'the audit event identifies WHICH principal acted -- PROVIDER alone cannot tell two integrations apart'
);

select is(
  (select a.actor_user_id from audit.audit_events a
    join fx f on f.label = 'employee_api' and f.id = a.entity_id
   where a.event_type = 'EMPLOYEE_CREATED'),
  null::uuid,
  'no user id is attached to a machine event'
);

-- ---------------------------------------------------------------------------------------
-- 5. Idempotency
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_company_id uuid := (select id from fx where label = 'company_a');
  v_result jsonb;
begin
  -- Same key, same request hash: must replay, not re-execute.
  v_result := m2m_rpc.create_employee(
    'AAAAAAAAAAAAAAAA', encode(extensions.digest('secret-a', 'sha256'), 'base64'),
    'idem-create-employee-1', encode(extensions.digest('body-v1', 'sha256'), 'base64'),
    v_company_id, 'API Criado',
    encode(repeat('m', 32)::bytea, 'base64'), encode(repeat('z', 40)::bytea, 'base64'),
    '***.333.333-**');
  insert into probe values ('replay_flag', (v_result->>'replayed'));
  insert into probe values ('replay_id', (v_result->'body'->>'id'));

  -- Same key, DIFFERENT request hash: must conflict, and must not write.
  begin
    perform m2m_rpc.create_employee(
      'AAAAAAAAAAAAAAAA', encode(extensions.digest('secret-a', 'sha256'), 'base64'),
      'idem-create-employee-1', encode(extensions.digest('body-v2', 'sha256'), 'base64'),
      v_company_id, 'Outro Nome',
      encode(repeat('n', 32)::bytea, 'base64'), encode(repeat('z', 40)::bytea, 'base64'),
      '***.444.444-**');
    insert into probe values ('reuse', 'ALLOWED');
  exception when others then
    insert into probe values ('reuse', sqlerrm);
  end;
end $$;

select is((select val from probe where label = 'replay_flag'), 'true',
  'the same Idempotency-Key with the same body replays instead of re-executing');

select is(
  (select val from probe where label = 'replay_id'),
  (select id::text from fx where label = 'employee_api'),
  'the replay returns the ORIGINAL response, not a new resource'
);

select is((select val from probe where label = 'reuse'), 'idempotency_key_reuse',
  'the same Idempotency-Key with a different body is refused');

select is(
  (select count(*)::int from app.employees
    where company_id = (select id from fx where label = 'company_a')
      and full_name in ('API Criado', 'Outro Nome')),
  1,
  'after a replay and a rejected reuse, exactly ONE employee exists -- the assertion that would catch a duplicate write'
);

-- ---------------------------------------------------------------------------------------
-- 6. Quota
-- ---------------------------------------------------------------------------------------
do $$
begin
  -- Pre-loading the counter is equivalent to having made the calls, and keeps the suite
  -- from having to make 600 of them.
  insert into m2m.quota_counters (bucket_key, window_start, hits)
  values ('principal:c0000000-0000-4000-8000-000000000001:read', clock_timestamp(), 600)
  on conflict (bucket_key) do update set hits = 600, window_start = clock_timestamp();

  begin
    perform m2m_rpc.list_employees('AAAAAAAAAAAAAAAA',
      encode(extensions.digest('secret-a', 'sha256'), 'base64'),
      (select id from fx where label = 'company_a'));
    insert into probe values ('quota', 'ALLOWED');
  exception when others then
    insert into probe values ('quota', sqlerrm);
  end;
end $$;

select is((select val from probe where label = 'quota'), 'rate_limited',
  'the quota is enforced inside authorize, so no endpoint can forget to check it');

-- ---------------------------------------------------------------------------------------
-- 7. Reachability
-- ---------------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'm2m_rpc'
      and a.privilege_type = 'EXECUTE'
      and coalesce(pg_get_userbyid(a.grantee), 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC')),
  0,
  'no m2m_rpc function is executable by anon, authenticated or PUBLIC'
);

do $$
declare n bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  begin
    execute 'select count(*) from m2m.api_keys' into n;
    insert into probe values ('read_keys', 'READ ' || n);
  exception when others then
    insert into probe values ('read_keys', sqlstate);
  end;
  reset role;
end $$;

select is((select val from probe where label = 'read_keys'), '42501',
  'a logged-in human cannot read m2m.api_keys -- not even the hashes');

select ok(
  not has_schema_privilege('authenticated', 'm2m', 'usage')
  and not has_schema_privilege('anon', 'm2m', 'usage'),
  'neither browser role holds USAGE on the m2m schema'
);

select * from finish();

rollback;
