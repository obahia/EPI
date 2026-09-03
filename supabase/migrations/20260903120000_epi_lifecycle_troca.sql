-- Phase C: PPE lifecycle -- vida útil, troca (wires the chain_id/chain_version/
-- corrects_delivery_id/superseded_by_delivery_id columns app.epi_deliveries has carried
-- since FASE 2 to an actual RPC), early-replacement policy enforcement, and a deterministic
-- lifecycle-status read.

-- api.create_replacement_delivery below sets superseded_by_delivery_id to a NOT-YET-INSERTED
-- id (minted before either statement, so the original's UPDATE and the new row's INSERT can
-- be ordered to satisfy deliveries_one_live_per_chain -- see that function's own comment).
-- A normal FK is checked at the end of the SAME statement, which would reject this; DEFERRABLE
-- INITIALLY DEFERRED postpones the check to COMMIT, by which point the referenced row exists
-- within the same transaction. This ALTER only changes deferred-ness, not the FK itself.
alter table app.epi_deliveries
  alter constraint epi_deliveries_superseded_by_delivery_id_fkey deferrable initially deferred;

-- Vida útil padrão is a versioned catalog attribute (alongside name/ca_number/manufacturer),
-- nullable -- not every EPI has a mandated replacement cycle.
alter table app.epi_versions
  add column default_lifespan_days integer check (default_lifespan_days is null or default_lifespan_days between 1 and 3650);

comment on column app.epi_versions.default_lifespan_days is
  'Vida útil padrão in days. NULL means this EPI has no tracked expiry -- its lifecycle status is always VIGENTE.';

-- Value-snapshotted onto the delivery item at creation time, same immutability discipline
-- as epi_name/ca_number/variant_label -- a later catalog edit must never retroactively
-- change what an already-issued delivery's due date is computed from.
alter table app.epi_delivery_items
  add column lifespan_days integer;

comment on column app.epi_delivery_items.lifespan_days is
  'Value-snapshot of the epi_version''s default_lifespan_days at delivery time. Immune to a later catalog edit -- see epi_name''s own comment for why this discipline exists.';

create type app.epi_lifecycle_status as enum (
  'VIGENTE', 'PROXIMO_DA_TROCA', 'TROCA_NECESSARIA', 'DEVOLVIDO', 'DESCARTADO'
);

comment on type app.epi_lifecycle_status is
  'The CURRENT status of one confirmed delivery item. SUBSTITUIDO/PERDIDO (spec §10) are not separate values here -- a superseded delivery simply stops appearing in api.employee_epi_lifecycle at all (its status moves to SUPERSEDED, excluded by that function''s own filter); the reason it was superseded is the REPLACING delivery''s own reason_code, visible on the ficha/timeline, not a state of the old item.';

-- api.create_delivery/api.create_delivery_batch both gain the lifespan_days snapshot --
-- same argument list as before (no signature change), so a plain CREATE OR REPLACE is safe.
create or replace function api.create_delivery(
  p_company_id uuid,
  p_employee_id uuid,
  p_delivery_date date,
  p_note text,
  p_items jsonb,
  p_reason_code text default 'FIRST_ISSUE',
  p_reason_note text default null
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

  select organization_id into v_org_id from app.companies where id = p_company_id;

  if not exists (
    select 1 from app.employees
    where id = p_employee_id and company_id = p_company_id and archived_at is null
  ) then
    raise exception 'employee_not_found' using errcode = 'P0002';
  end if;

  insert into app.epi_deliveries (
    organization_id, company_id, employee_id, delivery_date, note, reason_code, reason_note, created_by
  )
  values (v_org_id, p_company_id, p_employee_id, p_delivery_date, p_note, p_reason_code, p_reason_note, (select auth.uid()))
  returning id into v_delivery_id;

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
    v_delivery_id, p_company_id, r.ord, r.resolved_epi_id, r.epi_version_id,
    r.name, r.ca_number, r.manufacturer, r.model, r.quantity, coalesce(r.unit, r.default_unit),
    r.variant_id, r.variant_label, r.default_lifespan_days
  from resolved r
  where r.epi_company_id is null or r.epi_company_id = p_company_id;

  get diagnostics v_item_count = row_count;
  if v_item_count <> jsonb_array_length(p_items) then
    raise exception 'one_or_more_items_invalid' using errcode = '23514';
  end if;

  return v_delivery_id;
end;
$$;

comment on function api.create_delivery(uuid, uuid, date, text, jsonb, text, text) is
  'Creates a delivery in DRAFT with its items snapshotted from the current catalog (name/CA/manufacturer/model/variant/lifespan_days -- all immune to a later catalog edit). Each item may optionally carry a variant_id, which must belong to the SAME epi_id. p_reason_code defaults to FIRST_ISSUE.';

revoke execute on function api.create_delivery(uuid, uuid, date, text, jsonb, text, text) from public, anon;
grant execute on function api.create_delivery(uuid, uuid, date, text, jsonb, text, text) to authenticated;

create or replace function api.create_delivery_batch(
  p_company_id uuid,
  p_epi_items jsonb,
  p_confirmations jsonb,
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
      coalesce(x.unit, ev.default_unit) as unit, x.quantity, ev.company_id as epi_company_id, ev.default_lifespan_days
    from rows from (jsonb_to_recordset(p_epi_items) as (epi_id uuid, quantity int, unit text))
      with ordinality as x(epi_id, quantity, unit, ord)
    join app.epi_versions ev on ev.epi_id = x.epi_id and ev.valid_to is null
    where ev.company_id is null or ev.company_id = p_company_id
  ),
  new_deliveries as (
    insert into app.epi_deliveries (organization_id, company_id, employee_id, batch_id, delivery_date, note, status, issued_at, created_by)
    select v_org_id, p_company_id, vt.employee_id, v_batch_id, p_delivery_date, p_note, 'ISSUED', clock_timestamp(), v_created_by
    from valid_targets vt
    returning id, employee_id
  ),
  new_items as (
    insert into app.epi_delivery_items (
      delivery_id, company_id, line_no, epi_id, epi_version_id, epi_name, ca_number, manufacturer, model, quantity, unit, lifespan_days
    )
    select nd.id, p_company_id, ri.ord, ri.epi_id, ri.epi_version_id, ri.name, ri.ca_number, ri.manufacturer, ri.model, ri.quantity, ri.unit, ri.default_lifespan_days
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

  perform app.log_audit_event(v_org_id, p_company_id, 'BATCH_CREATED', 'delivery_batches', v_batch_id, 'USER', v_created_by,
    jsonb_build_object('delivery_count', v_created_delivery_count));

  return query select v_batch_id, v_created_delivery_count;
end;
$$;

comment on function api.create_delivery_batch(uuid, jsonb, jsonb, date, text) is
  'Creates an entire batch (deliveries + line items + confirmation_requests) in one transaction via chained data-modifying CTEs, including the lifespan_days snapshot on every item.';

revoke execute on function api.create_delivery_batch(uuid, jsonb, jsonb, date, text) from public, anon;
grant execute on function api.create_delivery_batch(uuid, jsonb, jsonb, date, text) to authenticated;

-- api.create_epi/api.update_epi both gain a trailing p_default_lifespan_days param -- a
-- genuine argument-count change, so the old signatures must be dropped first (Postgres
-- cannot widen a function's arg list via CREATE OR REPLACE even with a default value --
-- see this phase's own sibling migrations for where this was first caught empirically).
drop function if exists api.create_epi(uuid, uuid, text, text, text, text, text, text);
drop function if exists api.update_epi(uuid, text, text, text, text, text, text);

create function api.create_epi(
  p_organization_id uuid,
  p_company_id uuid,
  p_name text,
  p_ca_number text,
  p_manufacturer text default null,
  p_model text default null,
  p_description text default null,
  p_default_unit text default 'UN',
  p_default_lifespan_days integer default null
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
    manufacturer, model, description, default_unit, default_lifespan_days, created_by
  ) values (
    v_epi_id, p_organization_id, p_company_id, 1, p_name, p_ca_number,
    p_manufacturer, p_model, p_description, p_default_unit, p_default_lifespan_days, v_uid
  );

  return v_epi_id;
exception
  when unique_violation then
    raise exception 'ca_already_registered' using errcode = '23505';
end;
$$;

comment on function api.create_epi(uuid, uuid, text, text, text, text, text, text, integer) is
  'Creates a PPE catalog entry + its version 1, including the optional vida útil padrão (default_lifespan_days).';

revoke execute on function api.create_epi(uuid, uuid, text, text, text, text, text, text, integer) from public, anon;
grant execute on function api.create_epi(uuid, uuid, text, text, text, text, text, text, integer) to authenticated;

create function api.update_epi(
  p_epi_id uuid,
  p_name text,
  p_ca_number text,
  p_manufacturer text,
  p_model text,
  p_description text,
  p_default_unit text,
  p_default_lifespan_days integer default null
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
    manufacturer, model, description, default_unit, default_lifespan_days, created_by
  ) values (
    p_epi_id, v_org_id, v_company_id, v_next_version, p_name, p_ca_number,
    p_manufacturer, p_model, p_description, p_default_unit, p_default_lifespan_days, v_uid
  );
exception
  when unique_violation then
    raise exception 'ca_already_registered' using errcode = '23505';
end;
$$;

comment on function api.update_epi(uuid, text, text, text, text, text, text, integer) is
  'Closes the current epi_version and opens a new one (SCD2), including default_lifespan_days -- never an in-place UPDATE.';

revoke execute on function api.update_epi(uuid, text, text, text, text, text, text, integer) from public, anon;
grant execute on function api.update_epi(uuid, text, text, text, text, text, text, integer) to authenticated;

-- Existing views gain the new columns at the end.
create or replace view api.epis
  with (security_invoker = true) as
select
  e.id, e.organization_id, e.company_id, e.is_active, e.archived_at, e.created_at,
  v.id as current_version_id, v.version, v.name, v.ca_number, v.manufacturer, v.model,
  v.description, v.default_unit, v.valid_from as version_valid_from,
  e.requires_return_on_replacement, v.default_lifespan_days
from app.epis e
join app.epi_versions v on v.epi_id = e.id and v.valid_to is null
where e.archived_at is null;

comment on view api.epis is
  'One row per active EPI catalog entry, joined to its current version. security_invoker means RLS on both underlying tables applies for the caller.';

grant select on api.epis to authenticated;

create or replace view api.epi_delivery_items
  with (security_invoker = true) as
select
  id, delivery_id, company_id, line_no, epi_id, epi_version_id,
  epi_name, ca_number, manufacturer, model, quantity, unit, created_at,
  variant_id, variant_label, lifespan_days
from app.epi_delivery_items;

comment on view api.epi_delivery_items is
  'Read-only projection of the snapshotted line items -- exactly what was (or will be) presented to the worker, immune to later catalog/variant edits.';

grant select on api.epi_delivery_items to authenticated;

-- Troca ---------------------------------------------------------------------------------

-- Reuses the already-seeded CONFIRMED/CONTESTED -> SUPERSEDED edge (app.state_transitions,
-- FASE 2) rather than adding a new one. The original is superseded IMMEDIATELY at
-- troca-creation time -- a "troca" is a decision made now, not a state that waits for the
-- replacement's own confirmation cycle. This also means the original must be superseded
-- BEFORE the new delivery is inserted: deliveries_one_live_per_chain (a partial unique
-- index, checked immediately, not deferrable) would otherwise see two live rows on the same
-- chain_id for the instant between the two statements.
create function api.create_replacement_delivery(
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
  where d.id = p_original_delivery_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.issue')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.create')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  -- Only a delivery that actually reached a confirmed-or-contested receipt can be
  -- "replaced" -- a still-DRAFT/ISSUED delivery is edited or cancelled instead, and
  -- app.state_transitions has no SUPERSEDE edge from those states at all.
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

  -- Early-replacement check: the earliest (most conservative) due date across the
  -- ORIGINAL's own items that actually track a lifespan. No lifespan tracked on any item
  -- (v_earliest_due IS NULL) means nothing to warn about, regardless of policy.
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
    -- 'allow': no check at all.
  end if;

  -- Minted here, not left to app.epi_deliveries.id's own default gen_random_uuid() --
  -- superseded_ck requires superseded_by_delivery_id and status='SUPERSEDED' to become
  -- non-null/true in the SAME statement (a CHECK constraint is evaluated at the end of
  -- EVERY statement, not deferred), so the original's UPDATE must already know the new
  -- delivery's id before the new row itself exists. A real bug, caught only by actually
  -- running this against a real engine: the first draft superseded the original in one
  -- UPDATE (status only) and set superseded_by_delivery_id in a second, later UPDATE --
  -- violating superseded_ck on the very first statement, since status='SUPERSEDED' briefly
  -- existed with a still-NULL superseded_by_delivery_id.
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
  'The "troca" RPC: immediately supersedes p_original_delivery_id (must be CONFIRMED/CONTESTED) and creates a new delivery in the SAME correction chain (chain_version+1, corrects_delivery_id). Enforces the organization''s early_replacement_policy (warn/block/allow) -- warn requires p_confirm_early=true plus a non-trivial p_reason_note; block never proceeds regardless of p_confirm_early. The new delivery starts DRAFT like any other -- issue/confirm it through the normal flow.';

revoke execute on function api.create_replacement_delivery(uuid, jsonb, date, text, text, text, boolean) from public, anon;
grant execute on function api.create_replacement_delivery(uuid, jsonb, date, text, text, text, boolean) to authenticated;

-- Lifecycle read --------------------------------------------------------------------------

-- Deliberately excludes anything not currently CONFIRMED -- a DRAFT/ISSUED delivery has no
-- evidentiary receipt yet (spec §10: "após uma entrega CONFIRMADA"), and a SUPERSEDED one is
-- history, not a current holding (see app.epi_lifecycle_status's own comment).
create function api.employee_epi_lifecycle(p_employee_id uuid)
returns table (
  delivery_id uuid,
  delivery_item_id uuid,
  epi_id uuid,
  epi_name text,
  ca_number text,
  variant_label text,
  quantity integer,
  confirmed_at timestamptz,
  lifespan_days integer,
  due_date date,
  status app.epi_lifecycle_status,
  days_remaining integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_alert_days integer;
begin
  select company_id into v_company_id from app.employees where id = p_employee_id and archived_at is null;
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'employee.read')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select o.replacement_alert_days into v_alert_days
  from app.organizations o
  join app.companies c on c.organization_id = o.id
  where c.id = v_company_id;

  return query
  select
    d.id, i.id, i.epi_id, i.epi_name, i.ca_number, i.variant_label, i.quantity,
    d.confirmed_at, i.lifespan_days,
    case when i.lifespan_days is not null and d.confirmed_at is not null
      then (d.confirmed_at::date + i.lifespan_days) else null end,
    case
      when r.id is not null and r.condition_code = 'DISCARDED' then 'DESCARTADO'::app.epi_lifecycle_status
      when r.id is not null then 'DEVOLVIDO'::app.epi_lifecycle_status
      when i.lifespan_days is null or d.confirmed_at is null then 'VIGENTE'::app.epi_lifecycle_status
      when (d.confirmed_at::date + i.lifespan_days) < current_date then 'TROCA_NECESSARIA'::app.epi_lifecycle_status
      when (d.confirmed_at::date + i.lifespan_days) <= current_date + coalesce(v_alert_days, 30) then 'PROXIMO_DA_TROCA'::app.epi_lifecycle_status
      else 'VIGENTE'::app.epi_lifecycle_status
    end,
    case when i.lifespan_days is not null and d.confirmed_at is not null
      then (d.confirmed_at::date + i.lifespan_days) - current_date else null end
  from app.epi_deliveries d
  join app.epi_delivery_items i on i.delivery_id = d.id
  left join app.epi_returns r on r.delivery_item_id = i.id
  where d.employee_id = p_employee_id
    and d.status = 'CONFIRMED'
  order by d.confirmed_at desc;
end;
$$;

comment on function api.employee_epi_lifecycle(uuid) is
  'Deterministic per-item lifecycle status for one employee''s currently-held (CONFIRMED, non-superseded) deliveries -- see app.epi_lifecycle_status for the enum and why SUBSTITUIDO/PERDIDO are not separate values. Requires employee.read on the employee''s company.';

revoke execute on function api.employee_epi_lifecycle(uuid) from public, anon;
grant execute on function api.employee_epi_lifecycle(uuid) to authenticated;

-- Pendências de devolução obrigatória ("se não for devolvido, gerar pendência", spec §9) --
-- a SUPERSEDED delivery whose EPI is configured requires_return_on_replacement and has no
-- matching app.epi_returns row yet. Computed, not a stored flag -- resolves itself the
-- moment api.return_epi_item records the return.
create function api.pending_returns(p_company_id uuid)
returns table (
  delivery_id uuid,
  delivery_item_id uuid,
  epi_id uuid,
  epi_name text,
  ca_number text,
  employee_id uuid,
  employee_full_name text,
  superseded_at timestamptz,
  replaced_by_delivery_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_permission(p_company_id, 'delivery.return')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select
    d.id, i.id, i.epi_id, i.epi_name, i.ca_number,
    d.employee_id, e.full_name, d.status_changed_at, d.superseded_by_delivery_id
  from app.epi_deliveries d
  join app.epi_delivery_items i on i.delivery_id = d.id
  join app.epis ep on ep.id = i.epi_id
  join app.employees e on e.id = d.employee_id
  left join app.epi_returns r on r.delivery_item_id = i.id
  where d.company_id = p_company_id
    and d.status = 'SUPERSEDED'
    and ep.requires_return_on_replacement
    and r.id is null
  order by d.status_changed_at asc;
end;
$$;

comment on function api.pending_returns(uuid) is
  'EPIs flagged requires_return_on_replacement whose delivery was superseded (troca) but never got an app.epi_returns row -- an open pendency, per spec §9. Requires delivery.return on the company.';

revoke execute on function api.pending_returns(uuid) from public, anon;
grant execute on function api.pending_returns(uuid) to authenticated;

-- Organization policy settings ------------------------------------------------------------

-- Wires the Phase-A policy/feature-flag columns (early_replacement_policy,
-- replacement_alert_days, stock_negative_allowed, inventory_enabled, compliance_enabled,
-- role_matrix_enabled) to an actual settings RPC -- they shipped as columns-only in Phase A
-- deliberately (default-off, zero behavior change) until this write path existed.
create function api.update_organization_policy(
  p_organization_id uuid,
  p_early_replacement_policy text,
  p_replacement_alert_days integer,
  p_stock_negative_allowed boolean,
  p_inventory_enabled boolean,
  p_compliance_enabled boolean,
  p_role_matrix_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from authz.memberships m
    where m.user_id = (select auth.uid()) and m.organization_id = p_organization_id
      and m.company_id is null and m.role = 'ORG_ADMIN' and m.revoked_at is null
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_early_replacement_policy not in ('warn', 'block', 'allow') then
    raise exception 'invalid_policy' using errcode = '22023';
  end if;

  update app.organizations set
    early_replacement_policy = p_early_replacement_policy,
    replacement_alert_days = p_replacement_alert_days,
    stock_negative_allowed = p_stock_negative_allowed,
    inventory_enabled = p_inventory_enabled,
    compliance_enabled = p_compliance_enabled,
    role_matrix_enabled = p_role_matrix_enabled
  where id = p_organization_id;

  perform app.log_audit_event(
    p_organization_id, null, 'ORGANIZATION_POLICY_UPDATED', 'organizations', p_organization_id, 'USER', (select auth.uid()),
    jsonb_build_object(
      'early_replacement_policy', p_early_replacement_policy,
      'inventory_enabled', p_inventory_enabled,
      'compliance_enabled', p_compliance_enabled,
      'role_matrix_enabled', p_role_matrix_enabled
    )
  );
end;
$$;

comment on function api.update_organization_policy(uuid, text, integer, boolean, boolean, boolean, boolean) is
  'Org-wide ORG_ADMIN only. The write path for the Phase-A policy/feature-flag columns on app.organizations.';

revoke execute on function api.update_organization_policy(uuid, text, integer, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function api.update_organization_policy(uuid, text, integer, boolean, boolean, boolean, boolean) to authenticated;

-- Read projection of the policy columns (api.companies already exposes company-level
-- fields; organization-level policy has no read view yet at all).
create view api.organization_policy
  with (security_invoker = true) as
select
  id as organization_id, early_replacement_policy, replacement_alert_days, stock_negative_allowed,
  inventory_enabled, compliance_enabled, role_matrix_enabled, default_assurance_level,
  link_ttl_hours, identity_max_attempts, evidence_retention_months
from app.organizations;

comment on view api.organization_policy is
  'Read-only projection of the organization-level policy/feature-flag columns. security_invoker means RLS on app.organizations applies for the caller (visible only to the caller''s own organizations).';

grant select on api.organization_policy to authenticated;
