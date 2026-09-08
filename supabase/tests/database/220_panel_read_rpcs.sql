-- Phase F: the panel-facing read RPCs. This suite exists because a live end-to-end run
-- found all three of them broken on EVERY call -- a RETURNS TABLE OUT parameter named `id`
-- shadowing the column in an unqualified `where id = ...`, which Postgres rejects with
-- 42702. The same class of bug has now hit this codebase four times.
--
-- The lesson encoded here: it is not enough to assert that a read returns the RIGHT rows.
-- These functions have to be CALLED, because the failure mode is that they cannot run at
-- all -- and a suite that only checks grants and shapes never calls them.

create extension if not exists pgtap with schema extensions;

begin;

select plan(19);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-00000000000d',
   'authenticated', 'authenticated', 'admin-panel@tenant.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Panel Admin"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'd2000000-0000-4000-8000-00000000000e',
   'authenticated', 'authenticated', 'outsider-panel@nowhere.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Outsider"}', now(), now(), '', '', '', '', false, false);

create temporary table fx (label text primary key, id uuid not null);
grant all on fx to authenticated;
create temporary table probe (label text primary key, val text);
grant all on probe to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
  select company_id into v_company_id
  from api.onboard_organization('Panel LTDA', '99000111000155', 'Panel LTDA', '99000111000155', null);
  insert into fx values ('company', v_company_id);
  reset role;
end $$;

insert into fx select 'org', organization_id from app.companies where id = (select id from fx where label = 'company');

-- ---------------------------------------------------------------------------------------
-- Fixtures created through the real write RPCs, not by direct insert -- the point is that
-- the whole panel round trip works, not just the reads in isolation.
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_principal uuid;
  v_endpoint uuid;
  v_run uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);

  select api.create_integration_principal(
    (select id from fx where label = 'org'), 'Painel', null,
    array['employees:read', 'deliveries:read']) into v_principal;
  insert into fx values ('principal', v_principal);

  -- 'PANELPANELPANEL1' was rejected by api_keys_key_id_check: Crockford base32 excludes
  -- I, L, O and U so a key read aloud cannot be mistyped into a different valid key, and
  -- "PANEL" contains an L. The fixture violated the very constraint this phase added.
  perform api.create_api_key(v_principal, 'PANEKPANEKPANEK1',
    encode(extensions.digest('panel-secret', 'sha256'), 'base64'), 'live', null);

  select api.create_webhook_endpoint(
    (select id from fx where label = 'org'), 'https://painel.example.com/hook',
    encode(repeat('w', 40)::bytea, 'base64'), array['delivery.confirmed'], 'painel', false)
  into v_endpoint;
  insert into fx values ('endpoint', v_endpoint);

  select api.start_import_run((select id from fx where label = 'company'),
    'CSV', 'quadro.csv', null, '{"cpf":"CPF"}'::jsonb, 5, 5, 0, 2000, 1) into v_run;
  insert into fx values ('run', v_run);
  reset role;
end $$;

-- ---------------------------------------------------------------------------------------
-- 1. Each read RPC actually RUNS. Before the fix, every one of these raised 42702.
-- ---------------------------------------------------------------------------------------
do $$
declare n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);

  begin
    select count(*)::int into n from api.list_api_keys((select id from fx where label = 'principal'));
    insert into probe values ('list_api_keys', n::text);
  exception when others then
    insert into probe values ('list_api_keys', 'ERROR ' || sqlstate || ' ' || sqlerrm);
  end;

  begin
    select count(*)::int into n from api.list_webhook_deliveries((select id from fx where label = 'endpoint'), null, 50);
    insert into probe values ('list_webhook_deliveries', n::text);
  exception when others then
    insert into probe values ('list_webhook_deliveries', 'ERROR ' || sqlstate || ' ' || sqlerrm);
  end;

  begin
    select count(*)::int into n from api.import_run_status((select id from fx where label = 'run'));
    insert into probe values ('import_run_status', n::text);
  exception when others then
    insert into probe values ('import_run_status', 'ERROR ' || sqlstate || ' ' || sqlerrm);
  end;

  begin
    select count(*)::int into n from api.list_integration_principals((select id from fx where label = 'org'));
    insert into probe values ('list_integration_principals', n::text);
  exception when others then
    insert into probe values ('list_integration_principals', 'ERROR ' || sqlstate || ' ' || sqlerrm);
  end;

  begin
    select count(*)::int into n from api.list_webhook_endpoints((select id from fx where label = 'org'));
    insert into probe values ('list_webhook_endpoints', n::text);
  exception when others then
    insert into probe values ('list_webhook_endpoints', 'ERROR ' || sqlstate || ' ' || sqlerrm);
  end;
  reset role;
end $$;

select is((select val from probe where label = 'list_api_keys'), '1',
  'api.list_api_keys runs and returns the key (it raised 42702 before the ambiguity fix)');
select is((select val from probe where label = 'list_webhook_deliveries'), '0',
  'api.list_webhook_deliveries runs -- zero rows is the correct answer here, an error is not');
select is((select val from probe where label = 'import_run_status'), '1',
  'api.import_run_status runs and returns the run');
select is((select val from probe where label = 'list_integration_principals'), '1',
  'api.list_integration_principals runs');
select is((select val from probe where label = 'list_webhook_endpoints'), '1',
  'api.list_webhook_endpoints runs');

-- ---------------------------------------------------------------------------------------
-- 2. The secret material is absent from the returned shape, not merely unselected.
-- ---------------------------------------------------------------------------------------
select is(
  (select count(*)::int from information_schema.parameters
    where specific_schema = 'api'
      and specific_name like 'list_api_keys%'
      and parameter_name in ('secret_hash', 'secret_enc', 'secret_prev_enc')),
  0,
  'api.list_api_keys has no secret column in its RETURNS list at all'
);

select is(
  (select count(*)::int from information_schema.parameters
    where specific_schema = 'api'
      and specific_name like 'list_webhook_endpoints%'
      and parameter_name in ('secret_enc', 'secret_prev_enc')),
  0,
  'api.list_webhook_endpoints never returns the webhook signing secret, not even as ciphertext'
);

-- ---------------------------------------------------------------------------------------
-- 3. Authorization: org-wide ORG_ADMIN only
-- ---------------------------------------------------------------------------------------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d2000000-0000-4000-8000-00000000000e","role":"authenticated"}', true);

  begin
    perform api.list_api_keys((select id from fx where label = 'principal'));
    insert into probe values ('outsider_keys', 'ALLOWED');
  exception when others then
    insert into probe values ('outsider_keys', sqlstate);
  end;

  begin
    perform api.list_webhook_endpoints((select id from fx where label = 'org'));
    insert into probe values ('outsider_endpoints', 'ALLOWED');
  exception when others then
    insert into probe values ('outsider_endpoints', sqlstate);
  end;

  begin
    perform api.create_integration_principal((select id from fx where label = 'org'), 'Intruso', null, '{}');
    insert into probe values ('outsider_create', 'ALLOWED');
  exception when others then
    insert into probe values ('outsider_create', sqlstate);
  end;
  reset role;
end $$;

select is((select val from probe where label = 'outsider_keys'), '42501',
  'a user with no membership cannot list another organization''s API keys');
select is((select val from probe where label = 'outsider_endpoints'), '42501',
  'nor its webhook endpoints');
select is((select val from probe where label = 'outsider_create'), '42501',
  'nor create a principal in it');

-- ---------------------------------------------------------------------------------------
-- 4. An unknown scope is rejected at write time, not silently stored
-- ---------------------------------------------------------------------------------------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
  begin
    perform api.create_integration_principal(
      (select id from fx where label = 'org'), 'Escopo Inventado', null, array['employees:delete']);
    insert into probe values ('bad_scope', 'ALLOWED');
  exception when others then
    insert into probe values ('bad_scope', sqlerrm);
  end;
  reset role;
end $$;

select is((select val from probe where label = 'bad_scope'), 'unknown_scope',
  'a scope outside the m2m.api_scope allowlist is refused when written, not when used');


-- ---------------------------------------------------------------------------------------
-- 5. The webhook URL policy must live in the DATABASE, not only in the Server Action.
--    api.create_webhook_endpoint is granted to `authenticated`, so an ORG_ADMIN calling it
--    straight through PostgREST skipped checkWebhookUrl entirely -- a real bypass found by
--    an end-to-end run, which stored an IP literal, an internal host and a non-443 port.
-- ---------------------------------------------------------------------------------------
select ok(hooks.is_public_https_url('https://hooks.example.com/selo'),
  'a normal public https URL is accepted');

select ok(not hooks.is_public_https_url('http://hooks.example.com/selo'),
  'http is refused -- a signed payload sent in cleartext is an unsigned payload with extra steps');

select ok(not hooks.is_public_https_url('https://93.184.216.34/hook'),
  'an IPv4 literal is refused');

select ok(not hooks.is_public_https_url('https://[2606:2800:220:1:248:1893:25c8:1946]/hook'),
  'an IPv6 literal is refused');

select ok(not hooks.is_public_https_url('https://user:pw@hooks.example.com/hook'),
  'credentials embedded in the URL are refused');

select ok(not hooks.is_public_https_url('https://hooks.example.com:8443/hook'),
  'a port other than 443 is refused');

select ok(not hooks.is_public_https_url('https://api.internal/hook')
      and not hooks.is_public_https_url('https://localhost/hook')
      and not hooks.is_public_https_url('https://intranet/hook'),
  'internal hostnames are refused');

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
  begin
    -- Straight at the RPC, exactly as the bypass did.
    perform api.create_webhook_endpoint(
      (select id from fx where label = 'org'), 'https://93.184.216.34/hook',
      encode(repeat('w',40)::bytea,'base64'), '{}', null, false);
    insert into probe values ('rpc_ip_literal', 'ACEITOU');
  exception when others then
    insert into probe values ('rpc_ip_literal', sqlerrm);
  end;
  reset role;
end $$;

select is((select val from probe where label = 'rpc_ip_literal'), 'invalid_webhook_url',
  'api.create_webhook_endpoint itself refuses an IP literal -- the policy is no longer only in TypeScript');


select * from finish();

rollback;
