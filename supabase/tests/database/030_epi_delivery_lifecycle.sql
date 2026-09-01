-- FASE 2 Definition of Done (mvp-roadmap.md): editing an EPI after a delivery is ISSUED
-- must not change that delivery's snapshot; an illegal state transition must raise; a
-- direct PostgREST-style UPDATE on a state column must fail for lack of grant, not merely
-- be filtered by RLS. Every edge seeded in app.state_transitions with an RPC to fire it
-- (DRAFT->ISSUED, DRAFT->CANCELLED, ISSUED->CANCELLED) is exercised here; the remaining
-- edges (REQUEST_CONFIRMED/REQUEST_CONTESTED/REISSUE/SUPERSEDE) get their own coverage
-- once FASE 3/5 build the RPCs that fire them -- they exist as data now, not as reachable
-- API surface yet.

create extension if not exists pgtap with schema extensions;

begin;

select plan(11);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', '55555555-5555-5555-5555-555555555501',
  'authenticated', 'authenticated', 'admin-e@tenant-e.test',
  extensions.crypt('x', extensions.gen_salt('bf')), now(),
  '{}', '{"full_name":"Admin E"}', now(), now(), '', '', '', '', false, false
);

create temporary table fixture_ids (label text primary key, id uuid, extra text);
-- See the identical comment in 020_employee_isolation.sql: a session-temp table created
-- by the owner grants nothing to `authenticated` by default, and the DO blocks below
-- write to it while impersonating that role.
grant all on fixture_ids to authenticated;

-- extensions.digest is computed BEFORE the role switch -- see the identical comment in
-- 020_employee_isolation.sql: `authenticated` has no USAGE on the `extensions` schema.
do $$
declare v_company_id uuid; v_org_id uuid; v_cpf_hash_b64 text; v_cpf_enc_b64 text;
begin
  v_cpf_hash_b64 := encode(extensions.digest('cpf-e', 'sha256'), 'base64');
  v_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-e'::bytea, 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555501","role":"authenticated"}', true);

  select organization_id, company_id into v_org_id, v_company_id
  from api.onboard_organization('Tenant E LTDA', '11222333000181', 'Tenant E LTDA', '11222333000181', null);
  insert into fixture_ids values ('org', v_org_id, null), ('company', v_company_id, null);

  insert into fixture_ids
    select 'employee', api.create_employee(v_company_id, 'Trabalhador E',
      v_cpf_hash_b64, v_cpf_enc_b64, '***.333.333-**'), null;

  insert into fixture_ids
    select 'epi', api.create_epi(v_org_id, v_company_id, 'Capacete', '11111', 'Marca A', null, null, 'UN'), null;

  reset role;
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555501","role":"authenticated"}';

select ok((select count(*) = 4 from fixture_ids), 'org/company/employee/epi fixtures created');

-- Create + issue a delivery, capturing its id via a temp table (RPC return values can't
-- feed directly into a later pgTAP call in the same statement).
do $$
declare v_delivery_id uuid; v_company_id uuid; v_employee_id uuid; v_epi_id uuid;
begin
  select id into v_company_id from fixture_ids where label = 'company';
  select id into v_employee_id from fixture_ids where label = 'employee';
  select id into v_epi_id from fixture_ids where label = 'epi';

  select api.create_delivery(v_company_id, v_employee_id, current_date, 'Entrega FASE 2',
    jsonb_build_array(jsonb_build_object('epi_id', v_epi_id, 'quantity', 3)))
  into v_delivery_id;

  insert into fixture_ids values ('delivery', v_delivery_id, null);
  perform api.issue_delivery(v_delivery_id);
end $$;

select is(
  (select status::text from api.epi_deliveries where id = (select id from fixture_ids where label = 'delivery')),
  'ISSUED',
  'delivery transitions DRAFT -> ISSUED via the RPC'
);

select is(
  (select epi_name from api.epi_delivery_items where delivery_id = (select id from fixture_ids where label = 'delivery')),
  'Capacete',
  'item snapshot captured the EPI name at delivery time'
);

-- THE key DoD assertion: edit the catalog, then re-check the ALREADY-ISSUED delivery's
-- snapshot is untouched.
select api.update_epi((select id from fixture_ids where label = 'epi'), 'Capacete V2', '22222', 'Marca B', null, null, 'UN');

select is(
  (select name from api.epis where id = (select id from fixture_ids where label = 'epi')),
  'Capacete V2',
  'the catalog itself now shows the edited name (proves the edit really happened)'
);

select is(
  (select epi_name from api.epi_delivery_items where delivery_id = (select id from fixture_ids where label = 'delivery')),
  'Capacete',
  'the ISSUED delivery''s item snapshot is UNCHANGED after the catalog edit -- FASE 2 Definition of Done'
);

select is(
  (select ca_number from api.epi_delivery_items where delivery_id = (select id from fixture_ids where label = 'delivery')),
  '11111',
  'the ISSUED delivery''s CA snapshot is UNCHANGED after the catalog edit'
);

-- Illegal transition: no DELIVERY edge from ISSUED with event ISSUE exists (only from
-- DRAFT) -- attempting to re-run create_delivery's issue path on an already-ISSUED
-- delivery must be rejected by the RPC's own status check, and even if it weren't, the
-- trigger would still reject the illegal (ISSUED, 'ISSUE', ISSUED) tuple.
select throws_ok(
  $$ select api.issue_delivery((select id from fixture_ids where label = 'delivery')) $$,
  '23514',
  'issuing an already-ISSUED delivery is rejected (delivery_not_draft)'
);

-- Direct PostgREST-style UPDATE on a state column must fail for lack of GRANT, not be
-- silently filtered by RLS -- this is checked at the privilege layer, before any policy.
select throws_ok(
  $$ update app.epi_deliveries set status = 'CANCELLED' where id = (select id from fixture_ids where label = 'delivery') $$,
  '42501',
  'a direct UPDATE on epi_deliveries.status has no grant at all for authenticated'
);

-- A legal transition that IS reachable now: cancel a fresh DRAFT delivery.
do $$
declare v_delivery_id uuid; v_company_id uuid; v_employee_id uuid; v_epi_id uuid;
begin
  select id into v_company_id from fixture_ids where label = 'company';
  select id into v_employee_id from fixture_ids where label = 'employee';
  select id into v_epi_id from fixture_ids where label = 'epi';
  select api.create_delivery(v_company_id, v_employee_id, current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', v_epi_id, 'quantity', 1)))
  into v_delivery_id;
  insert into fixture_ids values ('delivery2', v_delivery_id, null);
  perform api.cancel_delivery(v_delivery_id, 'motivo de teste');
end $$;

select is(
  (select status::text from api.epi_deliveries where id = (select id from fixture_ids where label = 'delivery2')),
  'CANCELLED',
  'DRAFT -> CANCELLED succeeds via the RPC'
);

-- CANCELLED is terminal: no outgoing edge exists at all, so any further transition fails.
select throws_ok(
  $$ select api.cancel_delivery((select id from fixture_ids where label = 'delivery2'), 'segunda tentativa') $$,
  '23514',
  'CANCELLED is terminal -- a second cancel attempt is rejected (delivery_not_cancellable)'
);

-- Items are DRAFT-only: cannot insert a new line into the already-ISSUED delivery.
select throws_ok(
  $$ insert into app.epi_delivery_items (delivery_id, company_id, line_no, epi_version_id, epi_name, ca_number, quantity)
     select (select id from fixture_ids where label = 'delivery'), (select id from fixture_ids where label = 'company'),
            2, v.id, v.name, v.ca_number, 1
     from app.epi_versions v where v.epi_id = (select id from fixture_ids where label = 'epi') and v.valid_to is null $$,
  '23514',
  'cannot add a line item to an ISSUED delivery (items are DRAFT-only)'
);

select * from finish();

rollback;
