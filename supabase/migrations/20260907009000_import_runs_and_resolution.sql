-- Phase F, import (spec §18, contract section M).
--
-- Three things this adds, and one it deliberately does not.
--
-- ADDS: (1) a durable record of every import run and every chunk within it, so a partial
-- import is inspectable and resumable rather than a number that vanished with the browser
-- tab; (2) resolution of the "Cargo" and "Unidade" columns to app.job_positions.id and
-- app.locations.id, which is what connects a spreadsheet to the Phase A requirement matrix
-- and the Phase B stock buckets; (3) EMPLOYEES_IMPORTED, which until now existed only as an
-- i18n label with nothing emitting it -- mass employee creation left no audit trail at all.
--
-- DOES NOT ADD: automatic creation of a cargo or a unidade. A row whose Cargo does not
-- match is a row error the user resolves explicitly. Guessing here would quietly populate
-- the requirement matrix with typos, and a unidade invented from a spreadsheet cell would
-- create an orphan stock bucket.

-- ---------------------------------------------------------------------------------------
-- Import runs
-- ---------------------------------------------------------------------------------------
create table app.import_runs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  company_id      uuid not null,
  kind            text not null default 'EMPLOYEES' check (kind in ('EMPLOYEES')),
  source_format   text not null check (source_format in ('CSV', 'XLSX')),
  source_filename text check (length(source_filename) <= 260),
  source_sha256   bytea check (source_sha256 is null or octet_length(source_sha256) = 32),
  column_mapping  jsonb not null default '{}',
  total_rows      int not null default 0 check (total_rows >= 0),
  valid_rows      int not null default 0 check (valid_rows >= 0),
  error_rows      int not null default 0 check (error_rows >= 0),
  chunk_size      int not null check (chunk_size between 1 and 20000),
  chunk_count     int not null check (chunk_count >= 0),
  status          text not null default 'RUNNING'
                    check (status in ('RUNNING', 'COMPLETED', 'PARTIAL', 'ABANDONED')),
  created_by      uuid references app.users (id),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  foreign key (organization_id, company_id) references app.companies (organization_id, id) on delete restrict
);

comment on table app.import_runs is
  'One spreadsheet import. Exists because "497 válidos / 3 erros" and a progress bar are ephemeral: the moment a chunk fails, the only durable answer to "which 4000 of my 6000 rows actually landed?" has to come from the database. source_sha256 is what makes a resume safe -- a resumed run must be the same file, or it is a new run.';

create index import_runs_company_idx on app.import_runs (company_id, started_at desc);

create table app.import_run_chunks (
  import_run_id  uuid not null references app.import_runs (id) on delete restrict,
  chunk_index    int not null check (chunk_index >= 0),
  row_from       int not null,
  row_to         int not null,
  status         text not null default 'PENDING' check (status in ('PENDING', 'COMMITTED', 'FAILED')),
  created_count  int not null default 0,
  updated_count  int not null default 0,
  skipped_count  int not null default 0,
  error_signal   text check (length(error_signal) <= 200),
  committed_at   timestamptz,
  primary key (import_run_id, chunk_index),
  constraint import_run_chunks_committed_ck check ((status = 'COMMITTED') = (committed_at is not null))
);

comment on table app.import_run_chunks is
  'One row per chunk. A chunk''s result is written in the SAME transaction that inserts its rows, so COMMITTED means exactly "these rows are in the database" -- there is no window in which the count and the data disagree. Resuming reprocesses only chunks that are not COMMITTED; because the underlying UPSERT is idempotent per CPF, reprocessing one that secretly did commit is harmless.';

alter table app.import_runs       enable row level security;
alter table app.import_runs       force row level security;
alter table app.import_run_chunks enable row level security;
alter table app.import_run_chunks force row level security;

grant select on app.import_runs to authenticated;
grant select on app.import_run_chunks to authenticated;

create policy import_runs_select on app.import_runs
  for select to authenticated
  using (company_id = any ((select auth_ctx.company_ids('employee.import'))::uuid[]));

create policy import_run_chunks_select on app.import_run_chunks
  for select to authenticated
  using (exists (
    select 1 from app.import_runs r
    where r.id = import_run_id
      and r.company_id = any ((select auth_ctx.company_ids('employee.import'))::uuid[])
  ));

-- ---------------------------------------------------------------------------------------
-- Normalisation, shared by both resolvers so they can never diverge
-- ---------------------------------------------------------------------------------------
create function app.normalize_import_label(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(lower(regexp_replace(btrim(normalize(p_value, nfc)), '\s+', ' ', 'g')), '');
$$;

comment on function app.normalize_import_label(text) is
  'trim -> collapse internal whitespace -> NFC -> lower. Accents are deliberately PRESERVED: "Soldador" and "Soldádor" stay different, because folding them would silently merge two catalog entries a company may distinguish on purpose. A near-miss becomes a row error with suggestions, which is the user''s decision to make, not ours.';

-- ---------------------------------------------------------------------------------------
-- Reference resolution -- called during the preview step, before anything is written
-- ---------------------------------------------------------------------------------------
create function api.resolve_import_references(
  p_company_id uuid,
  p_titles text[] default '{}',
  p_location_refs text[] default '{}'
)
returns table (
  kind        text,     -- 'POSITION' | 'LOCATION'
  raw         text,
  resolved_id uuid,
  outcome     text,     -- 'RESOLVED' | 'NOT_FOUND' | 'AMBIGUOUS' | 'INACTIVE'
  suggestions text[]
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  if not (select auth_ctx.has_permission(p_company_id, 'employee.import')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select organization_id into v_org_id from app.companies where id = p_company_id;

  -- Positions. app.job_positions is unique on (organization_id, company_id, lower(title))
  -- for ACTIVE rows, but company_id may be NULL (the org-wide catalog), so a company can
  -- legitimately have BOTH an org-wide "Soldador" and its own "Soldador". The index does not
  -- prevent that, so the resolver needs an explicit precedence rule rather than assuming
  -- uniqueness: company-scoped wins, deterministically.
  return query
  with wanted as (
    select distinct t as raw, app.normalize_import_label(t) as norm
      from unnest(p_titles) as t
     where app.normalize_import_label(t) is not null
  ),
  matched as (
    select w.raw, w.norm,
           (select jp.id from app.job_positions jp
             where jp.organization_id = v_org_id
               and jp.status = 'ACTIVE'
               and app.normalize_import_label(jp.title) = w.norm
             order by (jp.company_id is null), jp.id    -- false sorts first: company-scoped wins
             limit 1) as active_id,
           exists (select 1 from app.job_positions jp
                    where jp.organization_id = v_org_id
                      and jp.status = 'INACTIVE'
                      and app.normalize_import_label(jp.title) = w.norm
                      and (jp.company_id is null or jp.company_id = p_company_id)) as has_inactive
      from wanted w
  )
  select 'POSITION'::text, m.raw, m.active_id,
         case when m.active_id is not null then 'RESOLVED'
              when m.has_inactive then 'INACTIVE'
              else 'NOT_FOUND' end,
         case when m.active_id is not null then null::text[]
              else (select coalesce(array_agg(jp.title order by jp.title), '{}')
                      from app.job_positions jp
                     where jp.organization_id = v_org_id
                       and jp.status = 'ACTIVE'
                       and (jp.company_id is null or jp.company_id = p_company_id)
                       -- OPERATOR(extensions.%) explicitly: pg_trgm lives in `extensions`,
                       -- and this function runs with search_path = '', where a bare % does
                       -- not resolve. Schema-qualifying a FUNCTION is habit; an OPERATOR
                       -- needs this syntax and is easy to miss.
                       and app.normalize_import_label(jp.title) OPERATOR(extensions.%) m.norm) end
    from matched m;

  -- Locations. app.locations has NO unique index on name or code, so two active units of the
  -- same company can legitimately share a name today. Resolving by name is therefore
  -- genuinely ambiguous, and the honest answer is to say so rather than pick the first row.
  -- `code` is tried first because that is the identifier an external payroll file actually
  -- carries.
  return query
  with wanted as (
    select distinct r as raw, app.normalize_import_label(r) as norm
      from unnest(p_location_refs) as r
     where app.normalize_import_label(r) is not null
  ),
  matched as (
    select w.raw, w.norm,
           (select array_agg(l.id)
              from app.locations l
             where l.company_id = p_company_id and l.status = 'ACTIVE'
               and app.normalize_import_label(l.code) = w.norm) as by_code,
           (select array_agg(l.id)
              from app.locations l
             where l.company_id = p_company_id and l.status = 'ACTIVE'
               and app.normalize_import_label(l.name) = w.norm) as by_name,
           exists (select 1 from app.locations l
                    where l.company_id = p_company_id and l.status = 'INACTIVE'
                      and (app.normalize_import_label(l.code) = w.norm
                        or app.normalize_import_label(l.name) = w.norm)) as has_inactive
      from wanted w
  ),
  chosen as (
    select m.*, coalesce(nullif(m.by_code, '{}'), m.by_name) as candidates from matched m
  )
  select 'LOCATION'::text, c.raw,
         case when coalesce(array_length(c.candidates, 1), 0) = 1 then c.candidates[1] else null end,
         case when coalesce(array_length(c.candidates, 1), 0) = 1 then 'RESOLVED'
              when coalesce(array_length(c.candidates, 1), 0) > 1 then 'AMBIGUOUS'
              when c.has_inactive then 'INACTIVE'
              else 'NOT_FOUND' end,
         case when coalesce(array_length(c.candidates, 1), 0) = 1 then null::text[]
              else (select coalesce(array_agg(l.name order by l.name), '{}')
                      from app.locations l
                     where l.company_id = p_company_id and l.status = 'ACTIVE') end
    from chosen c;
end;
$$;

comment on function api.resolve_import_references(uuid, text[], text[]) is
  'Resolves spreadsheet Cargo/Unidade labels to ids during the PREVIEW step, so an unmatched label is a row error the user fixes before importing rather than a surprise afterwards. Never creates anything. Suggestions for positions use pg_trgm similarity (the % operator) purely to help a human spot a typo -- they are never applied automatically.';

revoke execute on function api.resolve_import_references(uuid, text[], text[]) from public, anon;
grant execute on function api.resolve_import_references(uuid, text[], text[]) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Run lifecycle
-- ---------------------------------------------------------------------------------------
create function api.start_import_run(
  p_company_id uuid,
  p_source_format text,
  p_source_filename text,
  p_source_sha256_b64 text,
  p_column_mapping jsonb,
  p_total_rows int,
  p_valid_rows int,
  p_error_rows int,
  p_chunk_size int,
  p_chunk_count int
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_id uuid;
begin
  if not (select auth_ctx.has_permission(p_company_id, 'employee.import')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select organization_id into v_org_id from app.companies where id = p_company_id;

  insert into app.import_runs (
    organization_id, company_id, source_format, source_filename, source_sha256,
    column_mapping, total_rows, valid_rows, error_rows, chunk_size, chunk_count, created_by
  ) values (
    v_org_id, p_company_id, p_source_format, p_source_filename,
    case when p_source_sha256_b64 is null then null else decode(p_source_sha256_b64, 'base64') end,
    coalesce(p_column_mapping, '{}'::jsonb), p_total_rows, p_valid_rows, p_error_rows,
    p_chunk_size, p_chunk_count, (select auth.uid())
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function api.start_import_run(uuid, text, text, text, jsonb, int, int, int, int, int) from public, anon;
grant execute on function api.start_import_run(uuid, text, text, text, jsonb, int, int, int, int, int) to authenticated;

create function api.finish_import_run(p_import_run_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_status text;
begin
  select ir.*, c.organization_id as org_id into r
    from app.import_runs ir join app.companies c on c.id = ir.company_id
   where ir.id = p_import_run_id;
  if r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(r.company_id, 'employee.import')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- PARTIAL is a first-class outcome, not an error state. The whole point is that the user
  -- is told plainly that some chunks landed and some did not, instead of seeing a success
  -- message that is true of only part of the file.
  select case
           when count(*) filter (where status = 'COMMITTED') = r.chunk_count then 'COMPLETED'
           when count(*) filter (where status = 'COMMITTED') > 0 then 'PARTIAL'
           else 'ABANDONED'
         end
    into v_status
    from app.import_run_chunks where import_run_id = p_import_run_id;

  update app.import_runs set status = v_status, finished_at = now()
   where id = p_import_run_id;

  return v_status;
end;
$$;

revoke execute on function api.finish_import_run(uuid) from public, anon;
grant execute on function api.finish_import_run(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- The commit itself
-- ---------------------------------------------------------------------------------------
-- DROP + CREATE rather than CREATE OR REPLACE: the argument count changes, and
-- `create or replace` with a different arity silently installs a SECOND overload that
-- PostgREST may resolve instead -- the exact bug 20260903150000 had to clean up for
-- api.return_epi_item.
drop function if exists api.import_employees_commit(uuid, jsonb);

create function api.import_employees_commit(
  p_company_id uuid,
  p_rows jsonb,
  p_import_run_id uuid default null,
  p_chunk_index int default null,
  p_row_from int default null,
  p_row_to int default null
)
returns table (created_count int, updated_count int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_created int;
  v_updated int;
  v_bad int;
begin
  if not (select auth_ctx.has_permission(p_company_id, 'employee.import')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if jsonb_array_length(p_rows) > 20000 then
    raise exception 'batch_too_large' using errcode = '54000';
  end if;

  select organization_id into v_org_id from app.companies where id = p_company_id;

  -- position_id / location_id arrive already resolved (api.resolve_import_references runs
  -- during the preview), but they are re-validated here anyway: the client is a UX gate,
  -- never the only gate, and an id from another tenant must not be insertable just because
  -- the wizard sent it. Same reasoning as re-validating CPF in the Server Action.
  select count(*) into v_bad
    from jsonb_to_recordset(p_rows) as r(position_id uuid, location_id uuid)
   where (r.position_id is not null and not exists (
            select 1 from app.job_positions jp
             where jp.id = r.position_id and jp.organization_id = v_org_id
               and (jp.company_id is null or jp.company_id = p_company_id)))
      or (r.location_id is not null and not exists (
            select 1 from app.locations l
             where l.id = r.location_id and l.company_id = p_company_id));
  if v_bad > 0 then
    raise exception 'reference_out_of_scope' using errcode = '23514';
  end if;

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
      r.department,
      r.position_id,
      r.location_id
    from jsonb_to_recordset(p_rows) as r(
      full_name text, cpf_hash_b64 text, cpf_enc_b64 text, cpf_masked text,
      registration_number text, phone_e164 text, email text,
      position_title text, department text, position_id uuid, location_id uuid
    )
  ),
  ins as (
    insert into app.employees (
      organization_id, company_id, full_name, cpf_hash, cpf_enc, cpf_masked,
      registration_number, phone_e164, email, position_title, department,
      position_id, location_id, data_origin, created_by
    )
    select
      v_org_id, p_company_id, i.full_name, i.cpf_hash, i.cpf_enc, i.cpf_masked,
      i.registration_number, i.phone_e164, i.email, i.position_title, i.department,
      i.position_id, i.location_id, 'IMPORT', (select auth.uid())
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
      department = excluded.department,
      position_id = excluded.position_id,
      location_id = excluded.location_id
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert),
    count(*) filter (where not was_insert)
  into v_created, v_updated
  from ins;

  -- The chunk's result is written in THIS transaction, alongside the rows it describes.
  -- COMMITTED therefore means exactly "these rows are in the database" -- the count and the
  -- data can never disagree, and a crash before COMMIT leaves neither.
  if p_import_run_id is not null and p_chunk_index is not null then
    insert into app.import_run_chunks (
      import_run_id, chunk_index, row_from, row_to, status,
      created_count, updated_count, skipped_count, committed_at
    ) values (
      p_import_run_id, p_chunk_index, coalesce(p_row_from, 0), coalesce(p_row_to, 0),
      'COMMITTED', v_created, v_updated, 0, clock_timestamp()
    )
    on conflict (import_run_id, chunk_index) do update set
      status = 'COMMITTED',
      created_count = excluded.created_count,
      updated_count = excluded.updated_count,
      committed_at = excluded.committed_at,
      error_signal = null;
  end if;

  -- ONE event per chunk, never one per employee. A 20,000-row import would otherwise write
  -- 20,000 chain-hash computations and, once an organization has a webhook, attempt 20,000
  -- HTTP deliveries -- for a single operator action. The semantics are declared rather than
  -- implicit: employee.created fires for single-entity operations, and a bulk import
  -- announces itself as employee.import_completed. A consumer reconciles with
  -- GET /api/v1/employees?updated_since=<the event's occurred_at>.
  perform app.log_audit_event(
    v_org_id, p_company_id, 'EMPLOYEES_IMPORTED', 'app.import_runs', p_import_run_id,
    'USER', (select auth.uid()),
    jsonb_build_object(
      'import_run_id', p_import_run_id,
      'chunk_index', p_chunk_index,
      'created_count', v_created,
      'updated_count', v_updated
    )
  );

  return query select v_created, v_updated;
end;
$$;

comment on function api.import_employees_commit(uuid, jsonb, uuid, int, int, int) is
  'Commits ONE chunk of an employee import. Idempotent per CPF via the UPSERT, so re-running a chunk is safe. position_id/location_id are re-validated against the tenant even though the preview already resolved them. Emits exactly one EMPLOYEES_IMPORTED per chunk -- see the note in the body for why not one per row.';

revoke execute on function api.import_employees_commit(uuid, jsonb, uuid, int, int, int) from public, anon;
grant execute on function api.import_employees_commit(uuid, jsonb, uuid, int, int, int) to authenticated;

-- The runner/panel view of a run, so a partial import is legible without joining by hand.
create function api.import_run_status(p_import_run_id uuid)
returns table (
  id uuid, status text, chunk_count int, committed_chunks int,
  created_count int, updated_count int, total_rows int, valid_rows int, error_rows int,
  source_filename text, source_format text, started_at timestamptz, finished_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id from app.import_runs where id = p_import_run_id;
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'employee.import')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
    select r.id, r.status, r.chunk_count,
           (select count(*)::int from app.import_run_chunks c
             where c.import_run_id = r.id and c.status = 'COMMITTED'),
           (select coalesce(sum(c.created_count), 0)::int from app.import_run_chunks c
             where c.import_run_id = r.id and c.status = 'COMMITTED'),
           (select coalesce(sum(c.updated_count), 0)::int from app.import_run_chunks c
             where c.import_run_id = r.id and c.status = 'COMMITTED'),
           r.total_rows, r.valid_rows, r.error_rows,
           r.source_filename, r.source_format, r.started_at, r.finished_at
      from app.import_runs r where r.id = p_import_run_id;
end;
$$;

revoke execute on function api.import_run_status(uuid) from public, anon;
grant execute on function api.import_run_status(uuid) to authenticated;

insert into hooks.event_types (audit_event_type, webhook_type) values
  ('EMPLOYEES_IMPORTED', 'employee.import_completed');
