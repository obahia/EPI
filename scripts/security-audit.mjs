// Catalogue-level security audit of the whole schema, run against a real Postgres built from
// every migration in order. Written for the PILOT READINESS review: the questions it answers
// -- "is RLS forced on every business table", "does every SECURITY DEFINER function pin
// search_path", "what is anon allowed to execute" -- are exactly the ones a grep can only
// guess at, because a grep sees the migration text and not the state it produced.
//
// It reports facts and exits non-zero on a violation. It does not decide what is acceptable;
// the exceptions below are the ones this codebase argued for in writing, each with the
// document that argues it.
//
// Usage: node scripts/security-audit.mjs

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

let violations = 0;
function report(label, rows, expectation) {
  const ok = rows.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} -- ${label}`);
  if (!ok) {
    violations += 1;
    console.log(`        expected: ${expectation}`);
    for (const r of rows.slice(0, 25)) console.log(`        · ${JSON.stringify(r)}`);
    if (rows.length > 25) console.log(`        … and ${rows.length - 25} more`);
  }
  return ok;
}

function note(label, rows) {
  console.log(`INFO -- ${label}: ${rows.length}`);
  for (const r of rows.slice(0, 40)) console.log(`        · ${JSON.stringify(r)}`);
  if (rows.length > 40) console.log(`        … and ${rows.length - 40} more`);
}

async function q(sql) {
  const res = await db.query(sql);
  return res.rows;
}

async function main() {
  await db.exec(AUTH_STUB);
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  console.log(`Schema built from ${files.length} migrations.\n`);

  // -------------------------------------------------------------------------------------
  // 1. RLS
  // -------------------------------------------------------------------------------------
  console.log('--- RLS ---');

  const noRls = await q(`
    select n.nspname || '.' || c.relname as tbl, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and n.nspname in ('app','authz','evidence','audit','worker','integ','m2m','hooks')
       and not (c.relrowsecurity and c.relforcerowsecurity)
       -- authz.memberships is ENABLED but deliberately not FORCED. FORCE binds the table
       -- owner as well, and every auth_ctx.* helper is a SECURITY DEFINER function running AS
       -- the owner whose whole job is to read memberships across tenants to answer "which
       -- companies is this caller in". Forcing it would make those helpers return nothing and
       -- every policy in the product would deny everything. It is granted to no application
       -- role at all (proved by the next check), so nothing reaches it directly regardless.
       -- See docs/architecture.md §7.
       and not (n.nspname = 'authz' and c.relname = 'memberships' and c.relrowsecurity)
     order by 1`);
  report(
    'every table in a business schema has RLS ENABLED, and FORCED except where argued otherwise',
    noRls,
    'relrowsecurity and relforcerowsecurity true -- FORCE also binds the table owner, which is what a SECURITY DEFINER function runs as',
  );

  const grantedNoPolicy = await q(`
    select n.nspname || '.' || c.relname as tbl,
           string_agg(distinct a.privilege_type, ',') as privs
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      join pg_roles r on r.oid = a.grantee
     where c.relkind = 'r'
       and n.nspname in ('app','authz','evidence','audit','worker','integ','m2m','hooks')
       and r.rolname in ('authenticated','anon')
       and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
     group by 1 order by 1`);
  report(
    'no base table is granted to authenticated/anon without at least one policy',
    grantedNoPolicy,
    'a grant with no policy on a FORCED table denies everything, but the grant itself is a latent mistake',
  );

  // -------------------------------------------------------------------------------------
  // 2. SECURITY DEFINER + search_path
  // -------------------------------------------------------------------------------------
  console.log('\n--- SECURITY DEFINER / search_path ---');

  const definerNoPath = await q(`
    select n.nspname || '.' || p.proname as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef
       and n.nspname not in ('pg_catalog','information_schema','extensions','auth')
       and not exists (
         select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
          where cfg like 'search_path=%')
     order by 1`);
  report(
    'every SECURITY DEFINER function pins search_path',
    definerNoPath,
    "set search_path = '' -- without it a caller can shadow an unqualified name and run their own code as the owner",
  );

  const definerLoosePath = await q(`
    select n.nspname || '.' || p.proname as fn, cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral unnest(coalesce(p.proconfig, '{}')) cfg
     where p.prosecdef
       and n.nspname not in ('pg_catalog','information_schema','extensions','auth')
       and cfg like 'search_path=%'
       -- Postgres stores an EMPTY search_path in proconfig as the quoted empty string,
       -- search_path="" (quoted empty string), never as a bare search_path= . Comparing against the bare form
       -- flagged all 119 correctly-pinned functions on the first run of this script.
       and cfg not in ('search_path=', 'search_path=""')
     order by 1`);
  report(
    'and pins it to the EMPTY path, not a convenient one',
    definerLoosePath,
    "search_path='' exactly",
  );

  // -------------------------------------------------------------------------------------
  // 3. What anon can reach
  // -------------------------------------------------------------------------------------
  console.log('\n--- anon surface ---');

  const anonFns = await q(`
    select n.nspname || '.' || p.proname as fn
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      join pg_roles r on r.oid = a.grantee
     where r.rolname = 'anon' and a.privilege_type = 'EXECUTE'
       and n.nspname not in ('pg_catalog','information_schema','extensions','auth','graphql_public')
     order by 1`);
  note('functions executable by anon (the unauthenticated worker/verify surface)', anonFns);

  const anonTables = await q(`
    select n.nspname || '.' || c.relname as obj, a.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      join pg_roles r on r.oid = a.grantee
     where r.rolname = 'anon'
       and n.nspname not in ('pg_catalog','information_schema','extensions','auth','graphql_public')
     order by 1, 2`);
  report(
    'anon holds no direct table or view privilege anywhere',
    anonTables,
    'the unauthenticated worker path goes through SECURITY DEFINER functions only',
  );

  // -------------------------------------------------------------------------------------
  // 4. The append-only / immutable core
  // -------------------------------------------------------------------------------------
  console.log('\n--- immutability ---');

  const evidenceGrants = await q(`
    select n.nspname || '.' || c.relname as obj, r.rolname, a.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      join pg_roles r on r.oid = a.grantee
     where n.nspname in ('evidence','audit')
       and r.rolname in ('authenticated','anon','service_role')
     order by 1, 2`);
  report(
    'evidence.* and audit.* are granted to NO application role, including service_role',
    evidenceGrants,
    'the sealed record must not be reachable by a leaked key of any kind',
  );

  const mutationTriggers = await q(`
    select n.nspname || '.' || c.relname as tbl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('evidence','audit')
       and c.relkind = 'r'
       -- audit.chain_heads is the mutable head pointer, not the record: app.log_audit_event
       -- updates last_seq/last_hash on every append, so a no-UPDATE trigger there would stop
       -- the audit trail working at all.
       and not (n.nspname = 'audit' and c.relname = 'chain_heads')
       and not exists (
         select 1 from pg_trigger t
          where t.tgrelid = c.oid and not t.tgisinternal)
     order by 1`);
  report(
    'and every immutable table carries a trigger backstop against UPDATE/DELETE',
    mutationTriggers,
    'grants can be re-granted by a future migration; a trigger fails closed even against the owner, which is the layer that makes the immutability claim true rather than merely configured',
  );

  // -------------------------------------------------------------------------------------
  // 5. PII
  // -------------------------------------------------------------------------------------
  console.log('\n--- PII / CPF ---');

  const cpfColumns = await q(`
    select table_schema || '.' || table_name || '.' || column_name as col, data_type
      from information_schema.columns
     where column_name ilike '%cpf%'
       and table_schema not in ('pg_catalog','information_schema')
     order by 1`);
  note('every column whose name mentions CPF', cpfColumns);

  const plaintextCpf = await q(`
    select table_schema || '.' || table_name || '.' || column_name as col, data_type
      from information_schema.columns
     where column_name ilike '%cpf%'
       and data_type not in ('bytea')
       and column_name not ilike '%mask%'
       and column_name not ilike '%hash%'
       and column_name not ilike '%enc%'
       and table_schema not in ('pg_catalog','information_schema')
     order by 1`);
  report(
    'no CPF column stores anything but a hash, ciphertext or an explicit mask',
    plaintextCpf,
    'a plain CPF column would be readable in any dump',
  );

  // -------------------------------------------------------------------------------------
  // 6. Exposure surface
  // -------------------------------------------------------------------------------------
  console.log('\n--- exposed schemas ---');

  const exposed = await q(`
    select n.nspname as schema_name, count(*) filter (where c.relkind in ('r','v')) as relations,
           count(*) filter (where c.relkind = 'v') as views
      from pg_namespace n left join pg_class c on c.relnamespace = n.oid
     where n.nspname in ('api','worker','m2m_rpc','ops_rpc')
     group by 1 order by 1`);
  note('PostgREST-exposed schemas and their relation counts', exposed);

  const apiSecurityInvoker = await q(`
    select n.nspname || '.' || c.relname as view_name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'v' and n.nspname = 'api'
       and coalesce((select option_value from pg_options_to_table(c.reloptions)
                      where option_name = 'security_invoker'), 'false') <> 'true'
     order by 1`);
  report(
    'every api.* view runs with security_invoker, so the caller’s RLS applies',
    apiSecurityInvoker,
    'a view without it runs as its owner and silently bypasses every policy underneath',
  );

  console.log(
    `\n=== SECURITY AUDIT: ${violations === 0 ? 'NO VIOLATIONS' : violations + ' VIOLATION(S)'} ===`,
  );
  process.exit(violations === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(1);
});
