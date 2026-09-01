-- ===== 20260831200000_delivery_batches.sql =====
-- FASE 6: delivery_batches -- a mass-delivery operation (docs/architecture.md §6): thousands
-- of individual epi_deliveries created in ONE set-based statement, never a loop of
-- thousands of RPC round-trips or thousands of individual INSERTs from application code.

create table app.delivery_batches (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  company_id        uuid not null,
  delivery_date     date not null check (delivery_date between date '2020-01-01' and date '2100-01-01'),
  note              text check (note is null or length(note) <= 2000),
  total_count       integer not null default 0 check (total_count >= 0),
  confirmed_count   integer not null default 0 check (confirmed_count >= 0),
  contested_count   integer not null default 0 check (contested_count >= 0),
  cancelled_count   integer not null default 0 check (cancelled_count >= 0),
  created_by        uuid not null references app.users (id),
  created_at        timestamptz not null default clock_timestamp(),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  constraint delivery_batches_counts_ck check (confirmed_count + contested_count + cancelled_count <= total_count)
);

comment on table app.delivery_batches is
  'One row per mass-delivery operation. total_count is set ONCE, directly by api.create_delivery_batch right after its own bulk INSERT (GET DIAGNOSTICS, not a trigger -- that RPC is the only code path that bulk-inserts deliveries, so there is nothing else to defend against). confirmed_count/contested_count/cancelled_count are maintained by a row-level trigger on app.epi_deliveries instead -- those updates arrive one at a time, spread over hours/days as individual workers confirm/contest their own single delivery, never in bulk, so a row-level trigger is the right tool there (see docs/mvp-roadmap.md FASE 6 for why a statement-level trigger was NOT needed for either direction).';

create index delivery_batches_company_idx on app.delivery_batches (company_id, created_at desc);

revoke insert, update, delete on app.delivery_batches from authenticated, anon;

alter table app.delivery_batches enable row level security;
alter table app.delivery_batches force row level security;

grant select on app.delivery_batches to authenticated;

create policy delivery_batches_select on app.delivery_batches
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('delivery.read'))::uuid[]));

-- epi_deliveries gets a nullable batch_id -- null for individually-created deliveries
-- (FASE 2's api.create_delivery never sets it), populated only by api.create_delivery_batch.
alter table app.epi_deliveries add column batch_id uuid references app.delivery_batches (id) on delete restrict;
create index epi_deliveries_batch_idx on app.epi_deliveries (batch_id) where batch_id is not null;

-- Maintains delivery_batches' running counters as individual confirmations/contests/
-- cancellations land, one row at a time -- see the comment on delivery_batches above for
-- why this is row-level (correct here) rather than statement-level (needed only for the
-- batch's own bulk INSERT, handled directly in api.create_delivery_batch instead).
create function app.bump_batch_counter()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if NEW.batch_id is null or NEW.status is not distinct from OLD.status then
    return NEW;
  end if;

  if NEW.status = 'CONFIRMED' then
    update app.delivery_batches set confirmed_count = confirmed_count + 1 where id = NEW.batch_id;
  elsif NEW.status = 'CONTESTED' then
    update app.delivery_batches set contested_count = contested_count + 1 where id = NEW.batch_id;
  elsif NEW.status = 'CANCELLED' then
    update app.delivery_batches set cancelled_count = cancelled_count + 1 where id = NEW.batch_id;
  end if;

  return NEW;
end;
$$;

create trigger epi_deliveries_bump_batch_counter
  after update on app.epi_deliveries
  for each row execute function app.bump_batch_counter();

comment on function app.bump_batch_counter() is
  'Fires once per individual status change on a batch-linked delivery -- never in bulk (the batch''s own creation INSERT does not go through UPDATE at all, so this trigger never sees the initial 5000-row insert, only the one-at-a-time confirm/contest/cancel events that follow).';

-- ===== 20260831200100_delivery_batch_rpcs.sql =====
-- FASE 6: mass-delivery creation. One set-based statement (a chain of data-modifying CTEs)
-- creates every delivery, every line item, and every confirmation_request together -- never
-- a per-employee loop in application code or a per-employee RPC round trip. Node pre-generates
-- every worker token (fast, in-memory, no I/O) and passes only the hashes in, same discipline
-- as the individual-delivery confirmation flow (docs/architecture.md §8: raw tokens never
-- cross into Postgres).

create function api.create_delivery_batch(
  p_company_id uuid,
  p_epi_items jsonb,      -- [{epi_id, quantity, unit?}, ...] -- applied to every targeted employee
  p_confirmations jsonb,  -- [{employee_id, token_hash_b64}, ...] -- one row per targeted employee
  p_delivery_date date,
  p_note text
)
returns table (batch_id uuid, delivery_count int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_batch_id uuid;
  v_created_by uuid := (select auth.uid());
  v_input_employee_count int;
  v_input_item_count int;
  v_created_delivery_count int;
  v_created_item_count int;
  v_created_confirmation_count int;
begin
  if not (select auth_ctx.has_permission(p_company_id, 'delivery.batch.create')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_input_employee_count := coalesce(jsonb_array_length(p_confirmations), 0);
  if v_input_employee_count = 0 then
    raise exception 'batch_has_no_employees' using errcode = '23514';
  end if;
  if v_input_employee_count > 20000 then
    raise exception 'batch_too_large' using errcode = '54000';
  end if;

  v_input_item_count := coalesce(jsonb_array_length(p_epi_items), 0);
  if v_input_item_count = 0 then
    raise exception 'batch_has_no_items' using errcode = '23514';
  end if;
  if v_input_item_count > 200 then
    raise exception 'too_many_items' using errcode = '54000';
  end if;

  select organization_id into v_org_id from app.companies where id = p_company_id;
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  insert into app.delivery_batches (organization_id, company_id, delivery_date, note, created_by)
  values (v_org_id, p_company_id, p_delivery_date, p_note, v_created_by)
  returning id into v_batch_id;

  with targets as (
    select (x->>'employee_id')::uuid as employee_id, x->>'token_hash_b64' as token_hash_b64
    from jsonb_array_elements(p_confirmations) x
  ),
  valid_targets as (
    select t.employee_id, t.token_hash_b64
    from targets t
    join app.employees e on e.id = t.employee_id and e.company_id = p_company_id and e.archived_at is null
  ),
  resolved_items as (
    select
      x.ord, ev.epi_id, ev.id as epi_version_id, ev.name, ev.ca_number, ev.manufacturer, ev.model,
      coalesce(x.unit, ev.default_unit) as unit, x.quantity, ev.company_id as epi_company_id
    from rows from (jsonb_to_recordset(p_epi_items) as (epi_id uuid, quantity int, unit text))
      with ordinality as x(epi_id, quantity, unit, ord)
    join app.epi_versions ev on ev.epi_id = x.epi_id and ev.valid_to is null
    where ev.company_id is null or ev.company_id = p_company_id
  ),
  new_deliveries as (
    -- Created directly as ISSUED (not DRAFT) -- a batch creates the confirmation_request
    -- for every delivery in the SAME transaction below, and only an ISSUED/CONTESTED
    -- delivery may legally have a live confirmation_request (see
    -- api.create_confirmation_link's own check). There is no per-employee DRAFT review
    -- step in a mass flow -- the manager already committed to the whole list by submitting
    -- the batch. Direct INSERT, never through the enforce_state_transition trigger (which
    -- only fires on UPDATE), same as every other table's initial-status INSERT.
    insert into app.epi_deliveries (organization_id, company_id, employee_id, batch_id, delivery_date, note, status, issued_at, created_by)
    select v_org_id, p_company_id, vt.employee_id, v_batch_id, p_delivery_date, p_note, 'ISSUED', clock_timestamp(), v_created_by
    from valid_targets vt
    returning id, employee_id
  ),
  new_items as (
    insert into app.epi_delivery_items (
      delivery_id, company_id, line_no, epi_id, epi_version_id, epi_name, ca_number, manufacturer, model, quantity, unit
    )
    select nd.id, p_company_id, ri.ord, ri.epi_id, ri.epi_version_id, ri.name, ri.ca_number, ri.manufacturer, ri.model, ri.quantity, ri.unit
    from new_deliveries nd
    cross join resolved_items ri
    returning 1
  ),
  new_confirmations as (
    insert into app.confirmation_requests (
      organization_id, company_id, delivery_id, token_hash, status,
      required_assurance_level, action_nonce, expires_at, created_by
    )
    select
      v_org_id, p_company_id, nd.id, decode(vt.token_hash_b64, 'base64'), 'SENT',
      (select default_assurance_level from app.organizations where id = v_org_id),
      extensions.gen_random_bytes(16),
      clock_timestamp() + make_interval(hours => (select link_ttl_hours from app.organizations where id = v_org_id)),
      v_created_by
    from new_deliveries nd
    join valid_targets vt on vt.employee_id = nd.employee_id
    returning 1
  )
  select
    (select count(*) from new_deliveries),
    (select count(*) from new_items),
    (select count(*) from new_confirmations)
  into v_created_delivery_count, v_created_item_count, v_created_confirmation_count;

  -- Every input employee AND every input item must have resolved -- a partial batch (some
  -- employees silently dropped because they don't belong to this company, or an epi_id that
  -- doesn't resolve to a live version) is never acceptable; the whole batch rolls back.
  if v_created_delivery_count <> v_input_employee_count then
    raise exception 'one_or_more_employees_invalid' using errcode = '23514';
  end if;
  if v_created_item_count <> v_created_delivery_count * v_input_item_count then
    raise exception 'one_or_more_items_invalid' using errcode = '23514';
  end if;
  if v_created_confirmation_count <> v_created_delivery_count then
    raise exception 'confirmation_count_mismatch' using errcode = '23514';
  end if;

  update app.delivery_batches set total_count = v_created_delivery_count where id = v_batch_id;

  -- One audit event for the whole batch, never one per delivery (docs/architecture.md §13
  -- lists BATCH_CREATED, not per-item DELIVERY_CREATED -- logging per-delivery here would
  -- undo the entire point of a single set-based statement).
  perform app.log_audit_event(v_org_id, p_company_id, 'BATCH_CREATED', 'delivery_batches', v_batch_id, 'USER', v_created_by,
    jsonb_build_object('delivery_count', v_created_delivery_count));

  return query select v_batch_id, v_created_delivery_count;
end;
$$;

comment on function api.create_delivery_batch(uuid, jsonb, jsonb, date, text) is
  'Creates an entire batch (deliveries + line items + confirmation_requests) in one transaction via chained data-modifying CTEs -- see docs/mvp-roadmap.md FASE 6. Every item resolves against the CURRENT catalog once, at batch-creation time, and every resulting delivery snapshots it independently (immune to later catalog edits, same as api.create_delivery -- see FASE 2''s Definition of Done).';

revoke execute on function api.create_delivery_batch(uuid, jsonb, jsonb, date, text) from public, anon;
grant execute on function api.create_delivery_batch(uuid, jsonb, jsonb, date, text) to authenticated;

-- Resend-pending-only: revokes and replaces the confirmation_request for every delivery in
-- the batch that is STILL PENDING (SENT/VIEWED/IDENTITY_FAILED) -- never touches a delivery
-- that has already reached CONFIRMED/CONTESTED/CANCELLED. Same token-hash-in, raw-token-out
-- discipline as api.create_confirmation_link.
create function api.resend_batch_pending(p_batch_id uuid, p_confirmations jsonb)
returns table (delivery_id uuid, confirmation_request_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_org_id uuid;
  v_created_by uuid := (select auth.uid());
  v_ttl int;
  v_required app.assurance_level;
  v_old_id uuid;
begin
  select company_id, organization_id into v_company_id, v_org_id
  from app.delivery_batches where id = p_batch_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.batch.resend')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select link_ttl_hours, default_assurance_level into v_ttl, v_required
  from app.organizations where id = v_org_id;

  create temporary table pending_targets (delivery_id uuid primary key, token_hash_b64 text) on commit drop;

  insert into pending_targets (delivery_id, token_hash_b64)
  select d.id, t.token_hash_b64
  from jsonb_to_recordset(p_confirmations) as t(delivery_id uuid, token_hash_b64 text)
  join app.epi_deliveries d on d.id = t.delivery_id
  where d.batch_id = p_batch_id
    and d.status = 'ISSUED'
    and not exists (
      select 1 from app.confirmation_requests cr
      where cr.delivery_id = d.id and cr.status in ('CONFIRMED', 'CONTESTED')
    );

  -- Revoke each still-live confirmation_request one at a time: app.enforce_state_transition's
  -- transition_ok guard authorizes exactly one row id per UPDATE, by design (docs/architecture.md
  -- §8) -- a single bulk UPDATE spanning many different ids cannot satisfy it, and changing
  -- that shared guard (used by both the DELIVERY and CONFIRMATION_REQUEST machines
  -- everywhere) was judged riskier than this loop. Still zero network round-trips -- this
  -- runs entirely inside one PL/pgSQL call, nothing like looping RPC calls from a browser.
  for v_old_id in
    select cr.id from app.confirmation_requests cr
    join pending_targets pt on pt.delivery_id = cr.delivery_id
    where cr.status in ('SENT', 'VIEWED', 'IDENTITY_FAILED')
  loop
    perform set_config('app.transition_ok', v_old_id::text, true);
    update app.confirmation_requests
    set status = 'REVOKED', last_event = 'REVOKE', revoked_at = clock_timestamp()
    where id = v_old_id;
  end loop;

  -- Table alias + qualified RETURNING: same RETURNS-TABLE-vs-column-name ambiguity as
  -- api.create_confirmation_link/worker.verify_document -- see those migrations' comments.
  return query
  insert into app.confirmation_requests as ncr (
    organization_id, company_id, delivery_id, token_hash, status,
    required_assurance_level, action_nonce, expires_at, created_by
  )
  select
    v_org_id, v_company_id, pt.delivery_id, decode(pt.token_hash_b64, 'base64'), 'SENT',
    v_required, extensions.gen_random_bytes(16),
    clock_timestamp() + make_interval(hours => v_ttl), v_created_by
  from pending_targets pt
  returning ncr.delivery_id, ncr.id;
end;
$$;

comment on function api.resend_batch_pending(uuid, jsonb) is
  'p_confirmations must include every delivery_id the caller wants resent, each with a fresh Node-generated token hash -- a delivery not in p_confirmations, or already CONFIRMED/CONTESTED, is silently skipped (unlike api.create_delivery_batch, a partial resend is fine: the caller can always call again for the ones that did not need it). See docs/mvp-roadmap.md FASE 6.';

revoke execute on function api.resend_batch_pending(uuid, jsonb) from public, anon;
grant execute on function api.resend_batch_pending(uuid, jsonb) to authenticated;

-- ===== 20260831200200_dashboard_rpcs.sql =====
-- FASE 6: operational dashboard -- answers questions ("is there an unconfirmed delivery
-- that's been sitting for a week?"), not decorative charts. One aggregate RPC (cheap,
-- indexed) plus a company-wide activity feed reusing the audit trail already built in
-- FASE 3.

create function api.dashboard_summary(p_company_id uuid, p_since date default (current_date - 30))
returns table (
  active_employees_count       int,
  deliveries_in_period          int,
  confirmed_count                int,
  pending_count                   int,
  contested_count                 int,
  cancelled_count                  int,
  pending_over_3_days_count       int,
  pending_over_7_days_count       int
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_permission(p_company_id, 'delivery.read')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select
    (select count(*)::int from app.employees where company_id = p_company_id and status = 'ACTIVE' and archived_at is null),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and delivery_date >= p_since),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and delivery_date >= p_since and status = 'CONFIRMED'),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and delivery_date >= p_since and status = 'ISSUED'),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and delivery_date >= p_since and status = 'CONTESTED'),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and delivery_date >= p_since and status = 'CANCELLED'),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and status = 'ISSUED' and issued_at < clock_timestamp() - interval '3 days'),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and status = 'ISSUED' and issued_at < clock_timestamp() - interval '7 days');
end;
$$;

comment on function api.dashboard_summary(uuid, date) is
  'Operational counters for one company, over the trailing window ending today (p_since, default 30 days back for the period counts -- the two "pending over N days" counts are NOT period-bound, since a delivery stuck for 8 days matters regardless of when it was created). Every count is a simple indexed aggregate -- no decorative chart data, just the numbers a manager actually needs (docs/mvp-roadmap.md FASE 6).';

revoke execute on function api.dashboard_summary(uuid, date) from public, anon;
grant execute on function api.dashboard_summary(uuid, date) to authenticated;

-- Company-wide activity feed -- the same audit trail api.delivery_audit_events reads
-- per-delivery, here across every delivery/confirmation_request/batch for one company.
create function api.company_audit_events(p_company_id uuid, p_limit int default 50)
returns table (
  id uuid, seq bigint, event_type text, actor_kind text, actor_user_id uuid,
  entity_table text, entity_id uuid, data jsonb, created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_permission(p_company_id, 'audit.read')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_limit < 1 or p_limit > 200 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  return query
  select ae.id, ae.seq, ae.event_type, ae.actor_kind, ae.actor_user_id, ae.entity_table, ae.entity_id, ae.data, ae.created_at
  from audit.audit_events ae
  where ae.company_id = p_company_id
  order by ae.created_at desc
  limit p_limit;
end;
$$;

comment on function api.company_audit_events(uuid, int) is
  'The dashboard''s "últimas atividades" feed -- every audit event for one company, newest first, capped at 200 rows per call (paginate by calling again with a smaller p_limit and filtering client-side by created_at if a manager needs to go further back -- this is a glance-at-recent-activity feed, not an audit export).';

revoke execute on function api.company_audit_events(uuid, int) from public, anon;
grant execute on function api.company_audit_events(uuid, int) to authenticated;

-- Read-only projections for the batch list/detail screens.
create view api.delivery_batches
  with (security_invoker = true) as
select id, organization_id, company_id, delivery_date, note, total_count, confirmed_count,
       contested_count, cancelled_count, created_by, created_at
from app.delivery_batches;

comment on view api.delivery_batches is
  'Read-only projection of app.delivery_batches. security_invoker means RLS on the base table applies for the caller.';

grant select on api.delivery_batches to authenticated;

-- ===== 20260831200300_batch_items_insert_fix.sql =====
-- FASE 6: api.create_delivery_batch (previous migration) creates deliveries directly as
-- ISSUED (see that migration's comment for why) and inserts their line items in the SAME
-- transaction, atomically, before any worker could possibly have viewed anything. FASE 2's
-- app.enforce_items_draft_only() (supabase/migrations/20260831160400_epi_deliveries.sql,
-- already applied live) blocks ANY write -- including INSERT -- unless the parent delivery
-- is DRAFT, which broke the batch flow entirely.
--
-- The invariant that trigger actually needs to protect is narrower than what it enforces
-- today: "no CHANGE to an item after issuance" (UPDATE/DELETE), not "no INSERT unless
-- DRAFT". No RPC in this codebase ever inserts a NEW item onto a PRE-EXISTING delivery --
-- api.create_delivery (individual) creates the delivery as DRAFT then inserts its items,
-- all within its own transaction; api.create_delivery_batch does the same with ISSUED
-- instead of DRAFT. Both are safe because item insertion always happens atomically
-- alongside the delivery's own creation. `authenticated` has no INSERT/UPDATE/DELETE grant
-- on app.epi_delivery_items at all regardless (see that same migration) -- this trigger is
-- defense-in-depth against a future RPC bug, not the only thing standing between a caller
-- and a rogue write.

drop trigger if exists epi_delivery_items_draft_only on app.epi_delivery_items;
drop function if exists app.enforce_items_draft_only();

create function app.enforce_items_draft_only()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_delivery_id uuid;
  v_status app.delivery_status;
begin
  if TG_OP = 'INSERT' then
    return NEW;
  end if;

  v_delivery_id := coalesce(NEW.delivery_id, OLD.delivery_id);
  select status into v_status from app.epi_deliveries where id = v_delivery_id;
  if v_status is distinct from 'DRAFT' then
    raise exception 'delivery items are only editable while the delivery is DRAFT (current status: %)', v_status
      using errcode = '23514';
  end if;
  return coalesce(NEW, OLD);
end;
$$;

comment on function app.enforce_items_draft_only() is
  'INSERT is allowed regardless of the parent delivery''s status -- a batch delivery is created directly as ISSUED with its items inserted in the same transaction (docs/mvp-roadmap.md FASE 6). UPDATE/DELETE remain DRAFT-only: that is the invariant this trigger actually protects (no silent change to an item once a delivery may have been shown to a worker).';

create trigger epi_delivery_items_draft_only
  before insert or update or delete on app.epi_delivery_items
  for each row execute function app.enforce_items_draft_only();

-- ===== 20260831200400_deliveries_view_batch_id.sql =====
-- FASE 6: adds batch_id to api.epi_deliveries (created in FASE 2, before app.epi_deliveries
-- had this column). CREATE OR REPLACE VIEW can add a new trailing column to an
-- already-applied view without DROP, as long as every pre-existing column keeps its
-- position/name/type -- this is that case.

create or replace view api.epi_deliveries
  with (security_invoker = true) as
select
  d.id, d.organization_id, d.company_id, d.employee_id, d.chain_id, d.chain_version,
  d.corrects_delivery_id, d.superseded_by_delivery_id, d.status, d.delivery_date, d.note,
  d.issued_at, d.frozen_at, d.confirmed_at, d.contested_at, d.cancelled_at, d.cancel_reason,
  d.created_by, d.created_at, d.updated_at,
  e.full_name as employee_full_name,
  d.batch_id
from app.epi_deliveries d
join app.employees e on e.id = d.employee_id;

comment on view api.epi_deliveries is
  'Delivery list/detail projection, joined to the employee''s current name for display. security_invoker means RLS on epi_deliveries (and, via the join, employees) applies for the caller. batch_id (FASE 6) is null for individually-created deliveries.';

