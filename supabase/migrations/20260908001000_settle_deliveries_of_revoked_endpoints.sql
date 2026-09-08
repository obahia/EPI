-- Phase F fix: PENDING deliveries belonging to a non-ACTIVE endpoint were unreachable and
-- permanently poisoned the health signal.
--
-- ops_rpc.claim_webhook_batch joins hooks.endpoints with `e.status = 'ACTIVE'`, so once an
-- endpoint is revoked its queued deliveries can never be claimed again. They stayed PENDING
-- forever, and ops_rpc.webhook_health counted them -- so oldest_pending_seconds grew without
-- bound (already ~4 hours in epi-dev) on a queue that was in fact idle.
--
-- That matters more than the stuck rows themselves: the GitHub Actions workflow warns when
-- oldest_pending_seconds exceeds 15 minutes, and that warning would have fired on every run
-- forever. An alert that always fires is an alert nobody reads, which costs more than having
-- no alert at all.
--
-- Two independent fixes, because neither covers the other:
--   * Revoking an endpoint now SETTLES its pending deliveries. Revocation is terminal, so
--     leaving work queued for it is meaningless.
--   * webhook_health measures only deliveries on ACTIVE endpoints. DISABLED is deliberately
--     reversible -- an endpoint auto-disabled after 20 permanent failures can be reactivated
--     and should resume its queue -- so its deliveries are kept but must not be counted as
--     backlog while the endpoint is not running.

create or replace function api.set_webhook_endpoint_status(p_endpoint_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_url text;
  v_settled int := 0;
begin
  if p_status not in ('ACTIVE', 'DISABLED', 'REVOKED') then
    raise exception 'invalid_status' using errcode = '23514';
  end if;

  select e.organization_id, e.url into v_org_id, v_url
    from hooks.endpoints e where e.id = p_endpoint_id;
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_org_permission(v_org_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- A row stored before the URL policy moved into the database, or one whose policy has
  -- since tightened, must not return to service just because it already exists.
  if p_status = 'ACTIVE' and not hooks.is_public_https_url(v_url) then
    raise exception 'invalid_webhook_url' using errcode = '23514';
  end if;

  update hooks.endpoints
     set status = p_status,
         consecutive_failures = case when p_status = 'ACTIVE' then 0 else consecutive_failures end,
         disabled_at = case when p_status = 'ACTIVE' then null else clock_timestamp() end,
         disabled_reason = case when p_status = 'ACTIVE' then null else p_reason end
   where id = p_endpoint_id;

  -- REVOKED only. DISABLED keeps its queue so reactivation resumes it.
  if p_status = 'REVOKED' then
    with settled as (
      update hooks.deliveries d
         set state = 'FAILED_PERMANENT',
             settled_at = clock_timestamp(),
             last_error = 'endpoint revoked before delivery'
       where d.endpoint_id = p_endpoint_id
         and d.state = 'PENDING'
      returning 1
    )
    select count(*)::int into v_settled from settled;
  end if;

  perform app.log_audit_event(
    v_org_id, null, 'WEBHOOK_ENDPOINT_STATUS_CHANGED', 'hooks.endpoints', p_endpoint_id,
    'USER', (select auth.uid()),
    jsonb_build_object('status', p_status, 'reason', p_reason, 'settled_pending', v_settled)
  );
end;
$$;

-- Health now measures the queue that can actually move. `orphaned` is reported separately
-- rather than hidden: work parked behind a non-ACTIVE endpoint is a real fact an operator
-- may want to see, it is just not backlog and must not drive the lateness alarm.
create or replace function ops_rpc.webhook_health()
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'pending', (select count(*) from hooks.deliveries d
                 join hooks.endpoints e on e.id = d.endpoint_id
                where d.state = 'PENDING' and e.status = 'ACTIVE'),
    'in_flight', (select count(*) from hooks.deliveries where state = 'IN_FLIGHT'),
    'dlq', (select count(*) from hooks.deliveries where state = 'DLQ'),
    'orphaned', (select count(*) from hooks.deliveries d
                  join hooks.endpoints e on e.id = d.endpoint_id
                 where d.state = 'PENDING' and e.status <> 'ACTIVE'),
    'oldest_pending_seconds',
      (select coalesce(extract(epoch from (clock_timestamp() - min(d.created_at)))::int, 0)
         from hooks.deliveries d
         join hooks.endpoints e on e.id = d.endpoint_id
        where d.state = 'PENDING' and e.status = 'ACTIVE'),
    'unfanned_outbox', (select count(*) from hooks.outbox where fanned_out_at is null)
  );
$$;

-- One-time correction of rows that predate the fix. This is a data change inside a
-- migration, which is normally the wrong place -- justified here because these rows are in
-- a state the code can no longer produce, they are unreachable by any code path, and
-- leaving them would keep the lateness alarm permanently armed. A fresh database, which is
-- what CI builds, has no such rows and this is a no-op there.
update hooks.deliveries d
   set state = 'FAILED_PERMANENT',
       settled_at = clock_timestamp(),
       last_error = 'endpoint revoked before delivery (backfill 20260908001000)'
  from hooks.endpoints e
 where e.id = d.endpoint_id
   and d.state = 'PENDING'
   and e.status = 'REVOKED';
