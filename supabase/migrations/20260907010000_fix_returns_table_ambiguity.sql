-- Phase F bugfix, found by a live end-to-end run against epi-dev -- not by reading the SQL,
-- and not by the pgTAP suites either (only one of the three is exercised by them).
--
-- THE RECURRING BUG CLASS IN THIS CODEBASE, for the third time. A RETURNS TABLE function's
-- OUT parameters are in scope as PL/pgSQL variables throughout the body. When such a
-- function later writes an unqualified `where id = p_something`, `id` resolves ambiguously
-- between the OUT parameter and the table column, and Postgres raises 42702 -- so the
-- function fails on EVERY call, not just an edge case.
--
-- Previously hit by api.delivery_audit_events (FASE 3), worker.verify_document (FASE 5) and
-- api.resend_batch_pending (FASE 6). The rule the codebase already wrote down after FASE 5
-- is: any RETURNS TABLE function must alias every table it queries and qualify every column
-- reference, full stop, no exceptions, even for an "obviously fine" single-table lookup by
-- primary key. These three broke exactly that rule.
--
-- Three functions, all broken on every call:
--   api.list_api_keys          -- the integrations panel could never list a key
--   api.list_webhook_deliveries-- the panel could never show a delivery or the DLQ
--   api.import_run_status      -- a partial import could not report its own status
--
-- Signatures are unchanged, so CREATE OR REPLACE is correct here and no stale overload can
-- survive.

create or replace function api.list_api_keys(p_principal_id uuid)
returns table (
  id uuid, key_id text, env text, created_at timestamptz, last_used_at timestamptz,
  last_used_ip inet, expires_at timestamptz, revoked_at timestamptz, revoke_reason text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  -- `p.id`, not `id`: the OUT parameter named id shadows the column otherwise.
  select p.organization_id into v_org_id
    from m2m.integration_principals p where p.id = p_principal_id;
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_org_permission(v_org_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- secret_hash is deliberately not in the RETURNS list. It has no legitimate reader:
  -- verification happens inside m2m.resolve_principal, never in the application layer.
  return query
    select k.id, k.key_id, k.env, k.created_at, k.last_used_at, k.last_used_ip,
           k.expires_at, k.revoked_at, k.revoke_reason
      from m2m.api_keys k
     where k.principal_id = p_principal_id
     order by k.created_at desc;
end;
$$;

create or replace function api.list_webhook_deliveries(
  p_endpoint_id uuid,
  p_state text default null,
  p_limit int default 50
)
returns table (
  id uuid, event_type text, webhook_type text, state text, attempts int,
  last_status int, last_error text, created_at timestamptz, settled_at timestamptz,
  next_attempt_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  select e.organization_id into v_org_id
    from hooks.endpoints e where e.id = p_endpoint_id;
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_org_permission(v_org_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
    select d.id, o.event_type, t.webhook_type, d.state, d.attempts,
           d.last_status, d.last_error, d.created_at, d.settled_at, d.next_attempt_at
      from hooks.deliveries d
      join hooks.outbox o on o.id = d.outbox_id
      join hooks.event_types t on t.audit_event_type = o.event_type
     where d.endpoint_id = p_endpoint_id
       and (p_state is null or d.state = p_state)
     order by d.created_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

create or replace function api.import_run_status(p_import_run_id uuid)
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
  select r.company_id into v_company_id
    from app.import_runs r where r.id = p_import_run_id;
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
