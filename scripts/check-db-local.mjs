// Fast local sanity check for supabase/migrations, using PGlite (WASM Postgres) instead
// of the real Supabase stack. This is a DEVELOPER CONVENIENCE, not a substitute for CI:
// - it stubs a minimal auth.users table + auth.uid(), it does not run real GoTrue;
// - it has no pgTAP, so it cannot run supabase/tests/database/*.sql as written;
// - it does not check anything Supabase-CLI-specific (config.toml, seed.sql behaviour).
//
// What it DOES catch, in seconds, without Docker: every migration applying cleanly and in
// order from an empty database, plus the core two-tenant isolation property (a user of
// tenant A can read exactly tenant A's rows through api.*, and cannot reach app.organizations
// writes or authz.memberships at all). See docs/mvp-roadmap.md FASE 0 and the
// feedback-epi-no-docker memory for why this exists: Docker is not available on this
// machine, so `.github/workflows/ci.yml` (real `supabase start` + pgTAP) is the
// authoritative gate -- this script exists to shorten the feedback loop before pushing.
//
// Usage: npm run db:check:local

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { moddatetime } from '@electric-sql/pglite/contrib/moddatetime';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

const db = new PGlite({ extensions: { pgcrypto, citext, moddatetime, pg_trgm, unaccent } });

const AUTH_STUB = `
create schema if not exists auth;
create table auth.users (
  instance_id uuid, id uuid primary key, aud text, role text, email text,
  encrypted_password text, email_confirmed_at timestamptz, raw_app_meta_data jsonb,
  raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz,
  confirmation_token text, recovery_token text, email_change_token_new text,
  email_change text, is_sso_user boolean not null default false, is_anonymous boolean not null default false
);
create schema if not exists extensions;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$$;
create role authenticated;
create role anon;
create role service_role;
`;

let failures = 0;
function check(label, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' -- ' + label);
  if (!cond) failures++;
}

async function asUserQuery(sql, userId) {
  const results = await db.exec(`
    begin;
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"${userId}","role":"authenticated"}';
    ${sql};
    commit;
  `);
  return results[3];
}

async function asUserExpectError(sql, userId) {
  let threw = false;
  try {
    await db.exec(`
      begin;
      set local role authenticated;
      set local request.jwt.claims = '{"sub":"${userId}","role":"authenticated"}';
      ${sql};
      commit;
    `);
  } catch {
    threw = true;
    await db.query('rollback'); // batch's own commit was skipped after the error -- close it out
  }
  return threw;
}

async function main() {
  console.log(`Applying ${fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length} migrations from ${migrationsDir}\n`);
  await db.exec(AUTH_STUB);

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    process.stdout.write(`  ${f} ... `);
    try {
      await db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
      console.log('applied');
    } catch (err) {
      console.log('FAILED');
      console.error(err.message);
      process.exit(1);
    }
  }

  console.log('\nTwo-tenant isolation checks:');

  const A = '11111111-1111-1111-1111-111111111101';
  const B = '22222222-2222-2222-2222-222222222201';

  await db.exec(`
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, is_sso_user, is_anonymous) values
      ('00000000-0000-0000-0000-000000000000','${A}','authenticated','authenticated','admin-a@tenant-a.test', extensions.crypt('x', extensions.gen_salt('bf')), now(), '{}', '{"full_name":"Admin A"}', now(), now(), '', '', '', '', false, false),
      ('00000000-0000-0000-0000-000000000000','${B}','authenticated','authenticated','admin-b@tenant-b.test', extensions.crypt('x', extensions.gen_salt('bf')), now(), '{}', '{"full_name":"Admin B"}', now(), now(), '', '', '', '', false, false);
    insert into app.organizations (id, kind, legal_name, cnpj) values
      ('aaaaaaaa-0000-0000-0000-00000000000a','DIRECT','Empresa Tenant A','11111111000191'),
      ('bbbbbbbb-0000-0000-0000-00000000000b','DIRECT','Empresa Tenant B','22222222000172');
    insert into app.companies (id, organization_id, organization_kind, cnpj, legal_name) values
      ('aaaaaaaa-1111-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-00000000000a','DIRECT','11111111000191','Empresa Tenant A'),
      ('bbbbbbbb-1111-0000-0000-00000000000b','bbbbbbbb-0000-0000-0000-00000000000b','DIRECT','22222222000172','Empresa Tenant B');
    insert into authz.memberships (user_id, organization_id, company_id, role, accepted_at) values
      ('${A}','aaaaaaaa-0000-0000-0000-00000000000a', null, 'ORG_ADMIN', now()),
      ('${B}','bbbbbbbb-0000-0000-0000-00000000000b', null, 'ORG_ADMIN', now());
  `);

  const orgsAsA = await asUserQuery('select id from api.organizations', A);
  check('tenant A sees exactly its own organization', orgsAsA.rows.length === 1 && orgsAsA.rows[0].id === 'aaaaaaaa-0000-0000-0000-00000000000a');

  const companiesAsA = await asUserQuery('select id from api.companies', A);
  check('tenant A sees exactly its own company', companiesAsA.rows.length === 1 && companiesAsA.rows[0].id === 'aaaaaaaa-1111-0000-0000-00000000000a');

  const usersAsA = await asUserQuery('select id from api.users', A);
  check('tenant A cannot see tenant B via api.users', !usersAsA.rows.some((r) => r.id === B));

  check('authenticated cannot INSERT into app.organizations', await asUserExpectError(`insert into app.organizations (kind, legal_name) values ('DIRECT', 'x')`, A));
  check('authenticated cannot UPDATE app.organizations directly', await asUserExpectError(`update app.organizations set legal_name = 'x' where id = 'aaaaaaaa-0000-0000-0000-00000000000a'`, A));
  check('authenticated cannot read authz.memberships directly', await asUserExpectError('select 1 from authz.memberships limit 1', A));

  const orgsAsB = await asUserQuery('select id from api.organizations', B);
  check("tenant B sees exactly its own organization, not A's", orgsAsB.rows.length === 1 && orgsAsB.rows[0].id === 'bbbbbbbb-0000-0000-0000-00000000000b');

  console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`);
  console.log('(This is a local PGlite smoke test, not the real Supabase stack -- CI is the authoritative gate.)');
  process.exit(failures === 0 ? 0 : 1);
}

main();
