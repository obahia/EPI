-- Phase G: managing the memberships an invitation creates -- listing the team, changing a
-- role, and revoking access.
--
-- THE RULE THAT MATTERS MOST HERE is that an organization can never be left without a live
-- org-wide ORG_ADMIN. Every organization today has exactly one user, so without it the very
-- first action a customer could take is to lock themselves out permanently, with no recovery
-- path in the product and no support tooling behind it either (the platform break-glass
-- tables from FASE 0 still have no code -- deliberately out of this phase, see the Phase G
-- contract, decision G.4).

create function authz.is_last_org_admin(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from authz.memberships m
     where m.id = p_membership_id
       and m.company_id is null
       and m.role = 'ORG_ADMIN'
       and m.revoked_at is null
       and (
         select count(*)
           from authz.memberships other
          where other.organization_id = m.organization_id
            and other.company_id is null
            and other.role = 'ORG_ADMIN'
            and other.revoked_at is null
       ) = 1
  );
$$;

comment on function authz.is_last_org_admin(uuid) is
  'True iff this membership is the only live org-wide ORG_ADMIN of its organization. Both revocation and role change consult it: losing the last one leaves an organization nobody can administer, and there is no recovery path in the product.';

revoke all on function authz.is_last_org_admin(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- Reads. Every table aliased and every column qualified -- a RETURNS TABLE OUT parameter is
-- a PL/pgSQL variable throughout the body, and an unqualified `where id = ...` resolves
-- ambiguously and raises 42702 on EVERY call. That has now happened four times in this
-- codebase; it is not going to be five.
-- ---------------------------------------------------------------------------------------
create function api.list_members(p_organization_id uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  full_name text,
  email text,
  role text,
  company_id uuid,
  company_name text,
  accepted_at timestamptz,
  created_at timestamptz,
  is_last_org_admin boolean
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_org_permission(p_organization_id, 'membership.manage'))
     and not exists (
       select 1 from authz.memberships m
       where m.user_id = (select auth.uid())
         and m.organization_id = p_organization_id
         and m.role = 'COMPANY_ADMIN'
         and m.revoked_at is null
     ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
    select m.id, m.user_id, u.full_name, u.email::text, m.role::text,
           m.company_id, c.legal_name,
           m.accepted_at, m.created_at,
           authz.is_last_org_admin(m.id)
      from authz.memberships m
      join app.users u on u.id = m.user_id
      left join app.companies c on c.id = m.company_id
     where m.organization_id = p_organization_id
       and m.revoked_at is null
     order by (m.company_id is not null), u.full_name;
end;
$$;

revoke execute on function api.list_members(uuid) from public, anon;
grant execute on function api.list_members(uuid) to authenticated;

create function api.list_invitations(p_organization_id uuid)
returns table (
  invitation_id uuid,
  email text,
  role text,
  company_id uuid,
  company_name text,
  invited_by_name text,
  created_at timestamptz,
  expires_at timestamptz,
  status text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_org_permission(p_organization_id, 'membership.manage'))
     and not exists (
       select 1 from authz.memberships m
       where m.user_id = (select auth.uid())
         and m.organization_id = p_organization_id
         and m.role = 'COMPANY_ADMIN'
         and m.revoked_at is null
     ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- token_hash is absent from the RETURNS list. It has no legitimate reader: the only thing
  -- that ever compares it is api.accept_invitation, and a token that can be read back from
  -- a listing is a token anyone with panel access can redeem.
  return query
    select i.id, i.email::text, i.role::text, i.company_id, c.legal_name,
           inviter.full_name, i.created_at, i.expires_at,
           case when i.accepted_at is not null then 'ACCEPTED'
                when i.revoked_at is not null then 'REVOKED'
                when i.expires_at <= now() then 'EXPIRED'
                else 'OPEN' end
      from authz.membership_invitations i
      left join app.companies c on c.id = i.company_id
      join app.users inviter on inviter.id = i.invited_by
     where i.organization_id = p_organization_id
     order by i.created_at desc
     limit 200;
end;
$$;

revoke execute on function api.list_invitations(uuid) from public, anon;
grant execute on function api.list_invitations(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- api.update_membership_role
-- ---------------------------------------------------------------------------------------
create function api.update_membership_role(p_membership_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  v_new app.role;
begin
  begin
    v_new := p_role::app.role;
  exception when others then
    raise exception 'unknown_role' using errcode = '22P02';
  end;

  select mm.* into m from authz.memberships mm
   where mm.id = p_membership_id and mm.revoked_at is null;
  if m.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- Checked against BOTH the role being granted and the role being taken away: promoting
  -- someone requires the right to grant the new role, and demoting an ORG_ADMIN requires
  -- the right to have granted the old one. Without the second half, a COMPANY_ADMIN could
  -- demote the ORG_ADMIN above them.
  if not (select auth_ctx.can_grant_role(m.organization_id, m.company_id, v_new))
     or not (select auth_ctx.can_grant_role(m.organization_id, m.company_id, m.role)) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if v_new <> 'ORG_ADMIN' and (select authz.is_last_org_admin(p_membership_id)) then
    raise exception 'last_org_admin' using errcode = '23514';
  end if;

  if m.role = v_new then
    return;
  end if;

  update authz.memberships mm set role = v_new where mm.id = p_membership_id;

  perform app.log_audit_event(
    m.organization_id, m.company_id, 'MEMBER_ROLE_CHANGED', 'memberships', p_membership_id,
    'USER', (select auth.uid()),
    jsonb_build_object('from', m.role, 'to', v_new, 'subject_user_id', m.user_id)
  );
end;
$$;

revoke execute on function api.update_membership_role(uuid, text) from public, anon;
grant execute on function api.update_membership_role(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- api.revoke_membership
-- ---------------------------------------------------------------------------------------
create function api.revoke_membership(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
begin
  select mm.* into m from authz.memberships mm
   where mm.id = p_membership_id and mm.revoked_at is null;
  if m.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if not (select auth_ctx.can_grant_role(m.organization_id, m.company_id, m.role)) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if (select authz.is_last_org_admin(p_membership_id)) then
    raise exception 'last_org_admin' using errcode = '23514';
  end if;

  -- Revoked, never deleted. The row leaves the partial unique indexes (which are all
  -- `where revoked_at is null`), so the same person can be re-invited to the same scope
  -- later, and the history of who had access when survives.
  update authz.memberships mm
     set revoked_at = now()
   where mm.id = p_membership_id;

  perform app.log_audit_event(
    m.organization_id, m.company_id, 'MEMBER_REVOKED', 'memberships', p_membership_id,
    'USER', (select auth.uid()),
    jsonb_build_object('role', m.role, 'subject_user_id', m.user_id)
  );
end;
$$;

revoke execute on function api.revoke_membership(uuid) from public, anon;
grant execute on function api.revoke_membership(uuid) to authenticated;
