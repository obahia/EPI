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
