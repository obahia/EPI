-- Phase F: the machine authorization gate, and the read half of /api/v1.
--
-- Every m2m_rpc function begins with m2m.authorize(). It never reads auth.uid(), never
-- calls auth_ctx.company_ids/organization_ids/has_permission, and never touches worker.*.
-- The database credential the route handler uses (service_role) authorizes NOTHING on its
-- own: without valid key material these functions refuse every call.

create type m2m.auth_result as (
  principal_id    uuid,
  organization_id uuid,
  api_key_id      uuid,
  company_ids     uuid[]
);

create function m2m.authorize(
  p_key_id text,
  p_secret_hash_b64 text,
  p_scope m2m.api_scope,
  p_company_id uuid default null,
  p_client_ip inet default null
)
returns m2m.auth_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_out m2m.auth_result;
begin
  select * into r from m2m.resolve_principal(p_key_id, p_secret_hash_b64);

  -- One indistinguishable failure for every authentication problem: unknown key, wrong
  -- secret, revoked key, expired key, revoked principal. Telling them apart would turn
  -- key_id into an enumeration oracle.
  if r.principal_id is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- Scope is checked BEFORE any entity is read, so an under-scoped key cannot learn
  -- whether a given id exists.
  if not (p_scope = any (r.scopes)) then
    raise exception 'insufficient_scope' using errcode = '42501';
  end if;

  v_out.principal_id := r.principal_id;
  v_out.organization_id := r.organization_id;
  v_out.api_key_id := r.api_key_id;
  v_out.company_ids := r.company_ids;

  if p_company_id is not null then
    perform m2m.assert_company(v_out, p_company_id);
  end if;

  -- Best-effort usage stamp, throttled to at most one write per key per minute so a read
  -- endpoint does not turn into a write on every request, and so concurrent calls with the
  -- same key do not serialise on this row.
  update m2m.api_keys
     set last_used_at = now(),
         last_used_ip = coalesce(p_client_ip, last_used_ip)
   where id = r.api_key_id
     and (last_used_at is null or last_used_at < now() - interval '1 minute');

  return v_out;
end;
$$;

comment on function m2m.authorize(text, text, m2m.api_scope, uuid, inet) is
  'The single authorization entry point for every machine call. Resolves the principal from key material, enforces the scope, then the organization/company binding -- in that order, so nothing about a resource leaks before the caller has earned the right to ask about it.';

revoke all on function m2m.authorize(text, text, m2m.api_scope, uuid, inet) from public, anon, authenticated, service_role;

-- Split out so an endpoint that must resolve the company from the entity (get-by-id) can
-- re-check the binding without paying for a second key resolution -- and, more importantly,
-- without a second best-effort write to api_keys.
create function m2m.assert_company(p_auth m2m.auth_result, p_company_id uuid)
returns void
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not exists (
    select 1 from app.companies c
    where c.id = p_company_id
      and c.organization_id = p_auth.organization_id
      and c.archived_at is null
  ) then
    raise exception 'tenant_forbidden' using errcode = '42501';
  end if;

  if p_auth.company_ids is not null and not (p_company_id = any (p_auth.company_ids)) then
    raise exception 'tenant_forbidden' using errcode = '42501';
  end if;
end;
$$;

revoke all on function m2m.assert_company(m2m.auth_result, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- Cursor pagination
-- ---------------------------------------------------------------------------------------
-- Keyset on (created_at, id), never OFFSET: OFFSET leaks total counts through timing and
-- degrades with table size. The cursor is NOT a security boundary and is not signed -- it
-- only says "resume here". Tenant safety comes from the WHERE clause, which is derived from
-- the authorized principal, so a cursor lifted from another tenant selects nothing of
-- theirs; it can only move the window within data the caller was already entitled to.
create function m2m.decode_cursor(p_cursor text, out c_created_at timestamptz, out c_id uuid)
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_cursor is null or btrim(p_cursor) = '' then
    c_created_at := null;
    c_id := null;
    return;
  end if;
  c_created_at := split_part(p_cursor, '|', 1)::timestamptz;
  c_id := split_part(p_cursor, '|', 2)::uuid;
exception when others then
  raise exception 'invalid_cursor' using errcode = '22P02';
end;
$$;

revoke all on function m2m.decode_cursor(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- GET /api/v1/employees
-- ---------------------------------------------------------------------------------------
create function m2m_rpc.list_employees(
  p_key_id text,
  p_secret_hash_b64 text,
  p_company_id uuid,
  p_cursor text default null,
  p_limit int default 50,
  p_updated_since timestamptz default null,
  p_status text default null,
  p_client_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth m2m.auth_result;
  v_limit int;
  v_cur record;
  v_rows jsonb;
  v_next text;
begin
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, 'employees:read', p_company_id, p_client_ip);
  v_limit := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_cur := m2m.decode_cursor(p_cursor);

  with page as (
    select e.*
      from app.employees e
     where e.company_id = p_company_id
       and e.archived_at is null
       and (p_status is null or e.status = p_status)
       and (p_updated_since is null or e.updated_at >= p_updated_since)
       and (v_cur.c_created_at is null
            or (e.created_at, e.id) > (v_cur.c_created_at, v_cur.c_id))
     order by e.created_at, e.id
     limit v_limit
  ),
  ordered as (
    select p.*,
           row_number() over (order by p.created_at, p.id) as rn,
           count(*) over () as total
      from page p
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id,
           'company_id', o.company_id,
           'full_name', o.full_name,
           'cpf_masked', o.cpf_masked,
           'registration_number', o.registration_number,
           'phone_e164', o.phone_e164,
           'email', o.email::text,
           'position_id', o.position_id,
           'position_title', o.position_title,
           'location_id', o.location_id,
           'department', o.department,
           'status', o.status,
           'data_origin', o.data_origin,
           'external_source', o.external_source,
           'external_ref', o.external_ref,
           'created_at', o.created_at,
           'updated_at', o.updated_at
         ) order by o.rn), '[]'::jsonb),
         max(case when o.rn = o.total then o.created_at::text || '|' || o.id::text end)
    into v_rows, v_next
    from ordered o;

  return jsonb_build_object(
    'data', v_rows,
    'next_cursor', case when jsonb_array_length(v_rows) < v_limit then null else v_next end
  );
end;
$$;

revoke all on function m2m_rpc.list_employees(text, text, uuid, text, int, timestamptz, text, inet) from public, anon, authenticated;
grant execute on function m2m_rpc.list_employees(text, text, uuid, text, int, timestamptz, text, inet) to service_role;

-- ---------------------------------------------------------------------------------------
-- GET /api/v1/employees/{id}
-- ---------------------------------------------------------------------------------------
create function m2m_rpc.get_employee(
  p_key_id text,
  p_secret_hash_b64 text,
  p_employee_id uuid,
  p_client_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth m2m.auth_result;
  v_company_id uuid;
  v_row jsonb;
begin
  -- Scope first, with no company binding yet: nothing has been read, so nothing can leak.
  -- The company is then resolved server-side from the entity and re-checked.
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, 'employees:read', null, p_client_ip);

  select e.company_id into v_company_id
    from app.employees e
   where e.id = p_employee_id and e.archived_at is null
     and e.organization_id = v_auth.organization_id;

  -- Absent and out-of-tenant give the same answer, deliberately: distinguishing them would
  -- confirm the existence of another tenant's record.
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  perform m2m.assert_company(v_auth, v_company_id);

  select jsonb_build_object(
           'id', e.id, 'company_id', e.company_id, 'full_name', e.full_name,
           'cpf_masked', e.cpf_masked, 'registration_number', e.registration_number,
           'phone_e164', e.phone_e164, 'email', e.email::text,
           'position_id', e.position_id, 'position_title', e.position_title,
           'location_id', e.location_id, 'department', e.department,
           'status', e.status, 'data_origin', e.data_origin,
           'external_source', e.external_source, 'external_ref', e.external_ref,
           'created_at', e.created_at, 'updated_at', e.updated_at)
    into v_row
    from app.employees e where e.id = p_employee_id;

  return v_row;
end;
$$;

revoke all on function m2m_rpc.get_employee(text, text, uuid, inet) from public, anon, authenticated;
grant execute on function m2m_rpc.get_employee(text, text, uuid, inet) to service_role;

-- ---------------------------------------------------------------------------------------
-- GET /api/v1/positions -- also a hard dependency of employees:write, since a client
-- cannot send a position_id it has no way to discover.
-- ---------------------------------------------------------------------------------------
create function m2m_rpc.list_positions(
  p_key_id text,
  p_secret_hash_b64 text,
  p_company_id uuid default null,
  p_limit int default 100,
  p_client_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth m2m.auth_result;
  v_limit int;
  v_rows jsonb;
begin
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, 'positions:read', p_company_id, p_client_ip);
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 200);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', j.id, 'title', j.title, 'description', j.description,
           'company_id', j.company_id, 'status', j.status, 'created_at', j.created_at
         ) order by j.title), '[]'::jsonb)
    into v_rows
    from (
      select jp.id, jp.title, jp.description, jp.company_id, jp.status, jp.created_at
        from app.job_positions jp
       where jp.organization_id = v_auth.organization_id
         and (p_company_id is null or jp.company_id is null or jp.company_id = p_company_id)
       order by jp.title
       limit v_limit
    ) j;

  return jsonb_build_object('data', v_rows, 'next_cursor', null);
end;
$$;

revoke all on function m2m_rpc.list_positions(text, text, uuid, int, inet) from public, anon, authenticated;
grant execute on function m2m_rpc.list_positions(text, text, uuid, int, inet) to service_role;

-- ---------------------------------------------------------------------------------------
-- GET /api/v1/locations -- included ONLY as a dependency of employees:write (location_id).
-- Not in the spec's §19 list; if employees:write is ever withdrawn, this goes with it.
-- ---------------------------------------------------------------------------------------
create function m2m_rpc.list_locations(
  p_key_id text,
  p_secret_hash_b64 text,
  p_company_id uuid,
  p_limit int default 100,
  p_client_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth m2m.auth_result;
  v_limit int;
  v_rows jsonb;
begin
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, 'locations:read', p_company_id, p_client_ip);
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 200);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'name', l.name, 'code', l.code,
           'company_id', l.company_id, 'status', l.status, 'created_at', l.created_at
         ) order by l.name), '[]'::jsonb)
    into v_rows
    from (
      select lo.id, lo.name, lo.code, lo.company_id, lo.status, lo.created_at
        from app.locations lo
       where lo.company_id = p_company_id
       order by lo.name
       limit v_limit
    ) l;

  return jsonb_build_object('data', v_rows, 'next_cursor', null);
end;
$$;

revoke all on function m2m_rpc.list_locations(text, text, uuid, int, inet) from public, anon, authenticated;
grant execute on function m2m_rpc.list_locations(text, text, uuid, int, inet) to service_role;

-- ---------------------------------------------------------------------------------------
-- GET /api/v1/epis -- current catalog version only. The SCD2 history is not exposed:
-- nobody asked for it, and §19 is explicit about not publishing what is merely easy.
-- ---------------------------------------------------------------------------------------
create function m2m_rpc.list_epis(
  p_key_id text,
  p_secret_hash_b64 text,
  p_company_id uuid default null,
  p_limit int default 100,
  p_client_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth m2m.auth_result;
  v_limit int;
  v_rows jsonb;
begin
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, 'epis:read', p_company_id, p_client_ip);
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 200);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.epi_id, 'company_id', x.company_id, 'name', x.name,
           'ca_number', x.ca_number, 'manufacturer', x.manufacturer, 'model', x.model,
           'unit', x.default_unit, 'default_lifespan_days', x.default_lifespan_days
         ) order by x.name), '[]'::jsonb)
    into v_rows
    from (
      select e.id as epi_id, e.company_id, v.name, v.ca_number, v.manufacturer, v.model,
             v.default_unit, v.default_lifespan_days
        from app.epis e
        join app.epi_versions v on v.epi_id = e.id and v.valid_to is null
       where e.organization_id = v_auth.organization_id
         and (p_company_id is null or e.company_id is null or e.company_id = p_company_id)
       order by v.name
       limit v_limit
    ) x;

  return jsonb_build_object('data', v_rows, 'next_cursor', null);
end;
$$;

revoke all on function m2m_rpc.list_epis(text, text, uuid, int, inet) from public, anon, authenticated;
grant execute on function m2m_rpc.list_epis(text, text, uuid, int, inet) to service_role;

-- ---------------------------------------------------------------------------------------
-- GET /api/v1/deliveries -- never exposes evidence. No canonical_bytes, no payload hash,
-- no signature, no factors: those live behind the worker path and the panel, and an API key
-- must never be able to read or influence them.
-- ---------------------------------------------------------------------------------------
create function m2m_rpc.list_deliveries(
  p_key_id text,
  p_secret_hash_b64 text,
  p_company_id uuid,
  p_employee_id uuid default null,
  p_status text default null,
  p_since timestamptz default null,
  p_cursor text default null,
  p_limit int default 50,
  p_client_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth m2m.auth_result;
  v_limit int;
  v_cur record;
  v_rows jsonb;
  v_next text;
begin
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, 'deliveries:read', p_company_id, p_client_ip);
  v_limit := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_cur := m2m.decode_cursor(p_cursor);

  with page as (
    select d.*
      from app.epi_deliveries d
     where d.company_id = p_company_id
       and (p_employee_id is null or d.employee_id = p_employee_id)
       and (p_status is null or d.status = p_status)
       and (p_since is null or d.created_at >= p_since)
       and (v_cur.c_created_at is null
            or (d.created_at, d.id) > (v_cur.c_created_at, v_cur.c_id))
     order by d.created_at, d.id
     limit v_limit
  ),
  ordered as (
    select p.*,
           row_number() over (order by p.created_at, p.id) as rn,
           count(*) over () as total
      from page p
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id,
           'company_id', o.company_id,
           'employee_id', o.employee_id,
           'status', o.status,
           'delivery_date', o.delivery_date,
           'reason_code', o.reason_code,
           'batch_id', o.batch_id,
           'chain_id', o.chain_id,
           'chain_version', o.chain_version,
           'created_at', o.created_at
         ) order by o.rn), '[]'::jsonb),
         max(case when o.rn = o.total then o.created_at::text || '|' || o.id::text end)
    into v_rows, v_next
    from ordered o;

  return jsonb_build_object(
    'data', v_rows,
    'next_cursor', case when jsonb_array_length(v_rows) < v_limit then null else v_next end
  );
end;
$$;

revoke all on function m2m_rpc.list_deliveries(text, text, uuid, uuid, text, timestamptz, text, int, inet) from public, anon, authenticated;
grant execute on function m2m_rpc.list_deliveries(text, text, uuid, uuid, text, timestamptz, text, int, inet) to service_role;

create function m2m_rpc.get_delivery(
  p_key_id text,
  p_secret_hash_b64 text,
  p_delivery_id uuid,
  p_client_ip inet default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth m2m.auth_result;
  v_company_id uuid;
  v_row jsonb;
begin
  v_auth := m2m.authorize(p_key_id, p_secret_hash_b64, 'deliveries:read', null, p_client_ip);

  select d.company_id into v_company_id
    from app.epi_deliveries d
   where d.id = p_delivery_id and d.organization_id = v_auth.organization_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  perform m2m.assert_company(v_auth, v_company_id);

  select jsonb_build_object(
           'id', d.id, 'company_id', d.company_id, 'employee_id', d.employee_id,
           'status', d.status, 'delivery_date', d.delivery_date,
           'reason_code', d.reason_code, 'reason_note', d.reason_note,
           'batch_id', d.batch_id, 'chain_id', d.chain_id, 'chain_version', d.chain_version,
           'created_at', d.created_at, 'confirmed_at', d.confirmed_at,
           'contested_at', d.contested_at, 'cancelled_at', d.cancelled_at,
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'line_no', i.line_no, 'epi_id', i.epi_id, 'epi_name', i.epi_name,
                      'ca_number', i.ca_number, 'manufacturer', i.manufacturer,
                      'model', i.model, 'variant_id', i.variant_id,
                      'variant_label', i.variant_label, 'quantity', i.quantity,
                      'unit', i.unit, 'lifespan_days', i.lifespan_days
                    ) order by i.line_no)
               from app.epi_delivery_items i where i.delivery_id = d.id), '[]'::jsonb))
    into v_row
    from app.epi_deliveries d where d.id = p_delivery_id;

  return v_row;
end;
$$;

revoke all on function m2m_rpc.get_delivery(text, text, uuid, inet) from public, anon, authenticated;
grant execute on function m2m_rpc.get_delivery(text, text, uuid, inet) to service_role;

-- The one schema Phase F exposes to PostgREST. m2m and hooks stay unreachable over HTTP.
grant usage on schema m2m_rpc to service_role;
