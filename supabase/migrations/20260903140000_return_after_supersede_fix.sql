-- Real bug found during live E2E closure-audit testing: api.return_epi_item required the
-- delivery to be status='CONFIRMED' -- but a troca (api.create_replacement_delivery)
-- immediately moves the ORIGINAL delivery to status='SUPERSEDED'. Since requires_return_
-- on_replacement's whole point (spec §9) is "devolução obrigatória NA SUBSTITUIÇÃO", the
-- item that most needs to be returned is exactly the one on a delivery that has ALREADY
-- been superseded by a troca -- and the RPC unconditionally rejected that exact case with
-- delivery_not_confirmed, making the devolução obrigatória workflow (and api.pending_returns,
-- which specifically queries SUPERSEDED deliveries) impossible to ever complete. Found live:
-- after registering a troca in the browser against the real epi-dev database, the "Devolver"
-- action had nothing to call that would succeed.
--
-- Fixed: CONFIRMED or SUPERSEDED are both acceptable delivery states to return an item
-- from. Still rejects DRAFT/ISSUED/CONTESTED/CANCELLED -- an item that was never actually
-- confirmed received, or whose delivery was cancelled/contested, still cannot be "returned"
-- (there is nothing legally received to give back).

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

  -- CONFIRMED (the ordinary case) or SUPERSEDED (the item was received, then a troca
  -- replaced it -- the devolução obrigatória workflow this whole check exists for) are both
  -- legitimate. DRAFT/ISSUED (never confirmed received) and CONTESTED/CANCELLED (no valid
  -- receipt to return) are not.
  if v_delivery_status not in ('CONFIRMED', 'SUPERSEDED') then
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
  'Records that one delivery line item was returned. Accepts CONFIRMED or SUPERSEDED deliveries (a superseded delivery is exactly the devolução-obrigatória-on-troca case, spec §9) -- never DRAFT/ISSUED/CONTESTED/CANCELLED. Into the EMPLOYEE''S OWN location bucket when REUSABLE + inventory_enabled. p_condition_code (REUSABLE/DAMAGED/DISCARDED/OTHER) is the item''s physical condition, distinct from p_reason_code (why it came back).';

revoke execute on function api.return_epi_item(uuid, date, text, text, text) from public, anon;
grant execute on function api.return_epi_item(uuid, date, text, text, text) to authenticated;
