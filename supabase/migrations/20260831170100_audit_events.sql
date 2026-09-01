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
