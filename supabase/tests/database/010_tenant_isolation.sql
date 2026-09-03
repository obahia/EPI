-- Definition of Done item 14, expressed as a test rather than a promise: two synthetic
-- tenants with overlapping data shapes; a user of tenant A must see exactly tenant A's
-- rows through every FASE-0 table, and must be structurally unable to reach tenant B's
-- data or the authz.* internals, regardless of RLS (i.e. even where the base GRANT itself
-- is what's stopping them, not merely a policy). See docs/architecture.md §7.

create extension if not exists pgtap with schema extensions;

begin;

select plan(11);

-- ---------------------------------------------------------------------------
-- Fixtures. Inserted as the migration/superuser role, which bypasses RLS as the
-- table owner -- this is the standard pgTAP pattern: set up state with full privilege,
-- then switch role to prove what a restricted role can and cannot see.
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111101',
   'authenticated', 'authenticated', 'admin-a@tenant-a.test',
   extensions.crypt('test-password-a', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Admin Tenant A"}',
   now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222201',
   'authenticated', 'authenticated', 'admin-b@tenant-b.test',
   extensions.crypt('test-password-b', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Admin Tenant B"}',
   now(), now(), '', '', '', '', false, false);
-- app.users rows for both are created automatically by the app.handle_new_auth_user()
-- trigger (FASE 0 migration 20260831140300).

insert into app.organizations (id, kind, legal_name, cnpj) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'DIRECT', 'Empresa Tenant A LTDA', '11111111000191'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'DIRECT', 'Empresa Tenant B LTDA', '22222222000172');

insert into app.companies (id, organization_id, organization_kind, cnpj, legal_name) values
  ('aaaaaaaa-1111-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'DIRECT', '11111111000191', 'Empresa Tenant A LTDA'),
  ('bbbbbbbb-1111-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-00000000000b', 'DIRECT', '22222222000172', 'Empresa Tenant B LTDA');

insert into authz.memberships (user_id, organization_id, company_id, role, accepted_at) values
  ('11111111-1111-1111-1111-111111111101', 'aaaaaaaa-0000-0000-0000-00000000000a', null, 'ORG_ADMIN', now()),
  ('22222222-2222-2222-2222-222222222201', 'bbbbbbbb-0000-0000-0000-00000000000b', null, 'ORG_ADMIN', now());

-- ---------------------------------------------------------------------------
-- Act as user A (org-wide ORG_ADMIN of tenant A only).
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111101","role":"authenticated"}';

select results_eq(
  $$ select id from api.organizations order by id $$,
  $$ values ('aaaaaaaa-0000-0000-0000-00000000000a'::uuid) $$,
  'tenant A user sees exactly tenant A''s organization via api.organizations, never tenant B''s'
);

select results_eq(
  $$ select id from api.companies order by id $$,
  $$ values ('aaaaaaaa-1111-0000-0000-00000000000a'::uuid) $$,
  'tenant A user sees exactly tenant A''s company via api.companies, never tenant B''s'
);

select results_eq(
  $$ select organization_id from api.my_memberships() $$,
  $$ values ('aaaaaaaa-0000-0000-0000-00000000000a'::uuid) $$,
  'api.my_memberships() returns exactly the caller''s own membership'
);

select ok(
  (select bool_or(id = '22222222-2222-2222-2222-222222222201') from api.users) is not true,
  'tenant A user cannot see tenant B''s user via api.users (no shared organization)'
);

select ok(
  (select bool_or(id = '11111111-1111-1111-1111-111111111101') from api.users),
  'tenant A user can see themself via api.users'
);

-- Every throws_ok() below passes NULL as the third (errmsg) argument on purpose: pgTAP's
-- 3-argument form throws_ok(sql, errcode, X) treats X as the EXACT expected error message
-- to compare against the raised one, not as a free-text description (confirmed against
-- pgtap.org's own docs, which give NULL specifically as "one trick... allows you to still
-- pass a description as the fourth argument"). Every call in this suite was written with a
-- long, human-readable sentence in that slot -- never intended as literal Postgres error
-- text -- so all of them failed on message mismatch despite the SQLSTATE itself being
-- exactly right, undetected until CI actually ran this suite against a real Postgres.
select throws_ok(
  $$ insert into app.organizations (kind, legal_name) values ('DIRECT', 'Escaped Org') $$,
  '42501',
  NULL,
  'authenticated cannot INSERT into app.organizations directly (no grant, no policy -- creation is RPC-only, later phase)'
);

select throws_ok(
  $$ update app.organizations set legal_name = 'Renamed' where id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  '42501',
  NULL,
  'authenticated cannot UPDATE app.organizations directly, even its own row (UPDATE fully revoked -- mass-assignment defence)'
);

select throws_ok(
  $$ select 1 from authz.memberships limit 1 $$,
  '42501',
  NULL,
  'authenticated cannot read authz.memberships directly under any circumstance -- structurally unreachable, not merely unpolicied'
);

select throws_ok(
  $$ select 1 from evidence.evidence_versions limit 1 $$,
  '42501',  -- FASE 5 created evidence.evidence_versions (20260831190000_evidence_schema.sql)
            -- and it is, correctly, structurally unreachable to authenticated -- this
            -- assertion's own comment predicted exactly this update, once that table
            -- existed to raise permission_denied instead of undefined_table.
  NULL,
  'evidence.evidence_versions exists (FASE 5) but remains unreachable to authenticated (no grant)'
);

reset role;

-- ---------------------------------------------------------------------------
-- Act as user B: symmetric check in the other direction.
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222201","role":"authenticated"}';

select results_eq(
  $$ select id from api.organizations order by id $$,
  $$ values ('bbbbbbbb-0000-0000-0000-00000000000b'::uuid) $$,
  'tenant B user sees exactly tenant B''s organization, never tenant A''s'
);

select ok(
  (select bool_or(id = '11111111-1111-1111-1111-111111111101') from api.users) is not true,
  'tenant B user cannot see tenant A''s user via api.users'
);

reset role;

select * from finish();

rollback;
