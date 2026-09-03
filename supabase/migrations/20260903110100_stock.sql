-- Phase B: stock ledger. An append-only movement log (app.stock_movements) is the source of
-- truth; app.stock_balances is a maintained cache, reconstructible from the log at any time.
-- Everything here is gated behind app.organizations.inventory_enabled (default false, added
-- in Phase A) -- an org that never turns this on sees zero behavior change from Phase A.

alter table app.epis
  add column requires_return_on_replacement boolean not null default false;

comment on column app.epis.requires_return_on_replacement is
  'Organization policy: this EPI must be returned when replaced/terminated ("devolução obrigatória"). Surfaced by the delivery UI in this phase; full enforcement (blocking a new delivery until the old one is returned) is later lifecycle-phase work, once the troca/chain wiring exists.';

create table app.stock_movements (
  id                         uuid primary key default gen_random_uuid(),
  organization_id            uuid not null,
  company_id                 uuid not null,
  location_id                uuid,  -- NULL = company-wide bucket, not tied to one site
  epi_id                     uuid not null,
  variant_id                 uuid,
  movement_type              text not null check (movement_type in (
    'ENTRADA', 'ENTREGA', 'DEVOLUCAO', 'DESCARTE', 'AJUSTE',
    'TRANSFERENCIA_SAIDA', 'TRANSFERENCIA_ENTRADA'
  )),
  quantity                   integer not null check (quantity <> 0),  -- signed: + inbound, - outbound
  reference_delivery_item_id uuid,
  reference_return_id        uuid,
  reason                     text check (length(reason) <= 500),
  actor_user_id              uuid references app.users (id),
  metadata                   jsonb not null default '{}',
  created_at                 timestamptz not null default clock_timestamp(),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  foreign key (location_id, company_id) references app.locations (id, company_id) on delete restrict,
  foreign key (epi_id, organization_id) references app.epis (id, organization_id) on delete restrict,
  foreign key (variant_id, epi_id) references app.epi_variants (id, epi_id) on delete restrict,
  foreign key (reference_delivery_item_id, company_id) references app.epi_delivery_items (id, company_id) on delete restrict,
  foreign key (reference_return_id) references app.epi_returns (id) on delete restrict
);

comment on table app.stock_movements is
  'Append-only ledger. Every balance change (manual entrada/ajuste/descarte/transferência, or an automatic ENTREGA/DEVOLUCAO from issuing/returning a delivery item) is one row here -- app.stock_balances is a maintained cache, never a second source of truth. quantity is signed: positive for inbound movement types, negative for outbound.';

create index stock_movements_company_epi_idx on app.stock_movements (company_id, epi_id, variant_id, created_at desc);
create index stock_movements_delivery_item_idx on app.stock_movements (reference_delivery_item_id) where reference_delivery_item_id is not null;

-- Append-only: same discipline as audit.audit_events, but write access is via RPC/trigger
-- only (never a direct table grant) rather than fully revoked from service_role, since this
-- ledger has no legal-evidence weight the audit/evidence schemas carry -- an authorized
-- manual AJUSTE is a legitimate correction path, just never an UPDATE/DELETE of history.
revoke insert, update, delete on app.stock_movements from authenticated;

create function app.forbid_update_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME using errcode = '42501';
end;
$$;

comment on function app.forbid_update_delete() is
  'Generic append-only guard, reused wherever a table needs the audit.forbid_mutation()-style trigger but lives in app rather than audit/evidence (those two keep their own copy, revoked from every role including service_role -- this one is used by tables writable via RPC).';

create trigger stock_movements_no_update_delete
  before update or delete on app.stock_movements
  for each row execute function app.forbid_update_delete();

alter table app.stock_movements enable row level security;
alter table app.stock_movements force row level security;

grant select on app.stock_movements to authenticated;

create policy stock_movements_select on app.stock_movements
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('stock.read'))::uuid[]));

-- Maintained balance cache. NULLS NOT DISTINCT (PG15+) so the company-wide bucket
-- (location_id/variant_id both null) is a single well-defined row, same technique already
-- used by epis_scope_ca_key.
-- No PRIMARY KEY here on purpose: a primary key forces every one of its columns NOT NULL,
-- but location_id/variant_id are meant to be nullable (a company-wide bucket, or an EPI
-- with no variants). UNIQUE ... NULLS NOT DISTINCT (PG15+, same technique epis_scope_ca_key
-- already uses) is what ON CONFLICT below targets instead.
create table app.stock_balances (
  company_id  uuid not null,
  location_id uuid,
  epi_id      uuid not null,
  variant_id  uuid,
  quantity    integer not null default 0,
  updated_at  timestamptz not null default clock_timestamp(),
  constraint stock_balances_key unique nulls not distinct (company_id, location_id, epi_id, variant_id)
);

comment on table app.stock_balances is
  'Maintained cache of app.stock_movements, kept current by a trigger on that table -- reconstructible at any time as SUM(quantity) grouped by the same key. Never written to directly.';

revoke insert, update, delete on app.stock_balances from authenticated;

alter table app.stock_balances enable row level security;
alter table app.stock_balances force row level security;

grant select on app.stock_balances to authenticated;

create policy stock_balances_select on app.stock_balances
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('stock.read'))::uuid[]));

-- The negative-balance guard is a single atomic UPDATE (check-and-set in one statement, not
-- check-then-act): two concurrent deliveries consuming the last unit correctly serialize on
-- Postgres's own row-level lock -- the second transaction's UPDATE either sees the first's
-- already-committed decrement (and correctly fails the guard) or blocks until it commits.
-- No advisory lock needed, same reasoning as confirmation_requests_one_confirmed_per_delivery's
-- concurrency safety (docs/architecture.md's own pattern for this class of race).
create function app.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allow_negative boolean;
  v_updated int;
begin
  select stock_negative_allowed into v_allow_negative
  from app.organizations where id = new.organization_id;

  -- A negative starting quantity is impossible for a FRESH row (there is no prior balance
  -- to combine with, so the row is simply new.quantity as-is) -- guard that case explicitly
  -- before the INSERT, since ON CONFLICT's WHERE clause only ever governs the UPDATE branch,
  -- never the initial INSERT.
  if new.quantity < 0 and not coalesce(v_allow_negative, false) and not exists (
    select 1 from app.stock_balances
    where company_id = new.company_id
      and location_id is not distinct from new.location_id
      and epi_id = new.epi_id
      and variant_id is not distinct from new.variant_id
  ) then
    raise exception 'insufficient_stock' using errcode = '23514';
  end if;

  insert into app.stock_balances (company_id, location_id, epi_id, variant_id, quantity, updated_at)
  values (new.company_id, new.location_id, new.epi_id, new.variant_id, new.quantity, clock_timestamp())
  on conflict (company_id, location_id, epi_id, variant_id) do update set
    quantity = app.stock_balances.quantity + excluded.quantity,
    updated_at = excluded.updated_at
  where coalesce(v_allow_negative, false) or app.stock_balances.quantity + excluded.quantity >= 0;

  -- ROW_COUNT correctly reflects whether a row was inserted OR updated; a conflict whose
  -- WHERE clause blocked the update counts as zero rows affected (Postgres treats a
  -- WHERE-suppressed DO UPDATE the same as DO NOTHING for this purpose) -- this is what
  -- actually detects a blocked update, unlike re-SELECTing the row afterward (which, for an
  -- existing row the UPDATE never touched, just finds its unchanged-but-still-non-negative
  -- prior value and wrongly reports success -- a real bug caught only by executing this
  -- against a real engine, not by reading the SQL).
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'insufficient_stock' using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function app.apply_stock_movement() is
  'Maintains app.stock_balances from every app.stock_movements insert. Raises insufficient_stock (23514) if the resulting balance would go negative and the organization has not opted into stock_negative_allowed -- this aborts the whole transaction, including the stock_movements insert itself, so the ledger and the balance can never disagree.';

create trigger stock_movements_apply
  after insert on app.stock_movements
  for each row execute function app.apply_stock_movement();

insert into authz.role_permissions (role, permission) values
  ('VIEWER', 'stock.read'),
  ('SST_OPERATOR', 'stock.read'), ('SST_OPERATOR', 'stock.write'),
  ('COMPANY_ADMIN', 'stock.read'), ('COMPANY_ADMIN', 'stock.write'),
  ('ORG_ADMIN', 'stock.read'), ('ORG_ADMIN', 'stock.write');

-- Manual entrada/ajuste/descarte/transferência. ENTREGA/DEVOLUCAO are never recorded through
-- this RPC -- they are written automatically by api.issue_delivery/api.return_epi_item
-- below, always tied to a real delivery item/return.
create function api.record_stock_movement(
  p_company_id uuid,
  p_location_id uuid,
  p_epi_id uuid,
  p_variant_id uuid,
  p_movement_type text,
  p_quantity integer,
  p_reason text default null,
  p_metadata jsonb default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_movement_id uuid;
  v_signed_quantity integer;
begin
  if not (select auth_ctx.has_permission(p_company_id, 'stock.write')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_movement_type not in ('ENTRADA', 'AJUSTE', 'DESCARTE', 'TRANSFERENCIA_SAIDA', 'TRANSFERENCIA_ENTRADA') then
    raise exception 'invalid_movement_type_for_manual_entry' using errcode = '22023';
  end if;
  if p_quantity = 0 then
    raise exception 'quantity_cannot_be_zero' using errcode = '23514';
  end if;

  select organization_id into v_org_id from app.companies where id = p_company_id;

  -- AJUSTE carries the caller's own sign (a correction can go either way); every other
  -- manual type has a fixed direction regardless of the sign the caller passed in, so a
  -- careless negative/positive slip can't silently reverse an ENTRADA into an outflow.
  v_signed_quantity := case
    when p_movement_type = 'AJUSTE' then p_quantity
    when p_movement_type in ('ENTRADA', 'TRANSFERENCIA_ENTRADA') then abs(p_quantity)
    else -abs(p_quantity)
  end;

  insert into app.stock_movements (
    organization_id, company_id, location_id, epi_id, variant_id,
    movement_type, quantity, reason, actor_user_id, metadata
  ) values (
    v_org_id, p_company_id, p_location_id, p_epi_id, p_variant_id,
    p_movement_type, v_signed_quantity, p_reason, (select auth.uid()), coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_movement_id;

  perform app.log_audit_event(
    v_org_id, p_company_id, 'STOCK_MOVEMENT_RECORDED', 'stock_movements', v_movement_id, 'USER', (select auth.uid()),
    jsonb_build_object('movement_type', p_movement_type, 'quantity', v_signed_quantity, 'epi_id', p_epi_id)
  );

  return v_movement_id;
end;
$$;

comment on function api.record_stock_movement(uuid, uuid, uuid, uuid, text, integer, text, jsonb) is
  'Manual stock movement (entrada/ajuste/descarte/transferência). Rejects ENTREGA/DEVOLUCAO -- those are only ever written automatically, tied to a real delivery item or return.';

revoke execute on function api.record_stock_movement(uuid, uuid, uuid, uuid, text, integer, text, jsonb) from public, anon;
grant execute on function api.record_stock_movement(uuid, uuid, uuid, uuid, text, integer, text, jsonb) to authenticated;

create view api.stock_movements
  with (security_invoker = true) as
select
  id, organization_id, company_id, location_id, epi_id, variant_id, movement_type, quantity,
  reference_delivery_item_id, reference_return_id, reason, actor_user_id, metadata, created_at
from app.stock_movements;

comment on view api.stock_movements is 'Read-only projection of app.stock_movements. security_invoker means RLS applies for the caller.';

grant select on api.stock_movements to authenticated;

create view api.stock_balances
  with (security_invoker = true) as
select
  b.company_id, b.location_id, b.epi_id, b.variant_id, b.quantity, b.updated_at,
  v.name as epi_name, v.ca_number, ev.label as variant_label
from app.stock_balances b
join app.epi_versions v on v.epi_id = b.epi_id and v.valid_to is null
left join app.epi_variants ev on ev.id = b.variant_id;

comment on view api.stock_balances is
  'Stock balance cache joined to the epi''s current name/CA and (if set) the variant''s label for display. security_invoker means RLS on all three underlying tables applies for the caller.';

grant select on api.stock_balances to authenticated;

-- Delivery/return integration -----------------------------------------------------------

-- issue_delivery: after the existing DRAFT -> ISSUED transition, write one ENTREGA movement
-- per item IF the org has opted into inventory_enabled. A per-row loop, not a bulk
-- statement, for the same reason api.resend_batch_pending uses one -- but here it's simply
-- because each item's (location, variant) can differ, not a transition_ok constraint (this
-- table has no state machine). If inventory_enabled is false (the default), this block does
-- not run at all -- zero behavior change for every org that hasn't turned it on.
create or replace function api.issue_delivery(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_org_id uuid;
  v_status app.delivery_status;
  v_item_count int;
  v_inventory_enabled boolean;
  v_item record;
begin
  select d.company_id, d.status, c.organization_id
  into v_company_id, v_status, v_org_id
  from app.epi_deliveries d
  join app.companies c on c.id = d.company_id
  where d.id = p_delivery_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.issue')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'delivery_not_draft' using errcode = '23514';
  end if;

  select count(*) into v_item_count from app.epi_delivery_items where delivery_id = p_delivery_id;
  if v_item_count = 0 then
    raise exception 'delivery_has_no_items' using errcode = '23514';
  end if;

  perform set_config('app.transition_ok', p_delivery_id::text, true);
  update app.epi_deliveries
  set status = 'ISSUED', last_event = 'ISSUE', issued_at = clock_timestamp()
  where id = p_delivery_id;

  select inventory_enabled into v_inventory_enabled from app.organizations where id = v_org_id;

  if coalesce(v_inventory_enabled, false) then
    for v_item in
      select i.id, i.epi_id, i.variant_id, i.quantity
      from app.epi_delivery_items i
      where i.delivery_id = p_delivery_id
    loop
      insert into app.stock_movements (
        organization_id, company_id, epi_id, variant_id,
        movement_type, quantity, reference_delivery_item_id, actor_user_id
      ) values (
        v_org_id, v_company_id, v_item.epi_id, v_item.variant_id,
        'ENTREGA', -abs(v_item.quantity), v_item.id, (select auth.uid())
      );
    end loop;
  end if;
end;
$$;

comment on function api.issue_delivery(uuid) is
  'DRAFT -> ISSUED. When the organization has inventory_enabled, also writes one ENTREGA (negative) stock_movements row per item, in the company-wide bucket (location_id NULL) -- a location-aware pick is later lifecycle-phase work. insufficient_stock (23514) aborts the whole call, including the status transition, if any item would drive a balance negative and stock_negative_allowed is false.';

revoke execute on function api.issue_delivery(uuid) from public, anon;
grant execute on function api.issue_delivery(uuid) to authenticated;

-- return_epi_item: gains an optional condition_code (a CONDITION axis -- was the returned
-- item still usable? -- distinct from the existing reason_code WHY axis). REUSABLE +
-- inventory_enabled writes a DEVOLUCAO (positive) movement back into stock.
create or replace function api.return_epi_item(
  p_delivery_item_id uuid,
  p_returned_on date,
  p_reason_code text,
  p_note text default null,
  p_condition_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_org_id uuid;
  v_delivery_id uuid;
  v_delivery_status app.delivery_status;
  v_return_id uuid;
  v_epi_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_inventory_enabled boolean;
begin
  select i.company_id, i.delivery_id, d.status, i.epi_id, i.variant_id, i.quantity
  into v_company_id, v_delivery_id, v_delivery_status, v_epi_id, v_variant_id, v_quantity
  from app.epi_delivery_items i
  join app.epi_deliveries d on d.id = i.delivery_id
  where i.id = p_delivery_item_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.return')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if v_delivery_status <> 'CONFIRMED' then
    raise exception 'delivery_not_confirmed' using errcode = '23514';
  end if;

  if p_reason_code not in ('WORN_OUT', 'REPLACED', 'TERMINATION', 'OTHER') then
    raise exception 'invalid_reason_code' using errcode = '22023';
  end if;
  if p_reason_code = 'OTHER' and (p_note is null or length(btrim(p_note)) < 3) then
    raise exception 'note_required_for_other' using errcode = '23514';
  end if;
  if p_condition_code is not null and p_condition_code not in ('REUSABLE', 'DAMAGED', 'DISCARDED', 'OTHER') then
    raise exception 'invalid_condition_code' using errcode = '22023';
  end if;

  v_org_id := (select organization_id from app.companies where id = v_company_id);

  insert into app.epi_returns (
    organization_id, company_id, delivery_id, delivery_item_id,
    returned_on, reason_code, note, condition_code, created_by
  ) values (
    v_org_id, v_company_id, v_delivery_id, p_delivery_item_id,
    p_returned_on, p_reason_code, p_note, p_condition_code, (select auth.uid())
  )
  returning id into v_return_id;

  perform app.log_audit_event(
    v_org_id, v_company_id, 'EPI_RETURNED', 'epi_delivery_items', p_delivery_item_id, 'USER', (select auth.uid()),
    jsonb_build_object('return_id', v_return_id, 'reason_code', p_reason_code, 'condition_code', p_condition_code)
  );

  select inventory_enabled into v_inventory_enabled from app.organizations where id = v_org_id;

  if coalesce(v_inventory_enabled, false) and p_condition_code = 'REUSABLE' then
    insert into app.stock_movements (
      organization_id, company_id, epi_id, variant_id,
      movement_type, quantity, reference_return_id, actor_user_id
    ) values (
      v_org_id, v_company_id, v_epi_id, v_variant_id,
      'DEVOLUCAO', abs(v_quantity), v_return_id, (select auth.uid())
    );
  end if;

  return v_return_id;
exception
  when unique_violation then
    raise exception 'already_returned' using errcode = '23505';
end;
$$;

comment on function api.return_epi_item(uuid, date, text, text, text) is
  'Records that one delivery line item was returned. p_condition_code (REUSABLE/DAMAGED/DISCARDED/OTHER) is the item''s physical condition, distinct from p_reason_code (why it came back) -- REUSABLE + inventory_enabled writes it back into stock as a DEVOLUCAO movement.';

revoke execute on function api.return_epi_item(uuid, date, text, text, text) from public, anon;
grant execute on function api.return_epi_item(uuid, date, text, text, text) to authenticated;

alter table app.epi_returns
  add column condition_code text check (condition_code is null or condition_code in ('REUSABLE', 'DAMAGED', 'DISCARDED', 'OTHER'));

comment on column app.epi_returns.condition_code is
  'The returned item''s physical condition -- distinct from reason_code (why it was returned). Optional: a return recorded before this phase, or one where condition wasn''t assessed, leaves this NULL.';

create or replace view api.epi_returns
  with (security_invoker = true) as
select
  id, organization_id, company_id, delivery_id, delivery_item_id,
  returned_on, reason_code, note, created_by, created_at, condition_code
from app.epi_returns;

comment on view api.epi_returns is
  'Read-only projection of recorded EPI returns. security_invoker means RLS on epi_returns applies for the caller.';

grant select on api.epi_returns to authenticated;

-- Existing epis view gains the new column at the end.
create or replace view api.epis
  with (security_invoker = true) as
select
  e.id, e.organization_id, e.company_id, e.is_active, e.archived_at, e.created_at,
  v.id as current_version_id, v.version, v.name, v.ca_number, v.manufacturer, v.model,
  v.description, v.default_unit, v.valid_from as version_valid_from,
  e.requires_return_on_replacement
from app.epis e
join app.epi_versions v on v.epi_id = e.id and v.valid_to is null
where e.archived_at is null;

comment on view api.epis is
  'One row per active EPI catalog entry, joined to its current version. security_invoker means RLS on both underlying tables applies for the caller.';

grant select on api.epis to authenticated;
