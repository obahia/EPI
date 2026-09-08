-- Phase G: team membership. The assertions that decide whether invitations can be trusted
-- are about ESCALATION and LOCKOUT, not about the happy path.
--
-- `membership.manage` is held by BOTH COMPANY_ADMIN and ORG_ADMIN (20260831140300:80,90),
-- so the interesting question is never "can an admin invite someone" -- it is "can a
-- COMPANY_ADMIN mint an ORG_ADMIN", which is privilege escalation that would look exactly
-- like a feature. Every branch of auth_ctx.can_grant_role is exercised from the outside,
-- through api.invite_member, because the rule is only worth anything where it is enforced.

create extension if not exists pgtap with schema extensions;

begin;

select plan(26);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '11110000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'orgadmin@partner.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Org Admin"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '11110000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'compadmin@partner.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Company Admin"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '11110000-0000-4000-8000-000000000003',
   'authenticated', 'authenticated', 'invitee@partner.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Invitee"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '11110000-0000-4000-8000-000000000004',
   'authenticated', 'authenticated', 'wrongperson@partner.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Wrong Person"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '22220000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'other@othertenant.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Other Tenant"}', now(), now(), '', '', '', '', false, false);
-- app.users rows follow from the app.handle_new_auth_user() trigger (FASE 0).

create temporary table fx (label text primary key, id uuid not null);
grant all on fx to authenticated;
create temporary table probe (label text primary key, val text);
grant all on probe to authenticated;

-- A PARTNER-shaped tenant: one organization, two client companies. This is the customer
-- the tenancy model was designed around and the one that could not have a second member.
--
-- Built by direct insert as the migration/superuser role, not through api.onboard_organization,
-- because onboarding cannot produce this shape: it always writes kind 'DIRECT', and
-- companies_one_per_direct_org (FASE 0) then allows exactly one company per organization.
-- That constraint is correct and stays untouched -- a PARTNER organization is created by
-- Selo's own operators today, not self-serve, so no RPC mints one. Same setup technique as
-- 010_tenant_isolation.sql: full privilege for the fixture, then switch role to prove what a
-- restricted role can and cannot do.
insert into app.organizations (id, kind, legal_name, cnpj) values
  ('11110000-0000-4000-9000-0000000000a1', 'PARTNER', 'Clinica SST LTDA', '12345678000190'),
  ('22220000-0000-4000-9000-0000000000b1', 'DIRECT', 'Outro Tenant LTDA', '11222333000181');

insert into app.companies (id, organization_id, organization_kind, cnpj, legal_name) values
  ('11110000-0000-4000-9000-0000000000c1', '11110000-0000-4000-9000-0000000000a1', 'PARTNER', '12345678000190', 'Cliente Um LTDA'),
  ('11110000-0000-4000-9000-0000000000c2', '11110000-0000-4000-9000-0000000000a1', 'PARTNER', '98765432000109', 'Cliente Dois LTDA'),
  ('22220000-0000-4000-9000-0000000000c9', '22220000-0000-4000-9000-0000000000b1', 'DIRECT', '11222333000181', 'Outro LTDA');

insert into authz.memberships (user_id, organization_id, company_id, role, accepted_at) values
  ('11110000-0000-4000-8000-000000000001', '11110000-0000-4000-9000-0000000000a1', null, 'ORG_ADMIN', now()),
  ('22220000-0000-4000-8000-000000000001', '22220000-0000-4000-9000-0000000000b1', null, 'ORG_ADMIN', now());

insert into fx values
  ('org', '11110000-0000-4000-9000-0000000000a1'),
  ('company_one', '11110000-0000-4000-9000-0000000000c1'),
  ('company_two', '11110000-0000-4000-9000-0000000000c2'),
  ('other_org', '22220000-0000-4000-9000-0000000000b1'),
  ('other_company', '22220000-0000-4000-9000-0000000000c9');

select is(
  (select count(*)::int from app.companies c
    where c.organization_id = '11110000-0000-4000-9000-0000000000a1'
      and c.organization_kind = 'PARTNER'),
  2,
  'a PARTNER organization carrying two client companies -- the shape that had no way to be staffed');

-- The COMPANY_ADMIN this suite escalates FROM, scoped to company_one only.
insert into authz.memberships (user_id, organization_id, company_id, role, accepted_at)
values ('11110000-0000-4000-8000-000000000002', (select id from fx where label = 'org'),
        (select id from fx where label = 'company_one'), 'COMPANY_ADMIN', now());

-- ---------------------------------------------------------------------------------------
-- 1. Escalation. The section that matters.
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_org uuid := (select id from fx where label = 'org');
  v_c1  uuid := (select id from fx where label = 'company_one');
  v_c2  uuid := (select id from fx where label = 'company_two');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11110000-0000-4000-8000-000000000002","role":"authenticated"}', true);

  -- A COMPANY_ADMIN trying to mint an org-wide ORG_ADMIN.
  begin
    perform api.invite_member(v_org, null, 'x1@t.test', 'ORG_ADMIN',
      encode(repeat('1', 32)::bytea, 'base64'), 168);
    insert into probe values ('esc_org_admin', 'ALLOWED');
  exception when others then insert into probe values ('esc_org_admin', sqlerrm); end;

  -- ...an ORG_ADMIN scoped to their own company.
  begin
    perform api.invite_member(v_org, v_c1, 'x2@t.test', 'ORG_ADMIN',
      encode(repeat('2', 32)::bytea, 'base64'), 168);
    insert into probe values ('esc_org_admin_scoped', 'ALLOWED');
  exception when others then insert into probe values ('esc_org_admin_scoped', sqlerrm); end;

  -- ...a peer at their own level.
  begin
    perform api.invite_member(v_org, v_c1, 'x3@t.test', 'COMPANY_ADMIN',
      encode(repeat('3', 32)::bytea, 'base64'), 168);
    insert into probe values ('esc_peer', 'ALLOWED');
  exception when others then insert into probe values ('esc_peer', sqlerrm); end;

  -- ...org-wide, at a role they legitimately grant per-company.
  begin
    perform api.invite_member(v_org, null, 'x4@t.test', 'VIEWER',
      encode(repeat('4', 32)::bytea, 'base64'), 168);
    insert into probe values ('esc_org_wide_viewer', 'ALLOWED');
  exception when others then insert into probe values ('esc_org_wide_viewer', sqlerrm); end;

  -- ...into a sibling company of the same org, which they have no scope on.
  begin
    perform api.invite_member(v_org, v_c2, 'x5@t.test', 'VIEWER',
      encode(repeat('5', 32)::bytea, 'base64'), 168);
    insert into probe values ('esc_other_company', 'ALLOWED');
  exception when others then insert into probe values ('esc_other_company', sqlerrm); end;

  -- ...into an entirely different organization.
  begin
    perform api.invite_member((select id from fx where label = 'other_org'), null, 'x6@t.test',
      'VIEWER', encode(repeat('6', 32)::bytea, 'base64'), 168);
    insert into probe values ('esc_cross_org', 'ALLOWED');
  exception when others then insert into probe values ('esc_cross_org', sqlerrm); end;

  -- What a COMPANY_ADMIN legitimately CAN do: a lower role, into its own company.
  begin
    perform api.invite_member(v_org, v_c1, 'legit@t.test', 'SST_OPERATOR',
      encode(repeat('7', 32)::bytea, 'base64'), 168);
    insert into probe values ('legit', 'ALLOWED');
  exception when others then insert into probe values ('legit', sqlerrm); end;

  reset role;
end $$;

select is((select val from probe where label = 'esc_org_admin'), 'insufficient_privilege',
  'a COMPANY_ADMIN cannot mint an org-wide ORG_ADMIN');
select is((select val from probe where label = 'esc_org_admin_scoped'), 'insufficient_privilege',
  'nor a company-scoped ORG_ADMIN');
select is((select val from probe where label = 'esc_peer'), 'insufficient_privilege',
  'nor a peer COMPANY_ADMIN -- the rule is STRICTLY below, not at-or-below');
select is((select val from probe where label = 'esc_org_wide_viewer'), 'insufficient_privilege',
  'nor an org-wide VIEWER -- org-wide covers every present and future company of the org');
select is((select val from probe where label = 'esc_other_company'), 'insufficient_privilege',
  'nor into a sibling company it holds no scope on');
select is((select val from probe where label = 'esc_cross_org'), 'insufficient_privilege',
  'nor into another organization at all');
select is((select val from probe where label = 'legit'), 'ALLOWED',
  'but it CAN invite a lower role into its own company -- the rule restricts, it does not disable');

-- ---------------------------------------------------------------------------------------
-- 2. Acceptance
-- ---------------------------------------------------------------------------------------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11110000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  insert into fx values ('invite', api.invite_member(
    (select id from fx where label = 'org'), null, 'invitee@partner.test', 'SST_OPERATOR',
    encode(repeat('a', 32)::bytea, 'base64'), 168));
  reset role;
end $$;

do $$
begin
  set local role authenticated;
  -- The wrong person, holding a link that is genuinely valid.
  perform set_config('request.jwt.claims', '{"sub":"11110000-0000-4000-8000-000000000004","role":"authenticated"}', true);
  begin
    perform * from api.accept_invitation(encode(repeat('a', 32)::bytea, 'base64'));
    insert into probe values ('wrong_person', 'ALLOWED');
  exception when others then insert into probe values ('wrong_person', sqlerrm); end;

  -- A token that was never issued.
  begin
    perform * from api.accept_invitation(encode(repeat('z', 32)::bytea, 'base64'));
    insert into probe values ('unknown_token', 'ALLOWED');
  exception when others then insert into probe values ('unknown_token', sqlerrm); end;
  reset role;
end $$;

select is((select val from probe where label = 'wrong_person'), 'invitation_not_available',
  'a valid link in the wrong hands is refused -- the email is pinned, the link is not a bearer seat');
select is((select val from probe where label = 'unknown_token'), 'invitation_not_available',
  'and an unissued token gives the IDENTICAL signal -- a distinct one would confirm the link was real');

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11110000-0000-4000-8000-000000000003","role":"authenticated"}', true);
  perform * from api.accept_invitation(encode(repeat('a', 32)::bytea, 'base64'));
  -- Replaying the same link.
  begin
    perform * from api.accept_invitation(encode(repeat('a', 32)::bytea, 'base64'));
    insert into probe values ('replay', 'ALLOWED');
  exception when others then insert into probe values ('replay', sqlerrm); end;
  reset role;
end $$;

select is(
  (select m.role::text from authz.memberships m
    where m.user_id = '11110000-0000-4000-8000-000000000003' and m.revoked_at is null),
  'SST_OPERATOR',
  'accepting creates the membership at exactly the invited role');

select ok(
  (select m.company_id is null and m.accepted_at is not null from authz.memberships m
    where m.user_id = '11110000-0000-4000-8000-000000000003' and m.revoked_at is null),
  'at exactly the invited scope, and stamped with when it was accepted');

select is((select val from probe where label = 'replay'), 'invitation_not_available',
  'the link is single use -- replaying it is refused with the same opaque signal');

select is(
  (select count(*)::int from authz.memberships m
    where m.user_id = '11110000-0000-4000-8000-000000000003' and m.revoked_at is null),
  1,
  'and the replay created no second membership');

select is(
  (select count(*)::int from audit.audit_events a
    where a.entity_table = 'membership_invitations'
      and a.entity_id = (select id from fx where label = 'invite')),
  2,
  'both the invitation and the acceptance land in the tenant''s own hash-chained audit trail');

select ok(
  not exists (
    select 1 from audit.audit_events a
     where a.entity_table = 'membership_invitations' and a.data::text like '%@%'
  ),
  'and no email address is written into it -- the ids already answer who granted what scope');

-- ---------------------------------------------------------------------------------------
-- 2b. The two read RPCs, CALLED.
--
-- This section exists because of what Phase F cost. api.list_api_keys,
-- api.list_webhook_deliveries and api.import_run_status all shipped through a green CI and
-- were broken on EVERY call: a RETURNS TABLE OUT parameter shadowing a column in an
-- unqualified predicate, which Postgres rejects with 42702 at runtime. A suite that only
-- checks grants and RETURNS lists never calls them, so it never sees it -- and the panel's
-- DAL swallowed the error into an empty array, so the screen rendered blank instead of
-- failing. api.list_members and api.list_invitations are the same shape. They get called.
-- ---------------------------------------------------------------------------------------
do $
declare v_org uuid := (select id from fx where label = 'org'); n int; v_flag boolean; v_status text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11110000-0000-4000-8000-000000000001","role":"authenticated"}', true);

  select count(*) into n from api.list_members(v_org);
  insert into probe values ('members_n', n::text);

  select m.is_last_org_admin into v_flag from api.list_members(v_org) m
   where m.user_id = '11110000-0000-4000-8000-000000000001';
  insert into probe values ('members_last_admin', coalesce(v_flag::text, 'NULL'));

  select count(*) into n from api.list_invitations(v_org);
  insert into probe values ('invitations_n', n::text);

  select i.status into v_status from api.list_invitations(v_org) i
   where i.invitation_id = (select id from fx where label = 'invite');
  insert into probe values ('invitation_status', coalesce(v_status, 'NULL'));
  reset role;
exception when others then
  insert into probe values ('reads_error', sqlstate || ' ' || sqlerrm);
  reset role;
end $;

select is((select val from probe where label = 'members_n'), '3',
  'api.list_members RUNS and returns the org''s three live memberships -- the org-wide admin, the company-scoped admin, and the operator who just accepted');
select is((select val from probe where label = 'members_last_admin'), 'true',
  'and computes is_last_org_admin from authz.is_last_org_admin itself, so the panel disables exactly what the database would refuse');
select is((select val from probe where label = 'invitations_n'), '2',
  'api.list_invitations RUNS and returns both invitations, the open one and the spent one');
select is((select val from probe where label = 'invitation_status'), 'ACCEPTED',
  'with the redeemed invitation reported as ACCEPTED rather than silently vanishing from the list');

-- ---------------------------------------------------------------------------------------
-- 3. Lockout. Every organization has exactly one user on the day it is created, so without
--    this rule the first action a customer can take is permanent self-lockout: there is no
--    recovery path in the product and the FASE 0 break-glass tables still have no code.
-- ---------------------------------------------------------------------------------------
insert into fx
select 'admin_membership', m.id from authz.memberships m
 where m.user_id = '11110000-0000-4000-8000-000000000001'
   and m.company_id is null and m.revoked_at is null;

do $$
declare v_id uuid := (select id from fx where label = 'admin_membership');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11110000-0000-4000-8000-000000000001","role":"authenticated"}', true);

  begin
    perform api.revoke_membership(v_id);
    insert into probe values ('self_revoke', 'ALLOWED');
  exception when others then insert into probe values ('self_revoke', sqlerrm); end;

  begin
    perform api.update_membership_role(v_id, 'VIEWER');
    insert into probe values ('self_demote', 'ALLOWED');
  exception when others then insert into probe values ('self_demote', sqlerrm); end;
  reset role;
end $$;

-- The SST_OPERATOR who just accepted is org-wide but is not an admin, so it does not
-- satisfy the rule -- "someone else is in the org" was never the condition.
select is((select val from probe where label = 'self_revoke'), 'last_org_admin',
  'the last org-wide ORG_ADMIN cannot revoke itself');
select is((select val from probe where label = 'self_demote'), 'last_org_admin',
  'nor demote itself, which would leave the organization equally unadministrable');

insert into authz.memberships (user_id, organization_id, company_id, role, accepted_at)
values ('11110000-0000-4000-8000-000000000004', (select id from fx where label = 'org'),
        null, 'ORG_ADMIN', now());

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11110000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  begin
    perform api.revoke_membership((select id from fx where label = 'admin_membership'));
    insert into probe values ('revoke_with_second', 'ALLOWED');
  exception when others then insert into probe values ('revoke_with_second', sqlerrm); end;
  reset role;
end $$;

select is((select val from probe where label = 'revoke_with_second'), 'ALLOWED',
  'once a second org-wide ORG_ADMIN exists, the first is free to leave');

select ok(
  (select m.revoked_at is not null from authz.memberships m
    where m.id = (select id from fx where label = 'admin_membership')),
  'revocation sets revoked_at rather than deleting -- who had access, and when, survives');

-- ---------------------------------------------------------------------------------------
-- 4. Reachability of the token hash
-- ---------------------------------------------------------------------------------------
do $$
declare n bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11110000-0000-4000-8000-000000000003","role":"authenticated"}', true);
  begin
    execute 'select count(*) from authz.membership_invitations' into n;
    insert into probe values ('read_invites', 'READ ' || n);
  exception when others then insert into probe values ('read_invites', sqlstate); end;
  reset role;
end $$;

select is((select val from probe where label = 'read_invites'), '42501',
  'authenticated cannot read authz.membership_invitations directly -- no grant, not merely a policy');

select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api' and p.proname = 'list_invitations'
      and 'token_hash' = any (p.proargnames)),
  0,
  'and api.list_invitations does not return token_hash either -- a listable token is a redeemable token');

select * from finish();

rollback;
