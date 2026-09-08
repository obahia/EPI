-- ===== 20260908010000_membership_invitations.sql =====
-- Phase G: team membership. The capability the product has been missing since FASE 0.
--
-- There is exactly ONE `insert into authz.memberships` in the entire codebase today, inside
-- api.onboard_organization, and it makes the person who signs up the ORG_ADMIN of their own
-- new organization. There is no invitation, no way to add a second person, no way to scope
-- someone to one company, and no way to revoke anyone. `membership.manage` has been a seeded
-- permission since FASE 0 with no operation behind it.
--
-- That matters most for exactly the customer the tenancy model was designed around: a
-- PARTNER organization -- an SST clinic with N client companies -- cannot have a second
-- member of staff. The model supports it perfectly (company_id IS NULL covers every company
-- of the org with one row; company_id set scopes to one) and the RLS is built on top of it.
-- Nothing could write those rows.
--
-- NOT in this migration, deliberately: any form of cross-organization access.
-- docs/architecture.md §3 calls the two-level, one-owner model non-negotiable and rejects
-- ancestry predicates in RLS as "historicamente a causa mais comum de vazamento entre
-- tenants". Nothing here adds a predicate that crosses an organization.

-- ---------------------------------------------------------------------------------------
-- Who may grant what
-- ---------------------------------------------------------------------------------------
-- Additive: the five existing auth_ctx helpers keep byte-identical bodies.
--
-- This exists because membership.manage is held by BOTH COMPANY_ADMIN and ORG_ADMIN
-- (20260831140300:80,90). Without a rule, a COMPANY_ADMIN could invite someone as ORG_ADMIN
-- -- privilege escalation that is trivial, silent, and would look like a feature.
--
-- app.role is declared VIEWER < SST_OPERATOR < COMPANY_ADMIN < ORG_ADMIN, and Postgres
-- orders enums by declaration, so "strictly below me" is a plain comparison rather than a
-- lookup table that could drift from the enum.
create function auth_ctx.can_grant_role(
  p_organization_id uuid,
  p_company_id uuid,
  p_role app.role
)
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select
    -- An org-wide ORG_ADMIN may grant anything, at any scope, including another ORG_ADMIN.
    exists (
      select 1 from authz.memberships m
      where m.user_id = (select auth.uid())
        and m.organization_id = p_organization_id
        and m.company_id is null
        and m.role = 'ORG_ADMIN'
        and m.revoked_at is null
    )
    or (
      -- A COMPANY_ADMIN may only grant INTO a company they already cover, and only a role
      -- strictly below their own. Never org-wide: granting company_id IS NULL would hand
      -- out every present and future company of the organization.
      p_company_id is not null
      and p_role < 'COMPANY_ADMIN'
      and exists (
        select 1 from authz.memberships m
        join app.companies c
          on c.organization_id = m.organization_id
         and (m.company_id is null or c.id = m.company_id)
        where m.user_id = (select auth.uid())
          and m.organization_id = p_organization_id
          and m.role = 'COMPANY_ADMIN'
          and m.revoked_at is null
          and c.id = p_company_id
          and c.archived_at is null
      )
    );
$$;

comment on function auth_ctx.can_grant_role(uuid, uuid, app.role) is
  'Whether the current user may grant p_role at p_company_id (NULL = org-wide) inside p_organization_id. A COMPANY_ADMIN can only grant strictly below itself and only into a company it already covers -- without that rule, membership.manage would let a COMPANY_ADMIN mint an ORG_ADMIN.';

grant execute on function auth_ctx.can_grant_role(uuid, uuid, app.role) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------------------
create table authz.membership_invitations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references app.organizations (id) on delete restrict,
  company_id       uuid,                       -- NULL = org-wide, same convention as memberships
  email            extensions.citext not null,
  role             app.role not null,
  token_hash       bytea not null unique check (octet_length(token_hash) = 32),
  invited_by       uuid not null references app.users (id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  accepted_at      timestamptz,
  accepted_user_id uuid references app.users (id),
  revoked_at       timestamptz,
  revoked_by       uuid references app.users (id),
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict,
  constraint membership_invitations_ttl_ck check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  constraint membership_invitations_accepted_ck check ((accepted_at is null) = (accepted_user_id is null)),
  -- An invitation is either open, accepted, or revoked -- never accepted AND revoked.
  constraint membership_invitations_terminal_ck check (not (accepted_at is not null and revoked_at is not null))
);

comment on table authz.membership_invitations is
  'A pending grant. Only its token HASH is stored -- the raw token is generated in Node, hashed there, and only the hash reaches Postgres, the same discipline as app.confirmation_requests.token_hash. Unlike the worker token there is no pepper: an invitation token is 256 bits of CSPRNG, so its SHA-256 is not reversible from a database dump, and a pepper would only add a seventh secret that every environment must keep in sync -- a class of deployment failure this project has already paid for. The pepper on CPF exists because a CPF is low-entropy and enumerable; this is not.';

comment on column authz.membership_invitations.email is
  'Pinned at invitation time and checked on acceptance. Without it, anyone holding the link could take the seat -- the link would be the credential rather than the proof that a specific person was invited.';

create unique index membership_invitations_open_org_key
  on authz.membership_invitations (organization_id, email)
  where company_id is null and accepted_at is null and revoked_at is null;

create unique index membership_invitations_open_company_key
  on authz.membership_invitations (company_id, email)
  where company_id is not null and accepted_at is null and revoked_at is null;

create index membership_invitations_org_idx on authz.membership_invitations (organization_id);

alter table authz.membership_invitations enable row level security;
alter table authz.membership_invitations force row level security;
revoke all on authz.membership_invitations from authenticated, anon, service_role, public;

-- ---------------------------------------------------------------------------------------
-- api.invite_member
-- ---------------------------------------------------------------------------------------
create function api.invite_member(
  p_organization_id uuid,
  p_company_id uuid,
  p_email text,
  p_role text,
  p_token_hash_b64 text,
  p_ttl_hours int default 168
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.role;
  v_id uuid;
  v_email extensions.citext := lower(btrim(p_email))::extensions.citext;
begin
  begin
    v_role := p_role::app.role;
  exception when others then
    raise exception 'unknown_role' using errcode = '22P02';
  end;

  if not (select auth_ctx.can_grant_role(p_organization_id, p_company_id, v_role)) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_ttl_hours < 1 or p_ttl_hours > 720 then
    raise exception 'invalid_ttl' using errcode = '23514';
  end if;

  if position('@' in v_email::text) = 0 then
    raise exception 'invalid_email' using errcode = '23514';
  end if;

  -- Someone who already holds a live membership at this exact scope cannot be invited to it
  -- again; the unique index on memberships would reject the acceptance anyway, and failing
  -- now is better than handing out a link that can never be redeemed.
  if exists (
    select 1
      from authz.memberships m
      join app.users u on u.id = m.user_id
     where u.email = v_email
       and m.organization_id = p_organization_id
       and m.company_id is not distinct from p_company_id
       and m.revoked_at is null
  ) then
    raise exception 'already_member' using errcode = '23505';
  end if;

  insert into authz.membership_invitations (
    organization_id, company_id, email, role, token_hash, invited_by, expires_at
  ) values (
    p_organization_id, p_company_id, v_email, v_role,
    decode(p_token_hash_b64, 'base64'), (select auth.uid()),
    now() + make_interval(hours => p_ttl_hours)
  )
  returning id into v_id;

  perform app.log_audit_event(
    p_organization_id, p_company_id, 'MEMBER_INVITED', 'membership_invitations', v_id,
    'USER', (select auth.uid()),
    -- The invited address is NOT recorded: it is personal data, and the audit trail answers
    -- "who granted what scope", which the ids already do.
    jsonb_build_object('role', v_role, 'org_wide', p_company_id is null)
  );

  return v_id;
exception
  when unique_violation then
    raise exception 'invitation_already_open' using errcode = '23505';
end;
$$;

revoke execute on function api.invite_member(uuid, uuid, text, text, text, int) from public, anon;
grant execute on function api.invite_member(uuid, uuid, text, text, text, int) to authenticated;

-- ---------------------------------------------------------------------------------------
-- api.accept_invitation
-- ---------------------------------------------------------------------------------------
create function api.accept_invitation(p_token_hash_b64 text)
returns table (organization_id uuid, company_id uuid, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv record;
  v_uid uuid := (select auth.uid());
  v_email extensions.citext;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select u.email into v_email from app.users u where u.id = v_uid;

  select i.* into inv
    from authz.membership_invitations i
   where i.token_hash = decode(p_token_hash_b64, 'base64');

  -- One indistinguishable answer for unknown, expired, revoked and already-accepted. A link
  -- that says "this was already used" tells a stranger the link was real.
  if inv.id is null
     or inv.revoked_at is not null
     or inv.accepted_at is not null
     or inv.expires_at <= now() then
    raise exception 'invitation_not_available' using errcode = 'P0002';
  end if;

  -- Pinned address: the link is proof that a SPECIFIC person was invited, not a bearer seat.
  if inv.email is distinct from v_email then
    raise exception 'invitation_not_available' using errcode = 'P0002';
  end if;

  begin
    insert into authz.memberships (
      user_id, organization_id, company_id, role, invited_by, accepted_at
    ) values (
      v_uid, inv.organization_id, inv.company_id, inv.role, inv.invited_by, now()
    );
  exception when unique_violation then
    raise exception 'already_member' using errcode = '23505';
  end;

  update authz.membership_invitations i
     set accepted_at = now(), accepted_user_id = v_uid
   where i.id = inv.id;

  perform app.log_audit_event(
    inv.organization_id, inv.company_id, 'INVITATION_ACCEPTED',
    'membership_invitations', inv.id, 'USER', v_uid,
    jsonb_build_object('role', inv.role, 'org_wide', inv.company_id is null)
  );

  return query select inv.organization_id, inv.company_id, inv.role::text;
end;
$$;

revoke execute on function api.accept_invitation(text) from public, anon;
grant execute on function api.accept_invitation(text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- api.revoke_invitation
-- ---------------------------------------------------------------------------------------
create function api.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv record;
begin
  select i.* into inv from authz.membership_invitations i where i.id = p_invitation_id;
  if inv.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.can_grant_role(inv.organization_id, inv.company_id, inv.role)) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if inv.accepted_at is not null then
    raise exception 'invitation_already_accepted' using errcode = '23514';
  end if;

  update authz.membership_invitations i
     set revoked_at = now(), revoked_by = (select auth.uid())
   where i.id = p_invitation_id and i.revoked_at is null;

  perform app.log_audit_event(
    inv.organization_id, inv.company_id, 'INVITATION_REVOKED',
    'membership_invitations', inv.id, 'USER', (select auth.uid()), '{}'::jsonb
  );
end;
$$;

revoke execute on function api.revoke_invitation(uuid) from public, anon;
grant execute on function api.revoke_invitation(uuid) to authenticated;

-- ===== 20260908011000_membership_management.sql =====
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

-- ===== registro das versões =====
-- `supabase db push` faz isto sozinho. Este bloco existe para o caminho do editor SQL:
-- sem ele, o CLI acharia que as duas migrations ainda não foram aplicadas e tentaria
-- rodá-las de novo no próximo push, o que falharia em `create table`.
insert into supabase_migrations.schema_migrations (version, name)
values
  ('20260908010000', 'membership_invitations'),
  ('20260908011000', 'membership_management')
on conflict (version) do nothing;
