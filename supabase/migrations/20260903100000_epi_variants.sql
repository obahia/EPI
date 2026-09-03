-- Phase A: EPI variants/SKUs (spec §5 -- "não modele tamanho como string solta dentro da
-- entrega"). A variant belongs to exactly one epi (composite FK anti-cross-attach, same
-- structural pattern this schema already uses everywhere -- e.g. epi_returns's delivery_item_id
-- FK). Nullable everywhere it's referenced: an EPI with no variants (most of them) behaves
-- exactly as before this migration.

create table app.epi_variants (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  epi_id          uuid not null,
  label           text not null check (length(btrim(label)) between 1 and 30),  -- "42", "GG", etc.
  sku             text check (length(sku) <= 60),
  attributes      jsonb not null default '{}',
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  foreign key (epi_id, organization_id) references app.epis (id, organization_id) on delete restrict,
  constraint epi_variants_id_epi_key unique (id, epi_id),
  constraint epi_variants_label_key unique (epi_id, label)
);

comment on table app.epi_variants is
  'A size/color/SKU variant of one EPI catalog entry (e.g. Botina -> 38/39/40/41/42). epi_variants_id_epi_key exists so app.epi_delivery_items.variant_id can carry a composite FK preventing a variant from ever being attached to the wrong EPI.';

create index epi_variants_epi_idx on app.epi_variants (epi_id) where is_active;

alter table app.epi_variants enable row level security;
alter table app.epi_variants force row level security;

grant select on app.epi_variants to authenticated;

-- Same visibility rule as app.epis itself: a variant is visible whenever its parent epi is
-- (org-wide catalog or the caller's own company), resolved via a join here rather than a
-- denormalized company_id -- epi_variants has no company_id of its own since it always
-- belongs to exactly one epi, whose scope is already the single source of truth.
create policy epi_variants_select on app.epi_variants
  for select to authenticated
  using (
    exists (
      select 1 from app.epis e
      where e.id = epi_variants.epi_id
        and e.organization_id = any ((select auth_ctx.organization_ids())::uuid[])
        and (e.company_id is null or e.company_id = any ((select auth_ctx.company_ids())::uuid[]))
    )
  );

revoke insert, update, delete on app.epi_variants from authenticated;

create function api.create_epi_variant(
  p_epi_id uuid,
  p_label text,
  p_sku text default null,
  p_attributes jsonb default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_company_id uuid;
  v_org_id uuid;
  v_variant_id uuid;
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

  insert into app.epi_variants (organization_id, epi_id, label, sku, attributes)
  values (v_org_id, p_epi_id, p_label, p_sku, coalesce(p_attributes, '{}'::jsonb))
  returning id into v_variant_id;

  return v_variant_id;
exception
  when unique_violation then
    raise exception 'variant_label_already_exists' using errcode = '23505';
end;
$$;

comment on function api.create_epi_variant(uuid, text, text, jsonb) is
  'Creates a size/SKU variant under one EPI catalog entry. Same permission gate as editing the EPI itself (epi.update / org-wide ORG_ADMIN for a shared entry).';

revoke execute on function api.create_epi_variant(uuid, text, text, jsonb) from public, anon;
grant execute on function api.create_epi_variant(uuid, text, text, jsonb) to authenticated;

create function api.deactivate_epi_variant(p_variant_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_epi_id uuid;
  v_company_id uuid;
  v_org_id uuid;
begin
  select epi_id into v_epi_id from app.epi_variants where id = p_variant_id;
  if v_epi_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  select company_id, organization_id into v_company_id, v_org_id
  from app.epis where id = v_epi_id;

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

  update app.epi_variants set is_active = p_is_active where id = p_variant_id;
end;
$$;

comment on function api.deactivate_epi_variant(uuid, boolean) is
  'Toggles is_active. Does not affect history -- a delivery item that already snapshotted this variant keeps its variant_label regardless.';

revoke execute on function api.deactivate_epi_variant(uuid, boolean) from public, anon;
grant execute on function api.deactivate_epi_variant(uuid, boolean) to authenticated;

create view api.epi_variants
  with (security_invoker = true) as
select id, organization_id, epi_id, label, sku, attributes, is_active, created_at
from app.epi_variants;

comment on view api.epi_variants is 'Read-only projection of app.epi_variants. security_invoker means RLS applies for the caller.';

grant select on api.epi_variants to authenticated;

-- Delivery item gains an optional variant reference + value-snapshot label -- same
-- immutability discipline as epi_name/ca_number (a later variant rename/deactivation must
-- never change what an already-issued delivery says it handed over).
alter table app.epi_delivery_items
  add column variant_id uuid,
  add column variant_label text;

alter table app.epi_delivery_items
  add constraint epi_delivery_items_variant_epi_fk
    foreign key (variant_id, epi_id) references app.epi_variants (id, epi_id) on delete restrict;

comment on column app.epi_delivery_items.variant_id is
  'Optional -- most EPIs have no variants. When set, must belong to the same epi_id as this line item (enforced by the composite FK), never a different EPI''s variant.';
comment on column app.epi_delivery_items.variant_label is
  'Value-snapshot of the variant''s label at delivery time, same discipline as epi_name/ca_number -- immune to a later variant rename.';

-- Existing view (20260831160600_deliveries_api_views.sql) gets the two new columns
-- appended.
create or replace view api.epi_delivery_items
  with (security_invoker = true) as
select
  id, delivery_id, company_id, line_no, epi_id, epi_version_id,
  epi_name, ca_number, manufacturer, model, quantity, unit, created_at,
  variant_id, variant_label
from app.epi_delivery_items;

comment on view api.epi_delivery_items is
  'Read-only projection of the snapshotted line items -- exactly what was (or will be) presented to the worker, immune to later catalog/variant edits.';

grant select on api.epi_delivery_items to authenticated;

-- Final Phase-A shape of api.create_delivery: reason_code/reason_note (previous migration)
-- plus an optional variant_id per item. p_items rows may now include a "variant_id" key;
-- omitting it (every pre-Phase-A caller) resolves to NULL, unchanged behavior. A supplied
-- variant_id is validated to belong to the SAME epi_id as its own row -- a mismatched
-- variant fails the whole call via the same "resolved count must equal input count" guard
-- already used for epi_id itself, rather than silently dropping or reassigning it.
create or replace function api.create_delivery(
  p_company_id uuid,
  p_employee_id uuid,
  p_delivery_date date,
  p_note text,
  p_items jsonb,  -- [{epi_id: uuid, quantity: int, unit?: text, variant_id?: uuid}, ...]
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
      ev.name, ev.ca_number, ev.manufacturer, ev.model, ev.default_unit, ev.company_id as epi_company_id,
      i.variant_id, ev2.label as variant_label
    from incoming i
    join app.epi_versions ev on ev.epi_id = i.epi_id and ev.valid_to is null
    left join app.epi_variants ev2 on ev2.id = i.variant_id and ev2.epi_id = i.epi_id
    where i.variant_id is null or ev2.id is not null  -- a variant_id belonging to a DIFFERENT epi resolves to no row -> excluded, caught by the count check below
  )
  insert into app.epi_delivery_items (
    delivery_id, company_id, line_no, epi_id, epi_version_id,
    epi_name, ca_number, manufacturer, model, quantity, unit, variant_id, variant_label
  )
  select
    v_delivery_id, p_company_id, r.ord, r.resolved_epi_id, r.epi_version_id,
    r.name, r.ca_number, r.manufacturer, r.model, r.quantity, coalesce(r.unit, r.default_unit),
    r.variant_id, r.variant_label
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
  'Creates a delivery in DRAFT with its items snapshotted from the current catalog. Each item may optionally carry a variant_id, which must belong to the SAME epi_id -- a mismatched or foreign variant_id makes that item resolve to nothing, failing the whole call via the item-count guard, never silently dropped or reassigned. p_reason_code defaults to FIRST_ISSUE.';

revoke execute on function api.create_delivery(uuid, uuid, date, text, jsonb, text, text) from public, anon;
grant execute on function api.create_delivery(uuid, uuid, date, text, jsonb, text, text) to authenticated;
