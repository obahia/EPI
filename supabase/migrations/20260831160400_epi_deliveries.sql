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
