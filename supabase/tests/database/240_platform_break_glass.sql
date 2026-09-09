-- Phase H: platform break-glass. This is the mechanism by which the vendor's own staff read
-- a customer's data, so the assertions that matter are the ones proving it CANNOT be used --
-- without a grant, past a grant's expiry, after revocation, outside a grant's scope, or by
-- an ordinary user who found the function name.
--
-- The transparency half is tested just as hard. A back door with paperwork nobody can read
-- is still a back door: the affected tenant must be able to see who was given access, why,
-- for how long, and whether it was actually used.

create extension if not exists pgtap with schema extensions;

begin;

select plan(32);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'aa000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'super@selo.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Platform Super"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'aa000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'support@selo.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Platform Support"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'aa000000-0000-4000-8000-000000000003',
   'authenticated', 'authenticated', 'engineer@selo.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Platform Engineer"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'bb000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'admin@cliente.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Cliente Admin"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'bb000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'operador@cliente.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Cliente Operador"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'cc000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'admin@outro.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Outro Admin"}', now(), now(), '', '', '', '', false, false);

create temporary table fx (label text primary key, id uuid not null);
grant all on fx to authenticated;
create temporary table probe (label text primary key, val text);
grant all on probe to authenticated;

-- Two unrelated customers.
do $$
declare v_company uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bb000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  select company_id into v_company
  from api.onboard_organization('Cliente LTDA', '44555666000177', 'Cliente LTDA', '44555666000177', null);
  insert into fx values ('company_a', v_company);
  insert into fx select 'org_a', c.organization_id from app.companies c where c.id = v_company;
  reset role;
end $$;

do $$
declare v_company uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"cc000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  select company_id into v_company
  from api.onboard_organization('Outro LTDA', '77888999000155', 'Outro LTDA', '77888999000155', null);
  insert into fx values ('company_b', v_company);
  insert into fx select 'org_b', c.organization_id from app.companies c where c.id = v_company;
  reset role;
end $$;

-- A company-scoped member of tenant A -- the person the rescue write will promote.
insert into authz.memberships (user_id, organization_id, company_id, role, accepted_at)
values ('bb000000-0000-4000-8000-000000000002',
        (select id from fx where label = 'org_a'),
        (select id from fx where label = 'company_a'),
        'SST_OPERATOR', now());

-- The platform roster. Seeded by direct insert, which is exactly how the first SUPER is
-- created in production: a function able to mint the first platform admin would be a
-- function able to mint platform power out of an ordinary account.
insert into app.platform_admins (user_id, level) values
  ('aa000000-0000-4000-8000-000000000001', 'SUPER'),
  ('aa000000-0000-4000-8000-000000000002', 'SUPPORT'),
  ('aa000000-0000-4000-8000-000000000003', 'ENGINEER');

-- ---------------------------------------------------------------------------------------
-- 1. Who may issue a grant, and on what terms
-- ---------------------------------------------------------------------------------------
do $$
declare v_org uuid := (select id from fx where label = 'org_a');
begin
  set local role authenticated;

  -- An ordinary customer admin who somehow learned the function name.
  perform set_config('request.jwt.claims', '{"sub":"bb000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  begin
    perform api.grant_platform_access('aa000000-0000-4000-8000-000000000002', v_org, null,
      'cliente tentando conceder acesso de plataforma', null, 24);
    insert into probe values ('outsider_grant', 'ALLOWED');
  exception when others then insert into probe values ('outsider_grant', sqlerrm); end;

  perform set_config('request.jwt.claims', '{"sub":"aa000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

  -- Four eyes: nobody grants themselves access.
  begin
    perform api.grant_platform_access('aa000000-0000-4000-8000-000000000001', v_org, null,
      'preciso investigar um chamado deste cliente agora', 'TCK-1', 24);
    insert into probe values ('self_grant', 'ALLOWED');
  exception when others then insert into probe values ('self_grant', sqlerrm); end;

  begin
    perform api.grant_platform_access('aa000000-0000-4000-8000-000000000002', v_org, null,
      'curto', 'TCK-2', 24);
    insert into probe values ('short_reason', 'ALLOWED');
  exception when others then insert into probe values ('short_reason', sqlerrm); end;

  begin
    perform api.grant_platform_access('aa000000-0000-4000-8000-000000000002', v_org, null,
      'investigar chamado de entrega nao confirmada', 'TCK-3', 96);
    insert into probe values ('long_ttl', 'ALLOWED');
  exception when others then insert into probe values ('long_ttl', sqlerrm); end;

  begin
    perform api.grant_platform_access('aa000000-0000-4000-8000-000000000002', v_org,
      (select id from fx where label = 'company_b'),
      'escopo apontando para empresa de outro tenant', 'TCK-4', 24);
    insert into probe values ('foreign_company', 'ALLOWED');
  exception when others then insert into probe values ('foreign_company', sqlerrm); end;

  -- The legitimate grant this suite then exercises.
  begin
    insert into fx values ('grant_a', api.grant_platform_access(
      'aa000000-0000-4000-8000-000000000002', v_org, null,
      'cliente relatou entrega presa em ISSUED, chamado aberto', 'TCK-100', 24));
    insert into probe values ('legit_grant', 'ALLOWED');
  exception when others then insert into probe values ('legit_grant', sqlerrm); end;

  reset role;
end $$;

select is((select val from probe where label = 'outsider_grant'), 'insufficient_privilege',
  'a customer admin cannot issue themselves a platform grant');
select is((select val from probe where label = 'self_grant'), 'four_eyes_required',
  'and a platform admin cannot grant access to themselves -- four eyes, checked before the constraint');
select is((select val from probe where label = 'short_reason'), 'reason_too_short',
  'a grant without a real reason is refused -- the reason is what the customer gets to read');
select is((select val from probe where label = 'long_ttl'), 'invalid_ttl',
  'and no grant may outlast 72 hours');
select is((select val from probe where label = 'foreign_company'), 'company_not_in_organization',
  'the scope cannot name a company belonging to a different tenant');
select is((select val from probe where label = 'legit_grant'), 'ALLOWED',
  'a well-formed grant is issued');

select is(
  (select a.actor_kind from audit.audit_events a
    where a.entity_table = 'platform_access_grants'
      and a.entity_id = (select id from fx where label = 'grant_a')
      and a.event_type = 'PLATFORM_ACCESS_GRANTED'),
  'PLATFORM',
  'and lands in the AFFECTED TENANT''s own hash-chained audit trail, marked as a platform actor');

select ok(
  (select a.data ->> 'reason' from audit.audit_events a
    where a.entity_id = (select id from fx where label = 'grant_a')
      and a.event_type = 'PLATFORM_ACCESS_GRANTED') like '%chamado aberto%',
  'with the reason recorded in it -- a justification the customer cannot read protects nobody');

-- ---------------------------------------------------------------------------------------
-- 2. What a grant does and does not open
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_org_a uuid := (select id from fx where label = 'org_a');
  v_org_b uuid := (select id from fx where label = 'org_b');
  n bigint;
begin
  set local role authenticated;

  -- A platform admin with no grant at all.
  perform set_config('request.jwt.claims', '{"sub":"aa000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
  begin
    perform * from api.platform_organization_overview(v_org_a);
    insert into probe values ('no_grant_read', 'ALLOWED');
  exception when others then insert into probe values ('no_grant_read', sqlerrm); end;

  -- An ordinary customer admin.
  perform set_config('request.jwt.claims', '{"sub":"bb000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  begin
    perform * from api.platform_audit_events(v_org_a, 10);
    insert into probe values ('customer_read', 'ALLOWED');
  exception when others then insert into probe values ('customer_read', sqlerrm); end;
  begin
    perform * from api.platform_search_organizations(null, 10);
    insert into probe values ('customer_search', 'ALLOWED');
  exception when others then insert into probe values ('customer_search', sqlerrm); end;

  -- The grantee, on the tenant they were granted.
  perform set_config('request.jwt.claims', '{"sub":"aa000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  begin
    select count(*) into n from api.platform_organization_overview(v_org_a);
    insert into probe values ('granted_read', 'ROWS ' || n);
  exception when others then insert into probe values ('granted_read', sqlerrm); end;

  -- ...and on a tenant they were not.
  begin
    perform * from api.platform_organization_overview(v_org_b);
    insert into probe values ('cross_tenant_read', 'ALLOWED');
  exception when others then insert into probe values ('cross_tenant_read', sqlerrm); end;

  -- A second read, to prove the audit trail is not spammed once per call.
  begin
    perform * from api.platform_audit_events(v_org_a, 5);
    insert into probe values ('second_read', 'ALLOWED');
  exception when others then insert into probe values ('second_read', sqlerrm); end;

  reset role;
end $$;

select is((select val from probe where label = 'no_grant_read'), 'no_live_platform_grant',
  'a platform admin with no grant reads nothing -- being staff is not itself access');
select is((select val from probe where label = 'customer_read'), 'no_live_platform_grant',
  'and an ordinary user gets the same refusal, with no hint that the distinction exists');
select is((select val from probe where label = 'customer_search'), 'insufficient_privilege',
  'nor can an ordinary user enumerate the vendor''s customers');
select is((select val from probe where label = 'granted_read'), 'ROWS 1',
  'the grantee can read the tenant they were granted');
select is((select val from probe where label = 'cross_tenant_read'), 'no_live_platform_grant',
  'and only that one -- a grant on one tenant opens nothing on another');

select is(
  (select count(*)::int from audit.audit_events a
    where a.organization_id = (select id from fx where label = 'org_a')
      and a.event_type = 'PLATFORM_ACCESS_USED'),
  1,
  'PLATFORM_ACCESS_USED is written once for the grant, not once per read -- every read would serialise on the tenant''s chain head and bury their own history');

select is(
  (select g.use_count from app.platform_access_grants g
    where g.id = (select id from fx where label = 'grant_a')),
  2,
  'while the use counter records every successful access under it -- and only those: the
   cross-tenant attempt raised before it could reach the counter');

select is(
  (select (g.first_used_at is not null and g.last_used_at >= g.first_used_at)
     from app.platform_access_grants g
    where g.id = (select id from fx where label = 'grant_a')),
  true,
  'with a first and last use stamped on the grant itself');

-- ---------------------------------------------------------------------------------------
-- 3. Expiry, revocation, and scope
-- ---------------------------------------------------------------------------------------
insert into app.platform_access_grants (
  admin_user_id, organization_id, company_id, reason, granted_by, granted_at, expires_at
) values (
  'aa000000-0000-4000-8000-000000000003', (select id from fx where label = 'org_a'), null,
  'concessao antiga que ja passou da validade', 'aa000000-0000-4000-8000-000000000001',
  now() - interval '100 hours', now() - interval '28 hours'
);

-- A company-scoped grant, which must not reach organization-wide reads.
with g as (
  insert into app.platform_access_grants (
    admin_user_id, organization_id, company_id, reason, granted_by, expires_at
  ) values (
    'aa000000-0000-4000-8000-000000000003', (select id from fx where label = 'org_a'),
    (select id from fx where label = 'company_a'),
    'acesso restrito a uma unica empresa do cliente', 'aa000000-0000-4000-8000-000000000001',
    now() + interval '24 hours'
  ) returning id
)
insert into fx select 'grant_scoped', g.id from g;

do $$
declare v_org uuid := (select id from fx where label = 'org_a');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aa000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

  -- The expired grant exists, and does nothing. The company-scoped one exists too, and must
  -- not stand in for an organization-wide one.
  begin
    perform * from api.platform_organization_overview(v_org);
    insert into probe values ('scoped_org_read', 'ALLOWED');
  exception when others then insert into probe values ('scoped_org_read', sqlerrm); end;

  begin
    perform api.platform_grant_org_admin(v_org, 'bb000000-0000-4000-8000-000000000002');
    insert into probe values ('scoped_rescue', 'ALLOWED');
  exception when others then insert into probe values ('scoped_rescue', sqlerrm); end;

  reset role;
end $$;

select is((select val from probe where label = 'scoped_org_read'), 'no_live_platform_grant',
  'an expired grant grants nothing, and a company-scoped one does not answer for the organization');
select is((select val from probe where label = 'scoped_rescue'), 'no_live_platform_grant',
  'nor can a company-scoped grant mint an administrator over every company of the tenant');

do $$
declare v_org uuid := (select id from fx where label = 'org_a');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aa000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  perform api.revoke_platform_access((select id from fx where label = 'grant_a'));
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aa000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  begin
    perform * from api.platform_organization_overview(v_org);
    insert into probe values ('after_revoke', 'ALLOWED');
  exception when others then insert into probe values ('after_revoke', sqlerrm); end;
  reset role;
end $$;

select is((select val from probe where label = 'after_revoke'), 'no_live_platform_grant',
  'revoking a grant ends the access immediately, with no session to wait out');

select is(
  (select count(*)::int from audit.audit_events a
    where a.entity_id = (select id from fx where label = 'grant_a')
      and a.event_type = 'PLATFORM_ACCESS_REVOKED'),
  1,
  'and the tenant sees the revocation in their own trail, not just the grant');

-- ---------------------------------------------------------------------------------------
-- 4. Lockout recovery -- the reason this phase exists at all
-- ---------------------------------------------------------------------------------------
do $$
declare v_org uuid := (select id from fx where label = 'org_a');
begin
  -- The customer's only org-wide admin is gone. Phase G's rule stops them revoking
  -- themselves through the panel, but nothing stops the account being lost outside it.
  update authz.memberships m set revoked_at = now()
   where m.user_id = 'bb000000-0000-4000-8000-000000000001'
     and m.organization_id = v_org and m.company_id is null;

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aa000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  insert into fx values ('grant_rescue', api.grant_platform_access(
    'aa000000-0000-4000-8000-000000000002', v_org, null,
    'cliente sem administrador, chamado de recuperacao de acesso', 'TCK-200', 4));
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aa000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

  -- Support cannot introduce a stranger; only elevate someone already admitted.
  begin
    perform api.platform_grant_org_admin(v_org, 'cc000000-0000-4000-8000-000000000001');
    insert into probe values ('rescue_stranger', 'ALLOWED');
  exception when others then insert into probe values ('rescue_stranger', sqlerrm); end;

  begin
    perform api.platform_grant_org_admin(v_org, 'bb000000-0000-4000-8000-000000000002');
    insert into probe values ('rescue', 'ALLOWED');
  exception when others then insert into probe values ('rescue', sqlerrm); end;

  reset role;
end $$;

select is((select val from probe where label = 'rescue_stranger'), 'not_a_member',
  'support cannot put a stranger into a customer''s organization -- only elevate someone the tenant already admitted');
select is((select val from probe where label = 'rescue'), 'ALLOWED',
  'but it can promote an existing member, which is the whole point of the phase');

select is(
  (select count(*)::int from authz.memberships m
    where m.user_id = 'bb000000-0000-4000-8000-000000000002'
      and m.organization_id = (select id from fx where label = 'org_a')
      and m.company_id is null and m.role = 'ORG_ADMIN' and m.revoked_at is null),
  1,
  'the promoted member now holds a live org-wide ORG_ADMIN membership');

select ok(
  (select m.revoked_at is null from authz.memberships m
    where m.user_id = 'bb000000-0000-4000-8000-000000000002'
      and m.company_id = (select id from fx where label = 'company_a')),
  'and their original company-scoped membership survives -- that row is what the customer granted, and rewriting its scope would erase the fact');

do $$
declare v_org uuid := (select id from fx where label = 'org_a');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bb000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  begin
    insert into probe values ('recovered', (select auth_ctx.can_grant_role(v_org, null, 'ORG_ADMIN'))::text);
  exception when others then insert into probe values ('recovered', sqlerrm); end;
  reset role;
end $$;

select is((select val from probe where label = 'recovered'), 'true',
  'and can actually administer the organization again -- the lockout is genuinely recoverable, not merely recorded');

select is(
  (select a.actor_kind from audit.audit_events a
    where a.event_type = 'PLATFORM_ORG_ADMIN_GRANTED'
      and a.organization_id = (select id from fx where label = 'org_a')),
  'PLATFORM',
  'with the promotion recorded in the tenant''s trail as a platform action, never as something they did themselves');

-- ---------------------------------------------------------------------------------------
-- 5. The roster
-- ---------------------------------------------------------------------------------------
do $$
begin
  set local role authenticated;

  perform set_config('request.jwt.claims', '{"sub":"aa000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  begin
    perform api.grant_platform_admin('bb000000-0000-4000-8000-000000000001', 'SUPER');
    insert into probe values ('nonsuper_roster', 'ALLOWED');
  exception when others then insert into probe values ('nonsuper_roster', sqlerrm); end;

  perform set_config('request.jwt.claims', '{"sub":"aa000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  begin
    perform api.revoke_platform_admin('aa000000-0000-4000-8000-000000000001');
    insert into probe values ('revoke_self', 'ALLOWED');
  exception when others then insert into probe values ('revoke_self', sqlerrm); end;

  perform api.revoke_platform_admin('aa000000-0000-4000-8000-000000000002');
  reset role;
end $$;

select is((select val from probe where label = 'nonsuper_roster'), 'insufficient_privilege',
  'a SUPPORT-level admin cannot promote anyone onto the platform roster');
select is((select val from probe where label = 'revoke_self'), 'cannot_revoke_self',
  'and a SUPER cannot remove itself, which would leave the roster with no way back in');

select is(
  (select count(*)::int from app.platform_access_grants g
    where g.admin_user_id = 'aa000000-0000-4000-8000-000000000002'
      and g.revoked_at is null and g.expires_at > now()),
  0,
  'removing someone from the roster also ends every grant they were holding -- otherwise the roster says "not staff" while the grant still says "may read tenant A"');

-- ---------------------------------------------------------------------------------------
-- 6. What the customer can see about all of this
-- ---------------------------------------------------------------------------------------
do $$
declare v_org uuid := (select id from fx where label = 'org_a'); n bigint;
begin
  set local role authenticated;

  -- The member promoted during the rescue is now the organization's admin.
  perform set_config('request.jwt.claims', '{"sub":"bb000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  begin
    select count(*) into n from api.list_platform_access_grants(v_org);
    insert into probe values ('customer_sees', 'ROWS ' || n);
  exception when others then insert into probe values ('customer_sees', sqlerrm); end;

  begin
    insert into probe select 'customer_sees_reason', g.reason
      from api.list_platform_access_grants(v_org) g
     where g.grant_id = (select id from fx where label = 'grant_a');
  exception when others then insert into probe values ('customer_sees_reason', sqlerrm); end;

  -- Somebody from an entirely different tenant.
  perform set_config('request.jwt.claims', '{"sub":"cc000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  begin
    perform * from api.list_platform_access_grants(v_org);
    insert into probe values ('other_tenant_sees', 'ALLOWED');
  exception when others then insert into probe values ('other_tenant_sees', sqlerrm); end;

  reset role;
end $$;

select is((select val from probe where label = 'customer_sees'), 'ROWS 4',
  'the customer''s own admin can list every grant ever issued over their organization');
select ok(
  (select val from probe where label = 'customer_sees_reason') like '%chamado aberto%',
  'including the reason given for each one');
select is((select val from probe where label = 'other_tenant_sees'), 'insufficient_privilege',
  'and nobody from another tenant can read that list');

select * from finish();

rollback;
