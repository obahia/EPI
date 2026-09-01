-- FASE 2: EPI catalog RPCs. create_epi inserts the identity row + version 1 in one
-- transaction; update_epi closes the current version and opens a new one (SCD2) -- never
-- an in-place UPDATE of name/ca_number/etc, per docs/architecture.md §12.

create function api.create_epi(
  p_organization_id uuid,
  p_company_id uuid,       -- NULL = org-wide shared catalog entry
  p_name text,
  p_ca_number text,
  p_manufacturer text default null,
  p_model text default null,
  p_description text default null,
  p_default_unit text default 'UN'
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
    -- Org-wide catalog entry: requires org-wide ORG_ADMIN, same rule as api.create_company.
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
    manufacturer, model, description, default_unit, created_by
  ) values (
    v_epi_id, p_organization_id, p_company_id, 1, p_name, p_ca_number,
    p_manufacturer, p_model, p_description, p_default_unit, v_uid
  );

  return v_epi_id;
exception
  when unique_violation then
    raise exception 'ca_already_registered' using errcode = '23505';
end;
$$;

comment on function api.create_epi(uuid, uuid, text, text, text, text, text, text) is
  'Creates a PPE catalog entry + its version 1. p_company_id NULL creates an org-wide shared entry (requires org-wide ORG_ADMIN); non-null scopes it to one company (requires epi.create there).';

revoke execute on function api.create_epi(uuid, uuid, text, text, text, text, text, text) from public, anon;
grant execute on function api.create_epi(uuid, uuid, text, text, text, text, text, text) to authenticated;

create function api.update_epi(
  p_epi_id uuid,
  p_name text,
  p_ca_number text,
  p_manufacturer text,
  p_model text,
  p_description text,
  p_default_unit text
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
    manufacturer, model, description, default_unit, created_by
  ) values (
    p_epi_id, v_org_id, v_company_id, v_next_version, p_name, p_ca_number,
    p_manufacturer, p_model, p_description, p_default_unit, v_uid
  );
exception
  when unique_violation then
    raise exception 'ca_already_registered' using errcode = '23505';
end;
$$;

comment on function api.update_epi(uuid, text, text, text, text, text, text) is
  'Closes the current epi_version and opens a new one with the edited fields (SCD2) -- never an in-place UPDATE. Deliveries created before this call keep pointing at the old epi_version_id, so their snapshot is unaffected. See docs/mvp-roadmap.md FASE 2 acceptance criterion.';

revoke execute on function api.update_epi(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function api.update_epi(uuid, text, text, text, text, text, text) to authenticated;

create function api.deactivate_epi(p_epi_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_company_id uuid;
  v_org_id uuid;
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

  update app.epis set is_active = p_is_active where id = p_epi_id;
end;
$$;

comment on function api.deactivate_epi(uuid, boolean) is
  'Toggles is_active. Does not affect history -- a delivery referencing an inactive EPI keeps its snapshot; inactive EPIs are just hidden from the picker for new deliveries.';

revoke execute on function api.deactivate_epi(uuid, boolean) from public, anon;
grant execute on function api.deactivate_epi(uuid, boolean) to authenticated;
