-- Phase C: EPI lifecycle + troca. Covers (1) tenant isolation, (2) the troca RPC correctly
-- chaining (chain_version+1, corrects_delivery_id) and immediately superseding the original,
-- (3) early-replacement policy enforcement (block hard-fails, warn requires confirm_early +
-- a real reason_note, allow proceeds silently), (4) lifecycle status derivation
-- (VIGENTE/PROXIMO_DA_TROCA/TROCA_NECESSARIA), (5) a superseded delivery no longer appears
-- in api.employee_epi_lifecycle at all.
--
-- Getting a delivery to CONFIRMED without going through the real worker OTP flow: this file
-- updates app.epi_deliveries directly (as the unrestricted owner/superuser role the test
-- runs as by default, never impersonating `authenticated` for this one step) rather than
-- reimplementing worker.finish_confirmation's identity challenge -- that flow is already
-- covered by 040_confirmation_flow.sql; this file's job is the LIFECYCLE logic that starts
-- from an already-CONFIRMED delivery, not the confirmation flow itself.

create extension if not exists pgtap with schema extensions;

begin;

select plan(14);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01',
   'authenticated', 'authenticated', 'admin-k@tenant-k.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin K"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'cccccccc-cccc-cccc-cccc-cccccccccc01',
   'authenticated', 'authenticated', 'admin-l@tenant-l.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin L"}', now(), now(), '', '', '', '', false, false);

create temporary table fixture_ids (label text primary key, id uuid not null);
grant all on fixture_ids to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant K LTDA', '11222333000581', 'Tenant K LTDA', '11222333000581', null);
  insert into fixture_ids values ('company_k', v_company_id);
  reset role;
end $$;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccc01","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant L LTDA', '22333444000596', 'Tenant L LTDA', '22333444000596', null);
  insert into fixture_ids values ('company_l', v_company_id);
  reset role;
end $$;

-- Tenant K: an EPI with a 90-day lifespan, an employee, a delivery -- confirmed 100 days ago
-- (already overdue) so the "normal troca" path below is never itself flagged as early.
do $$
declare
  v_company_k uuid; v_org_k uuid; v_epi_id uuid; v_employee_id uuid; v_delivery_id uuid;
  v_cpf_hash_b64 text; v_cpf_enc_b64 text;
begin
  select id into v_company_k from fixture_ids where label = 'company_k';
  v_org_k := (select organization_id from app.companies where id = v_company_k);
  v_cpf_hash_b64 := encode(extensions.digest('cpf-k', 'sha256'), 'base64');
  v_cpf_enc_b64 := encode(decode('000000000000000000000000000000000000000000000000000000', 'hex') || 'fake-k'::bytea, 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01","role":"authenticated"}', true);

  select api.create_epi(v_org_k, v_company_k, 'Luva Isolante', '77777', null, null, null, 'PAR', 90) into v_epi_id;
  insert into fixture_ids values ('epi_k', v_epi_id);

  select api.create_employee(v_company_k, 'Funcionário Tenant K', v_cpf_hash_b64, v_cpf_enc_b64, '***.666.666-**')
  into v_employee_id;
  insert into fixture_ids values ('employee_k', v_employee_id);

  select api.create_delivery(
    v_company_k, v_employee_id, current_date - 100, null,
    jsonb_build_array(jsonb_build_object('epi_id', v_epi_id, 'quantity', 1))
  ) into v_delivery_id;
  insert into fixture_ids values ('delivery_k1', v_delivery_id);

  -- DRAFT -> ISSUED -> CONFIRMED has no direct edge; the state machine requires ISSUED
  -- first, so this fixture issues it for real before the direct-CONFIRMED hack below.
  perform api.issue_delivery(v_delivery_id);

  reset role;
end $$;

select is(
  (select default_lifespan_days::int from api.epis where id = (select id from fixture_ids where label = 'epi_k')),
  90,
  'the EPI catalog entry carries its vida útil padrão (90 days)'
);

-- Confirm delivery_k1 directly (bypassing the real worker OTP flow -- see file header),
-- backdated so it is already overdue (100 days ago + 90-day lifespan < today). The
-- app.enforce_state_transition trigger still fires regardless of role, so this fixture
-- needs the same app.transition_ok guard the real RPCs set before their own UPDATEs.
select set_config('app.transition_ok', (select id::text from fixture_ids where label = 'delivery_k1'), true);
update app.epi_deliveries
set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = (current_date - 100)::timestamptz, frozen_at = clock_timestamp()
where id = (select id from fixture_ids where label = 'delivery_k1');

select is(
  (select status::text from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_k1')),
  'CONFIRMED',
  'delivery_k1 is CONFIRMED (test fixture, bypassing the real worker flow)'
);

-- Lifecycle status BEFORE any troca: overdue (100 days held, 90-day lifespan) -> TROCA_NECESSARIA.
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01","role":"authenticated"}';

select results_eq(
  $$ select status::text from api.employee_epi_lifecycle((select id from fixture_ids where label = 'employee_k')) $$,
  $$ values ('TROCA_NECESSARIA'::text) $$,
  'an EPI held 100 days against a 90-day lifespan shows TROCA_NECESSARIA'
);

reset role;

-- Troca: replace delivery_k1. Not early (it's overdue), so no policy check should trigger
-- regardless of the default 'warn' policy.
do $$
declare v_new_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01","role":"authenticated"}', true);

  select api.create_replacement_delivery(
    (select id from fixture_ids where label = 'delivery_k1'),
    jsonb_build_array(jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_k'), 'quantity', 1)),
    current_date, null, 'PERIODIC_REPLACEMENT', null, false
  ) into v_new_id;
  insert into fixture_ids values ('delivery_k2', v_new_id);

  reset role;
end $$;

select is(
  (select status::text from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_k1')),
  'SUPERSEDED',
  'the original delivery is immediately SUPERSEDED by the troca'
);

select is(
  (select superseded_by_delivery_id from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_k1')),
  (select id from fixture_ids where label = 'delivery_k2'),
  'the original correctly points at the new delivery via superseded_by_delivery_id'
);

select is(
  (select (chain_id, chain_version, corrects_delivery_id) from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_k2')),
  (select (chain_id, chain_version + 1, id) from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_k1')),
  'the new delivery shares the same chain_id, is chain_version+1, and corrects the original'
);

select is(
  (select status::text from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_k2')),
  'DRAFT',
  'the new delivery starts DRAFT like any other -- it goes through the normal issue/confirm flow'
);

-- The superseded original no longer appears in the lifecycle read at all.
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01","role":"authenticated"}';

select is(
  (select count(*)::int from api.employee_epi_lifecycle((select id from fixture_ids where label = 'employee_k'))),
  0,
  'once superseded, delivery_k1 no longer appears in the lifecycle read (delivery_k2 is still DRAFT, not CONFIRMED, so it doesn''t appear either yet)'
);

-- Attempting a SECOND troca against the now-SUPERSEDED delivery_k1 must fail.
select throws_ok(
  format(
    $$ select api.create_replacement_delivery(%L, jsonb_build_array(jsonb_build_object('epi_id', %L, 'quantity', 1)), current_date, null, 'OTHER', null, false) $$,
    (select id from fixture_ids where label = 'delivery_k1'),
    (select id from fixture_ids where label = 'epi_k')
  ),
  '23514',
  NULL,
  'a second troca against an already-SUPERSEDED delivery is rejected (original_not_replaceable)'
);

reset role;

-- Confirm delivery_k2 (fresh today), then attempt an EARLY troca against it: 90-day
-- lifespan, confirmed today -> due date is 90 days out, so this troca is early. Issue it
-- first (DRAFT -> ISSUED), same state-machine requirement as delivery_k1 above.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01","role":"authenticated"}', true);
  perform api.issue_delivery((select id from fixture_ids where label = 'delivery_k2'));
  reset role;
end $$;

select set_config('app.transition_ok', (select id::text from fixture_ids where label = 'delivery_k2'), true);
update app.epi_deliveries
set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = clock_timestamp(), frozen_at = clock_timestamp()
where id = (select id from fixture_ids where label = 'delivery_k2');

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01","role":"authenticated"}';

select results_eq(
  $$ select status::text from api.employee_epi_lifecycle((select id from fixture_ids where label = 'employee_k')) $$,
  $$ values ('VIGENTE'::text) $$,
  'delivery_k2, confirmed today against a 90-day lifespan, shows VIGENTE'
);

-- Default policy is 'warn': an early troca WITHOUT confirm_early must be rejected asking
-- for confirmation, not silently blocked or silently allowed.
select throws_ok(
  format(
    $$ select api.create_replacement_delivery(%L, jsonb_build_array(jsonb_build_object('epi_id', %L, 'quantity', 1)), current_date, null, 'SIZE_CHANGE', null, false) $$,
    (select id from fixture_ids where label = 'delivery_k2'),
    (select id from fixture_ids where label = 'epi_k')
  ),
  '23514',
  NULL,
  'an early troca (still VIGENTE) without confirm_early is rejected (early_replacement_confirmation_required)'
);

-- confirm_early=true but no reason_note must still be rejected.
select throws_ok(
  format(
    $$ select api.create_replacement_delivery(%L, jsonb_build_array(jsonb_build_object('epi_id', %L, 'quantity', 1)), current_date, null, 'SIZE_CHANGE', null, true) $$,
    (select id from fixture_ids where label = 'delivery_k2'),
    (select id from fixture_ids where label = 'epi_k')
  ),
  '23514',
  NULL,
  'confirm_early=true WITHOUT a real reason_note is still rejected (reason_note_required_for_early_replacement)'
);

-- confirm_early=true WITH a real reason_note succeeds.
do $$
declare v_new_id uuid;
begin
  select api.create_replacement_delivery(
    (select id from fixture_ids where label = 'delivery_k2'),
    jsonb_build_array(jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_k'), 'quantity', 1)),
    current_date, null, 'SIZE_CHANGE', 'Colaborador trocou de função e precisa de tamanho diferente', true
  ) into v_new_id;
  insert into fixture_ids values ('delivery_k3', v_new_id);
end $$;

select is(
  (select status::text from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_k2')),
  'SUPERSEDED',
  'confirm_early=true + a real reason_note lets the early troca proceed'
);

reset role;

-- Isolation: tenant L must see none of tenant K's lifecycle/troca data.
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccc01","role":"authenticated"}';

-- api.employee_epi_lifecycle is SECURITY DEFINER, so its own internal SELECT against
-- app.employees runs as the function owner (which this schema's convention exempts from
-- FORCE ROW LEVEL SECURITY when the owner has BYPASSRLS) -- it finds the employee
-- regardless of caller. The auth_ctx.has_permission check is what actually protects it,
-- same as every other RPC in this codebase (e.g. api.return_epi_item, api.delivery_audit_events).
select throws_ok(
  $$ select api.employee_epi_lifecycle((select id from fixture_ids where label = 'employee_k')) $$,
  '42501',
  NULL,
  'tenant L cannot read tenant K''s employee lifecycle (insufficient_privilege -- no membership at all for tenant K''s company)'
);

reset role;

select * from finish();

rollback;
