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
