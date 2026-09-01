-- FASE 1: organization/company creation RPCs. Both were deliberately deferred out of
-- FASE 0 (docs/architecture.md §7: "organizations are created by a platform/onboarding
-- SECURITY DEFINER RPC") -- this is that RPC, now that there is an actual UI to call it.

-- A brand-new user with ZERO live memberships creates their own DIRECT organization plus
-- its one company, and becomes ORG_ADMIN, in one transaction. This is what makes
-- "Admin cria empresa" (Definition of Done step 1) meaningful without an invite system --
-- see mvp-roadmap.md FASE 1. A user who already has a membership cannot call this again:
-- self-serve onboarding is a one-time bootstrap, not a general "create another org" tool
-- (that path, for a PARTNER admin adding a second organization, doesn't exist yet and
-- isn't needed yet -- flagged, not built speculatively).
create function api.onboard_organization(
  p_org_legal_name text,
  p_org_cnpj text,
  p_company_legal_name text,
  p_company_cnpj text,
  p_company_trade_name text default null
)
returns table (organization_id uuid, company_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_org_id uuid;
  v_company_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if exists (select 1 from authz.memberships m where m.user_id = v_uid and m.revoked_at is null) then
    raise exception 'already_onboarded' using errcode = '42710';
  end if;

  insert into app.organizations (kind, legal_name, cnpj)
  values ('DIRECT', p_org_legal_name, p_org_cnpj)
  returning id into v_org_id;

  insert into app.companies (organization_id, organization_kind, legal_name, cnpj, trade_name)
  values (v_org_id, 'DIRECT', p_company_legal_name, p_company_cnpj, p_company_trade_name)
  returning id into v_company_id;

  insert into authz.memberships (user_id, organization_id, company_id, role, accepted_at)
  values (v_uid, v_org_id, null, 'ORG_ADMIN', now());

  return query select v_org_id, v_company_id;
end;
$$;

comment on function api.onboard_organization(text, text, text, text, text) is
  'Self-serve bootstrap: a user with zero memberships creates their own DIRECT organization + its one company + becomes ORG_ADMIN. One-shot -- rejects a second call once any membership exists.';

revoke execute on function api.onboard_organization(text, text, text, text, text) from public, anon;
grant execute on function api.onboard_organization(text, text, text, text, text) to authenticated;

-- Adding a further company (a PARTNER organization's second, third, ... client company).
-- Requires org-wide ORG_ADMIN -- a company-scoped membership cannot create sibling
-- companies. For a DIRECT organization this will always fail past the first company: the
-- `companies_one_per_direct_org` unique index (FASE 0) rejects it at the constraint layer,
-- which is the correct enforcement point, not a check duplicated here.
create function api.create_company(
  p_organization_id uuid,
  p_legal_name text,
  p_cnpj text,
  p_trade_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_company_id uuid;
  v_org_kind app.org_kind;
begin
  if not exists (
    select 1 from authz.memberships m
    where m.user_id = v_uid and m.organization_id = p_organization_id
      and m.company_id is null and m.role = 'ORG_ADMIN' and m.revoked_at is null
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select kind into v_org_kind from app.organizations where id = p_organization_id;

  insert into app.companies (organization_id, organization_kind, legal_name, cnpj, trade_name)
  values (p_organization_id, v_org_kind, p_legal_name, p_cnpj, p_trade_name)
  returning id into v_company_id;

  return v_company_id;
end;
$$;

comment on function api.create_company(uuid, text, text, text) is
  'Adds a company to an existing organization. Requires org-wide ORG_ADMIN. A DIRECT organization can never end up with a second company -- enforced by the companies_one_per_direct_org unique index, not duplicated here.';

revoke execute on function api.create_company(uuid, text, text, text) from public, anon;
grant execute on function api.create_company(uuid, text, text, text) to authenticated;

-- Update an existing company's editable fields. Full CNPJ/organization re-parenting are
-- deliberately not exposed here -- see docs/architecture.md §3, "re-parenting is not a
-- supported operation".
create function api.update_company(
  p_company_id uuid,
  p_legal_name text,
  p_trade_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_permission(p_company_id, 'company.settings.update')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  update app.companies
  set legal_name = p_legal_name, trade_name = p_trade_name
  where id = p_company_id;

  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

comment on function api.update_company(uuid, text, text) is
  'Updates legal_name/trade_name only. CNPJ and organization_id are immutable through this RPC -- see docs/architecture.md §3.';

revoke execute on function api.update_company(uuid, text, text) from public, anon;
grant execute on function api.update_company(uuid, text, text) to authenticated;
