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
