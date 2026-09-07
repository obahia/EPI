-- Phase F: the machine-to-machine plane. Principals, API keys, scopes, idempotency and
-- commercial quota. See the Phase F contract sections A, C, D, G, H.
--
-- THE CENTRAL RULE: an API key is NOT a user. Nothing here reads auth.uid(), and the four
-- existing auth_ctx helpers keep byte-identical bodies -- the machine path simply does not
-- call them. A machine's identity is resolved from the key material itself, inside Postgres,
-- exactly the way worker.* resolves a worker from a hashed token.
--
-- Why the key material and not a principal id: if an m2m_rpc function took a bare
-- p_principal_id, then anyone holding the database credential could declare themselves any
-- principal of any organization, and the only thing standing in the way would be the route
-- handler. Taking (key_id, secret_hash) instead means the database credential alone
-- authorizes nothing.

create schema if not exists m2m;
comment on schema m2m is
  'Machine-to-machine control plane: integration principals, API keys, idempotency ledger, quota counters. NEVER in PGRST_DB_SCHEMAS -- no HTTP endpoint reaches it. Distinct from `integ`, which is reserved for adapters where Selo CONSUMES an external system; this schema is the opposite direction.';

create schema if not exists m2m_rpc;
comment on schema m2m_rpc is
  'The only Phase F schema exposed to PostgREST. Functions only, zero tables. Every function authorizes from verified API key material before touching a domain core.';

-- Scopes are their own vocabulary, deliberately NOT authz.role_permissions (which governs
-- humans and must be free to evolve without silently widening what an existing key can do).
-- An enum gives allowlisting for free: writing an unknown scope fails at write time, not at
-- use time, and adding one is an explicit migration.
create type m2m.api_scope as enum (
  'employees:read',
  'employees:write',
  'positions:read',
  'locations:read',
  'epis:read',
  'deliveries:read'
);

comment on type m2m.api_scope is
  'Closed allowlist of API scopes. No wildcard, and no implicit hierarchy -- employees:write does NOT grant employees:read. A scope never changes meaning; widening it means a new scope, narrowing it means a new scope plus deprecation of the old one.';

-- ---------------------------------------------------------------------------------------
-- Principals
-- ---------------------------------------------------------------------------------------
create table m2m.integration_principals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete restrict,
  name            text not null check (length(btrim(name)) between 2 and 120),
  company_ids     uuid[],                                  -- NULL = every company of the org
  scopes          m2m.api_scope[] not null default '{}',
  status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  created_at      timestamptz not null default now(),
  created_by      uuid references app.users (id),
  revoked_at      timestamptz,
  revoked_by      uuid references app.users (id),
  constraint integration_principals_revoked_ck check ((status = 'REVOKED') = (revoked_at is not null)),
  constraint integration_principals_org_name_key unique (organization_id, name),
  constraint integration_principals_company_ids_ck check (company_ids is null or array_length(company_ids, 1) between 1 and 100)
);

comment on table m2m.integration_principals is
  'The machine subject. organization_id is immutable and is the outer tenant boundary; company_ids optionally narrows it further. Never a row in app.users, never a row in authz.memberships -- an API key is not a person and must not be able to masquerade as one in the audit trail.';
comment on column m2m.integration_principals.company_ids is
  'NULL means every company of the organization. A non-null array is a restriction, never an expansion -- every entry is re-validated against the organization at authorization time, so a stale id here can never widen access.';

create index integration_principals_org_idx on m2m.integration_principals (organization_id) where status = 'ACTIVE';

alter table m2m.integration_principals enable row level security;
alter table m2m.integration_principals force row level security;

-- ---------------------------------------------------------------------------------------
-- API keys
-- ---------------------------------------------------------------------------------------
create table m2m.api_keys (
  id            uuid primary key default gen_random_uuid(),
  principal_id  uuid not null references m2m.integration_principals (id) on delete restrict,
  key_id        text not null unique check (key_id ~ '^[0-9A-HJKMNP-TV-Z]{16}$'),
  secret_hash   bytea not null check (octet_length(secret_hash) = 32),
  env           text not null check (env in ('live', 'test')),
  created_at    timestamptz not null default now(),
  created_by    uuid references app.users (id),
  last_used_at  timestamptz,
  last_used_ip  inet,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid references app.users (id),
  revoke_reason text check (length(revoke_reason) <= 500)
);

comment on table m2m.api_keys is
  'The full key is `selo_<env>_<key_id>_<secret>`. Only key_id (public, indexed) and secret_hash are stored -- the secret itself is shown exactly once, at creation, and is unrecoverable afterwards by anyone including an ORG_ADMIN or a database reader. secret_hash is HMAC-SHA256 computed in Node with API_KEY_PEPPER, mirroring src/lib/crypto/worker-token.ts: the pepper deliberately lives outside Postgres, so a full database dump does not yield usable keys.';
comment on column m2m.api_keys.key_id is
  'Crockford base32 without I/L/O/U, 16 chars. Public: it appears in the panel, in logs and in audit events. Never enough to authenticate on its own.';

create index api_keys_principal_idx on m2m.api_keys (principal_id) where revoked_at is null;

alter table m2m.api_keys enable row level security;
alter table m2m.api_keys force row level security;

-- ---------------------------------------------------------------------------------------
-- Idempotency ledger (contract section G)
-- ---------------------------------------------------------------------------------------
create table m2m.idempotency_records (
  principal_id    uuid not null references m2m.integration_principals (id) on delete restrict,
  endpoint_key    text not null check (length(endpoint_key) between 3 and 120),
  idempotency_key text not null check (length(idempotency_key) between 8 and 255),
  organization_id uuid not null,
  request_hash    bytea not null check (octet_length(request_hash) = 32),
  status          text not null check (status in ('IN_FLIGHT', 'COMPLETED')),
  response_status int check (response_status between 100 and 599),
  response_body   jsonb,
  created_at      timestamptz not null default clock_timestamp(),
  completed_at    timestamptz,
  expires_at      timestamptz not null,
  primary key (principal_id, endpoint_key, idempotency_key),
  constraint idempotency_completed_ck check (
    (status = 'COMPLETED') = (completed_at is not null and response_status is not null)
  )
);

comment on table m2m.idempotency_records is
  'Scoped to (principal, endpoint, key) so one principal can never observe or collide with another''s traffic. A row is claimed, the domain runs, and the row is marked COMPLETED -- all in ONE transaction, so "the domain committed but the client never learned the outcome" is structurally impossible rather than merely unlikely. A consequence: IN_FLIGHT is never visible to another transaction (it only ever exists uncommitted), so no lease or expiry machinery is needed for crashed processes, and a failed domain operation leaves no record at all -- errors are re-executable rather than replayable.';

create index idempotency_records_expiry_idx on m2m.idempotency_records (expires_at);

alter table m2m.idempotency_records enable row level security;
alter table m2m.idempotency_records force row level security;

-- ---------------------------------------------------------------------------------------
-- Quota counters (contract section H)
-- ---------------------------------------------------------------------------------------
-- Deliberately LOGGED, unlike app.link_rate_limits which is UNLOGGED. The correct behaviour
-- on restart is opposite for the two dimensions: losing a security throttle opens a window
-- of seconds (acceptable); losing a commercial quota counter serves untracked traffic and
-- makes the invoice indefensible (not acceptable).
create table m2m.quota_counters (
  bucket_key   text primary key,
  window_start timestamptz not null,
  hits         int not null
);

comment on table m2m.quota_counters is
  'Durable commercial/abuse quota, counted per principal and per organization. See m2m.check_quota. app.check_rate_limit stays as-is for the short-window security throttle on the worker path -- two dimensions, two mechanisms, deliberately.';

alter table m2m.quota_counters enable row level security;
alter table m2m.quota_counters force row level security;

revoke all on all tables in schema m2m from authenticated, anon, service_role, public;

-- ---------------------------------------------------------------------------------------
-- Constant-time comparison
-- ---------------------------------------------------------------------------------------
-- bytea `=` is a memcmp and short-circuits on the first differing byte. For a 32-byte
-- secret hash behind a network hop that is not a practical oracle, but making it constant
-- time costs almost nothing here, so there is no reason to argue about it. Length is not
-- secret, so short-circuiting on length is fine.
create function m2m.ct_eq(a bytea, b bytea)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select octet_length(a) = octet_length(b)
     and 0 = coalesce(
       (select sum(case when get_byte(a, i) = get_byte(b, i) then 0 else 1 end)
          from generate_series(0, octet_length(a) - 1) as i),
       0);
$$;

comment on function m2m.ct_eq(bytea, bytea) is
  'Content-independent equality for equal-length bytea: always inspects every byte, no early exit.';

-- ---------------------------------------------------------------------------------------
-- Quota check -- same atomic single-statement shape as app.check_rate_limit (no
-- read-then-write race), but on a durable table.
-- ---------------------------------------------------------------------------------------
create function m2m.check_quota(p_bucket_key text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hits int;
begin
  insert into m2m.quota_counters (bucket_key, window_start, hits)
  values (p_bucket_key, clock_timestamp(), 1)
  on conflict (bucket_key) do update
    set hits = case
                 when m2m.quota_counters.window_start < clock_timestamp() - make_interval(secs => p_window_seconds)
                   then 1
                 else m2m.quota_counters.hits + 1
               end,
        window_start = case
                 when m2m.quota_counters.window_start < clock_timestamp() - make_interval(secs => p_window_seconds)
                   then clock_timestamp()
                 else m2m.quota_counters.window_start
               end
  returning hits into v_hits;

  return v_hits <= p_limit;
end;
$$;

comment on function m2m.check_quota(text, int, int) is
  'Durable fixed-window counter. Returns false once p_bucket_key exceeded p_limit hits inside the trailing window.';

revoke all on function m2m.check_quota(text, int, int) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- Principal resolution -- the single authorization entry point for every machine call
-- ---------------------------------------------------------------------------------------
create function m2m.resolve_principal(
  p_key_id text,
  p_secret_hash_b64 text
)
returns table (
  principal_id    uuid,
  organization_id uuid,
  company_ids     uuid[],
  scopes          m2m.api_scope[],
  api_key_id      uuid
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_provided bytea;
  v_row record;
begin
  v_provided := decode(p_secret_hash_b64, 'base64');
  if octet_length(v_provided) <> 32 then
    return;
  end if;

  select k.id as api_key_id, k.secret_hash, k.expires_at, k.revoked_at,
         p.id as principal_id, p.organization_id, p.company_ids, p.scopes, p.status
    into v_row
    from m2m.api_keys k
    join m2m.integration_principals p on p.id = k.principal_id
    join app.organizations o on o.id = p.organization_id
   where k.key_id = p_key_id;

  if not found then
    -- Equalise the cost of "unknown key_id" and "wrong secret": without this, response
    -- latency distinguishes the two and turns key_id into an enumerable oracle.
    perform m2m.ct_eq(v_provided, decode(repeat('00', 32), 'hex'));
    return;
  end if;

  if not m2m.ct_eq(v_row.secret_hash, v_provided) then
    return;
  end if;
  if v_row.revoked_at is not null then
    return;
  end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then
    return;
  end if;
  if v_row.status <> 'ACTIVE' then
    return;
  end if;

  return query select v_row.principal_id, v_row.organization_id, v_row.company_ids,
                      v_row.scopes, v_row.api_key_id;
end;
$$;

comment on function m2m.resolve_principal(text, text) is
  'Returns zero rows for EVERY failure mode -- unknown key, wrong secret, revoked key, expired key, revoked principal -- so the caller can only ever produce one indistinguishable 401. Never raises, never explains.';

revoke all on function m2m.resolve_principal(text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- Org-scoped permission helper
-- ---------------------------------------------------------------------------------------
-- Additive. The four existing auth_ctx helpers are NOT touched -- integration principals are
-- an organization-level object, and answering "may this user manage this ORGANIZATION's
-- integrations" with a company-scoped helper would let a COMPANY_ADMIN of one company
-- mint keys valid for the whole org.
create function auth_ctx.has_org_permission(p_organization_id uuid, p_permission text)
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select p_organization_id is not null and exists (
    select 1
    from authz.memberships m
    join authz.role_permissions rp on rp.role = m.role and rp.permission = p_permission
    where m.user_id = (select auth.uid())
      and m.revoked_at is null
      and m.company_id is null            -- org-wide membership only, never a single-company one
      and m.organization_id = p_organization_id
  );
$$;

comment on function auth_ctx.has_org_permission(uuid, text) is
  'True iff the current user holds p_permission through an ORG-WIDE membership (company_id IS NULL) of p_organization_id. Deliberately stricter than auth_ctx.has_permission: a company-scoped membership never satisfies it.';

grant execute on function auth_ctx.has_org_permission(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Permission seed: none needed.
-- ---------------------------------------------------------------------------------------
-- ('ORG_ADMIN', 'integration.manage') was already seeded in FASE 0
-- (20260831140300_users_memberships.sql:92), provisioned for exactly this phase and never
-- used until now. Re-inserting it violates role_permissions_pkey, so this migration only
-- documents that the permission is already in place -- and that ORG_ADMIN is the only role
-- that holds it, which is what auth_ctx.has_org_permission above relies on.
