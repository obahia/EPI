-- FASE 1: employee create/update/import RPCs.
--
-- CPF hash/ciphertext parameters are accepted as base64 TEXT, not `bytea` directly: a
-- PostgREST JSON-RPC call would have to send Postgres's own hex-text bytea format
-- (`\x...`) to bind a bytea parameter correctly, which is a needless coupling to a
-- Postgres-internal wire detail. Every RPC below takes `_b64` text parameters and decodes
-- with `decode(x, 'base64')` -- simple, unambiguous, and exactly what
-- src/lib/crypto/cpf-secrets.ts already emits (Buffer -> base64 string).

create function api.create_employee(
  p_company_id uuid,
  p_full_name text,
  p_cpf_hash_b64 text,
  p_cpf_enc_b64 text,
  p_cpf_masked text,
  p_registration_number text default null,
  p_phone_e164 text default null,
  p_email text default null,
  p_position_title text default null,
  p_department text default null,
  p_data_origin app.data_origin default 'MANUAL',
  p_external_source text default null,
  p_external_ref text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_employee_id uuid;
begin
  if not (select auth_ctx.has_permission(p_company_id, 'employee.create')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select organization_id into v_org_id from app.companies where id = p_company_id;

  insert into app.employees (
    organization_id, company_id, full_name, cpf_hash, cpf_enc, cpf_masked,
    registration_number, phone_e164, email, position_title, department,
    data_origin, external_source, external_ref, created_by
  ) values (
    v_org_id, p_company_id, p_full_name,
    decode(p_cpf_hash_b64, 'base64'), decode(p_cpf_enc_b64, 'base64'), p_cpf_masked,
    p_registration_number, p_phone_e164, p_email, p_position_title, p_department,
    p_data_origin, p_external_source, p_external_ref, (select auth.uid())
  )
  returning id into v_employee_id;

  return v_employee_id;
exception
  when unique_violation then
    raise exception 'cpf_already_registered' using errcode = '23505';
end;
$$;

comment on function api.create_employee(uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text) is
  'Manual (or import-row) employee creation. Never accepts a raw CPF -- caller must already have computed cpf_hash/cpf_enc/cpf_masked (src/lib/crypto/cpf-secrets.ts, src/lib/br/cpf.ts) before calling.';

revoke execute on function api.create_employee(uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text) from public, anon;
grant execute on function api.create_employee(uuid, text, text, text, text, text, text, text, text, text, app.data_origin, text, text) to authenticated;

create function api.update_employee(
  p_employee_id uuid,
  p_full_name text,
  p_registration_number text,
  p_phone_e164 text,
  p_email text,
  p_position_title text,
  p_department text,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id from app.employees where id = p_employee_id and archived_at is null;
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if not (select auth_ctx.has_permission(v_company_id, 'employee.update')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  update app.employees set
    full_name = p_full_name,
    registration_number = p_registration_number,
    phone_e164 = p_phone_e164,
    email = p_email,
    position_title = p_position_title,
    department = p_department,
    status = p_status,
    terminated_on = case when p_status = 'TERMINATED' then coalesce(terminated_on, current_date) else null end
  where id = p_employee_id;
end;
$$;

comment on function api.update_employee(uuid, text, text, text, text, text, text, text) is
  'Updates editable employee fields. CPF (hash/enc/masked) is never editable through this RPC -- a CPF correction is a deliberately separate, rarer operation not built in FASE 1.';

revoke execute on function api.update_employee(uuid, text, text, text, text, text, text, text) from public, anon;
grant execute on function api.update_employee(uuid, text, text, text, text, text, text, text) to authenticated;

-- Bulk commit for the CSV import flow (docs/architecture.md §6.4 / mvp-roadmap.md FASE 1).
-- Takes an ALREADY VALIDATED jsonb array -- parsing, column mapping, CPF/phone validation
-- and per-row hashing all happen client/server-side in Next.js before this is called. One
-- statement, one transaction: either the whole batch commits or none of it does. Rows
-- whose (company_id, cpf_hash) already exists are UPDATED (idempotent re-import), not
-- duplicated or rejected -- matches the "upload -> preview -> map -> validate -> confirm"
-- flow allowing a corrected re-upload of the same file.
create function api.import_employees_commit(p_company_id uuid, p_rows jsonb)
returns table (created_count int, updated_count int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_created int;
  v_updated int;
begin
  if not (select auth_ctx.has_permission(p_company_id, 'employee.import')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if jsonb_array_length(p_rows) > 20000 then
    raise exception 'batch_too_large' using errcode = '54000';
  end if;

  select organization_id into v_org_id from app.companies where id = p_company_id;

  with incoming as (
    select
      r.full_name,
      decode(r.cpf_hash_b64, 'base64') as cpf_hash,
      decode(r.cpf_enc_b64, 'base64') as cpf_enc,
      r.cpf_masked,
      r.registration_number,
      r.phone_e164,
      r.email,
      r.position_title,
      r.department
    from jsonb_to_recordset(p_rows) as r(
      full_name text, cpf_hash_b64 text, cpf_enc_b64 text, cpf_masked text,
      registration_number text, phone_e164 text, email text,
      position_title text, department text
    )
  ),
  ins as (
    insert into app.employees (
      organization_id, company_id, full_name, cpf_hash, cpf_enc, cpf_masked,
      registration_number, phone_e164, email, position_title, department,
      data_origin, created_by
    )
    select
      v_org_id, p_company_id, i.full_name, i.cpf_hash, i.cpf_enc, i.cpf_masked,
      i.registration_number, i.phone_e164, i.email, i.position_title, i.department,
      'IMPORT', (select auth.uid())
    from incoming i
    on conflict (company_id, cpf_hash) where archived_at is null
    do update set
      full_name = excluded.full_name,
      cpf_enc = excluded.cpf_enc,
      cpf_masked = excluded.cpf_masked,
      registration_number = excluded.registration_number,
      phone_e164 = excluded.phone_e164,
      email = excluded.email,
      position_title = excluded.position_title,
      department = excluded.department
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert),
    count(*) filter (where not was_insert)
  into v_created, v_updated
  from ins;

  return query select v_created, v_updated;
end;
$$;

comment on function api.import_employees_commit(uuid, jsonb) is
  'Set-based bulk upsert for CSV import, one statement/transaction. Hard cap 20,000 rows per call -- see docs/mvp-roadmap.md FASE 1; the UI must chunk or reject larger files with an honest message, never truncate silently. xmax=0 is the standard Postgres idiom to distinguish an INSERT from an ON CONFLICT UPDATE in the same RETURNING clause.';

revoke execute on function api.import_employees_commit(uuid, jsonb) from public, anon;
grant execute on function api.import_employees_commit(uuid, jsonb) to authenticated;
