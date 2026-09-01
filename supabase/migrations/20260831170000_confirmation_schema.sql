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
