-- Phase F: webhooks. audit.audit_events is the canonical source; hooks.outbox is a
-- projection of it, enqueued by a trigger inside the SAME transaction as the business
-- change (contract sections I, J).
--
-- WHY A TRIGGER AND NOT POLLING. Polling audit_events with a `seq > watermark` cursor is not
-- merely crude, it is incorrect: seq is assigned under a lock on audit.chain_heads, but
-- transactions COMMIT in arbitrary order, so a poller that has read up to seq=100 can
-- permanently miss an event with seq=97 whose transaction committed afterwards. Silent
-- event loss. A trigger has no such window -- the outbox row and the audit row commit or
-- vanish together, and hooks.outbox.audit_event_id is a foreign key to a table that can
-- never be deleted, so it can never dangle.
--
-- WHY NOT pg_net / an Edge Function. Both put network I/O inside Postgres. The hard rule
-- from the contract is that worker.finish_confirmation never performs external I/O; keeping
-- the capability out of the database entirely is stronger than promising not to use it.
-- The only thing this migration adds inside a business transaction is one INSERT.

create schema if not exists hooks;
comment on schema hooks is
  'Outbound integration plane: webhook endpoints, the audit-event outbox, per-endpoint deliveries and their HTTP attempts. NEVER in PGRST_DB_SCHEMAS. Separate from m2m (the inbound plane) so compromising one does not read the other -- notably, nothing here can read an API key hash.';

create schema if not exists ops_rpc;
comment on schema ops_rpc is
  'Operator-plane RPCs for the webhook runner and periodic cleanup. Exposed to PostgREST for service_role only; the internal route that calls it validates the scheduler secret first. Unlike m2m_rpc there is no third-party principal here -- these are operations on our own queue, not on a tenant''s behalf.';

-- ---------------------------------------------------------------------------------------
-- Which audit events are publishable, and under what public name
-- ---------------------------------------------------------------------------------------
create table hooks.event_types (
  audit_event_type text primary key,
  webhook_type     text not null unique
);

comment on table hooks.event_types is
  'The closed mapping from internal audit event type to public webhook type. An audit event whose type is absent here is NEVER enqueued -- this table is the enqueue allowlist as well as the naming table. Adding a row is a deliberate migration, not a config change.';

insert into hooks.event_types (audit_event_type, webhook_type) values
  ('DELIVERY_CREATED',   'delivery.created'),
  ('DELIVERY_ISSUED',    'delivery.issued'),
  ('DELIVERY_CONFIRMED', 'delivery.confirmed'),
  ('DELIVERY_CONTESTED', 'delivery.contested'),
  ('DELIVERY_CANCELLED', 'delivery.cancelled'),
  ('DELIVERY_REPLACED',  'ppe.replaced'),
  ('EPI_RETURNED',       'ppe.returned'),
  ('EMPLOYEE_CREATED',   'employee.created'),
  ('EMPLOYEE_UPDATED',   'employee.updated');

-- Deliberately absent, and each for a stated reason:
--   delivery.refused    -- no event has that semantics. DELIVERY_CONTESTED is a worker
--                          contesting with a reason, which is a different fact; aliasing
--                          them would publish a claim the data does not support.
--   compliance.changed  -- compliance is derived on demand and never materialised. There is
--                          no state that can "change", and creating one would mean a second
--                          source of truth alongside the Phase D engine.

-- ---------------------------------------------------------------------------------------
-- Endpoints
-- ---------------------------------------------------------------------------------------
create table hooks.endpoints (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references app.organizations (id) on delete restrict,
  url                   text not null check (url ~ '^https://[a-zA-Z0-9]' and length(url) <= 2000),
  description           text check (length(description) <= 200),
  event_types           text[] not null default '{}',
  secret_enc            bytea not null check (octet_length(secret_enc) >= 29),
  secret_prev_enc       bytea check (secret_prev_enc is null or octet_length(secret_prev_enc) >= 29),
  secret_rotated_at     timestamptz,
  ordered_delivery      boolean not null default false,
  status                text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED', 'REVOKED')),
  consecutive_failures  int not null default 0,
  created_at            timestamptz not null default now(),
  created_by            uuid references app.users (id),
  disabled_at           timestamptz,
  disabled_reason       text check (length(disabled_reason) <= 500)
);

comment on table hooks.endpoints is
  'One subscriber URL. HTTPS only, enforced here and again at connection time (an https:// URL whose DNS resolves to a private address is still refused by the runner -- see the SSRF policy). The signing secret is AES-256-GCM ciphertext produced in Node with WEBHOOK_SECRET_KEY, exactly like app.employees.cpf_enc: the key never enters Postgres, so a database dump cannot forge a signature.';
comment on column hooks.endpoints.secret_prev_enc is
  'The previous secret during a rotation window. While it is set, the runner signs with BOTH secrets so a subscriber can migrate without dropping events.';
comment on column hooks.endpoints.ordered_delivery is
  'Opt-in strict ordering: one delivery in flight at a time for this endpoint. Default false, because it trades head-of-line blocking (one slow subscriber stalls that tenant''s whole queue) for an ordering guarantee consumers can usually get more cheaply by sorting on the envelope''s `sequence`.';

create index endpoints_org_active_idx on hooks.endpoints (organization_id) where status = 'ACTIVE';

-- ---------------------------------------------------------------------------------------
-- Outbox: one row per publishable audit event
-- ---------------------------------------------------------------------------------------
create table hooks.outbox (
  id              uuid primary key default gen_random_uuid(),
  audit_event_id  uuid not null unique references audit.audit_events (id) on delete restrict,
  organization_id uuid not null,
  company_id      uuid,
  event_type      text not null,
  seq             bigint not null,
  occurred_at     timestamptz not null,
  fanned_out_at   timestamptz,
  created_at      timestamptz not null default clock_timestamp()
);

comment on table hooks.outbox is
  'Written by a trigger on audit.audit_events, in that event''s own transaction. The UNIQUE on audit_event_id makes double-enqueue impossible even if the trigger were ever to fire twice. seq is audit.audit_events.seq, which is already a per-tenant total order (audit_events_org_seq_key) -- consumers order on it, which is why at-least-once delivery without ordering guarantees is still usable.';

create index outbox_pending_fanout_idx on hooks.outbox (created_at) where fanned_out_at is null;

-- ---------------------------------------------------------------------------------------
-- Deliveries: one row per (event x subscribed endpoint) -- the state machine
-- ---------------------------------------------------------------------------------------
create table hooks.deliveries (
  id               uuid primary key default gen_random_uuid(),
  outbox_id        uuid not null references hooks.outbox (id) on delete restrict,
  endpoint_id      uuid not null references hooks.endpoints (id) on delete restrict,
  organization_id  uuid not null,
  state            text not null default 'PENDING'
                     check (state in ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED_PERMANENT', 'DLQ')),
  attempts         int not null default 0 check (attempts between 0 and 12),
  next_attempt_at  timestamptz not null default clock_timestamp(),
  claimed_at       timestamptz,
  last_status      int,
  last_error       text check (length(last_error) <= 2000),
  created_at       timestamptz not null default clock_timestamp(),
  settled_at       timestamptz,
  constraint deliveries_event_endpoint_key unique (outbox_id, endpoint_id),
  constraint deliveries_settled_ck check (
    (state in ('SUCCEEDED', 'FAILED_PERMANENT', 'DLQ')) = (settled_at is not null)
  )
);

comment on table hooks.deliveries is
  'One row per (event x subscribed endpoint). organization_id is denormalised from the outbox row so a cross-tenant pairing is visible in the row itself and testable directly -- the fan-out joins endpoint to outbox ON organization_id, and 200_webhooks_outbox.sql asserts that no delivery ever pairs an event with an endpoint of another organization.';

create index deliveries_claimable_idx on hooks.deliveries (next_attempt_at)
  where state = 'PENDING';
create index deliveries_endpoint_idx on hooks.deliveries (endpoint_id, state);

create table hooks.delivery_attempts (
  id               uuid primary key default gen_random_uuid(),
  delivery_id      uuid not null references hooks.deliveries (id) on delete restrict,
  attempt_no       int not null check (attempt_no between 1 and 12),
  http_status      int check (http_status between 100 and 599),
  error_kind       text check (error_kind in ('TIMEOUT', 'DNS', 'TLS', 'CONNECTION', 'BLOCKED', 'HTTP', 'REDIRECT')),
  error_detail     text check (length(error_detail) <= 2000),
  latency_ms       int,
  attempted_at     timestamptz not null default clock_timestamp(),
  constraint delivery_attempts_key unique (delivery_id, attempt_no)
);

comment on table hooks.delivery_attempts is
  'Append-only history of HTTP attempts. error_detail holds at most the first 2 KB of the subscriber''s response body, redacted -- enough to debug, small enough that a hostile subscriber cannot use the response to fill our storage.';

-- Reuses the generic guard introduced for app.stock_movements (20260903110100:50): an
-- attempt log that can be edited after the fact is not a log.
create trigger delivery_attempts_no_update_delete
  before update or delete on hooks.delivery_attempts
  for each row execute function app.forbid_update_delete();

alter table hooks.event_types        enable row level security;
alter table hooks.event_types        force row level security;
alter table hooks.endpoints          enable row level security;
alter table hooks.endpoints          force row level security;
alter table hooks.outbox             enable row level security;
alter table hooks.outbox             force row level security;
alter table hooks.deliveries         enable row level security;
alter table hooks.deliveries         force row level security;
alter table hooks.delivery_attempts  enable row level security;
alter table hooks.delivery_attempts  force row level security;

revoke all on all tables in schema hooks from authenticated, anon, service_role, public;

-- ---------------------------------------------------------------------------------------
-- The enqueue trigger
-- ---------------------------------------------------------------------------------------
create function hooks.enqueue_outbox()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Two guards, both cheap indexed lookups, and both necessary. The type check keeps
  -- internal-only events (IDENTITY_FAILED, LINK_VIEWED, EVIDENCE_SEALED, ...) out of the
  -- outbox entirely. The endpoint check means an organization with no webhooks -- which is
  -- every organization today -- stores nothing at all and pays one EXISTS.
  if not exists (select 1 from hooks.event_types t where t.audit_event_type = new.event_type) then
    return new;
  end if;

  if not exists (
    select 1 from hooks.endpoints e
     where e.organization_id = new.organization_id and e.status = 'ACTIVE'
  ) then
    return new;
  end if;

  insert into hooks.outbox (audit_event_id, organization_id, company_id, event_type, seq, occurred_at)
  values (new.id, new.organization_id, new.company_id, new.event_type, new.seq, new.created_at);

  return new;
end;
$$;

comment on function hooks.enqueue_outbox() is
  'Runs inside the business transaction, as an AFTER INSERT on audit.audit_events. Performs one INSERT and nothing else: no HTTP, no DNS, no pg_net, no extension call. This is what keeps worker.finish_confirmation free of external I/O while still guaranteeing the event is queued exactly when -- and only when -- the business change commits.';

create trigger audit_events_enqueue_outbox
  after insert on audit.audit_events
  for each row execute function hooks.enqueue_outbox();

-- ---------------------------------------------------------------------------------------
-- Payload construction -- the allowlist lives here, in one place
-- ---------------------------------------------------------------------------------------
create function hooks.build_envelope(p_outbox_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o record;
  a record;
  v_type text;
  v_data jsonb := '{}'::jsonb;
  v_entity_table text;
begin
  select * into o from hooks.outbox where id = p_outbox_id;
  select * into a from audit.audit_events where id = o.audit_event_id;
  select webhook_type into v_type from hooks.event_types where audit_event_type = o.event_type;

  v_entity_table := coalesce(a.entity_table, '');

  -- Per-type allowlist. Anything not named here does not travel, and the default is to
  -- omit. Never present under any type: full CPF, its hash or ciphertext, cpf_masked, the
  -- worker's name, phone, email, address, any image, any signature, canonical_bytes,
  -- payload_sha256, evidence factors, tokens, nonces, event_hash/prev_hash.
  if o.event_type in ('DELIVERY_CREATED', 'DELIVERY_ISSUED', 'DELIVERY_CONFIRMED',
                      'DELIVERY_CONTESTED', 'DELIVERY_CANCELLED', 'DELIVERY_REPLACED') then
    select jsonb_strip_nulls(jsonb_build_object(
             'delivery_id', d.id,
             'employee_id', d.employee_id,
             'status', d.status,
             'delivery_date', d.delivery_date,
             'reason_code', d.reason_code,
             'item_count', (select count(*) from app.epi_delivery_items i where i.delivery_id = d.id)
           ))
      into v_data
      from app.epi_deliveries d where d.id = a.entity_id;

  elsif o.event_type = 'EPI_RETURNED' then
    select jsonb_strip_nulls(jsonb_build_object(
             'return_id', r.id,
             'delivery_item_id', r.delivery_item_id,
             'condition_code', r.condition_code
           ))
      into v_data
      from app.epi_returns r where r.id = a.entity_id;

  elsif o.event_type in ('EMPLOYEE_CREATED', 'EMPLOYEE_UPDATED') then
    -- Straight from the audit event's own `data`, which already carries only field NAMES
    -- and booleans -- so there is nothing to filter out, by construction rather than by
    -- this function remembering to.
    v_data := coalesce(a.data, '{}'::jsonb);
  end if;

  return jsonb_build_object(
    'id', a.id,
    'type', v_type,
    'api_version', 'v1',
    'occurred_at', to_char(o.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sequence', o.seq,
    'organization_id', o.organization_id,
    'company_id', o.company_id,
    'entity', jsonb_build_object(
      'type', case
                when v_entity_table = 'app.epi_deliveries' then 'delivery'
                when v_entity_table = 'app.employees' then 'employee'
                when v_entity_table = 'app.epi_returns' then 'epi_return'
                else v_entity_table
              end,
      'id', a.entity_id),
    'data', v_data
  );
end;
$$;

revoke all on function hooks.build_envelope(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- Fan-out: outbox row -> one delivery per subscribed endpoint
-- ---------------------------------------------------------------------------------------
-- Deliberately NOT in the trigger. Doing it at enqueue time would put subscription logic
-- inside the business transaction (and inside the chain_heads lock window), and would mean
-- an endpoint created one second later silently misses events already in flight.
create function hooks.fan_out(p_limit int default 200)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  with pending as (
    select o.id, o.organization_id, o.event_type
      from hooks.outbox o
     where o.fanned_out_at is null
     order by o.created_at
     for update skip locked
     limit p_limit
  ),
  inserted as (
    insert into hooks.deliveries (outbox_id, endpoint_id, organization_id)
    select p.id, e.id, p.organization_id
      from pending p
      join hooks.endpoints e
        on e.organization_id = p.organization_id      -- the cross-tenant barrier
       and e.status = 'ACTIVE'
       and (cardinality(e.event_types) = 0
            or (select t.webhook_type from hooks.event_types t
                 where t.audit_event_type = p.event_type) = any (e.event_types))
    on conflict (outbox_id, endpoint_id) do nothing
    returning 1
  ),
  marked as (
    update hooks.outbox o set fanned_out_at = clock_timestamp()
      from pending p where p.id = o.id
    returning 1
  )
  select count(*) into v_count from marked;

  return v_count;
end;
$$;

revoke all on function hooks.fan_out(int) from public, anon, authenticated, service_role;
