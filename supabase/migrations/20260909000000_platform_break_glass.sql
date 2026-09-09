-- Phase H: platform break-glass. The FASE 0 tables (app.platform_admins,
-- app.platform_access_grants) have had no code behind them since the day they were written,
-- which meant two things at once: our own staff had no sanctioned way to look at a tenant's
-- data when a customer asked for help, and -- as Phase G had to record explicitly -- a
-- customer who lost their last org-wide ORG_ADMIN had no recovery path inside the product at
-- all. The only remedy for either was hand-written SQL against production, which is the exact
-- thing this table set exists to make unnecessary.
--
-- THE LOAD-BEARING DECISION: this is NOT an extension of RLS.
--
-- docs/architecture.md §5 already said break-glass must not be an RLS bypass. There is a
-- second, sharper reason to keep it off the RLS path, and it comes from the architecture's
-- own event catalogue (§13): it lists PLATFORM_ACCESS_USED alongside PLATFORM_ACCESS_GRANTED.
-- A row-level security policy cannot write an audit row -- policies are read predicates --
-- so if break-glass worked by teaching auth_ctx.company_ids() about grants, the customer
-- could only ever be told that access was AUTHORISED, never that it was USED. The difference
-- matters to the person whose employees' data it is.
--
-- So the five auth_ctx.* helpers stay byte-identical, every existing policy behaves exactly
-- as before, and platform access is a small, explicit set of SECURITY DEFINER functions that
-- each check a live grant and record the use. A bug in this file cannot widen any existing
-- policy, because no existing policy consults any of it.
--
-- These functions live in `api` rather than a new schema on purpose. Phase F cost real time
-- discovering that exposing a schema to PostgREST on the hosted project is a dashboard
-- setting invisible to migrations; adding another one here would buy nothing, since the
-- guard is inside each function and never in the schema name. `api` already holds functions
-- only an ORG_ADMIN may call.

-- ---------------------------------------------------------------------------------------
-- Use tracking, so a grant records what happened under it and not only that it was issued.
-- ---------------------------------------------------------------------------------------
alter table app.platform_access_grants
  add column first_used_at timestamptz,
  add column last_used_at  timestamptz,
  add column use_count     integer not null default 0 check (use_count >= 0);

comment on column app.platform_access_grants.first_used_at is
  'When this grant was first actually exercised. PLATFORM_ACCESS_USED is written into the tenant''s audit chain exactly once, here -- not on every read. Every read would serialise on that organization''s audit.chain_heads row and bury the customer''s own history under our support traffic; a grant is already time-boxed to 72h, so "it was used, starting at T" plus a count carries the fact that matters without that cost. The tradeoff is deliberate and is the one thing this table does not record per-action.';

-- ---------------------------------------------------------------------------------------
-- Is there a live grant covering this scope?
-- ---------------------------------------------------------------------------------------
create function authz.has_live_platform_grant(p_organization_id uuid, p_company_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from app.platform_access_grants g
      join app.platform_admins pa on pa.user_id = g.admin_user_id and pa.revoked_at is null
     where g.admin_user_id = (select auth.uid())
       and g.organization_id = p_organization_id
       and g.revoked_at is null
       and g.expires_at > now()
       -- An org-wide grant (company_id IS NULL) covers every company; a company-scoped one
       -- covers only its own, and can never be widened by asking for the org.
       and (g.company_id is null or g.company_id = p_company_id)
  );
$$;

comment on function authz.has_live_platform_grant(uuid, uuid) is
  'Whether the calling platform admin holds an unrevoked, unexpired grant covering this scope. Deliberately not called by any RLS policy -- see the header of this migration.';

revoke all on function authz.has_live_platform_grant(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- The gate every platform read and the rescue write go through.
-- ---------------------------------------------------------------------------------------
create function app.assert_platform_grant(p_organization_id uuid, p_company_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  g record;
begin
  select gr.* into g
    from app.platform_access_grants gr
    join app.platform_admins pa on pa.user_id = gr.admin_user_id and pa.revoked_at is null
   where gr.admin_user_id = (select auth.uid())
     and gr.organization_id = p_organization_id
     and gr.revoked_at is null
     and gr.expires_at > now()
     and (gr.company_id is null or gr.company_id = p_company_id)
   order by gr.expires_at desc
   limit 1;

  if g.id is null then
    -- Same signal whether the caller is not a platform admin, has no grant, or had one that
    -- expired. None of those distinctions is any of the caller's business.
    raise exception 'no_live_platform_grant' using errcode = '42501';
  end if;

  update app.platform_access_grants gr
     set first_used_at = coalesce(gr.first_used_at, now()),
         last_used_at = now(),
         use_count = gr.use_count + 1
   where gr.id = g.id;

  if g.first_used_at is null then
    perform app.log_audit_event(
      g.organization_id, g.company_id, 'PLATFORM_ACCESS_USED',
      'platform_access_grants', g.id, 'PLATFORM', (select auth.uid()),
      jsonb_build_object('reason', g.reason, 'ticket_ref', g.ticket_ref, 'expires_at', g.expires_at)
    );
  end if;
end;
$$;

comment on function app.assert_platform_grant(uuid, uuid) is
  'Raises 42501 unless the caller holds a live grant for this scope; otherwise records the use and, on the FIRST use of that grant, writes PLATFORM_ACCESS_USED into the affected tenant''s own audit chain. Every platform-facing function below calls it first.';

revoke all on function app.assert_platform_grant(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- The platform admin roster. The FIRST SUPER is seeded by hand -- see docs/architecture.md
-- §27 -- because a function that can mint the first platform admin would be a function that
-- can mint platform power out of an ordinary account.
-- ---------------------------------------------------------------------------------------
create function api.grant_platform_admin(p_user_id uuid, p_level text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from app.platform_admins pa
     where pa.user_id = (select auth.uid()) and pa.level = 'SUPER' and pa.revoked_at is null
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_level not in ('SUPPORT', 'ENGINEER', 'SUPER') then
    raise exception 'unknown_level' using errcode = '22P02';
  end if;

  if not exists (select 1 from app.users u where u.id = p_user_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  insert into app.platform_admins (user_id, level)
  values (p_user_id, p_level)
  on conflict (user_id) do update set level = excluded.level, revoked_at = null;
end;
$$;

revoke execute on function api.grant_platform_admin(uuid, text) from public, anon;
grant execute on function api.grant_platform_admin(uuid, text) to authenticated;

create function api.revoke_platform_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from app.platform_admins pa
     where pa.user_id = (select auth.uid()) and pa.level = 'SUPER' and pa.revoked_at is null
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_user_id = (select auth.uid()) then
    raise exception 'cannot_revoke_self' using errcode = '23514';
  end if;

  update app.platform_admins pa set revoked_at = now()
   where pa.user_id = p_user_id and pa.revoked_at is null;

  -- Revoking the person also ends any access they were holding. Leaving live grants behind
  -- a revoked admin would mean the roster says "no longer staff" while the grant still says
  -- "may read tenant 7".
  update app.platform_access_grants g set revoked_at = now()
   where g.admin_user_id = p_user_id and g.revoked_at is null and g.expires_at > now();
end;
$$;

revoke execute on function api.revoke_platform_admin(uuid) from public, anon;
grant execute on function api.revoke_platform_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Granting access to a tenant. Four eyes: the CHECK on the table already forbids
-- granted_by = admin_user_id, but a constraint violation is a terrible error message for
-- the single most important rule here, so it is also checked explicitly.
-- ---------------------------------------------------------------------------------------
create function api.grant_platform_access(
  p_admin_user_id uuid,
  p_organization_id uuid,
  p_company_id uuid,
  p_reason text,
  p_ticket_ref text default null,
  p_ttl_hours int default 24
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not (select auth_ctx.is_platform_admin()) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_admin_user_id = (select auth.uid()) then
    raise exception 'four_eyes_required' using errcode = '23514';
  end if;

  if not exists (
    select 1 from app.platform_admins pa
     where pa.user_id = p_admin_user_id and pa.revoked_at is null
  ) then
    raise exception 'not_a_platform_admin' using errcode = 'P0002';
  end if;

  if p_ttl_hours < 1 or p_ttl_hours > 72 then
    raise exception 'invalid_ttl' using errcode = '23514';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 20 then
    raise exception 'reason_too_short' using errcode = '23514';
  end if;

  if p_company_id is not null and not exists (
    select 1 from app.companies c
     where c.id = p_company_id and c.organization_id = p_organization_id
  ) then
    raise exception 'company_not_in_organization' using errcode = '23514';
  end if;

  insert into app.platform_access_grants (
    admin_user_id, organization_id, company_id, reason, ticket_ref, granted_by, expires_at
  ) values (
    p_admin_user_id, p_organization_id, p_company_id, btrim(p_reason), p_ticket_ref,
    (select auth.uid()), now() + make_interval(hours => p_ttl_hours)
  )
  returning id into v_id;

  -- Into the AFFECTED TENANT's chain, not ours. The reason text is included deliberately:
  -- the customer is entitled to read why someone at the vendor was given access to their
  -- data, and a reason they cannot see is a reason that protects nobody.
  perform app.log_audit_event(
    p_organization_id, p_company_id, 'PLATFORM_ACCESS_GRANTED',
    'platform_access_grants', v_id, 'PLATFORM', (select auth.uid()),
    jsonb_build_object(
      'admin_user_id', p_admin_user_id,
      'granted_by', (select auth.uid()),
      'reason', btrim(p_reason),
      'ticket_ref', p_ticket_ref,
      'expires_at', now() + make_interval(hours => p_ttl_hours),
      'org_wide', p_company_id is null
    )
  );

  return v_id;
end;
$$;

revoke execute on function api.grant_platform_access(uuid, uuid, uuid, text, text, int) from public, anon;
grant execute on function api.grant_platform_access(uuid, uuid, uuid, text, text, int) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Ending access early. Any platform admin may end anyone's grant, including their own --
-- there is no reason to make handing back access harder than taking it.
-- ---------------------------------------------------------------------------------------
create function api.revoke_platform_access(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  g record;
begin
  if not (select auth_ctx.is_platform_admin()) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select gr.* into g from app.platform_access_grants gr where gr.id = p_grant_id;
  if g.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if g.revoked_at is not null then
    return;
  end if;

  update app.platform_access_grants gr set revoked_at = now() where gr.id = p_grant_id;

  perform app.log_audit_event(
    g.organization_id, g.company_id, 'PLATFORM_ACCESS_REVOKED',
    'platform_access_grants', g.id, 'PLATFORM', (select auth.uid()),
    jsonb_build_object('admin_user_id', g.admin_user_id, 'use_count', g.use_count)
  );
end;
$$;

revoke execute on function api.revoke_platform_access(uuid) from public, anon;
grant execute on function api.revoke_platform_access(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Finding a tenant to support. This is the one platform-facing read with no grant behind
-- it, and it has to be: you cannot ask for access to an organization whose id you cannot
-- discover. It returns our OWN commercial metadata about a customer -- legal name, CNPJ,
-- kind, size -- and no data belonging to any employee of theirs.
-- ---------------------------------------------------------------------------------------
create function api.platform_search_organizations(p_query text default null, p_limit int default 25)
returns table (
  organization_id uuid,
  legal_name text,
  cnpj text,
  kind text,
  company_count bigint,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not (select auth_ctx.is_platform_admin()) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
    select o.id, o.legal_name, o.cnpj, o.kind::text,
           (select count(*) from app.companies c where c.organization_id = o.id),
           o.created_at
      from app.organizations o
     where p_query is null
        or btrim(p_query) = ''
        or o.legal_name ilike '%' || btrim(p_query) || '%'
        or o.cnpj like '%' || btrim(p_query) || '%'
     order by o.created_at desc
     limit least(greatest(coalesce(p_limit, 25), 1), 100);
end;
$$;

revoke execute on function api.platform_search_organizations(text, int) from public, anon;
grant execute on function api.platform_search_organizations(text, int) to authenticated;

-- ---------------------------------------------------------------------------------------
-- What a live grant actually lets you see.
--
-- Every RETURNS TABLE below aliases every table and qualifies every column. An OUT parameter
-- is a PL/pgSQL variable throughout the body, and an unqualified `where id = ...` resolves
-- ambiguously and raises 42702 on EVERY call. That has hit this codebase five times.
-- ---------------------------------------------------------------------------------------
create function api.platform_organization_overview(p_organization_id uuid)
returns table (
  organization_id uuid,
  legal_name text,
  kind text,
  company_count bigint,
  employee_count bigint,
  member_count bigint,
  live_org_admin_count bigint,
  delivery_count bigint,
  pending_delivery_count bigint,
  last_audit_at timestamptz
)
language plpgsql
security definer
-- VOLATILE, deliberately. Every function that goes through app.assert_platform_grant writes:
-- it bumps the grant's use counter and, on the first use, appends to the tenant's audit
-- chain. Marking one of these STABLE would make Postgres refuse that UPDATE at runtime, on
-- every single call -- the "broken for everyone, not just an edge case" failure this codebase
-- has already shipped twice.
set search_path = ''
as $$
begin
  perform app.assert_platform_grant(p_organization_id, null);

  return query
    select o.id, o.legal_name, o.kind::text,
           (select count(*) from app.companies c where c.organization_id = o.id),
           (select count(*) from app.employees e where e.organization_id = o.id),
           (select count(*) from authz.memberships m
             where m.organization_id = o.id and m.revoked_at is null),
           (select count(*) from authz.memberships m
             where m.organization_id = o.id and m.revoked_at is null
               and m.company_id is null and m.role = 'ORG_ADMIN'),
           (select count(*) from app.epi_deliveries d where d.organization_id = o.id),
           (select count(*) from app.epi_deliveries d
             where d.organization_id = o.id and d.status = 'ISSUED'),
           (select max(a.created_at) from audit.audit_events a where a.organization_id = o.id)
      from app.organizations o
     where o.id = p_organization_id;
end;
$$;

comment on function api.platform_organization_overview(uuid) is
  'Counts, never names. Enough to tell whether a tenant is healthy and, via live_org_admin_count, whether it has locked itself out -- without reading a single employee record.';

revoke execute on function api.platform_organization_overview(uuid) from public, anon;
grant execute on function api.platform_organization_overview(uuid) to authenticated;

create function api.platform_audit_events(p_organization_id uuid, p_limit int default 100)
returns table (
  id uuid,
  seq bigint,
  event_type text,
  actor_kind text,
  actor_user_id uuid,
  entity_table text,
  entity_id uuid,
  data jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_grant(p_organization_id, null);

  -- The single most useful support tool in the product, and it carries no CPF -- but that
  -- is a property INHERITED from audit.audit_events, not established here. Its own comment
  -- (20260831170100:36) states that a selfie, a biometric template, a secret, a full token or
  -- an unnecessary full CPF never enters `data`, and the real control is that no caller of
  -- app.log_audit_event ever has those values in scope to pass. If that ever stops being
  -- true, this function becomes a window onto whatever was put there.
  return query
    select a.id, a.seq, a.event_type, a.actor_kind, a.actor_user_id,
           a.entity_table, a.entity_id, a.data, a.created_at
      from audit.audit_events a
     where a.organization_id = p_organization_id
     order by a.seq desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

revoke execute on function api.platform_audit_events(uuid, int) from public, anon;
grant execute on function api.platform_audit_events(uuid, int) to authenticated;

create function api.platform_list_members(p_organization_id uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  full_name text,
  email text,
  role text,
  company_id uuid,
  accepted_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_grant(p_organization_id, null);

  return query
    select m.id, m.user_id, u.full_name, u.email::text, m.role::text,
           m.company_id, m.accepted_at, m.created_at
      from authz.memberships m
      join app.users u on u.id = m.user_id
     where m.organization_id = p_organization_id
       and m.revoked_at is null
     order by (m.company_id is not null), u.full_name;
end;
$$;

comment on function api.platform_list_members(uuid) is
  'Who currently holds access to this tenant. Panel users, never employees -- app.users is the manager table and an employee never has a row in it, so no CPF is reachable from here by construction.';

revoke execute on function api.platform_list_members(uuid) from public, anon;
grant execute on function api.platform_list_members(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- The one write. Lockout recovery, and nothing else.
--
-- It can only ELEVATE somebody the tenant already admitted. Support can never introduce a
-- new person into a customer's organization: if nobody holds a live membership there is no
-- one to promote, and this refuses rather than inventing a member. That keeps the blast
-- radius at "an existing colleague was made an admin", which the customer can see and undo,
-- instead of "a stranger appeared in our account".
-- ---------------------------------------------------------------------------------------
create function api.platform_grant_org_admin(p_organization_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing record;
  v_id uuid;
begin
  -- An org-wide grant only, and asking for it is the whole check: assert_platform_grant
  -- matches a grant whose company_id IS NULL when the requested scope is NULL, so a grant
  -- scoped to one company can never reach this function at all. A company-scoped grant must
  -- not be able to mint an administrator over every company of the organization.
  perform app.assert_platform_grant(p_organization_id, null);

  select m.* into v_existing
    from authz.memberships m
   where m.user_id = p_user_id
     and m.organization_id = p_organization_id
     and m.revoked_at is null
   order by (m.company_id is null) desc
   limit 1;

  if v_existing.id is null then
    raise exception 'not_a_member' using errcode = 'P0002';
  end if;

  if v_existing.company_id is null and v_existing.role = 'ORG_ADMIN' then
    return v_existing.id;
  end if;

  if v_existing.company_id is null then
    update authz.memberships m set role = 'ORG_ADMIN' where m.id = v_existing.id;
    v_id := v_existing.id;
  else
    -- A company-scoped member is promoted by giving them a NEW org-wide membership rather
    -- than widening the one they have: the company-scoped row is what the customer granted,
    -- and rewriting its scope would erase that fact.
    insert into authz.memberships (user_id, organization_id, company_id, role, accepted_at)
    values (p_user_id, p_organization_id, null, 'ORG_ADMIN', now())
    returning id into v_id;
  end if;

  perform app.log_audit_event(
    p_organization_id, null, 'PLATFORM_ORG_ADMIN_GRANTED',
    'memberships', v_id, 'PLATFORM', (select auth.uid()),
    jsonb_build_object('subject_user_id', p_user_id, 'from_role', v_existing.role)
  );

  return v_id;
end;
$$;

revoke execute on function api.platform_grant_org_admin(uuid, uuid) from public, anon;
grant execute on function api.platform_grant_org_admin(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- What each side can see about the grants themselves.
-- ---------------------------------------------------------------------------------------
create function api.my_platform_grants()
returns table (
  grant_id uuid,
  organization_id uuid,
  organization_name text,
  company_id uuid,
  reason text,
  ticket_ref text,
  granted_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  use_count integer
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not (select auth_ctx.is_platform_admin()) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
    select g.id, g.organization_id, o.legal_name, g.company_id, g.reason, g.ticket_ref,
           g.granted_at, g.expires_at, g.revoked_at, g.use_count
      from app.platform_access_grants g
      join app.organizations o on o.id = g.organization_id
     where g.admin_user_id = (select auth.uid())
     order by g.granted_at desc
     limit 100;
end;
$$;

revoke execute on function api.my_platform_grants() from public, anon;
grant execute on function api.my_platform_grants() to authenticated;

-- The customer's own view. This is the promise in docs/architecture.md §5 made real: the
-- organization can see who at the vendor was given access to their data, why, for how long,
-- and whether it was actually used.
create function api.list_platform_access_grants(p_organization_id uuid)
returns table (
  grant_id uuid,
  admin_name text,
  admin_email text,
  granted_by_name text,
  company_id uuid,
  reason text,
  ticket_ref text,
  granted_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  first_used_at timestamptz,
  last_used_at timestamptz,
  use_count integer
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_org_permission(p_organization_id, 'membership.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
    select g.id, admin_u.full_name, admin_u.email::text, granter.full_name,
           g.company_id, g.reason, g.ticket_ref, g.granted_at, g.expires_at, g.revoked_at,
           g.first_used_at, g.last_used_at, g.use_count
      from app.platform_access_grants g
      join app.users admin_u on admin_u.id = g.admin_user_id
      join app.users granter on granter.id = g.granted_by
     where g.organization_id = p_organization_id
     order by g.granted_at desc
     limit 200;
end;
$$;

comment on function api.list_platform_access_grants(uuid) is
  'The customer''s own audit of vendor access. Names the person at the vendor, who approved it, the reason, the window, and whether it was used -- the transparency half of break-glass, without which the rest is just a back door with paperwork.';

revoke execute on function api.list_platform_access_grants(uuid) from public, anon;
grant execute on function api.list_platform_access_grants(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- The one projection the console needs. PostgREST only sees `api`, and the FASE 0 policy
-- platform_admins_select_self already exists precisely to make a self-read safe:
-- security_invoker means that policy applies for the caller, so this view answers "what am
-- I" and can never enumerate the vendor's staff.
-- ---------------------------------------------------------------------------------------
create view api.platform_admins
  with (security_invoker = true) as
select pa.user_id, pa.level, pa.created_at, pa.revoked_at
from app.platform_admins pa;

comment on view api.platform_admins is
  'Self-read only, enforced by the base table''s RLS through security_invoker. A platform admin sees their own row; nobody sees anyone else''s.';

grant select on api.platform_admins to authenticated;

-- ---------------------------------------------------------------------------------------
-- The roster, visible to the roster. Four eyes only works if you can see who the other two
-- belong to: without this, granting access to a colleague would mean looking their user id
-- up in the database by hand, which is the workflow this whole phase exists to replace.
-- Restricted to active platform admins, and it reveals the vendor's own staff -- never a
-- customer's users.
-- ---------------------------------------------------------------------------------------
create function api.platform_list_admins()
returns table (
  user_id uuid,
  full_name text,
  email text,
  level text,
  created_at timestamptz,
  revoked_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not (select auth_ctx.is_platform_admin()) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
    select pa.user_id, u.full_name, u.email::text, pa.level, pa.created_at, pa.revoked_at
      from app.platform_admins pa
      join app.users u on u.id = pa.user_id
     order by (pa.revoked_at is not null), u.full_name;
end;
$$;

revoke execute on function api.platform_list_admins() from public, anon;
grant execute on function api.platform_list_admins() to authenticated;
