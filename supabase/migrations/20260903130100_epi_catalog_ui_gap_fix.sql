-- Phase C closure-gate fix: default_lifespan_days (added in 20260903120000) and
-- requires_return_on_replacement (added in 20260903110100) were both real, migrated,
-- functioning backend columns feeding real logic (the lifecycle-status computation and the
-- pending-returns pendency respectively) -- but NEITHER api.create_epi nor api.update_epi
-- ever accepted requires_return_on_replacement at all (it could only ever be its column
-- default, false, forever -- there was no write path, so api.pending_returns could never
-- return a row in practice), and the frontend never surfaced default_lifespan_days even
-- though the RPC already accepted it. A backend feature with no way to ever be turned on is
-- exactly the "declared in schema but not functional" gap this phase's own closure audit
-- must not defer -- fixed now, not left as technical debt.

drop function if exists api.create_epi(uuid, uuid, text, text, text, text, text, text, integer);
drop function if exists api.update_epi(uuid, text, text, text, text, text, text, integer);

create function api.create_epi(
  p_organization_id uuid,
  p_company_id uuid,
  p_name text,
  p_ca_number text,
  p_manufacturer text default null,
  p_model text default null,
  p_description text default null,
  p_default_unit text default 'UN',
  p_default_lifespan_days integer default null,
  p_requires_return_on_replacement boolean default false
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

  insert into app.epis (organization_id, company_id, requires_return_on_replacement, created_by)
  values (p_organization_id, p_company_id, coalesce(p_requires_return_on_replacement, false), v_uid)
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

comment on function api.create_epi(uuid, uuid, text, text, text, text, text, text, integer, boolean) is
  'Creates a PPE catalog entry + its version 1, including vida útil padrão (default_lifespan_days) and the devolução-obrigatória policy flag (requires_return_on_replacement) -- the only two write paths for either field.';

revoke execute on function api.create_epi(uuid, uuid, text, text, text, text, text, text, integer, boolean) from public, anon;
grant execute on function api.create_epi(uuid, uuid, text, text, text, text, text, text, integer, boolean) to authenticated;

create function api.update_epi(
  p_epi_id uuid,
  p_name text,
  p_ca_number text,
  p_manufacturer text,
  p_model text,
  p_description text,
  p_default_unit text,
  p_default_lifespan_days integer default null,
  p_requires_return_on_replacement boolean default false
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

  -- requires_return_on_replacement is identity-level policy, not a versioned attribute like
  -- name/ca_number -- a plain UPDATE on app.epis itself, same as api.deactivate_epi's own
  -- is_active toggle, never part of the epi_versions SCD2 history.
  update app.epis set requires_return_on_replacement = coalesce(p_requires_return_on_replacement, false)
  where id = p_epi_id;

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

comment on function api.update_epi(uuid, text, text, text, text, text, text, integer, boolean) is
  'Closes the current epi_version and opens a new one (SCD2), including default_lifespan_days -- and separately, plainly updates requires_return_on_replacement on app.epis itself (not versioned).';

revoke execute on function api.update_epi(uuid, text, text, text, text, text, text, integer, boolean) from public, anon;
grant execute on function api.update_epi(uuid, text, text, text, text, text, text, integer, boolean) to authenticated;
