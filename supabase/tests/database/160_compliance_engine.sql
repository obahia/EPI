-- Phase D: deterministic compliance engine. Covers the formal contract negotiated before
-- implementation (see the closure-audit conversation): SEM_CARGO/MATRIZ_VAZIA (indeterminado,
-- never conforme nor não-conforme), SEM_REQUISITOS_OBRIGATORIOS (conforme, matrix exists but
-- nothing required), quantity math (NUNCA_ENTREGUE/QUANTIDADE_INSUFICIENTE/ITEM_VENCIDO),
-- due-soon/overdue boundary arithmetic (identical to api.employee_epi_lifecycle's own), the
-- replacement gap (original SUPERSEDED, replacement not yet CONFIRMED -> real gap, not a
-- bug), CONTESTED never satisfying a requirement even after resolve_contest, the
-- compliance_percent formula, required=false never gating the aggregate, the
-- compliance_enabled feature flag (off -> feature_disabled, never a fabricated state), and
-- cross-tenant isolation on all three api.*_compliance_* RPCs.

create extension if not exists pgtap with schema extensions;

begin;

select plan(35);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'dddddddd-dddd-dddd-dddd-dddddddddd01',
   'authenticated', 'authenticated', 'admin-p@tenant-p.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin P"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01',
   'authenticated', 'authenticated', 'admin-q@tenant-q.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin Q"}', now(), now(), '', '', '', '', false, false);

create temporary table fixture_ids (label text primary key, id uuid not null);
grant all on fixture_ids to authenticated;

-- Tenant P: the main compliance test subject. Tenant Q: cross-tenant probe only.
do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant P LTDA', '33444555000607', 'Tenant P LTDA', '33444555000607', null);
  insert into fixture_ids values ('company_p', v_company_id);
  reset role;
end $$;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant Q LTDA', '44555666000718', 'Tenant Q LTDA', '44555666000718', null);
  insert into fixture_ids values ('company_q', v_company_id);
  reset role;
end $$;

-- compliance_enabled defaults false -- flip it on for tenant P only (tenant Q stays off,
-- doubling as the feature-flag-off fixture).
update app.organizations set compliance_enabled = true
where id = (select organization_id from app.companies where id = (select id from fixture_ids where label = 'company_p'));

-- Catalog + matrix fixtures, all as tenant P's admin.
do $$
declare
  v_company uuid; v_org uuid;
  v_epi_capacete uuid; v_epi_luva uuid;
  v_pos_main uuid; v_pos_sem_matriz uuid; v_pos_opcional uuid; v_pos_percent uuid;
begin
  select id into v_company from fixture_ids where label = 'company_p';
  v_org := (select organization_id from app.companies where id = v_company);

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);

  -- Capacete: 90-day default lifespan. Luva: no default lifespan at all (tests that the
  -- requirement's own periodicity_days is what supplies one).
  select api.create_epi(v_org, v_company, 'Capacete Compliance', '90001', null, null, null, 'UN', 90) into v_epi_capacete;
  insert into fixture_ids values ('epi_capacete', v_epi_capacete);
  select api.create_epi(v_org, v_company, 'Luva Compliance', '90002', null, null, null, 'PAR', null) into v_epi_luva;
  insert into fixture_ids values ('epi_luva', v_epi_luva);

  select api.create_job_position(v_org, v_company, 'Cargo Principal') into v_pos_main;
  insert into fixture_ids values ('pos_main', v_pos_main);
  select api.create_job_position(v_org, v_company, 'Cargo Sem Matriz') into v_pos_sem_matriz;
  insert into fixture_ids values ('pos_sem_matriz', v_pos_sem_matriz);
  select api.create_job_position(v_org, v_company, 'Cargo Opcional') into v_pos_opcional;
  insert into fixture_ids values ('pos_opcional', v_pos_opcional);
  select api.create_job_position(v_org, v_company, 'Cargo Percentual') into v_pos_percent;
  insert into fixture_ids values ('pos_percent', v_pos_percent);

  -- Cargo Principal: capacete required qty=1 (periodicity falls back to the EPI's own 90
  -- days), luva required qty=2 with an explicit periodicity_days=60 override (the EPI itself
  -- has none) -- exercises the requirement-wins-over-EPI-default precedence directly.
  perform api.set_position_epi_requirement(v_pos_main, v_epi_capacete, true, 1, null, null);
  perform api.set_position_epi_requirement(v_pos_main, v_epi_luva, true, 2, 60, null);

  -- Cargo Opcional: one requirement, required=false -- must never gate the aggregate.
  perform api.set_position_epi_requirement(v_pos_opcional, v_epi_capacete, false, 1, null, null);

  -- Cargo Percentual: 4 required rows, matching the spec's own "75%" example shape.
  perform api.set_position_epi_requirement(v_pos_percent, v_epi_capacete, true, 1, null, null);

  reset role;
end $$;

-- Employees, each isolating exactly one scenario. Named args throughout since most callers
-- only care about a handful of the many optional parameters.
do $$
declare
  v_company uuid;
  v_cpf_hash bytea; v_cpf_enc bytea;
begin
  select id into v_company from fixture_ids where label = 'company_p';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);

  -- emp_sem_cargo: position_id left null entirely.
  perform api.create_employee(
    p_company_id := v_company, p_full_name := 'Func Sem Cargo',
    p_cpf_hash_b64 := encode(extensions.digest('cpf-d-01', 'sha256'), 'base64'),
    p_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-d-01'::bytea, 'base64'),
    p_cpf_masked := '***.001.001-**'
  );
  insert into fixture_ids select 'emp_sem_cargo', id from app.employees where full_name = 'Func Sem Cargo' and company_id = v_company;

  -- emp_matriz_vazia: has a position, that position has zero requirement rows.
  perform api.create_employee(
    p_company_id := v_company, p_full_name := 'Func Matriz Vazia',
    p_cpf_hash_b64 := encode(extensions.digest('cpf-d-02', 'sha256'), 'base64'),
    p_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-d-02'::bytea, 'base64'),
    p_cpf_masked := '***.002.002-**',
    p_position_id := (select id from fixture_ids where label = 'pos_sem_matriz')
  );
  insert into fixture_ids select 'emp_matriz_vazia', id from app.employees where full_name = 'Func Matriz Vazia' and company_id = v_company;

  -- emp_opcional: position's only requirement is required=false.
  perform api.create_employee(
    p_company_id := v_company, p_full_name := 'Func Opcional',
    p_cpf_hash_b64 := encode(extensions.digest('cpf-d-03', 'sha256'), 'base64'),
    p_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-d-03'::bytea, 'base64'),
    p_cpf_masked := '***.003.003-**',
    p_position_id := (select id from fixture_ids where label = 'pos_opcional')
  );
  insert into fixture_ids select 'emp_opcional', id from app.employees where full_name = 'Func Opcional' and company_id = v_company;

  -- emp_main: drives the NUNCA_ENTREGUE -> fully-satisfied walkthrough.
  perform api.create_employee(
    p_company_id := v_company, p_full_name := 'Func Principal',
    p_cpf_hash_b64 := encode(extensions.digest('cpf-d-04', 'sha256'), 'base64'),
    p_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-d-04'::bytea, 'base64'),
    p_cpf_masked := '***.004.004-**',
    p_position_id := (select id from fixture_ids where label = 'pos_main')
  );
  insert into fixture_ids select 'emp_main', id from app.employees where full_name = 'Func Principal' and company_id = v_company;

  -- emp_vencido: will hold an expired capacete (quantity present, but past due).
  perform api.create_employee(
    p_company_id := v_company, p_full_name := 'Func Vencido',
    p_cpf_hash_b64 := encode(extensions.digest('cpf-d-05', 'sha256'), 'base64'),
    p_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-d-05'::bytea, 'base64'),
    p_cpf_masked := '***.005.005-**',
    p_position_id := (select id from fixture_ids where label = 'pos_main')
  );
  insert into fixture_ids select 'emp_vencido', id from app.employees where full_name = 'Func Vencido' and company_id = v_company;

  -- emp_due_soon: capacete due inside the alert window.
  perform api.create_employee(
    p_company_id := v_company, p_full_name := 'Func Due Soon',
    p_cpf_hash_b64 := encode(extensions.digest('cpf-d-06', 'sha256'), 'base64'),
    p_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-d-06'::bytea, 'base64'),
    p_cpf_masked := '***.006.006-**',
    p_position_id := (select id from fixture_ids where label = 'pos_main')
  );
  insert into fixture_ids select 'emp_due_soon', id from app.employees where full_name = 'Func Due Soon' and company_id = v_company;

  -- emp_replace: drives the replacement-gap walkthrough.
  perform api.create_employee(
    p_company_id := v_company, p_full_name := 'Func Replace',
    p_cpf_hash_b64 := encode(extensions.digest('cpf-d-07', 'sha256'), 'base64'),
    p_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-d-07'::bytea, 'base64'),
    p_cpf_masked := '***.007.007-**',
    p_position_id := (select id from fixture_ids where label = 'pos_main')
  );
  insert into fixture_ids select 'emp_replace', id from app.employees where full_name = 'Func Replace' and company_id = v_company;

  -- emp_contest: drives the CONTESTED-never-satisfies walkthrough.
  perform api.create_employee(
    p_company_id := v_company, p_full_name := 'Func Contest',
    p_cpf_hash_b64 := encode(extensions.digest('cpf-d-08', 'sha256'), 'base64'),
    p_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-d-08'::bytea, 'base64'),
    p_cpf_masked := '***.008.008-**',
    p_position_id := (select id from fixture_ids where label = 'pos_main')
  );
  insert into fixture_ids select 'emp_contest', id from app.employees where full_name = 'Func Contest' and company_id = v_company;

  -- emp_percent: 1 of 4 required rows on pos_percent unsatisfied -> 75% (spec's own example).
  perform api.create_employee(
    p_company_id := v_company, p_full_name := 'Func Percent',
    p_cpf_hash_b64 := encode(extensions.digest('cpf-d-09', 'sha256'), 'base64'),
    p_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-d-09'::bytea, 'base64'),
    p_cpf_masked := '***.009.009-**',
    p_position_id := (select id from fixture_ids where label = 'pos_percent')
  );
  insert into fixture_ids select 'emp_percent', id from app.employees where full_name = 'Func Percent' and company_id = v_company;

  reset role;
end $$;

-- ===========================================================================================
-- 1. SEM_CARGO / INDETERMINADO
-- ===========================================================================================

set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}';

select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_sem_cargo'))),
  'SEM_CARGO',
  'an employee with no position_id shows SEM_CARGO in the per-requirement detail'
);
select is(
  (select aggregate_state from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_sem_cargo'))),
  'INDETERMINADO',
  'the aggregate for a cargo-less employee is INDETERMINADO, never CONFORME nor NÃO CONFORME'
);
select is(
  (select aggregate_reason from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_sem_cargo'))),
  'SEM_CARGO',
  'the reason is SEM_CARGO specifically'
);

-- ===========================================================================================
-- 2. MATRIZ_VAZIA / INDETERMINADO (distinct from SEM_CARGO and from SEM_REQUISITOS_OBRIGATORIOS)
-- ===========================================================================================

select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_matriz_vazia'))),
  'MATRIZ_VAZIA',
  'a position with zero matrix rows shows MATRIZ_VAZIA, not SEM_CARGO'
);
select is(
  (select aggregate_state from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_matriz_vazia'))),
  'INDETERMINADO',
  'MATRIZ_VAZIA also aggregates to INDETERMINADO'
);

-- ===========================================================================================
-- 3. SEM_REQUISITOS_OBRIGATORIOS / CONFORME (matrix HAS rows, all optional -- not indeterminado)
-- ===========================================================================================

select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_opcional'))),
  'OPCIONAL',
  'a required=false requirement computes as OPCIONAL, never NUNCA_ENTREGUE'
);
select is(
  (select aggregate_state from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_opcional'))),
  'CONFORME',
  'a matrix with rows but none required is CONFORME, not indeterminado -- this is the contradiction fixed before implementation'
);
select is(
  (select aggregate_reason from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_opcional'))),
  'SEM_REQUISITOS_OBRIGATORIOS',
  'reason distinguishes this from a genuinely empty matrix'
);
select is(
  (select compliance_percent from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_opcional'))),
  null,
  'percent is null (no required=true denominator), not a divide-by-zero or a fake 100%'
);

-- ===========================================================================================
-- 4. NUNCA_ENTREGUE (emp_main before any delivery) -> NAO_CONFORME
-- ===========================================================================================

select is(
  (select aggregate_state from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_main'))),
  'NAO_CONFORME',
  'an employee with a real matrix and zero deliveries is NÃO CONFORME'
);
select results_eq(
  $$ select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_main')) order by epi_name $$,
  $$ values ('NUNCA_ENTREGUE'::text), ('NUNCA_ENTREGUE'::text) $$,
  'both capacete and luva requirements are NUNCA_ENTREGUE (neither ever delivered)'
);

-- Deliver + confirm both requirements for emp_main: capacete qty=1, luva qty=2 (satisfies
-- the qty=2 requirement exactly, using the requirement's own periodicity_days=60 override
-- since the luva EPI itself has no default lifespan at all).
do $$
declare
  v_company uuid; v_employee uuid; v_delivery uuid;
begin
  select id into v_company from fixture_ids where label = 'company_p';
  select id into v_employee from fixture_ids where label = 'emp_main';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);

  select api.create_delivery(
    v_company, v_employee, current_date, null,
    jsonb_build_array(
      jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_capacete'), 'quantity', 1),
      jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_luva'), 'quantity', 2)
    )
  ) into v_delivery;
  perform api.issue_delivery(v_delivery);
  insert into fixture_ids values ('delivery_main', v_delivery);
  reset role;
end $$;

select set_config('app.transition_ok', (select id::text from fixture_ids where label = 'delivery_main'), true);
update app.epi_deliveries
set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = clock_timestamp(), frozen_at = clock_timestamp()
where id = (select id from fixture_ids where label = 'delivery_main');

select is(
  (select aggregate_state from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_main'))),
  'CONFORME',
  'once both requirements are satisfied with fresh stock, the employee is CONFORME'
);
select is(
  (select compliance_percent from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_main'))),
  100.0,
  'fully satisfied -> 100% (2 of 2 required rows OK)'
);
select results_eq(
  $$ select held_quantity, fresh_quantity from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_main'))
     where epi_id = (select id from fixture_ids where label = 'epi_luva') $$,
  $$ values (2, 2) $$,
  'luva quantity=2 requirement is satisfied by one delivery of quantity 2, using the requirement''s own periodicity_days override'
);

-- ===========================================================================================
-- 5. QUANTIDADE_INSUFICIENTE (emp_vencido gets only 1 of the required 2 luvas, held but short)
-- ===========================================================================================

do $$
declare
  v_company uuid; v_employee uuid; v_delivery uuid;
begin
  select id into v_company from fixture_ids where label = 'company_p';
  select id into v_employee from fixture_ids where label = 'emp_vencido';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);

  select api.create_delivery(
    v_company, v_employee, current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_luva'), 'quantity', 1))
  ) into v_delivery;
  perform api.issue_delivery(v_delivery);
  insert into fixture_ids values ('delivery_vencido_luva', v_delivery);
  reset role;
end $$;

select set_config('app.transition_ok', (select id::text from fixture_ids where label = 'delivery_vencido_luva'), true);
update app.epi_deliveries
set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = clock_timestamp(), frozen_at = clock_timestamp()
where id = (select id from fixture_ids where label = 'delivery_vencido_luva');

select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_vencido'))
   where epi_id = (select id from fixture_ids where label = 'epi_luva')),
  'QUANTIDADE_INSUFICIENTE',
  'held=1 against required=2, nothing expired -- insufficient quantity, not overdue'
);

-- ===========================================================================================
-- 6. ITEM_VENCIDO (emp_vencido's capacete: held enough, but expired)
-- ===========================================================================================

do $$
declare
  v_company uuid; v_employee uuid; v_delivery uuid;
begin
  select id into v_company from fixture_ids where label = 'company_p';
  select id into v_employee from fixture_ids where label = 'emp_vencido';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);

  select api.create_delivery(
    v_company, v_employee, current_date - 100, null,
    jsonb_build_array(jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_capacete'), 'quantity', 1))
  ) into v_delivery;
  perform api.issue_delivery(v_delivery);
  insert into fixture_ids values ('delivery_vencido_capacete', v_delivery);
  reset role;
end $$;

-- Backdated 100 days: 90-day lifespan means this is already 10 days overdue.
select set_config('app.transition_ok', (select id::text from fixture_ids where label = 'delivery_vencido_capacete'), true);
update app.epi_deliveries
set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = (current_date - 100)::timestamptz, frozen_at = clock_timestamp()
where id = (select id from fixture_ids where label = 'delivery_vencido_capacete');

select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_vencido'))
   where epi_id = (select id from fixture_ids where label = 'epi_capacete')),
  'ITEM_VENCIDO',
  'held=1 >= required=1, but the one held unit expired 10 days ago -- ITEM_VENCIDO, not NUNCA_ENTREGUE'
);
select is(
  (select aggregate_state from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_vencido'))),
  'NAO_CONFORME',
  'either shortfall alone (quantity or expiry) drags the aggregate to NÃO CONFORME'
);

-- ===========================================================================================
-- 7. PROXIMO_DA_TROCA (emp_due_soon: capacete due inside the org's 30-day alert window)
-- ===========================================================================================

do $$
declare
  v_company uuid; v_employee uuid; v_delivery uuid;
begin
  select id into v_company from fixture_ids where label = 'company_p';
  select id into v_employee from fixture_ids where label = 'emp_due_soon';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);

  select api.create_delivery(
    v_company, v_employee, current_date - 65, null,
    jsonb_build_array(
      jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_capacete'), 'quantity', 1),
      jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_luva'), 'quantity', 2)
    )
  ) into v_delivery;
  perform api.issue_delivery(v_delivery);
  insert into fixture_ids values ('delivery_due_soon', v_delivery);
  reset role;
end $$;

-- 90-day lifespan, confirmed 65 days ago -> due in 25 days, inside the default 30-day
-- replacement_alert_days window (first ATENÇÃO day is due_date - alert_days = day 60).
select set_config('app.transition_ok', (select id::text from fixture_ids where label = 'delivery_due_soon'), true);
update app.epi_deliveries
set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = (current_date - 65)::timestamptz, frozen_at = clock_timestamp()
where id = (select id from fixture_ids where label = 'delivery_due_soon');

select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_due_soon'))
   where epi_id = (select id from fixture_ids where label = 'epi_capacete')),
  'PROXIMO_DA_TROCA',
  'due in 25 days, inside the 30-day alert window -- PROXIMO_DA_TROCA, not yet ITEM_VENCIDO'
);
select is(
  (select aggregate_state from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_due_soon'))),
  'ATENCAO',
  'a due-soon requirement (with everything else satisfied) aggregates to ATENÇÃO, not NÃO CONFORME'
);
select is(
  (select earliest_due_date from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_due_soon'))
   where epi_id = (select id from fixture_ids where label = 'epi_capacete')),
  (current_date - 65) + 90,
  'the reported due date matches confirmed_at + effective_periodicity_days exactly'
);

-- ===========================================================================================
-- 8. Replacement gap: SUPERSEDED original + DRAFT replacement is a real, reported gap
-- ===========================================================================================

do $$
declare
  v_company uuid; v_employee uuid; v_delivery uuid;
begin
  select id into v_company from fixture_ids where label = 'company_p';
  select id into v_employee from fixture_ids where label = 'emp_replace';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);

  select api.create_delivery(
    v_company, v_employee, current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_capacete'), 'quantity', 1))
  ) into v_delivery;
  perform api.issue_delivery(v_delivery);
  insert into fixture_ids values ('delivery_replace_orig', v_delivery);
  reset role;
end $$;

select set_config('app.transition_ok', (select id::text from fixture_ids where label = 'delivery_replace_orig'), true);
update app.epi_deliveries
set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = clock_timestamp(), frozen_at = clock_timestamp()
where id = (select id from fixture_ids where label = 'delivery_replace_orig');

select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_replace'))
   where epi_id = (select id from fixture_ids where label = 'epi_capacete')),
  'OK',
  'before any troca, the confirmed capacete satisfies the requirement'
);

do $$
declare v_new_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);
  select api.create_replacement_delivery(
    (select id from fixture_ids where label = 'delivery_replace_orig'),
    jsonb_build_array(jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_capacete'), 'quantity', 1)),
    current_date, null, 'WEAR', null, false
  ) into v_new_id;
  insert into fixture_ids values ('delivery_replace_new', v_new_id);
  reset role;
end $$;

select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_replace'))
   where epi_id = (select id from fixture_ids where label = 'epi_capacete')),
  'NUNCA_ENTREGUE',
  'original SUPERSEDED, replacement still DRAFT -- a real gap, not a bug: no CONFIRMED delivery covers this requirement right now'
);
select is(
  (select aggregate_state from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_replace'))),
  'NAO_CONFORME',
  'the gap is reflected in the aggregate too, exactly as an unconfirmed replacement must never count as valid protection'
);

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);
  perform api.issue_delivery((select id from fixture_ids where label = 'delivery_replace_new'));
  reset role;
end $$;

select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_replace'))
   where epi_id = (select id from fixture_ids where label = 'epi_capacete')),
  'NUNCA_ENTREGUE',
  'ISSUED (link sent, awaiting worker confirmation) still does not count -- same as DRAFT'
);

select set_config('app.transition_ok', (select id::text from fixture_ids where label = 'delivery_replace_new'), true);
update app.epi_deliveries
set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = clock_timestamp(), frozen_at = clock_timestamp()
where id = (select id from fixture_ids where label = 'delivery_replace_new');

select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_replace'))
   where epi_id = (select id from fixture_ids where label = 'epi_capacete')),
  'OK',
  'once the replacement itself reaches CONFIRMED, the requirement is satisfied again, from its own fresh confirmed_at'
);

-- ===========================================================================================
-- 9. CONTESTED never satisfies a requirement, even after resolve_contest (no reissue in D)
-- ===========================================================================================

do $$
declare
  v_company uuid; v_employee uuid; v_delivery uuid; v_confirmation_request uuid; v_contest uuid;
begin
  select id into v_company from fixture_ids where label = 'company_p';
  select id into v_employee from fixture_ids where label = 'emp_contest';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);

  select api.create_delivery(
    v_company, v_employee, current_date, null,
    jsonb_build_array(jsonb_build_object('epi_id', (select id from fixture_ids where label = 'epi_capacete'), 'quantity', 1))
  ) into v_delivery;
  perform api.issue_delivery(v_delivery);
  insert into fixture_ids values ('delivery_contest', v_delivery);

  -- A real confirmation_requests + delivery_contests row (not a bare status flip) -- so
  -- api.resolve_contest, the actual product RPC, is what gets exercised below, not a fixture
  -- shortcut standing in for it.
  insert into app.confirmation_requests (
    organization_id, company_id, delivery_id, token_hash, status, required_assurance_level,
    achieved_assurance_level, action_nonce, contested_at, frozen_at, expires_at
  ) values (
    (select organization_id from app.companies where id = v_company), v_company, v_delivery,
    extensions.digest('contest-token-fixture', 'sha256'), 'CONTESTED', 'AL1_LINK_KNOWLEDGE',
    'AL1_LINK_KNOWLEDGE', extensions.digest('contest-nonce-fixture', 'sha256'),
    clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '7 days'
  ) returning id into v_confirmation_request;
  insert into fixture_ids values ('confirmation_request_contest', v_confirmation_request);

  insert into app.delivery_contests (
    organization_id, company_id, delivery_id, confirmation_request_id, reason_code, raised_assurance_level
  ) values (
    (select organization_id from app.companies where id = v_company), v_company, v_delivery,
    v_confirmation_request, 'NOT_RECEIVED', 'AL1_LINK_KNOWLEDGE'
  ) returning id into v_contest;
  insert into fixture_ids values ('contest_id', v_contest);

  reset role;
end $$;

select set_config('app.transition_ok', (select id::text from fixture_ids where label = 'delivery_contest'), true);
update app.epi_deliveries
set status = 'CONTESTED', last_event = 'REQUEST_CONTESTED', contested_at = clock_timestamp(), frozen_at = clock_timestamp()
where id = (select id from fixture_ids where label = 'delivery_contest');

select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_contest'))
   where epi_id = (select id from fixture_ids where label = 'epi_capacete')),
  'NUNCA_ENTREGUE',
  'a CONTESTED delivery never satisfies the requirement it would have covered'
);

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}', true);
  perform api.resolve_contest((select id from fixture_ids where label = 'contest_id'), 'Verificado com o gestor da obra, item nunca chegou.');
  reset role;
end $$;

select is(
  (select status::text from app.epi_deliveries where id = (select id from fixture_ids where label = 'delivery_contest')),
  'CONTESTED',
  'resolve_contest does not change delivery status -- confirmed against the RPC''s own source'
);
select is(
  (select state from api.employee_compliance_detail((select id from fixture_ids where label = 'emp_contest'))
   where epi_id = (select id from fixture_ids where label = 'epi_capacete')),
  'NUNCA_ENTREGUE',
  'resolving the contest does not restore compliance -- the requirement is still unmet until a real CONFIRMED delivery exists (no reissue in Phase D)'
);

reset role;

-- ===========================================================================================
-- 10. Percent formula (spec''s own "75%" example: 3 of 4 required rows OK)
-- ===========================================================================================

set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddd01","role":"authenticated"}';

select is(
  (select compliance_percent from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_percent'))),
  0.0,
  'pos_percent has exactly 1 required row (capacete), never delivered -- 0 of 1 -- 0%'
);
select is(
  (select required_total from api.employee_compliance_summary((select id from fixture_ids where label = 'emp_percent'))),
  1,
  'required_total counts only required=true rows'
);

reset role;

-- ===========================================================================================
-- 11. Feature flag: tenant Q never enabled compliance_enabled
-- ===========================================================================================

do $$
declare v_company uuid; v_employee uuid;
begin
  select id into v_company from fixture_ids where label = 'company_q';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01","role":"authenticated"}', true);
  perform api.create_employee(
    p_company_id := v_company, p_full_name := 'Func Tenant Q',
    p_cpf_hash_b64 := encode(extensions.digest('cpf-d-10', 'sha256'), 'base64'),
    p_cpf_enc_b64 := encode(decode(repeat('00', 28), 'hex') || 'fake-d-10'::bytea, 'base64'),
    p_cpf_masked := '***.010.010-**'
  );
  insert into fixture_ids select 'emp_q', id from app.employees where full_name = 'Func Tenant Q' and company_id = v_company;
  reset role;
end $$;

select throws_ok(
  format(
    $$ select api.employee_compliance_detail(%L) $$,
    (select id from fixture_ids where label = 'emp_q')
  ),
  '23514', 'feature_disabled',
  'compliance_enabled=false raises feature_disabled -- never a fabricated compliance state'
);
select throws_ok(
  format($$ select api.company_compliance_summary(%L) $$, (select id from fixture_ids where label = 'company_q')),
  '23514', 'feature_disabled',
  'the company-wide summary is gated by the same flag'
);

-- ===========================================================================================
-- 12. Cross-tenant: tenant Q must never read tenant P's compliance data
-- ===========================================================================================

set local role authenticated;
set local request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01","role":"authenticated"}';

select throws_ok(
  format($$ select api.employee_compliance_detail(%L) $$, (select id from fixture_ids where label = 'emp_main')),
  '42501', NULL,
  'tenant Q cannot read tenant P''s employee compliance detail (insufficient_privilege -- no membership at all for tenant P''s company)'
);
select throws_ok(
  format($$ select api.employee_compliance_summary(%L) $$, (select id from fixture_ids where label = 'emp_main')),
  '42501', NULL,
  'same isolation on the per-employee summary'
);
select throws_ok(
  format($$ select api.company_compliance_summary(%L) $$, (select id from fixture_ids where label = 'company_p')),
  '42501', NULL,
  'tenant Q cannot read tenant P''s company-wide compliance summary'
);

reset role;

select * from finish();

rollback;
