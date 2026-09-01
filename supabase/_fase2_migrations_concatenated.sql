-- FASE 2: novas migrations (catálogo de EPI, máquina de estados de entrega, entregas + itens, RPCs).
-- Colar de uma vez no SQL Editor do projeto epi-dev.

-- ============================================================
-- 20260831160000_epi_catalog.sql
-- ============================================================
-- FASE 2: PPE (EPI) catalog. Versioned (epis + epi_versions, SCD2) so a later correction
-- to a CA number or name can never retroactively change what a historical delivery
-- claims -- deliveries snapshot the values by copy into epi_delivery_items (next
-- migration), keyed to a specific epi_version_id. No stock, no purchasing (docs/mvp-roadmap.md
-- FASE 2 / original spec §10).

create table app.epis (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete restrict,
  company_id      uuid,  -- NULL = shared catalog entry across every company in the org
  is_active       boolean not null default true,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  created_by      uuid references app.users (id),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  constraint epis_org_id_key unique (organization_id, id)
);

comment on table app.epis is
  'PPE catalog item identity. company_id NULL means the org-wide/shared catalog (a partner clinic defines an item once for all its client companies); company_id set scopes it to one company. Evidence-relevant attributes live in epi_versions, never here.';

create table app.epi_versions (
  id              uuid primary key default gen_random_uuid(),
  epi_id          uuid not null references app.epis (id) on delete restrict,
  organization_id uuid not null,
  company_id      uuid,
  -- clock_timestamp(), not now(): now() is frozen at transaction START, so two versions
  -- opened/closed within the SAME transaction (e.g. create-then-immediately-update, or a
  -- future bulk edit) would get IDENTICAL valid_from/valid_to values -- violating the
  -- valid_to > valid_from CHECK below. Caught by actually running this against a real
  -- Postgres engine, not by inspection -- see the identical fix on issued_at/cancelled_at
  -- in epi_deliveries (next migration set).
  version         integer not null check (version >= 1),
  name            text not null check (length(btrim(name)) between 2 and 200),
  ca_number       text not null check (ca_number ~ '^[0-9]{3,8}$'),
  manufacturer    text check (length(manufacturer) <= 150),
  model           text check (length(model) <= 150),
  description     text check (length(description) <= 2000),
  default_unit    text not null default 'UN' check (default_unit in ('UN', 'PAR', 'CX', 'M', 'KG')),
  valid_from      timestamptz not null default clock_timestamp(),
  valid_to        timestamptz,
  created_by      uuid references app.users (id),
  foreign key (epi_id, organization_id) references app.epis (id, organization_id),
  constraint epi_versions_seq_key unique (epi_id, version),
  check (valid_to is null or valid_to > valid_from)
);

comment on table app.epi_versions is
  'Append-only attribute history for one epi. Exactly one row per epi has valid_to IS NULL (the current version) -- enforced by epi_versions_current below. A correction inserts a new row and closes the old one (valid_to = now()); it never UPDATEs name/ca_number/etc in place, so a delivery that snapshotted an old version keeps pointing at exactly what it said at delivery time.';

create unique index epi_versions_current on app.epi_versions (epi_id) where valid_to is null;

-- One live catalog entry per (scope, CA). NULLS NOT DISTINCT (PG15+) so two org-wide
-- entries (company_id IS NULL) with the same CA collide too, not just same-company ones.
create unique index epis_scope_ca_key on app.epi_versions (organization_id, company_id, ca_number)
  nulls not distinct where valid_to is null;

create index epi_versions_ca_search on app.epi_versions (ca_number) where valid_to is null;

alter table app.epis enable row level security;
alter table app.epis force row level security;
alter table app.epi_versions enable row level security;
alter table app.epi_versions force row level security;

grant select on app.epis, app.epi_versions to authenticated;

-- A company-scoped member sees the org's shared catalog (company_id IS NULL) plus their
-- own company's entries -- never a sibling company's private catalog items.
create policy epis_select on app.epis
  for select to authenticated
  using (
    organization_id = any ((select auth_ctx.organization_ids())::uuid[])
    and (company_id is null or company_id = any ((select auth_ctx.company_ids())::uuid[]))
  );

create policy epi_versions_select on app.epi_versions
  for select to authenticated
  using (
    organization_id = any ((select auth_ctx.organization_ids())::uuid[])
    and (company_id is null or company_id = any ((select auth_ctx.company_ids())::uuid[]))
  );

-- Writes are RPC-only (api.create_epi / api.update_epi, next migration) -- creating/
-- editing an org-wide catalog entry needs org-level ORG_ADMIN, which a per-table RLS
-- policy cannot express cleanly against a nullable company_id; the RPC does that check.
revoke insert, update, delete on app.epis, app.epi_versions from authenticated;

-- ============================================================
-- 20260831160100_epi_rpcs.sql
-- ============================================================
-- FASE 2: EPI catalog RPCs. create_epi inserts the identity row + version 1 in one
-- transaction; update_epi closes the current version and opens a new one (SCD2) -- never
-- an in-place UPDATE of name/ca_number/etc, per docs/architecture.md §12.

create function api.create_epi(
  p_organization_id uuid,
  p_company_id uuid,       -- NULL = org-wide shared catalog entry
  p_name text,
  p_ca_number text,
  p_manufacturer text default null,
  p_model text default null,
  p_description text default null,
  p_default_unit text default 'UN'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_epi_id uuid;
begin
  if p_company_id is null then
    -- Org-wide catalog entry: requires org-wide ORG_ADMIN, same rule as api.create_company.
    if not exists (
      select 1 from authz.memberships m
      where m.user_id = v_uid and m.organization_id = p_organization_id
        and m.company_id is null and m.role = 'ORG_ADMIN' and m.revoked_at is null
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  else
    if not (select auth_ctx.has_permission(p_company_id, 'epi.create')) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  insert into app.epis (organization_id, company_id, created_by)
  values (p_organization_id, p_company_id, v_uid)
  returning id into v_epi_id;

  insert into app.epi_versions (
    epi_id, organization_id, company_id, version, name, ca_number,
    manufacturer, model, description, default_unit, created_by
  ) values (
    v_epi_id, p_organization_id, p_company_id, 1, p_name, p_ca_number,
    p_manufacturer, p_model, p_description, p_default_unit, v_uid
  );

  return v_epi_id;
exception
  when unique_violation then
    raise exception 'ca_already_registered' using errcode = '23505';
end;
$$;

comment on function api.create_epi(uuid, uuid, text, text, text, text, text, text) is
  'Creates a PPE catalog entry + its version 1. p_company_id NULL creates an org-wide shared entry (requires org-wide ORG_ADMIN); non-null scopes it to one company (requires epi.create there).';

revoke execute on function api.create_epi(uuid, uuid, text, text, text, text, text, text) from public, anon;
grant execute on function api.create_epi(uuid, uuid, text, text, text, text, text, text) to authenticated;

create function api.update_epi(
  p_epi_id uuid,
  p_name text,
  p_ca_number text,
  p_manufacturer text,
  p_model text,
  p_description text,
  p_default_unit text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_company_id uuid;
  v_org_id uuid;
  v_next_version int;
begin
  select company_id, organization_id into v_company_id, v_org_id
  from app.epis where id = p_epi_id and archived_at is null;

  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if v_company_id is null then
    if not exists (
      select 1 from authz.memberships m
      where m.user_id = v_uid and m.organization_id = v_org_id
        and m.company_id is null and m.role = 'ORG_ADMIN' and m.revoked_at is null
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  else
    if not (select auth_ctx.has_permission(v_company_id, 'epi.update')) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select version + 1 into v_next_version from app.epi_versions
  where epi_id = p_epi_id and valid_to is null;

  update app.epi_versions set valid_to = clock_timestamp()
  where epi_id = p_epi_id and valid_to is null;

  insert into app.epi_versions (
    epi_id, organization_id, company_id, version, name, ca_number,
    manufacturer, model, description, default_unit, created_by
  ) values (
    p_epi_id, v_org_id, v_company_id, v_next_version, p_name, p_ca_number,
    p_manufacturer, p_model, p_description, p_default_unit, v_uid
  );
exception
  when unique_violation then
    raise exception 'ca_already_registered' using errcode = '23505';
end;
$$;

comment on function api.update_epi(uuid, text, text, text, text, text, text) is
  'Closes the current epi_version and opens a new one with the edited fields (SCD2) -- never an in-place UPDATE. Deliveries created before this call keep pointing at the old epi_version_id, so their snapshot is unaffected. See docs/mvp-roadmap.md FASE 2 acceptance criterion.';

revoke execute on function api.update_epi(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function api.update_epi(uuid, text, text, text, text, text, text) to authenticated;

create function api.deactivate_epi(p_epi_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_company_id uuid;
  v_org_id uuid;
begin
  select company_id, organization_id into v_company_id, v_org_id
  from app.epis where id = p_epi_id and archived_at is null;

  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if v_company_id is null then
    if not exists (
      select 1 from authz.memberships m
      where m.user_id = v_uid and m.organization_id = v_org_id
        and m.company_id is null and m.role = 'ORG_ADMIN' and m.revoked_at is null
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  else
    if not (select auth_ctx.has_permission(v_company_id, 'epi.update')) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  update app.epis set is_active = p_is_active where id = p_epi_id;
end;
$$;

comment on function api.deactivate_epi(uuid, boolean) is
  'Toggles is_active. Does not affect history -- a delivery referencing an inactive EPI keeps its snapshot; inactive EPIs are just hidden from the picker for new deliveries.';

revoke execute on function api.deactivate_epi(uuid, boolean) from public, anon;
grant execute on function api.deactivate_epi(uuid, boolean) to authenticated;

-- ============================================================
-- 20260831160200_epis_api_view.sql
-- ============================================================
-- FASE 2: read-only projection joining an epi to its current version -- the shape the
-- catalog list/picker actually wants, without the caller needing to know about the SCD2
-- versioning underneath.

create view api.epis
  with (security_invoker = true) as
select
  e.id, e.organization_id, e.company_id, e.is_active, e.archived_at, e.created_at,
  v.id as current_version_id, v.version, v.name, v.ca_number, v.manufacturer, v.model,
  v.description, v.default_unit, v.valid_from as version_valid_from
from app.epis e
join app.epi_versions v on v.epi_id = e.id and v.valid_to is null
where e.archived_at is null;

comment on view api.epis is
  'One row per active EPI catalog entry, joined to its current version. security_invoker means RLS on both underlying tables applies for the caller.';

grant select on api.epis to authenticated;

-- ============================================================
-- 20260831160300_delivery_state_machine.sql
-- ============================================================
-- FASE 2: the DELIVERY state machine, as data (app.state_transitions, created empty in
-- FASE 0) plus the generic trigger function that enforces it. See docs/architecture.md §8.
--
-- The full machine is seeded now, including edges FASE 2 has no UI for yet
-- (REQUEST_CONFIRMED/REQUEST_CONTESTED fire from the confirmation flow, FASE 3; SUPERSEDE
-- fires from a correction flow, FASE 5) -- the machine is meant to be complete and
-- queryable as data from the start, not grown edge-by-edge per phase. Only ISSUE and
-- CANCEL are reachable from FASE 2's own RPCs.

create type app.delivery_status as enum ('DRAFT', 'ISSUED', 'CONFIRMED', 'CONTESTED', 'CANCELLED', 'SUPERSEDED');
comment on type app.delivery_status is
  'The business-fact lifecycle of a delivery. Deliberately separate from the confirmation ATTEMPT lifecycle (FASE 3''s confirmation_requests.status) -- see docs/architecture.md §8 for why merging them was rejected: a resend would have to overwrite the record of the first attempt.';

insert into app.state_transitions (machine, machine_version, from_state, event, to_state, actor_kinds, required_permission, is_terminal, introduced_in) values
  ('DELIVERY', 1, 'DRAFT',     'ISSUE',             'ISSUED',     array['USER'],   'delivery.issue',  false, '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'DRAFT',     'CANCEL',            'CANCELLED',  array['USER'],   'delivery.cancel', true,  '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'ISSUED',    'CANCEL',            'CANCELLED',  array['USER'],   'delivery.cancel', true,  '20260831160300_delivery_state_machine.sql'),
  -- FASE 3: fired by the worker confirmation flow (app.confirm_delivery / app.contest_delivery), not built yet.
  ('DELIVERY', 1, 'ISSUED',    'REQUEST_CONFIRMED', 'CONFIRMED',  array['SYSTEM'], null,              false, '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'ISSUED',    'REQUEST_CONTESTED', 'CONTESTED',  array['SYSTEM'], null,              false, '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'ISSUED',    'REISSUE',           'ISSUED',     array['USER'],   'delivery.issue',  false, '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'CONTESTED', 'REISSUE',           'CONTESTED',  array['USER'],   'delivery.issue',  false, '20260831160300_delivery_state_machine.sql'),
  -- FASE 5: fired by the correction/supersede flow, not built yet.
  ('DELIVERY', 1, 'CONFIRMED', 'SUPERSEDE',         'SUPERSEDED', array['USER'],   'delivery.issue',  true,  '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'CONTESTED', 'SUPERSEDE',         'SUPERSEDED', array['USER'],   'delivery.issue',  true,  '20260831160300_delivery_state_machine.sql');

-- Generic enforcement trigger, reused for CONFIRMATION_REQUEST in FASE 3 (any table with a
-- `status` + `last_event` column and a `frozen_at` column can attach it, passing its own
-- machine name via TG_ARGV[0]).
create function app.enforce_state_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_transition app.state_transitions%rowtype;
begin
  if NEW.status is not distinct from OLD.status then
    if OLD.frozen_at is not null then
      raise exception 'row % is frozen and cannot be modified', OLD.id using errcode = '23514';
    end if;
    return NEW;
  end if;

  -- Belt-and-braces beyond the column-level REVOKE: catches a bug in a FUTURE RPC that
  -- updates `status` outside a dedicated transition_*() call, since every RPC runs as the
  -- table owner (bypassing grants) and this check does not rely on grants at all.
  if current_setting('app.transition_ok', true) is distinct from OLD.id::text then
    raise exception 'status may only change inside a transition function' using errcode = '42501';
  end if;

  select * into v_transition from app.state_transitions t
   where t.machine = TG_ARGV[0] and t.machine_version = 1
     and t.from_state = OLD.status::text and t.event = NEW.last_event;

  if not found or v_transition.to_state <> NEW.status::text then
    raise exception 'illegal transition %: % --%--> %', TG_ARGV[0], OLD.status, NEW.last_event, NEW.status
      using errcode = '23514';
  end if;

  NEW.status_changed_at := clock_timestamp();
  return NEW;
end;
$$;

comment on function app.enforce_state_transition() is
  'Generic (OLD.status, event, NEW.status) validator against app.state_transitions. A CHECK constraint cannot see OLD (cannot validate a MOVE, only a value) and a generated column cannot depend on the previous row -- a trigger is the only mechanism that can. Requires the calling RPC to perform `perform set_config(''app.transition_ok'', id::text, true)` immediately before the UPDATE.';

-- ============================================================
-- 20260831160400_epi_deliveries.sql
-- ============================================================
-- FASE 2: the business fact (epi_deliveries) and its snapshot line items
-- (epi_delivery_items). See docs/architecture.md §8 for the state machine and §6/§12 for
-- why items are value-copies, not live references.

create table app.epi_deliveries (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null,
  company_id                uuid not null,
  employee_id               uuid not null,
  chain_id                  uuid not null default gen_random_uuid(),
  chain_version             integer not null default 1 check (chain_version >= 1),
  corrects_delivery_id      uuid references app.epi_deliveries (id) on delete restrict,
  superseded_by_delivery_id uuid references app.epi_deliveries (id) on delete restrict,
  status                    app.delivery_status not null default 'DRAFT',
  last_event                text,
  status_changed_at         timestamptz not null default now(),
  delivery_date             date not null check (delivery_date between date '2020-01-01' and date '2100-01-01'),
  note                      text check (length(note) <= 2000),
  issued_at                 timestamptz,
  frozen_at                 timestamptz,
  confirmed_at              timestamptz,
  contested_at              timestamptz,
  cancelled_at              timestamptz,
  cancel_reason             text check (length(cancel_reason) <= 500),
  created_by                uuid not null references app.users (id),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  foreign key (company_id, employee_id) references app.employees (company_id, id) on delete restrict,
  constraint deliveries_id_company_key unique (id, company_id),
  constraint deliveries_chain_key unique (chain_id, chain_version),
  constraint frozen_iff_settled check ((frozen_at is not null) = (status in ('CONFIRMED', 'CONTESTED', 'SUPERSEDED'))),
  constraint confirmed_ts_ck check (confirmed_at is null or status in ('CONFIRMED', 'SUPERSEDED')),
  constraint contested_ts_ck check (contested_at is null or status in ('CONTESTED', 'SUPERSEDED')),
  constraint cancelled_ts_ck check ((cancelled_at is not null) = (status = 'CANCELLED')),
  constraint superseded_ck check ((superseded_by_delivery_id is not null) = (status = 'SUPERSEDED')),
  constraint correction_ck check (chain_version = 1 or corrects_delivery_id is not null)
);

comment on table app.epi_deliveries is
  'The business fact: this company handed these PPE items to this worker on this date. Holds only the DELIVERY lifecycle (docs/architecture.md §8) -- never the confirmation-attempt lifecycle, which lives on confirmation_requests (FASE 3). frozen_at is the immutability boundary: once set, no column may change except the supersession pair.';

-- At most one non-terminal delivery per correction chain -- a correction chain never has
-- two "live" deliveries in flight simultaneously.
create unique index deliveries_one_live_per_chain on app.epi_deliveries (chain_id)
  where status not in ('SUPERSEDED', 'CANCELLED');
create index deliveries_board_idx on app.epi_deliveries (company_id, status, delivery_date desc);
create index deliveries_emp_idx on app.epi_deliveries (employee_id, delivery_date desc);

create trigger epi_deliveries_transition
  before update on app.epi_deliveries
  for each row execute function app.enforce_state_transition('DELIVERY');

create trigger epi_deliveries_set_updated_at
  before update on app.epi_deliveries
  for each row execute function extensions.moddatetime(updated_at);

-- Mass-assignment / illegal-write defence: authenticated cannot touch ANY column via a
-- direct PostgREST UPDATE. Every write, including the initial insert, is RPC-only
-- (next migration) -- there is no INSERT grant either, so a delivery cannot even be
-- created directly.
revoke insert, update, delete on app.epi_deliveries from authenticated;

alter table app.epi_deliveries enable row level security;
alter table app.epi_deliveries force row level security;

grant select on app.epi_deliveries to authenticated;

create policy epi_deliveries_select on app.epi_deliveries
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('delivery.read'))::uuid[]));

create table app.epi_delivery_items (
  id             uuid primary key default gen_random_uuid(),
  delivery_id    uuid not null,
  company_id     uuid not null,
  line_no        smallint not null check (line_no between 1 and 200),
  epi_id         uuid references app.epis (id) on delete restrict,          -- provenance only
  epi_version_id uuid not null references app.epi_versions (id) on delete restrict,
  -- value copies: what was shown/handed over, immune to later catalog edits
  epi_name       text not null check (length(btrim(epi_name)) between 2 and 200),
  ca_number      text not null check (ca_number ~ '^[0-9]{3,8}$'),
  manufacturer   text,
  model          text,
  quantity       integer not null check (quantity between 1 and 10000),
  unit           text not null default 'UN' check (unit in ('UN', 'PAR', 'CX', 'M', 'KG')),
  created_at     timestamptz not null default now(),
  foreign key (company_id, delivery_id) references app.epi_deliveries (company_id, id) on delete restrict,
  constraint items_line_key unique (delivery_id, line_no)
);

comment on table app.epi_delivery_items is
  'Line items, snapshotted BY VALUE from the epi_version current at creation time. This table, not the catalog, is what docs/mvp-roadmap.md FASE 2''s acceptance test checks: editing an epi after ISSUED must not change these rows.';

create index items_delivery_idx on app.epi_delivery_items (delivery_id, line_no);
create index items_ca_idx on app.epi_delivery_items (company_id, ca_number);

-- Items are mutable ONLY while the parent delivery is DRAFT -- once ISSUED the worker may
-- already have opened a link (FASE 3), so changing a line would break "what was shown".
create function app.enforce_items_draft_only()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_delivery_id uuid;
  v_status app.delivery_status;
begin
  v_delivery_id := coalesce(NEW.delivery_id, OLD.delivery_id);
  select status into v_status from app.epi_deliveries where id = v_delivery_id;
  if v_status is distinct from 'DRAFT' then
    raise exception 'delivery items are only editable while the delivery is DRAFT (current status: %)', v_status
      using errcode = '23514';
  end if;
  return coalesce(NEW, OLD);
end;
$$;

create trigger epi_delivery_items_draft_only
  before insert or update or delete on app.epi_delivery_items
  for each row execute function app.enforce_items_draft_only();

revoke insert, update, delete on app.epi_delivery_items from authenticated;

alter table app.epi_delivery_items enable row level security;
alter table app.epi_delivery_items force row level security;

grant select on app.epi_delivery_items to authenticated;

create policy epi_delivery_items_select on app.epi_delivery_items
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('delivery.read'))::uuid[]));

-- ============================================================
-- 20260831160500_delivery_rpcs.sql
-- ============================================================
-- FASE 2: delivery creation and state-transition RPCs.

-- Creates a DRAFT delivery plus its line items in one transaction, snapshotting each
-- item's name/CA/manufacturer/model from the epi's CURRENT version at this instant. Later
-- catalog edits (api.update_epi) can never retroactively change these rows -- see
-- docs/mvp-roadmap.md FASE 2's acceptance test.
create function api.create_delivery(
  p_company_id uuid,
  p_employee_id uuid,
  p_delivery_date date,
  p_note text,
  p_items jsonb  -- [{epi_id: uuid, quantity: int, unit?: text}, ...]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_delivery_id uuid;
  v_item_count int;
begin
  if not (select auth_ctx.has_permission(p_company_id, 'delivery.create')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'delivery_has_no_items' using errcode = '23514';
  end if;
  if jsonb_array_length(p_items) > 200 then
    raise exception 'too_many_items' using errcode = '54000';
  end if;

  select organization_id into v_org_id from app.companies where id = p_company_id;

  if not exists (
    select 1 from app.employees
    where id = p_employee_id and company_id = p_company_id and archived_at is null
  ) then
    raise exception 'employee_not_found' using errcode = 'P0002';
  end if;

  insert into app.epi_deliveries (organization_id, company_id, employee_id, delivery_date, note, created_by)
  values (v_org_id, p_company_id, p_employee_id, p_delivery_date, p_note, (select auth.uid()))
  returning id into v_delivery_id;

  with incoming as (
    select x.epi_id, x.quantity, x.unit, x.ord
    from rows from (jsonb_to_recordset(p_items) as (epi_id uuid, quantity int, unit text))
      with ordinality as x(epi_id, quantity, unit, ord)
  ),
  resolved as (
    select
      i.ord, i.quantity, i.unit,
      ev.epi_id as resolved_epi_id, ev.id as epi_version_id,
      ev.name, ev.ca_number, ev.manufacturer, ev.model, ev.default_unit, ev.company_id as epi_company_id
    from incoming i
    join app.epi_versions ev on ev.epi_id = i.epi_id and ev.valid_to is null
  )
  insert into app.epi_delivery_items (
    delivery_id, company_id, line_no, epi_id, epi_version_id,
    epi_name, ca_number, manufacturer, model, quantity, unit
  )
  select
    v_delivery_id, p_company_id, r.ord, r.resolved_epi_id, r.epi_version_id,
    r.name, r.ca_number, r.manufacturer, r.model, r.quantity, coalesce(r.unit, r.default_unit)
  from resolved r
  where r.epi_company_id is null or r.epi_company_id = p_company_id;  -- reject items from another company's private catalog

  get diagnostics v_item_count = row_count;
  if v_item_count <> jsonb_array_length(p_items) then
    raise exception 'one_or_more_items_invalid' using errcode = '23514';
  end if;

  return v_delivery_id;
end;
$$;

comment on function api.create_delivery(uuid, uuid, date, text, jsonb) is
  'Creates a delivery in DRAFT with its items snapshotted from the current catalog. Every item must resolve to a live epi_version visible to this company (org-wide or same-company) or the whole call fails -- no partial delivery with silently-dropped items.';

revoke execute on function api.create_delivery(uuid, uuid, date, text, jsonb) from public, anon;
grant execute on function api.create_delivery(uuid, uuid, date, text, jsonb) to authenticated;

create function api.issue_delivery(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_status app.delivery_status;
  v_item_count int;
begin
  select company_id, status into v_company_id, v_status
  from app.epi_deliveries where id = p_delivery_id;

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
end;
$$;

comment on function api.issue_delivery(uuid) is
  'DRAFT -> ISSUED. FASE 3 will extend this (or wrap it) to also create the first confirmation_request/token -- deliberately not built yet, see docs/mvp-roadmap.md FASE 2/3.';

revoke execute on function api.issue_delivery(uuid) from public, anon;
grant execute on function api.issue_delivery(uuid) to authenticated;

create function api.cancel_delivery(p_delivery_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_status app.delivery_status;
begin
  select company_id, status into v_company_id, v_status
  from app.epi_deliveries where id = p_delivery_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.cancel')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_status not in ('DRAFT', 'ISSUED') then
    raise exception 'delivery_not_cancellable' using errcode = '23514';
  end if;

  perform set_config('app.transition_ok', p_delivery_id::text, true);
  update app.epi_deliveries
  set status = 'CANCELLED', last_event = 'CANCEL', cancelled_at = clock_timestamp(), cancel_reason = p_reason
  where id = p_delivery_id;
end;
$$;

comment on function api.cancel_delivery(uuid, text) is
  'DRAFT or ISSUED -> CANCELLED. Never callable once frozen (CONFIRMED/CONTESTED/SUPERSEDED) -- the trigger enforces this independent of this check, since is_settled deliveries have no CANCEL edge in app.state_transitions at all.';

revoke execute on function api.cancel_delivery(uuid, text) from public, anon;
grant execute on function api.cancel_delivery(uuid, text) to authenticated;

-- ============================================================
-- 20260831160600_deliveries_api_views.sql
-- ============================================================
-- FASE 2: read-only projections for the delivery list/detail screens.

create view api.epi_deliveries
  with (security_invoker = true) as
select
  d.id, d.organization_id, d.company_id, d.employee_id, d.chain_id, d.chain_version,
  d.corrects_delivery_id, d.superseded_by_delivery_id, d.status, d.delivery_date, d.note,
  d.issued_at, d.frozen_at, d.confirmed_at, d.contested_at, d.cancelled_at, d.cancel_reason,
  d.created_by, d.created_at, d.updated_at,
  e.full_name as employee_full_name
from app.epi_deliveries d
join app.employees e on e.id = d.employee_id;

comment on view api.epi_deliveries is
  'Delivery list/detail projection, joined to the employee''s current name for display. security_invoker means RLS on epi_deliveries (and, via the join, employees) applies for the caller.';

grant select on api.epi_deliveries to authenticated;

create view api.epi_delivery_items
  with (security_invoker = true) as
select
  id, delivery_id, company_id, line_no, epi_id, epi_version_id,
  epi_name, ca_number, manufacturer, model, quantity, unit, created_at
from app.epi_delivery_items;

comment on view api.epi_delivery_items is
  'Read-only projection of the snapshotted line items -- exactly what was (or will be) presented to the worker, immune to later catalog edits.';

grant select on api.epi_delivery_items to authenticated;

