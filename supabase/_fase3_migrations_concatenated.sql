-- ===== 20260831170000_confirmation_schema.sql =====
-- FASE 3: confirmation_requests (Machine 1, docs/architecture.md §8), identity_verifications,
-- delivery_contests, the CONFIRMATION_REQUEST state machine, and the `worker` schema that
-- will hold the anon-callable SECURITY DEFINER functions (next migration).
--
-- Deliberate scope decision (documented in docs/mvp-roadmap.md FASE 3): the architecture's
-- `epi_worker_gw` dedicated Postgres role (§7, "reduzir ainda mais o raio de explosão") is
-- NOT created this phase. `anon` already has zero table grants anywhere in this schema --
-- the actual security invariant ("no id for an IDOR to substitute, only a token") is
-- enforced by every worker.* function taking a token hash and nothing else. A second custom
-- role would require a hand-rolled direct-Postgres connection (bypassing PostgREST/the
-- Supabase client entirely) purely for a defense-in-depth layer on top of an already-zero
-- ambient privilege -- real added complexity for marginal hardening. Left as a candidate for
-- later, not a gap: every write path below is still a token-gated SECURITY DEFINER function.

create schema if not exists worker;
comment on schema worker is
  'Anon-callable SECURITY DEFINER functions for the unauthenticated worker confirmation path (docs/architecture.md §7-8). Every function here takes a token hash, never an id -- there is no id in the contract for an IDOR to substitute. Exposed to PostgREST alongside `api` (see supabase/config.toml).';

revoke all on schema worker from public, authenticated;
grant usage on schema worker to anon;

create type app.confirmation_request_status as enum (
  'PENDING', 'SENT', 'VIEWED', 'IDENTITY_PENDING', 'IDENTITY_VERIFIED',
  'IDENTITY_FAILED', 'CONFIRMED', 'CONTESTED', 'DELIVERY_FAILED', 'EXPIRED', 'REVOKED'
);
comment on type app.confirmation_request_status is
  'The confirmation ATTEMPT lifecycle (docs/architecture.md §8, Machine 1) -- deliberately separate from app.delivery_status (Machine 2). PENDING/IDENTITY_PENDING/IDENTITY_VERIFIED/DELIVERY_FAILED are reserved for FASE 4+ (async notification queue, multi-step biometric provider round-trips) and are never produced by FASE 3''s own RPCs, kept in the enum now so a later phase does not need a type migration.';

-- Postgres rate-limit backstop (docs/architecture.md §8: "WAF + tabela Postgres UNLOGGED").
-- The Vercel WAF (free on every plan) is the first line for broad per-IP abuse; this table
-- is the atomic, no-read-then-write-race layer for limits tied to a specific token/IP that
-- must be checked in the same transaction as the row already being touched.
create unlogged table app.link_rate_limits (
  bucket_key   text primary key,
  window_start timestamptz not null default clock_timestamp(),
  hits         integer not null default 1
);
comment on table app.link_rate_limits is
  'UNLOGGED on purpose -- rate-limit state surviving a crash/restart is not a correctness requirement, and UNLOGGED avoids WAL overhead on a table written on every worker-path request.';
revoke all on app.link_rate_limits from authenticated, anon, public;

create function app.check_rate_limit(p_bucket_key text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hits int;
begin
  insert into app.link_rate_limits (bucket_key, window_start, hits)
  values (p_bucket_key, clock_timestamp(), 1)
  on conflict (bucket_key) do update
    set hits = case
                 when app.link_rate_limits.window_start < clock_timestamp() - make_interval(secs => p_window_seconds)
                   then 1
                 else app.link_rate_limits.hits + 1
               end,
        window_start = case
                 when app.link_rate_limits.window_start < clock_timestamp() - make_interval(secs => p_window_seconds)
                   then clock_timestamp()
                 else app.link_rate_limits.window_start
               end
  returning hits into v_hits;

  return v_hits <= p_limit;
end;
$$;
comment on function app.check_rate_limit(text, int, int) is
  'Atomic fixed-window counter via a single INSERT ... ON CONFLICT (no read-then-write race). Returns false once p_bucket_key has exceeded p_limit hits within the trailing p_window_seconds window.';

create table app.confirmation_requests (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  company_id               uuid not null,
  delivery_id              uuid not null,
  token_hash               bytea not null check (octet_length(token_hash) = 32),
  status                   app.confirmation_request_status not null default 'SENT',
  last_event               text,
  status_changed_at        timestamptz not null default clock_timestamp(),
  frozen_at                timestamptz,
  required_assurance_level app.assurance_level not null,
  achieved_assurance_level app.assurance_level,
  identity_attempts        smallint not null default 0 check (identity_attempts >= 0),
  identity_max_attempts    smallint not null default 5 check (identity_max_attempts > 0),
  action_nonce             bytea not null,
  nonce_consumed_at        timestamptz,
  viewed_at                timestamptz,
  confirmed_at             timestamptz,
  contested_at             timestamptz,
  expires_at               timestamptz not null,
  revoked_at               timestamptz,
  consumed_at              timestamptz,
  created_at               timestamptz not null default clock_timestamp(),
  created_by               uuid references app.users (id),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  foreign key (company_id, delivery_id) references app.epi_deliveries (company_id, id) on delete restrict,
  constraint confirmation_requests_id_company_key unique (id, company_id),
  constraint token_hash_unique unique (token_hash),
  constraint frozen_iff_settled check ((frozen_at is not null) = (status in ('CONFIRMED', 'CONTESTED'))),
  constraint confirmed_ts_ck check ((confirmed_at is not null) = (status = 'CONFIRMED')),
  constraint contested_ts_ck check ((contested_at is not null) = (status = 'CONTESTED')),
  constraint achieved_ge_required_ck check (status <> 'CONFIRMED' or achieved_assurance_level >= required_assurance_level)
);

comment on table app.confirmation_requests is
  'One confirmation ATTEMPT for a delivery -- a delivery can have several over time (expired link, resend). Never merged with epi_deliveries -- see docs/architecture.md §8 for why (a resend would otherwise overwrite the evidence of the first attempt). token_hash is the ONLY thing that ever crosses into Postgres for the raw token -- see src/lib/crypto/worker-token.ts; the pepper used to compute it lives outside Supabase Vault, in application env.';
comment on column app.confirmation_requests.action_nonce is
  'One-time-use action nonce (docs/architecture.md §8), reissued by worker.open_link on every successful view -- a stale rendered page''s nonce is superseded, not just already-consumed, the moment the link is opened again.';

-- Uso único no ato de confirmar/contestar: no more than one LIVE (not yet settled/expired/
-- revoked) request per delivery at a time -- structurally forces "todo reenvio roda o
-- token" (worker.create_confirmation_link revokes the old one in the same transaction).
create unique index confirmation_requests_one_live_per_delivery on app.confirmation_requests (delivery_id)
  where status in ('SENT', 'VIEWED', 'IDENTITY_FAILED');
-- The concurrency-proof half of "dupla confirmação concorrente": two simultaneous CONFIRM
-- calls both passing the row-level lock in worker.finish_confirmation is already prevented
-- by that function's SELECT ... FOR UPDATE, but this index is the second, independent line
-- of defense docs/architecture.md §8 point 3 calls for -- arithmetically impossible, not
-- just defended in application code.
create unique index confirmation_requests_one_confirmed_per_delivery on app.confirmation_requests (delivery_id)
  where status = 'CONFIRMED';
create index confirmation_requests_delivery_idx on app.confirmation_requests (delivery_id, created_at desc);

create trigger confirmation_requests_transition
  before update on app.confirmation_requests
  for each row execute function app.enforce_state_transition('CONFIRMATION_REQUEST');

-- No column-level write access at all for `authenticated` (manager reads it, never writes
-- it directly -- creation/revocation is api.create_confirmation_link) and none whatsoever
-- for `anon` (worker.* functions are SECURITY DEFINER, owned by the table owner, so they
-- write without needing a grant -- see docs/architecture.md §7).
revoke insert, update, delete on app.confirmation_requests from authenticated, anon;

alter table app.confirmation_requests enable row level security;
alter table app.confirmation_requests force row level security;

grant select on app.confirmation_requests to authenticated;

create policy confirmation_requests_select on app.confirmation_requests
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('delivery.read'))::uuid[]));

create table app.identity_verifications (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  company_id               uuid not null,
  delivery_id              uuid not null,
  confirmation_request_id  uuid not null,
  provider                 text not null default 'INTERNAL',
  method                   text not null check (method in ('LINK_ONLY', 'LINK_KNOWLEDGE', 'SELFIE_LIVENESS', 'FACE_MATCH_ENROLLED', 'GOV_VERIFIED')),
  result                   text not null check (result in ('PASS', 'FAIL')),
  achieved_assurance_level app.assurance_level not null,
  match_score              text check (match_score is null or match_score ~ '^[0-9]+(\.[0-9]+)?$'),
  image_sha256             bytea check (image_sha256 is null or octet_length(image_sha256) = 32),
  created_at               timestamptz not null default clock_timestamp(),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  foreign key (company_id, delivery_id) references app.epi_deliveries (company_id, id) on delete restrict,
  foreign key (confirmation_request_id) references app.confirmation_requests (id) on delete restrict
);

comment on table app.identity_verifications is
  'The RESULT of an identity check, never the raw biometric (docs/architecture.md §9/§16). method is LINK_ONLY/LINK_KNOWLEDGE in FASE 3 (AL0/AL1, non-biometric); SELFIE_LIVENESS/FACE_MATCH_ENROLLED/GOV_VERIFIED are reserved for FASE 4''s IdentityVerificationProvider adapters and are never produced yet. match_score is a fixed-decimal STRING, never float (rounding must never affect canonicalization later -- see §12), always null for the non-biometric methods this phase produces.';

create index identity_verifications_delivery_idx on app.identity_verifications (delivery_id);

revoke insert, update, delete on app.identity_verifications from authenticated, anon;

alter table app.identity_verifications enable row level security;
alter table app.identity_verifications force row level security;

grant select on app.identity_verifications to authenticated;

create policy identity_verifications_select on app.identity_verifications
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('delivery.read'))::uuid[]));

create table app.delivery_contests (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  company_id               uuid not null,
  delivery_id              uuid not null,
  confirmation_request_id  uuid not null,
  reason_code              text not null check (reason_code in ('NOT_RECEIVED', 'WRONG_ITEM', 'WRONG_QUANTITY', 'ALREADY_RETURNED', 'OTHER')),
  comment                  text check (comment is null or length(comment) <= 2000),
  raised_assurance_level   app.assurance_level not null,
  created_at               timestamptz not null default clock_timestamp(),
  resolved_at              timestamptz,
  resolved_by              uuid references app.users (id),
  resolution_note          text check (resolution_note is null or length(resolution_note) <= 2000),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  foreign key (company_id, delivery_id) references app.epi_deliveries (company_id, id) on delete restrict,
  foreign key (confirmation_request_id) references app.confirmation_requests (id) on delete restrict,
  constraint contest_other_needs_comment check (reason_code <> 'OTHER' or (comment is not null and length(btrim(comment)) >= 3)),
  constraint contest_resolution_ck check ((resolved_at is not null) = (resolved_by is not null))
);

comment on table app.delivery_contests is
  'Append-only: a worker''s "I did not receive this" (or wrong item/quantity/already returned) never counts as a confirmation -- docs/architecture.md §8. resolved_at/resolved_by/resolution_note are the ONLY mutable columns (a manager''s written response, CONTEST_RESPONDED in the audit trail), set once via api.resolve_contest, never overwriting the original reason/comment.';

create index delivery_contests_delivery_idx on app.delivery_contests (delivery_id);

revoke insert, delete on app.delivery_contests from authenticated, anon;
revoke update on app.delivery_contests from anon;

alter table app.delivery_contests enable row level security;
alter table app.delivery_contests force row level security;

grant select on app.delivery_contests to authenticated;

create policy delivery_contests_select on app.delivery_contests
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('delivery.read'))::uuid[]));

-- The CONFIRMATION_REQUEST machine (docs/architecture.md §8). SENT is the initial status,
-- set directly at INSERT (no transition-table lookup fires on INSERT, only UPDATE -- same
-- convention as epi_deliveries starting at DRAFT). IDENTITY_PENDING/IDENTITY_VERIFIED edges
-- are intentionally absent: FASE 3's identity check (a synchronous CPF-last-3-digits
-- knowledge challenge, see worker_rpcs.sql) resolves inside the SAME request as
-- VIEWED->CONFIRMED, with no separate async round-trip -- those two states exist in the
-- enum for FASE 4's biometric providers, which will need real transitions through them.
insert into app.state_transitions (machine, machine_version, from_state, event, to_state, actor_kinds, required_permission, is_terminal, introduced_in) values
  ('CONFIRMATION_REQUEST', 1, 'SENT',            'VIEW',               'VIEWED',         array['WORKER'], null, false, '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'SENT',            'EXPIRE',             'EXPIRED',        array['SYSTEM'], null, true,  '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'SENT',            'REVOKE',             'REVOKED',        array['USER'],   null, true,  '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'VIEWED',          'CONFIRM',            'CONFIRMED',      array['WORKER'], null, true,  '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'VIEWED',          'IDENTITY_FAIL',      'IDENTITY_FAILED', array['WORKER'], null, false, '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'VIEWED',          'CONTEST',            'CONTESTED',      array['WORKER'], null, true,  '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'VIEWED',          'EXPIRE',             'EXPIRED',        array['SYSTEM'], null, true,  '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'VIEWED',          'REVOKE',             'REVOKED',        array['USER'],   null, true,  '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'IDENTITY_FAILED', 'CONFIRM',            'CONFIRMED',      array['WORKER'], null, true,  '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'IDENTITY_FAILED', 'CONTEST',            'CONTESTED',      array['WORKER'], null, true,  '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'IDENTITY_FAILED', 'ATTEMPTS_EXHAUSTED', 'EXPIRED',        array['SYSTEM'], null, true,  '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'IDENTITY_FAILED', 'EXPIRE',             'EXPIRED',        array['SYSTEM'], null, true,  '20260831170000_confirmation_schema.sql'),
  ('CONFIRMATION_REQUEST', 1, 'IDENTITY_FAILED', 'REVOKE',             'REVOKED',        array['USER'],   null, true,  '20260831170000_confirmation_schema.sql');

-- ===== 20260831170100_audit_events.sql =====
-- FASE 3: audit.audit_events -- append-only, per-organization hash-chained (docs/architecture.md
-- §13). Full evidence sealing (RFC 8785 canonicalization, evidence.evidence_versions,
-- external timestamp anchor) is FASE 5 -- this is only the audit trail the roadmap requires
-- now ("eventos de todo passo do fluxo"), deliberately simpler than the eventual evidence
-- hash: this hash exists to make the audit log itself tamper-evident, not to be the
-- evidentiary payload hash a court would be shown.

create table audit.chain_heads (
  organization_id uuid primary key,
  last_seq        bigint not null default 0,
  last_hash       bytea
);
comment on table audit.chain_heads is
  'One row per organization: the tip of that org''s audit hash chain. Locked with SELECT ... FOR UPDATE inside app.log_audit_event to serialize concurrent inserts for the same org into a single well-defined sequence -- this table, not audit_events itself, is what makes the chain race-free.';
revoke all on audit.chain_heads from authenticated, anon, public;

create table audit.audit_events (
  id              uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  company_id      uuid,
  seq             bigint not null,
  event_type      text not null check (event_type ~ '^[A-Z][A-Z0-9_]{2,49}$'),
  entity_table    text,
  entity_id       uuid,
  actor_kind      text not null check (actor_kind in ('USER', 'WORKER', 'SYSTEM', 'PROVIDER', 'PLATFORM')),
  actor_user_id   uuid references app.users (id),
  data            jsonb not null default '{}'::jsonb check (pg_column_size(data) < 8000),
  prev_hash       bytea,
  event_hash      bytea not null,
  created_at      timestamptz not null default clock_timestamp(),
  primary key (id),
  constraint audit_events_org_seq_key unique (organization_id, seq)
);

comment on table audit.audit_events is
  'Append-only, chained per organization_id (not globally -- docs/architecture.md §13: exporting one tenant''s chain must not reveal another''s event count, and there is no single hot write point). Never in `data`: selfie, biometric, secret, full token, unnecessary full CPF -- the 8000-byte CHECK is a physical backstop against someone stuffing a blob in by mistake, not the primary control (the primary control is that no caller of app.log_audit_event ever has those values in scope to pass).';

create index audit_events_entity_idx on audit.audit_events (entity_table, entity_id);
create index audit_events_org_created_idx on audit.audit_events (organization_id, created_at desc);

-- Four independent immutability layers, per docs/architecture.md §12 (applied here to the
-- audit chain itself, one phase before evidence.* gets the same treatment in FASE 5):
-- (1) no DML grant to any role, including service_role; (2) a trigger that RAISEs even for
-- a superuser going around grants via psql; (3) `audit` is not in PGRST_DB_SCHEMAS, so no
-- HTTP endpoint reaches it at all; (4) hash chain makes tampering detectable after the fact.
revoke insert, update, delete, truncate on audit.audit_events from authenticated, anon, service_role, public;

create function audit.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit.% is append-only', TG_TABLE_NAME using errcode = '42501';
end;
$$;

create trigger audit_events_no_update_delete
  before update or delete on audit.audit_events
  for each row execute function audit.forbid_mutation();

alter table audit.audit_events enable row level security;
alter table audit.audit_events force row level security;
-- No policy at all: with RLS forced and zero policies, every role except the table owner
-- gets zero rows, unconditionally. Reads only ever happen through api.delivery_audit_events
-- (SECURITY DEFINER, next), which runs as the owner and is therefore exempt.

-- The single write path. Never exposed to PostgREST (lives in `app`, not `api`/`worker`,
-- and is granted to nobody) -- only callable from inside another SECURITY DEFINER
-- function's body, which executes as the function OWNER regardless of the original
-- caller's own grants (owners always have implicit EXECUTE on their own objects).
create function app.log_audit_event(
  p_organization_id uuid,
  p_company_id uuid,
  p_event_type text,
  p_entity_table text,
  p_entity_id uuid,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_data jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_prev_seq bigint;
  v_prev_hash bytea;
  v_seq bigint;
  v_hash bytea;
  v_created_at timestamptz := clock_timestamp();
begin
  insert into audit.chain_heads (organization_id) values (p_organization_id)
    on conflict (organization_id) do nothing;

  select last_seq, last_hash into v_prev_seq, v_prev_hash
  from audit.chain_heads where organization_id = p_organization_id
  for update;

  v_seq := v_prev_seq + 1;
  v_hash := extensions.digest(
    coalesce(v_prev_hash, ''::bytea) || v_seq::text || p_organization_id::text ||
    p_event_type || v_created_at::text || coalesce(p_entity_id::text, '') ||
    coalesce(p_actor_user_id::text, '') || coalesce(p_data::text, '{}'),
    'sha256'
  );

  insert into audit.audit_events (
    id, organization_id, company_id, seq, event_type, entity_table, entity_id,
    actor_kind, actor_user_id, data, prev_hash, event_hash, created_at
  ) values (
    gen_random_uuid(), p_organization_id, p_company_id, v_seq, p_event_type, p_entity_table, p_entity_id,
    p_actor_kind, p_actor_user_id, coalesce(p_data, '{}'::jsonb), v_prev_hash, v_hash, v_created_at
  ) returning id into v_id;

  update audit.chain_heads set last_seq = v_seq, last_hash = v_hash where organization_id = p_organization_id;

  return v_id;
end;
$$;

comment on function app.log_audit_event(uuid, uuid, text, text, uuid, text, uuid, jsonb) is
  'The only INSERT path into audit.audit_events. Called from inside api.*/worker.* RPCs after their own state change succeeds, in the SAME transaction -- if the caller''s transaction later rolls back, the audit row never existed, so the chain never has a gap.';

-- Manager-facing read: one timeline covering both a delivery''s own events and every
-- confirmation_request that has existed for it (a resend creates a NEW confirmation_request
-- row, so this UNION is needed to keep the timeline complete across resends).
create function api.delivery_audit_events(p_delivery_id uuid)
returns table (
  id uuid, seq bigint, event_type text, actor_kind text, actor_user_id uuid,
  data jsonb, created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  -- Table aliased and every column qualified throughout: RETURNS TABLE(id, ...) implicitly
  -- declares `id` (among others) as a PL/pgSQL variable in this function's own namespace,
  -- so an unqualified `id` below would be ambiguous with app.epi_deliveries.id -- a real
  -- bug caught only by actually executing this against PGlite, not by reading the code.
  select d.company_id into v_company_id from app.epi_deliveries d where d.id = p_delivery_id;
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'audit.read')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select ae.id, ae.seq, ae.event_type, ae.actor_kind, ae.actor_user_id, ae.data, ae.created_at
  from audit.audit_events ae
  where (ae.entity_table = 'epi_deliveries' and ae.entity_id = p_delivery_id)
     or (ae.entity_table in ('confirmation_requests', 'epi_delivery_items') and ae.entity_id in (
           select cr.id from app.confirmation_requests cr where cr.delivery_id = p_delivery_id
         ))
  order by ae.seq asc;
end;
$$;

comment on function api.delivery_audit_events(uuid) is
  'The full audit timeline for one delivery, across every confirmation_request it has ever had. Requires audit.read on the delivery''s company.';

revoke execute on function api.delivery_audit_events(uuid) from public, anon;
grant execute on function api.delivery_audit_events(uuid) to authenticated;

-- ===== 20260831170200_confirmation_manager_rpcs.sql =====
-- FASE 3: manager-facing RPC to (re)generate a worker confirmation link. Only the token
-- HASH ever reaches this function -- the raw token is generated in Node
-- (src/lib/crypto/worker-token.ts) and returned straight to the manager's browser response,
-- never stored server-side beyond that single response.
--
-- p_token_hash_b64 is base64 TEXT, not `bytea` directly -- same reasoning as
-- 20260831150200_employee_rpcs.sql's cpf_hash_b64/cpf_enc_b64: a PostgREST JSON-RPC call
-- would otherwise have to send Postgres's own hex-text bytea wire format (`\x...`), a
-- needless coupling to a Postgres-internal detail. decode(x, 'base64') below is exactly
-- what src/lib/crypto/worker-token.ts's Buffer.toString('base64') output expects.

create function api.create_confirmation_link(
  p_delivery_id uuid,
  p_token_hash_b64 text,
  p_ttl_hours int default null
)
returns table (confirmation_request_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_org_id uuid;
  v_status app.delivery_status;
  v_org_ttl int;
  v_required app.assurance_level;
  v_ttl int;
  v_expires timestamptz;
  v_id uuid;
  v_old record;
  v_token_hash bytea;
begin
  select company_id, organization_id, status into v_company_id, v_org_id, v_status
  from app.epi_deliveries where id = p_delivery_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.issue')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_status not in ('ISSUED', 'CONTESTED') then
    raise exception 'delivery_not_open_for_confirmation' using errcode = '23514';
  end if;

  v_token_hash := decode(p_token_hash_b64, 'base64');
  if octet_length(v_token_hash) <> 32 then
    raise exception 'invalid_token_hash' using errcode = '22023';
  end if;

  select link_ttl_hours, default_assurance_level into v_org_ttl, v_required
  from app.organizations where id = v_org_id;
  v_ttl := coalesce(p_ttl_hours, v_org_ttl, 168);
  v_expires := clock_timestamp() + make_interval(hours => v_ttl);

  -- Todo reenvio roda o token: revoke any still-live request for this delivery in the SAME
  -- transaction the new one is issued in (docs/architecture.md §8). The partial unique index
  -- confirmation_requests_one_live_per_delivery would reject the insert below otherwise.
  for v_old in
    select id from app.confirmation_requests
    where delivery_id = p_delivery_id and status in ('SENT', 'VIEWED', 'IDENTITY_FAILED')
    for update
  loop
    perform set_config('app.transition_ok', v_old.id::text, true);
    update app.confirmation_requests
    set status = 'REVOKED', last_event = 'REVOKE', revoked_at = clock_timestamp()
    where id = v_old.id;

    perform app.log_audit_event(v_org_id, v_company_id, 'CONFIRMATION_REVOKED', 'confirmation_requests', v_old.id, 'USER', (select auth.uid()), '{}'::jsonb);
  end loop;

  insert into app.confirmation_requests (
    organization_id, company_id, delivery_id, token_hash, status,
    required_assurance_level, action_nonce, expires_at, created_by
  ) values (
    v_org_id, v_company_id, p_delivery_id, v_token_hash, 'SENT',
    v_required, extensions.gen_random_bytes(16), v_expires, (select auth.uid())
  ) returning id into v_id;

  perform app.log_audit_event(v_org_id, v_company_id, 'CONFIRMATION_CREATED', 'confirmation_requests', v_id, 'USER', (select auth.uid()), jsonb_build_object('delivery_id', p_delivery_id));

  return query select v_id, v_expires;
end;
$$;

comment on function api.create_confirmation_link(uuid, text, int) is
  'Creates (or regenerates -- see the revoke loop) the confirmation_request for an ISSUED/CONTESTED delivery. Caller (Node) has already generated the raw token and hashed it; only the hash is ever passed here. The raw token/link is assembled and shown to the manager by the Server Action that calls this, never persisted server-side beyond that single response.';

revoke execute on function api.create_confirmation_link(uuid, text, int) from public, anon;
grant execute on function api.create_confirmation_link(uuid, text, int) to authenticated;

create function api.resolve_contest(p_contest_id uuid, p_resolution_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_delivery_id uuid;
begin
  select company_id, delivery_id into v_company_id, v_delivery_id
  from app.delivery_contests where id = p_contest_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.issue')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_resolution_note is null or length(btrim(p_resolution_note)) < 3 then
    raise exception 'resolution_note_required' using errcode = '23514';
  end if;

  update app.delivery_contests
  set resolved_at = clock_timestamp(), resolved_by = (select auth.uid()), resolution_note = p_resolution_note
  where id = p_contest_id and resolved_at is null;

  if not found then
    raise exception 'already_resolved' using errcode = '23514';
  end if;

  perform app.log_audit_event(
    (select organization_id from app.companies where id = v_company_id),
    v_company_id, 'CONTEST_RESPONDED', 'epi_deliveries', v_delivery_id, 'USER', (select auth.uid()),
    jsonb_build_object('contest_id', p_contest_id)
  );
end;
$$;

comment on function api.resolve_contest(uuid, text) is
  'Records the manager''s written response to a contest. Does not change delivery status (a REISSUE with a corrected delivery is the actual path past a contest, not built yet) -- this only closes the loop on "someone read this and responded", visible in the audit timeline.';

revoke execute on function api.resolve_contest(uuid, text) from public, anon;
grant execute on function api.resolve_contest(uuid, text) to authenticated;

-- ===== 20260831170300_worker_rpcs.sql =====
-- FASE 3: the anon-callable worker path. Every function here takes a token HASH (never an
-- id) as its sole means of identifying "which confirmation_request" -- see
-- docs/architecture.md §7-8. Raw tokens are hashed in Node (src/lib/crypto/worker-token.ts)
-- before ever reaching Postgres.
--
-- Every p_token_hash_b64 parameter below is base64 TEXT, not `bytea` directly -- same
-- reasoning as api.create_confirmation_link and 20260831150200_employee_rpcs.sql: a
-- PostgREST JSON-RPC call would otherwise have to send Postgres's own hex-text bytea wire
-- format, a needless coupling to a Postgres-internal detail.

create function worker.open_link(p_token_hash_b64 text, p_client_ip inet default null)
returns table (
  confirmation_request_id  uuid,
  view_status               app.confirmation_request_status,
  action_nonce              text,
  company_name              text,
  employee_full_name        text,
  delivery_date              date,
  note                       text,
  required_assurance_level  app.assurance_level,
  identity_attempts          smallint,
  identity_max_attempts     smallint,
  items                      jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req app.confirmation_requests%rowtype;
  v_token_hash bytea := decode(p_token_hash_b64, 'base64');
begin
  if not app.check_rate_limit('open:' || encode(v_token_hash, 'hex'), 20, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;
  if p_client_ip is not null and not app.check_rate_limit('open_ip:' || host(p_client_ip), 60, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;

  select * into v_req from app.confirmation_requests where token_hash = v_token_hash;

  -- Same generic outcome for "does not exist", "expired" and "revoked" -- only a request
  -- that WAS live and has just now lapsed gets the side effect of being flipped to EXPIRED
  -- below (lazy expiry, docs/architecture.md §8). CONFIRMED/CONTESTED are NOT an error --
  -- "depois do desfecho, a mesma URL passa a renderizar um recibo somente-leitura... nunca
  -- um erro" (§8): a worker who bookmarks/reopens the link after confirming finds their
  -- receipt, not a broken page. Token possession is already proven by the hash match at
  -- that point, so there is no anti-enumeration reason left to hide which terminal state.
  if not found or v_req.status in ('EXPIRED', 'REVOKED') then
    raise exception 'link_not_available' using errcode = 'P0002';
  end if;

  if v_req.status in ('CONFIRMED', 'CONTESTED') then
    perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'LINK_VIEWED', 'confirmation_requests', v_req.id, 'WORKER', null, jsonb_build_object('read_only', true));
    return query
    select
      v_req.id, v_req.status, null::text,
      coalesce(c.trade_name, c.legal_name), e.full_name, d.delivery_date, d.note,
      v_req.required_assurance_level, v_req.identity_attempts, v_req.identity_max_attempts,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'epi_name', i.epi_name, 'ca_number', i.ca_number, 'manufacturer', i.manufacturer,
          'model', i.model, 'quantity', i.quantity, 'unit', i.unit
        ) order by i.line_no), '[]'::jsonb)
        from app.epi_delivery_items i where i.delivery_id = d.id
      )
    from app.epi_deliveries d
    join app.companies c on c.id = d.company_id
    join app.employees e on e.id = d.employee_id
    where d.id = v_req.delivery_id;
    return;
  end if;

  if v_req.expires_at <= clock_timestamp() then
    perform set_config('app.transition_ok', v_req.id::text, true);
    update app.confirmation_requests set status = 'EXPIRED', last_event = 'EXPIRE' where id = v_req.id;
    perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'CONFIRMATION_EXPIRED', 'confirmation_requests', v_req.id, 'SYSTEM', null, '{}'::jsonb);
    raise exception 'link_not_available' using errcode = 'P0002';
  end if;

  if v_req.status = 'SENT' then
    perform set_config('app.transition_ok', v_req.id::text, true);
    update app.confirmation_requests
    set status = 'VIEWED', last_event = 'VIEW', viewed_at = clock_timestamp(),
        action_nonce = extensions.gen_random_bytes(16), nonce_consumed_at = null
    where id = v_req.id
    returning * into v_req;
  else
    -- Already VIEWED or IDENTITY_FAILED: re-viewing is legitimate and repeatable (a worker
    -- who lost signal reopens the link) -- same-status update, no transition-table lookup
    -- fires (see app.enforce_state_transition's early-exit branch). A fresh nonce is still
    -- issued so a stale earlier render of this same page can never submit successfully.
    update app.confirmation_requests
    set action_nonce = extensions.gen_random_bytes(16), nonce_consumed_at = null
    where id = v_req.id
    returning * into v_req;
  end if;

  perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'LINK_VIEWED', 'confirmation_requests', v_req.id, 'WORKER', null, '{}'::jsonb);

  return query
  select
    v_req.id,
    v_req.status,
    encode(v_req.action_nonce, 'base64'),
    coalesce(c.trade_name, c.legal_name),
    e.full_name,
    d.delivery_date,
    d.note,
    v_req.required_assurance_level, v_req.identity_attempts, v_req.identity_max_attempts,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'epi_name', i.epi_name, 'ca_number', i.ca_number, 'manufacturer', i.manufacturer,
        'model', i.model, 'quantity', i.quantity, 'unit', i.unit
      ) order by i.line_no), '[]'::jsonb)
      from app.epi_delivery_items i where i.delivery_id = d.id
    )
  from app.epi_deliveries d
  join app.companies c on c.id = d.company_id
  join app.employees e on e.id = d.employee_id
  where d.id = v_req.delivery_id;
end;
$$;

comment on function worker.open_link(text, inet) is
  'Every load of /e/<token> and /e/s/<view-id> calls this. Repeatable (viewing never consumes anything) -- reissues action_nonce every call so an old rendered page can never submit. Never reveals the CPF challenge material -- see worker.begin_confirmation.';

revoke execute on function worker.open_link(text, inet) from public, authenticated;
grant execute on function worker.open_link(text, inet) to anon;

-- Returns the encrypted CPF ciphertext so Node can decrypt it (CPF_ENCRYPTION_KEY lives
-- only in the Next.js server environment, never in Postgres) and compare the worker's typed
-- last 3 digits -- see docs/mvp-roadmap.md FASE 3 for why this is the chosen AL1 challenge.
-- The ciphertext is used once, in the same request, and discarded -- never sent to the
-- browser, never persisted anywhere beyond app.employees.cpf_enc itself.
--
-- Returned as base64 TEXT, not `bytea` -- PostgREST serializes a `bytea` OUTPUT column as
-- Postgres's own `\x...` hex-text wire format, not base64; src/app/e/s/[id]/actions.ts
-- decodes this value as base64 (matching src/lib/crypto/cpf-secrets.ts's own convention),
-- so returning raw bytea here silently fed the wrong bytes into AES-GCM decryption and
-- failed with "Unsupported state or unable to authenticate data" -- a real bug caught only
-- by live E2E testing against the actual Supabase client, not by local PGlite (which
-- returns bytea columns as raw bytes, not through PostgREST's JSON serialization at all).
create function worker.begin_confirmation(p_token_hash_b64 text, p_nonce text)
returns table (cpf_enc_b64 text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req app.confirmation_requests%rowtype;
  v_token_hash bytea := decode(p_token_hash_b64, 'base64');
begin
  if not app.check_rate_limit('begin:' || encode(v_token_hash, 'hex'), 20, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;

  select * into v_req from app.confirmation_requests where token_hash = v_token_hash;
  if not found or v_req.status not in ('VIEWED', 'IDENTITY_FAILED')
     or v_req.expires_at <= clock_timestamp()
     or v_req.nonce_consumed_at is not null
     or v_req.action_nonce is distinct from decode(p_nonce, 'base64')
  then
    raise exception 'link_not_available' using errcode = 'P0002';
  end if;
  if v_req.required_assurance_level <> 'AL1_LINK_KNOWLEDGE' then
    raise exception 'no_challenge_required' using errcode = '23514';
  end if;

  return query
  select encode(em.cpf_enc, 'base64')
  from app.epi_deliveries d
  join app.employees em on em.id = d.employee_id
  where d.id = v_req.delivery_id;
end;
$$;

comment on function worker.begin_confirmation(text, text) is
  'Read-only -- does NOT consume the nonce (worker.finish_confirmation does). Only called when required_assurance_level is AL1_LINK_KNOWLEDGE; an AL0_LINK_ONLY org''s worker flow never calls this at all, so cpf_enc is only ever fetched when a challenge is actually about to happen.';

revoke execute on function worker.begin_confirmation(text, text) from public, authenticated;
grant execute on function worker.begin_confirmation(text, text) to anon;

create function worker.finish_confirmation(
  p_token_hash_b64 text,
  p_nonce text,
  p_action text,
  p_identity_passed boolean default null,
  p_contest_reason_code text default null,
  p_contest_comment text default null
)
returns table (result text, delivery_status app.delivery_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req app.confirmation_requests%rowtype;
  v_achieved app.assurance_level;
  v_attempts int;
  v_token_hash bytea := decode(p_token_hash_b64, 'base64');
begin
  if p_action not in ('CONFIRM', 'CONTEST') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  if not app.check_rate_limit('finish:' || encode(v_token_hash, 'hex'), 20, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;

  select * into v_req from app.confirmation_requests where token_hash = v_token_hash for update;
  if not found or v_req.status not in ('VIEWED', 'IDENTITY_FAILED') or v_req.expires_at <= clock_timestamp() then
    raise exception 'link_not_available' using errcode = 'P0002';
  end if;

  -- One-time nonce, consumed here regardless of outcome (confirm, contest, or a failed
  -- identity attempt) -- a replayed/stale submission (same nonce twice) always fails from
  -- here on, forcing a fresh worker.open_link call and a fresh nonce.
  if v_req.nonce_consumed_at is not null or v_req.action_nonce is distinct from decode(p_nonce, 'base64') then
    raise exception 'stale_submission' using errcode = '40001';
  end if;
  update app.confirmation_requests set nonce_consumed_at = clock_timestamp() where id = v_req.id;

  if p_action = 'CONTEST' then
    if p_contest_reason_code is null then
      raise exception 'contest_reason_required' using errcode = '23514';
    end if;

    perform set_config('app.transition_ok', v_req.id::text, true);
    update app.confirmation_requests
    set status = 'CONTESTED', last_event = 'CONTEST', contested_at = clock_timestamp(),
        consumed_at = clock_timestamp(), frozen_at = clock_timestamp()
    where id = v_req.id;

    insert into app.delivery_contests (
      organization_id, company_id, delivery_id, confirmation_request_id,
      reason_code, comment, raised_assurance_level
    ) values (
      v_req.organization_id, v_req.company_id, v_req.delivery_id, v_req.id,
      p_contest_reason_code, p_contest_comment, coalesce(v_req.achieved_assurance_level, 'AL0_LINK_ONLY')
    );

    perform set_config('app.transition_ok', v_req.delivery_id::text, true);
    update app.epi_deliveries
    set status = 'CONTESTED', last_event = 'REQUEST_CONTESTED', contested_at = clock_timestamp(), frozen_at = clock_timestamp()
    where id = v_req.delivery_id;

    perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'DELIVERY_CONTESTED', 'epi_deliveries', v_req.delivery_id, 'WORKER', null,
      jsonb_build_object('reason_code', p_contest_reason_code));

    return query select 'CONTESTED'::text, 'CONTESTED'::app.delivery_status;
    return;
  end if;

  -- p_action = 'CONFIRM'. Não existe aresta para CONFIRMED que não passe por uma verificação
  -- de identidade registrada (docs/architecture.md §8) -- mesmo AL0_LINK_ONLY grava uma
  -- linha em identity_verifications, só que sem desafio nenhum.
  if v_req.required_assurance_level = 'AL0_LINK_ONLY' then
    v_achieved := 'AL0_LINK_ONLY';
  elsif v_req.required_assurance_level = 'AL1_LINK_KNOWLEDGE' then
    if p_identity_passed is null then
      raise exception 'identity_result_required' using errcode = '23514';
    end if;

    if not p_identity_passed then
      -- A wrong-digits attempt is an ordinary, expected OUTCOME of a successful call, not
      -- an error -- it must return normally, not RAISE. An uncaught RAISE EXCEPTION aborts
      -- the entire enclosing transaction in Postgres, which would silently undo the
      -- IDENTITY_FAILED update and the audit_event insert made just before it (a real bug,
      -- caught only by actually running this against PGlite and checking the row
      -- afterwards -- the earlier version of this function raised here and looked correct
      -- on inspection, but nothing it wrote ever actually persisted).
      v_attempts := v_req.identity_attempts + 1;
      if v_attempts >= v_req.identity_max_attempts then
        perform set_config('app.transition_ok', v_req.id::text, true);
        update app.confirmation_requests
        set status = 'EXPIRED', last_event = 'ATTEMPTS_EXHAUSTED', identity_attempts = v_attempts
        where id = v_req.id;
        perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'IDENTITY_FAILED', 'confirmation_requests', v_req.id, 'WORKER', null,
          jsonb_build_object('attempts', v_attempts, 'exhausted', true));
        return query select 'ATTEMPTS_EXHAUSTED'::text, null::app.delivery_status;
        return;
      end if;

      perform set_config('app.transition_ok', v_req.id::text, true);
      update app.confirmation_requests
      set status = 'IDENTITY_FAILED', last_event = 'IDENTITY_FAIL', identity_attempts = v_attempts
      where id = v_req.id;
      perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'IDENTITY_FAILED', 'confirmation_requests', v_req.id, 'WORKER', null,
        jsonb_build_object('attempts', v_attempts, 'exhausted', false));
      return query select 'IDENTITY_MISMATCH'::text, null::app.delivery_status;
      return;
    end if;

    v_achieved := 'AL1_LINK_KNOWLEDGE';
  else
    raise exception 'unsupported_assurance_level' using errcode = '0A000';
  end if;

  perform set_config('app.transition_ok', v_req.id::text, true);
  update app.confirmation_requests
  set status = 'CONFIRMED', last_event = 'CONFIRM', confirmed_at = clock_timestamp(),
      consumed_at = clock_timestamp(), frozen_at = clock_timestamp(), achieved_assurance_level = v_achieved
  where id = v_req.id;

  insert into app.identity_verifications (
    organization_id, company_id, delivery_id, confirmation_request_id,
    provider, method, result, achieved_assurance_level
  ) values (
    v_req.organization_id, v_req.company_id, v_req.delivery_id, v_req.id,
    'INTERNAL', case when v_achieved = 'AL0_LINK_ONLY' then 'LINK_ONLY' else 'LINK_KNOWLEDGE' end,
    'PASS', v_achieved
  );

  perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'IDENTITY_VERIFIED', 'confirmation_requests', v_req.id, 'WORKER', null,
    jsonb_build_object('achieved_assurance_level', v_achieved));

  perform set_config('app.transition_ok', v_req.delivery_id::text, true);
  update app.epi_deliveries
  set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = clock_timestamp(), frozen_at = clock_timestamp()
  where id = v_req.delivery_id;

  perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'DELIVERY_CONFIRMED', 'epi_deliveries', v_req.delivery_id, 'WORKER', null, '{}'::jsonb);

  return query select 'CONFIRMED'::text, 'CONFIRMED'::app.delivery_status;
end;
$$;

comment on function worker.finish_confirmation(text, text, text, boolean, text, text) is
  'The only mutating call on the worker path. CONTEST never requires identity (docs/architecture.md §8 -- blocking it would let an org suppress contestation by configuring a check the worker cannot pass). CONFIRM with AL1_LINK_KNOWLEDGE requires p_identity_passed, computed by Node from worker.begin_confirmation''s ciphertext -- Postgres only ever sees the boolean RESULT, never the CPF digits either party compared.';

revoke execute on function worker.finish_confirmation(text, text, text, boolean, text, text) from public, authenticated;
grant execute on function worker.finish_confirmation(text, text, text, boolean, text, text) to anon;

-- ===== 20260831170400_confirmation_api_views.sql =====
-- FASE 3: read-only projections for the delivery detail screen's confirmation/identity/
-- contest panels.

create view api.confirmation_requests
  with (security_invoker = true) as
select
  id, company_id, delivery_id, status, status_changed_at, required_assurance_level,
  achieved_assurance_level, identity_attempts, identity_max_attempts, viewed_at,
  confirmed_at, contested_at, expires_at, revoked_at, consumed_at, created_at, created_by
from app.confirmation_requests;

comment on view api.confirmation_requests is
  'Read-only projection -- token_hash, action_nonce never selected (there is no legitimate reason for the panel to see either). security_invoker means the underlying table''s RLS applies for the caller.';

grant select on api.confirmation_requests to authenticated;

create view api.identity_verifications
  with (security_invoker = true) as
select
  id, company_id, delivery_id, confirmation_request_id, provider, method, result,
  achieved_assurance_level, match_score, created_at
from app.identity_verifications;

comment on view api.identity_verifications is
  'Read-only projection -- image_sha256 (a hash pointer, not the image itself) is omitted; nothing here has ever been a raw biometric.';

grant select on api.identity_verifications to authenticated;

create view api.delivery_contests
  with (security_invoker = true) as
select
  id, company_id, delivery_id, confirmation_request_id, reason_code, comment,
  raised_assurance_level, created_at, resolved_at, resolved_by, resolution_note
from app.delivery_contests;

comment on view api.delivery_contests is
  'Read-only projection of contest history for a delivery. Writing resolved_at/resolved_by/resolution_note goes through api.resolve_contest, never a direct UPDATE.';

grant select on api.delivery_contests to authenticated;

