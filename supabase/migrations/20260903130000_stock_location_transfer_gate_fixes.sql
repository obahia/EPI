-- Phase B/C closure-gate fixes, found by a rigorous re-audit before marking either phase
-- CLOSED (not by a new feature request): three real gaps, each fixed here rather than
-- deferred, per the standing rule that a bug belonging to the phase being closed must be
-- fixed now, not pushed to technical debt.
--
-- Gap 1: api.issue_delivery's automatic ENTREGA movement always used location_id NULL (the
-- company-wide bucket), even when the employee has a location_id -- so "estoque por
-- unidade" (locations, this same Phase B) was never actually consumed from the right
-- bucket. Same gap in api.return_epi_item's DEVOLUCAO movement. Fixed: both now resolve the
-- employee's own location_id and use it (falling back to the company-wide NULL bucket only
-- when the employee has none).
--
-- Gap 2: TRANSFERENCIA_SAIDA/TRANSFERENCIA_ENTRADA were valid movement_type values in the
-- CHECK constraint and could be recorded individually via api.record_stock_movement, but
-- there was no RPC that ever created BOTH sides atomically -- a caller could decrement one
-- location without ever crediting the other, silently losing units from the ledger's own
-- point of view. Fixed: a new api.transfer_stock RPC that writes both movements in one
-- transaction (the SAIDA side can fail insufficient_stock, rolling back the whole transfer).
--
-- Gap 3: api.create_replacement_delivery's initial SELECT of the original delivery's status
-- had no row lock -- under genuine concurrent execution (two managers replacing the same
-- delivery at the same instant), the loser's status check could read stale data and only
-- fail later at the UPDATE, surfacing the trigger's raw "row is frozen" message instead of
-- the domain-level original_not_replaceable error a sequential caller gets. Fixed: `for
-- update` on that SELECT serializes concurrent callers on the row lock, so the loser
-- re-reads the now-SUPERSEDED status after the winner commits and hits the same clean
-- domain error a sequential second call already does -- no behavior change for the
-- non-concurrent case, and no new state introduced.

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
  v_employee_location_id uuid;
  v_item record;
begin
  select d.company_id, d.status, c.organization_id, e.location_id
  into v_company_id, v_status, v_org_id, v_employee_location_id
  from app.epi_deliveries d
  join app.companies c on c.id = d.company_id
  join app.employees e on e.id = d.employee_id
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
        organization_id, company_id, location_id, epi_id, variant_id,
        movement_type, quantity, reference_delivery_item_id, actor_user_id
      ) values (
        v_org_id, v_company_id, v_employee_location_id, v_item.epi_id, v_item.variant_id,
        'ENTREGA', -abs(v_item.quantity), v_item.id, (select auth.uid())
      );
    end loop;
  end if;
end;
$$;

comment on function api.issue_delivery(uuid) is
  'DRAFT -> ISSUED. When the organization has inventory_enabled, also writes one ENTREGA (negative) stock_movements row per item, in the EMPLOYEE''S OWN location bucket (falling back to the company-wide NULL bucket only when the employee has no location_id). insufficient_stock (23514) aborts the whole call, including the status transition, if any item would drive a balance negative and stock_negative_allowed is false.';

revoke execute on function api.issue_delivery(uuid) from public, anon;
grant execute on function api.issue_delivery(uuid) to authenticated;

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
  v_employee_location_id uuid;
  v_inventory_enabled boolean;
begin
  select i.company_id, i.delivery_id, d.status, i.epi_id, i.variant_id, i.quantity, e.location_id
  into v_company_id, v_delivery_id, v_delivery_status, v_epi_id, v_variant_id, v_quantity, v_employee_location_id
  from app.epi_delivery_items i
  join app.epi_deliveries d on d.id = i.delivery_id
  join app.employees e on e.id = d.employee_id
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
      organization_id, company_id, location_id, epi_id, variant_id,
      movement_type, quantity, reference_return_id, actor_user_id
    ) values (
      v_org_id, v_company_id, v_employee_location_id, v_epi_id, v_variant_id,
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
  'Records that one delivery line item was returned, into the EMPLOYEE''S OWN location bucket when REUSABLE + inventory_enabled (same fallback rule as api.issue_delivery). p_condition_code (REUSABLE/DAMAGED/DISCARDED/OTHER) is the item''s physical condition, distinct from p_reason_code (why it came back).';

revoke execute on function api.return_epi_item(uuid, date, text, text, text) from public, anon;
grant execute on function api.return_epi_item(uuid, date, text, text, text) to authenticated;

-- Atomic paired transfer: both movements in one transaction, one referencing the other via
-- metadata (there is no dedicated "transfer group" table -- two rows with a shared
-- transfer_id in metadata is enough for this phase's audit/history needs). The SAIDA side is
-- inserted FIRST so the negative-balance guard (app.apply_stock_movement) can reject the
-- whole transfer if the source location doesn't actually have the stock, before the
-- destination is ever credited.
create function api.transfer_stock(
  p_company_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_epi_id uuid,
  p_variant_id uuid,
  p_quantity integer,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_transfer_id uuid := gen_random_uuid();
begin
  if not (select auth_ctx.has_permission(p_company_id, 'stock.write')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '23514';
  end if;
  if p_from_location_id is not distinct from p_to_location_id then
    raise exception 'transfer_locations_must_differ' using errcode = '23514';
  end if;

  select organization_id into v_org_id from app.companies where id = p_company_id;

  insert into app.stock_movements (
    organization_id, company_id, location_id, epi_id, variant_id,
    movement_type, quantity, reason, actor_user_id, metadata
  ) values (
    v_org_id, p_company_id, p_from_location_id, p_epi_id, p_variant_id,
    'TRANSFERENCIA_SAIDA', -p_quantity, p_reason, (select auth.uid()), jsonb_build_object('transfer_id', v_transfer_id)
  );

  insert into app.stock_movements (
    organization_id, company_id, location_id, epi_id, variant_id,
    movement_type, quantity, reason, actor_user_id, metadata
  ) values (
    v_org_id, p_company_id, p_to_location_id, p_epi_id, p_variant_id,
    'TRANSFERENCIA_ENTRADA', p_quantity, p_reason, (select auth.uid()), jsonb_build_object('transfer_id', v_transfer_id)
  );

  perform app.log_audit_event(
    v_org_id, p_company_id, 'STOCK_TRANSFERRED', 'stock_movements', v_transfer_id, 'USER', (select auth.uid()),
    jsonb_build_object('from_location_id', p_from_location_id, 'to_location_id', p_to_location_id, 'epi_id', p_epi_id, 'quantity', p_quantity)
  );

  return v_transfer_id;
end;
$$;

comment on function api.transfer_stock(uuid, uuid, uuid, uuid, uuid, integer, text) is
  'The only path that ever produces TRANSFERENCIA_SAIDA/TRANSFERENCIA_ENTRADA rows -- api.record_stock_movement rejects both (see its own CHECK below). Writes both sides of a transfer atomically: if the source location lacks the stock, app.apply_stock_movement''s guard raises insufficient_stock on the FIRST insert, and the whole transfer (including the not-yet-executed credit side) rolls back -- never a transfer that debited one location without crediting the other.';

revoke execute on function api.transfer_stock(uuid, uuid, uuid, uuid, uuid, integer, text) from public, anon;
grant execute on function api.transfer_stock(uuid, uuid, uuid, uuid, uuid, integer, text) to authenticated;

-- api.record_stock_movement already listed TRANSFERENCIA_SAIDA/TRANSFERENCIA_ENTRADA as
-- invalid for manual entry (see its own p_movement_type CHECK, unchanged) -- restated here
-- only as a comment update, not a behavior change: this migration's job is to give those
-- two movement types an actual atomic path (api.transfer_stock, above), not to relax the
-- manual RPC's guard against a caller creating a lopsided single-sided "transfer" by hand.
comment on function api.record_stock_movement(uuid, uuid, uuid, uuid, text, integer, text, jsonb) is
  'Manual stock movement (entrada/ajuste/descarte) plus the single-sided rejection of transferência types -- api.transfer_stock is the only path that ever produces TRANSFERENCIA_SAIDA/TRANSFERENCIA_ENTRADA rows, always as an atomic pair.';

-- Concurrency hardening for api.create_replacement_delivery: `for update` on the initial
-- SELECT (see this migration's own header for why). Everything else in the function body is
-- unchanged from 20260903120000_epi_lifecycle_troca.sql.
create or replace function api.create_replacement_delivery(
  p_original_delivery_id uuid,
  p_items jsonb,
  p_delivery_date date,
  p_note text,
  p_reason_code text,
  p_reason_note text default null,
  p_confirm_early boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_org_id uuid;
  v_employee_id uuid;
  v_status app.delivery_status;
  v_chain_id uuid;
  v_chain_version int;
  v_earliest_due date;
  v_policy text;
  v_new_delivery_id uuid;
  v_item_count int;
begin
  select d.company_id, c.organization_id, d.employee_id, d.status, d.chain_id, d.chain_version
  into v_company_id, v_org_id, v_employee_id, v_status, v_chain_id, v_chain_version
  from app.epi_deliveries d
  join app.companies c on c.id = d.company_id
  where d.id = p_original_delivery_id
  for update of d;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.issue')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.create')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_status not in ('CONFIRMED', 'CONTESTED') then
    raise exception 'original_not_replaceable' using errcode = '23514';
  end if;

  if p_reason_code not in (
    'FIRST_ISSUE', 'PERIODIC_REPLACEMENT', 'WEAR', 'DAMAGE', 'LOSS',
    'SIZE_CHANGE', 'ROLE_CHANGE', 'EXPIRATION', 'OTHER'
  ) then
    raise exception 'invalid_reason_code' using errcode = '22023';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'delivery_has_no_items' using errcode = '23514';
  end if;
  if jsonb_array_length(p_items) > 200 then
    raise exception 'too_many_items' using errcode = '54000';
  end if;

  select min(d.confirmed_at::date + i.lifespan_days)
  into v_earliest_due
  from app.epi_deliveries d
  join app.epi_delivery_items i on i.delivery_id = d.id
  where d.id = p_original_delivery_id and i.lifespan_days is not null and d.confirmed_at is not null;

  select early_replacement_policy into v_policy from app.organizations where id = v_org_id;

  if v_earliest_due is not null and v_earliest_due > current_date then
    if v_policy = 'block' then
      raise exception 'early_replacement_blocked' using errcode = '23514';
    elsif v_policy = 'warn' then
      if not p_confirm_early then
        raise exception 'early_replacement_confirmation_required' using errcode = '23514';
      end if;
      if p_reason_note is null or length(btrim(p_reason_note)) < 3 then
        raise exception 'reason_note_required_for_early_replacement' using errcode = '23514';
      end if;
    end if;
  end if;

  v_new_delivery_id := gen_random_uuid();

  perform set_config('app.transition_ok', p_original_delivery_id::text, true);
  update app.epi_deliveries
  set status = 'SUPERSEDED', last_event = 'SUPERSEDE', superseded_by_delivery_id = v_new_delivery_id
  where id = p_original_delivery_id;

  insert into app.epi_deliveries (
    id, organization_id, company_id, employee_id, chain_id, chain_version, corrects_delivery_id,
    delivery_date, note, reason_code, reason_note, created_by
  )
  values (
    v_new_delivery_id, v_org_id, v_company_id, v_employee_id, v_chain_id, v_chain_version + 1, p_original_delivery_id,
    p_delivery_date, p_note, p_reason_code, p_reason_note, (select auth.uid())
  );

  with incoming as (
    select x.epi_id, x.quantity, x.unit, x.variant_id, x.ord
    from rows from (
      jsonb_to_recordset(p_items) as (epi_id uuid, quantity int, unit text, variant_id uuid)
    ) with ordinality as x(epi_id, quantity, unit, variant_id, ord)
  ),
  resolved as (
    select
      i.ord, i.quantity, i.unit,
      ev.epi_id as resolved_epi_id, ev.id as epi_version_id,
      ev.name, ev.ca_number, ev.manufacturer, ev.model, ev.default_unit, ev.default_lifespan_days,
      ev.company_id as epi_company_id,
      i.variant_id, ev2.label as variant_label
    from incoming i
    join app.epi_versions ev on ev.epi_id = i.epi_id and ev.valid_to is null
    left join app.epi_variants ev2 on ev2.id = i.variant_id and ev2.epi_id = i.epi_id
    where i.variant_id is null or ev2.id is not null
  )
  insert into app.epi_delivery_items (
    delivery_id, company_id, line_no, epi_id, epi_version_id,
    epi_name, ca_number, manufacturer, model, quantity, unit, variant_id, variant_label, lifespan_days
  )
  select
    v_new_delivery_id, v_company_id, r.ord, r.resolved_epi_id, r.epi_version_id,
    r.name, r.ca_number, r.manufacturer, r.model, r.quantity, coalesce(r.unit, r.default_unit),
    r.variant_id, r.variant_label, r.default_lifespan_days
  from resolved r
  where r.epi_company_id is null or r.epi_company_id = v_company_id;

  get diagnostics v_item_count = row_count;
  if v_item_count <> jsonb_array_length(p_items) then
    raise exception 'one_or_more_items_invalid' using errcode = '23514';
  end if;

  perform app.log_audit_event(
    v_org_id, v_company_id, 'DELIVERY_REPLACED', 'epi_deliveries', p_original_delivery_id, 'USER', (select auth.uid()),
    jsonb_build_object('new_delivery_id', v_new_delivery_id, 'reason_code', p_reason_code)
  );

  return v_new_delivery_id;
end;
$$;

comment on function api.create_replacement_delivery(uuid, jsonb, date, text, text, text, boolean) is
  'The "troca" RPC: locks the original row (FOR UPDATE) before checking its status, so two concurrent trocas against the same delivery serialize -- the loser re-reads the now-SUPERSEDED status after the winner commits and hits original_not_replaceable, the same clean domain error a sequential second call already gets, never the state-machine trigger''s raw "row is frozen" message. Immediately supersedes p_original_delivery_id (must be CONFIRMED/CONTESTED) and creates a new delivery in the SAME correction chain (chain_version+1, corrects_delivery_id). Enforces early_replacement_policy (warn/block/allow).';

revoke execute on function api.create_replacement_delivery(uuid, jsonb, date, text, text, text, boolean) from public, anon;
grant execute on function api.create_replacement_delivery(uuid, jsonb, date, text, text, text, boolean) to authenticated;
