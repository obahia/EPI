-- Phase A: organization-level policy/feature-flag columns (extends the existing
-- app.organizations policy-column convention -- link_ttl_hours, identity_max_attempts,
-- evidence_retention_months, 20260831140200_organizations_companies.sql -- rather than
-- inventing a generic settings blob) + delivery reason_code (spec §7's "motivos possíveis").
--
-- Feature flags default OFF: this migration must not change behavior for any existing org.
-- A dedicated org-settings-update RPC to flip them is a later phase's concern (flipping
-- inventory_enabled needs its own permission/audit story once inventory actually exists).

alter table app.organizations
  add column early_replacement_policy text not null default 'warn'
    check (early_replacement_policy in ('warn', 'block', 'allow')),
  add column replacement_alert_days integer not null default 30
    check (replacement_alert_days between 1 and 365),
  add column stock_negative_allowed boolean not null default false,
  add column inventory_enabled boolean not null default false,
  add column compliance_enabled boolean not null default false,
  add column role_matrix_enabled boolean not null default false;

comment on column app.organizations.early_replacement_policy is
  'Governs what happens when a manager tries to deliver an EPI a worker already holds within its lifespan: warn (default, confirm-to-continue), block, or allow silently. Enforced by a later phase''s create_delivery extension once lifecycle tracking exists.';
comment on column app.organizations.inventory_enabled is
  'Feature flag, default false. When true, issue_delivery/return_epi_item also write app.stock_movements. False means zero behavior change from the pre-inventory schema.';

alter table app.epi_deliveries
  add column reason_code text not null default 'FIRST_ISSUE' check (reason_code in (
    'FIRST_ISSUE', 'PERIODIC_REPLACEMENT', 'WEAR', 'DAMAGE', 'LOSS',
    'SIZE_CHANGE', 'ROLE_CHANGE', 'EXPIRATION', 'OTHER'
  )),
  add column reason_note text check (reason_note is null or length(reason_note) <= 1000);

comment on column app.epi_deliveries.reason_code is
  'Why this delivery happened (spec: primeira entrega/substituição periódica/desgaste/dano/perda/troca de tamanho/troca de função/vencimento/outro). Existing rows backfilled to FIRST_ISSUE -- a safe default with no data loss, not a claim that every prior delivery really was a first issue.';

-- Existing view (20260831160600_deliveries_api_views.sql, already extended once for
-- batch_id in 20260831200400) gets the two new columns appended -- CREATE OR REPLACE VIEW
-- can add trailing columns without a DROP, same precedent as that earlier extension.
create or replace view api.epi_deliveries
  with (security_invoker = true) as
select
  d.id, d.organization_id, d.company_id, d.employee_id, d.chain_id, d.chain_version,
  d.corrects_delivery_id, d.superseded_by_delivery_id, d.status, d.delivery_date, d.note,
  d.issued_at, d.frozen_at, d.confirmed_at, d.contested_at, d.cancelled_at, d.cancel_reason,
  d.created_by, d.created_at, d.updated_at,
  e.full_name as employee_full_name,
  d.batch_id,
  d.reason_code, d.reason_note
from app.epi_deliveries d
join app.employees e on e.id = d.employee_id;

comment on view api.epi_deliveries is
  'Delivery list/detail projection, joined to the employee''s current name for display. security_invoker means RLS on epi_deliveries (and, via the join, employees) applies for the caller.';

grant select on api.epi_deliveries to authenticated;

-- api.create_delivery gains two new trailing DEFAULTed params. A function's identity in
-- Postgres is name + parameter TYPE LIST -- CREATE OR REPLACE cannot change the argument
-- count even when every new parameter has a default (verified against a real Postgres
-- engine: doing this for api.create_employee left both signatures installed as separate
-- overloads, "is not unique" on any call with fewer than the new full argument count). The
-- old 5-arg signature must be dropped explicitly first -- same convention this schema
-- already uses for worker.open_link/worker.finish_confirmation across signature changes.
drop function if exists api.create_delivery(uuid, uuid, date, text, jsonb);

create function api.create_delivery(
  p_company_id uuid,
  p_employee_id uuid,
  p_delivery_date date,
  p_note text,
  p_items jsonb,  -- [{epi_id: uuid, quantity: int, unit?: text}, ...]
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

comment on function api.create_delivery(uuid, uuid, date, text, jsonb, text, text) is
  'Creates a delivery in DRAFT with its items snapshotted from the current catalog. p_reason_code defaults to FIRST_ISSUE so every pre-Phase-A caller keeps working unchanged. Every item must resolve to a live epi_version visible to this company (org-wide or same-company) or the whole call fails -- no partial delivery with silently-dropped items.';

revoke execute on function api.create_delivery(uuid, uuid, date, text, jsonb, text, text) from public, anon;
grant execute on function api.create_delivery(uuid, uuid, date, text, jsonb, text, text) to authenticated;
