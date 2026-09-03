-- EPI returns (devolução), per-item, manager-recorded only -- two explicit product
-- decisions made with the user before writing this:
--   1. Scoped to one delivery ITEM, not the whole delivery -- a multi-item delivery
--      (luva + bota) can have one line returned while the other stays with the worker.
--   2. No worker confirmation and no sealed evidence, unlike a delivery: the manager
--      records date + reason directly. A devolução is bookkeeping, not the same legal
--      receipt a delivery confirmation is -- it never touches confirmation_requests,
--      worker.*, or evidence.*.
--
-- Own table rather than columns on epi_delivery_items, for the same reason
-- delivery_contests is its own table: a return is an EVENT with its own actor/timestamp/
-- reason, not a mutable property of the item row -- and epi_delivery_items is otherwise
-- immutable once ISSUED (enforce_items_draft_only), so writing onto it would need an
-- exception carved into that trigger for this one case.

-- Composite unique needed so app.epi_returns can chain a tenant-scoped FK to the item,
-- the same structural anti-escape pattern every cross-tenant-sensitive table in this
-- schema already uses (docs/architecture.md §3) -- epi_delivery_items never needed one
-- until now (nothing referenced it directly before).
alter table app.epi_delivery_items add constraint items_id_company_key unique (id, company_id);

create table app.epi_returns (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  company_id        uuid not null,
  delivery_id       uuid not null,
  delivery_item_id  uuid not null,
  returned_on       date not null check (returned_on between date '2020-01-01' and date '2100-01-01'),
  reason_code       text not null check (reason_code in ('WORN_OUT', 'REPLACED', 'TERMINATION', 'OTHER')),
  note              text check (note is null or length(note) <= 2000),
  created_by        uuid not null references app.users (id),
  created_at        timestamptz not null default clock_timestamp(),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  foreign key (company_id, delivery_id) references app.epi_deliveries (company_id, id) on delete restrict,
  foreign key (delivery_item_id, company_id) references app.epi_delivery_items (id, company_id) on delete restrict,
  constraint returns_other_needs_note check (reason_code <> 'OTHER' or (note is not null and length(btrim(note)) >= 3)),
  -- One return per item, full stop, for v1 -- no partial-quantity returns (quantity 2
  -- gloves returning 1 of them), no re-return after a correction. Revisit only if a real
  -- customer needs it; nothing here blocks adding that later.
  constraint returns_one_per_item unique (delivery_item_id)
);

comment on table app.epi_returns is
  'One row per returned line item -- manager-recorded fact, no worker confirmation or sealed evidence (product decision, 2026-09-03: a devolução is bookkeeping, not a legal receipt the way a delivery is). At most one return per delivery_item_id.';

create index returns_delivery_idx on app.epi_returns (delivery_id);
create index returns_item_idx on app.epi_returns (delivery_item_id);

revoke insert, update, delete on app.epi_returns from authenticated;
alter table app.epi_returns enable row level security;
alter table app.epi_returns force row level security;

grant select on app.epi_returns to authenticated;

-- Same read gate as the delivery it belongs to -- a return is part of the delivery
-- record, not a separate resource with its own permission.
create policy epi_returns_select on app.epi_returns
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('delivery.read'))::uuid[]));

-- New permission, INSERT-only into the existing table (no DDL) -- same convention the
-- original role_permissions seed migration documents for exactly this situation.
insert into authz.role_permissions (role, permission) values
  ('SST_OPERATOR', 'delivery.return'),
  ('COMPANY_ADMIN', 'delivery.return'),
  ('ORG_ADMIN', 'delivery.return');

create function api.return_epi_item(
  p_delivery_item_id uuid,
  p_returned_on date,
  p_reason_code text,
  p_note text default null
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
begin
  select i.company_id, i.delivery_id, d.status
  into v_company_id, v_delivery_id, v_delivery_status
  from app.epi_delivery_items i
  join app.epi_deliveries d on d.id = i.delivery_id
  where i.id = p_delivery_item_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.return')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Cannot return an item from a delivery that was never confirmed received: DRAFT/ISSUED
  -- means the worker hasn't confirmed getting it yet, CONTESTED means they dispute even
  -- that, CANCELLED means it was undone. Only a genuinely confirmed handover can later be
  -- returned.
  if v_delivery_status <> 'CONFIRMED' then
    raise exception 'delivery_not_confirmed' using errcode = '23514';
  end if;

  if p_reason_code not in ('WORN_OUT', 'REPLACED', 'TERMINATION', 'OTHER') then
    raise exception 'invalid_reason_code' using errcode = '22023';
  end if;
  if p_reason_code = 'OTHER' and (p_note is null or length(btrim(p_note)) < 3) then
    raise exception 'note_required_for_other' using errcode = '23514';
  end if;

  v_org_id := (select organization_id from app.companies where id = v_company_id);

  insert into app.epi_returns (
    organization_id, company_id, delivery_id, delivery_item_id,
    returned_on, reason_code, note, created_by
  ) values (
    v_org_id, v_company_id, v_delivery_id, p_delivery_item_id,
    p_returned_on, p_reason_code, p_note, (select auth.uid())
  )
  returning id into v_return_id;

  perform app.log_audit_event(
    v_org_id, v_company_id, 'EPI_RETURNED', 'epi_delivery_items', p_delivery_item_id, 'USER', (select auth.uid()),
    jsonb_build_object('return_id', v_return_id, 'reason_code', p_reason_code)
  );

  return v_return_id;
exception
  when unique_violation then
    raise exception 'already_returned' using errcode = '23505';
end;
$$;

comment on function api.return_epi_item(uuid, date, text, text) is
  'Records that one delivery line item was returned. Manager-facing only -- no worker confirmation, no sealed evidence. Requires delivery.return and the parent delivery to be CONFIRMED. One return per item (already_returned, 23505, on a second attempt).';

revoke execute on function api.return_epi_item(uuid, date, text, text) from public, anon;
grant execute on function api.return_epi_item(uuid, date, text, text) to authenticated;

-- Read-only projection, same shape/convention as api.epi_delivery_items.
create view api.epi_returns
  with (security_invoker = true) as
select
  id, organization_id, company_id, delivery_id, delivery_item_id,
  returned_on, reason_code, note, created_by, created_at
from app.epi_returns;

comment on view api.epi_returns is
  'Read-only projection of recorded EPI returns. security_invoker means RLS on epi_returns applies for the caller.';

grant select on api.epi_returns to authenticated;

-- Fixes a bug this migration's own EPI_RETURNED event just made reachable for the first
-- time: api.delivery_audit_events grouped entity_table 'epi_delivery_items' into the SAME
-- entity_id-in-confirmation_requests subquery as 'confirmation_requests' events. An
-- epi_delivery_items-tagged event's entity_id is an item id, never a confirmation_request
-- id, so that branch could never have matched anything -- dead code until now, because
-- nothing produced an epi_delivery_items-tagged audit event before EPI_RETURNED. Split
-- into its own clause, scoped by the item's own delivery_id instead.
create or replace function api.delivery_audit_events(p_delivery_id uuid)
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
     or (ae.entity_table = 'confirmation_requests' and ae.entity_id in (
           select cr.id from app.confirmation_requests cr where cr.delivery_id = p_delivery_id
         ))
     or (ae.entity_table = 'epi_delivery_items' and ae.entity_id in (
           select i.id from app.epi_delivery_items i where i.delivery_id = p_delivery_id
         ))
  order by ae.seq asc;
end;
$$;

comment on function api.delivery_audit_events(uuid) is
  'The full audit timeline for one delivery: its own events, every confirmation_request it has ever had, and every return recorded against one of its line items. Requires audit.read on the delivery''s company.';
