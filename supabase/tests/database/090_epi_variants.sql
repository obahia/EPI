-- Phase A: EPI variants/SKUs. Covers (1) tenant isolation, (2) the composite FK rejecting a
-- variant attached to the wrong EPI (via api.create_delivery's item-count guard, the same
-- path a real caller would hit), (3) variant_label correctly snapshotted onto the delivery
-- item, (4) unique label per EPI.

create extension if not exists pgtap with schema extensions;

begin;

select plan(7);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '77777777-7777-7777-7777-777777777701',
   'authenticated', 'authenticated', 'admin-g@tenant-g.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin G"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '88888888-8888-8888-8888-888888888801',
   'authenticated', 'authenticated', 'admin-h@tenant-h.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Admin H"}', now(), now(), '', '', '', '', false, false);

create temporary table fixture_ids (label text primary key, id uuid not null);
grant all on fixture_ids to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777701","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant G LTDA', '11222333000381', 'Tenant G LTDA', '11222333000381', null);
  insert into fixture_ids values ('company_g', v_company_id);
  reset role;
end $$;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888801","role":"authenticated"}', true);
  select company_id into v_company_id from api.onboard_organization('Tenant H LTDA', '22333444000398', 'Tenant H LTDA', '22333444000398', null);
  insert into fixture_ids values ('company_h', v_company_id);
  reset role;
end $$;

-- Tenant G: two EPIs, each with one variant, plus an employee to deliver to.
do $$
declare
  v_company_g uuid; v_org_g uuid;
  v_epi_boot uuid; v_epi_glove uuid;
  v_variant_boot uuid; v_variant_glove uuid;
  v_employee_id uuid;
  v_cpf_hash_b64 text; v_cpf_enc_b64 text;
begin
  select id into v_company_g from fixture_ids where label = 'company_g';
  v_org_g := (select organization_id from app.companies where id = v_company_g);

  -- Computed BEFORE the role switch: `authenticated` has no USAGE on the `extensions`
  -- schema (by design), so evaluating extensions.digest() as an argument expression AFTER
  -- `set local role authenticated` fails with "permission denied for schema extensions" --
  -- the same class of bug documented in 020_employee_isolation.sql's fixture comment.
  v_cpf_hash_b64 := encode(extensions.digest('cpf-g', 'sha256'), 'base64');
  v_cpf_enc_b64 := encode(decode('000000000000000000000000000000000000000000000000000000', 'hex') || 'fake-g'::bytea, 'base64');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777701","role":"authenticated"}', true);

  select api.create_epi(v_org_g, v_company_g, 'Botina', '11111') into v_epi_boot;
  select api.create_epi(v_org_g, v_company_g, 'Luva', '22222') into v_epi_glove;
  insert into fixture_ids values ('epi_boot', v_epi_boot), ('epi_glove', v_epi_glove);

  select api.create_epi_variant(v_epi_boot, '42', null, '{}') into v_variant_boot;
  select api.create_epi_variant(v_epi_glove, 'GG', null, '{}') into v_variant_glove;
  insert into fixture_ids values ('variant_boot_42', v_variant_boot), ('variant_glove_gg', v_variant_glove);

  select api.create_employee(
    v_company_g, 'Funcionário Tenant G',
    v_cpf_hash_b64, v_cpf_enc_b64,
    '***.333.333-**'
  ) into v_employee_id;
  insert into fixture_ids values ('employee_g', v_employee_id);

  reset role;
end $$;

select ok(
  (select count(*) = 5 from fixture_ids where label like 'epi_%' or label like 'variant_%' or label = 'employee_g'),
  'tenant G created two EPIs, one variant each, and an employee'
);

-- Isolation: tenant H must see zero of tenant G's variants.
set local role authenticated;
set local request.jwt.claims = '{"sub":"88888888-8888-8888-8888-888888888801","role":"authenticated"}';

select is(
  (select count(*)::int from api.epi_variants),
  0,
  'tenant H sees zero epi_variants -- tenant G''s are invisible'
);

reset role;

-- The composite FK rejects a variant attached to the WRONG epi: this line item's epi_id is
-- Botina but variant_id points at the Luva-GG variant. api.create_delivery's item-count
-- guard (the LEFT JOIN in `resolved` only matches a variant to its own epi_id) must fail the
-- whole call rather than silently drop or reassign the mismatched item.
set local role authenticated;
set local request.jwt.claims = '{"sub":"77777777-7777-7777-7777-777777777701","role":"authenticated"}';

select throws_ok(
  format(
    $$ select api.create_delivery(
         %L, %L, current_date, null,
         jsonb_build_array(jsonb_build_object(
           'epi_id', %L, 'quantity', 1, 'variant_id', %L
         ))
       ) $$,
    (select id from fixture_ids where label = 'company_g'),
    (select id from fixture_ids where label = 'employee_g'),
    (select id from fixture_ids where label = 'epi_boot'),
    (select id from fixture_ids where label = 'variant_glove_gg')
  ),
  '23514',
  NULL,
  'a variant_id belonging to a DIFFERENT epi makes the whole create_delivery call fail (one_or_more_items_invalid), never silently reassigned'
);

-- The correctly-matched case: variant_label is snapshotted onto the delivery item.
do $$
declare v_delivery_id uuid;
begin
  select api.create_delivery(
    (select id from fixture_ids where label = 'company_g'),
    (select id from fixture_ids where label = 'employee_g'),
    current_date, null,
    jsonb_build_array(jsonb_build_object(
      'epi_id', (select id from fixture_ids where label = 'epi_boot'),
      'quantity', 1,
      'variant_id', (select id from fixture_ids where label = 'variant_boot_42')
    ))
  ) into v_delivery_id;
  insert into fixture_ids values ('delivery_g', v_delivery_id);
end $$;

select results_eq(
  $$ select variant_label from api.epi_delivery_items
     where delivery_id = (select id from fixture_ids where label = 'delivery_g') $$,
  $$ values ('42'::text) $$,
  'the correctly-matched variant''s label ("42") is snapshotted onto the delivery item'
);

reset role;

-- Unique label per EPI: a second "42" under the SAME epi is rejected.
set local role authenticated;
set local request.jwt.claims = '{"sub":"77777777-7777-7777-7777-777777777701","role":"authenticated"}';

select throws_ok(
  format(
    $$ select api.create_epi_variant(%L, '42', null, '{}') $$,
    (select id from fixture_ids where label = 'epi_boot')
  ),
  '23505',
  NULL,
  'a duplicate variant label under the same epi is rejected (variant_label_already_exists)'
);

reset role;

-- Ground truth: exactly the two variants created up front exist, and exactly one delivery
-- item was ever persisted (the mismatched-variant attempt above never left a row).
select is((select count(*)::int from app.epi_variants), 2, 'exactly 2 variants exist in total');
select is((select count(*)::int from app.epi_delivery_items), 1, 'exactly 1 delivery item exists -- the mismatched-variant attempt never persisted');

select * from finish();

rollback;
