-- Phase F: the webhook runner's database interface, and panel management of endpoints.
--
-- The runner is a Vercel Cron job hitting an internal route (contract section B/T.2). It
-- never holds a long transaction: claim -> HTTP -> report are three separate short calls, so
-- FOR UPDATE SKIP LOCKED does its job entirely inside the database and a stateless serverless
-- function is a perfectly adequate host for it.

-- ---------------------------------------------------------------------------------------
-- Runner: claim
-- ---------------------------------------------------------------------------------------
create function ops_rpc.claim_webhook_batch(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_rows jsonb;
begin
  -- Fan out first so a batch never starves waiting for a separate scheduler tick.
  perform hooks.fan_out(500);

  with claimable as (
    select d.id
      from hooks.deliveries d
      join hooks.endpoints e on e.id = d.endpoint_id
     where d.state = 'PENDING'
       and d.next_attempt_at <= clock_timestamp()
       and e.status = 'ACTIVE'
       -- ordered_delivery endpoints admit one in-flight delivery at a time. The cost is
       -- head-of-line blocking, which is exactly what the subscriber opted into.
       and (not e.ordered_delivery
            or not exists (select 1 from hooks.deliveries d2
                            where d2.endpoint_id = d.endpoint_id and d2.state = 'IN_FLIGHT'))
     order by d.next_attempt_at, d.created_at
     for update of d skip locked
     limit v_limit
  ),
  claimed as (
    update hooks.deliveries d
       set state = 'IN_FLIGHT',
           attempts = d.attempts + 1,
           claimed_at = clock_timestamp()
      from claimable c
     where d.id = c.id
    returning d.id, d.outbox_id, d.endpoint_id, d.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'delivery_id', c.id,
           'endpoint_id', c.endpoint_id,
           'attempt_no', c.attempts,
           'url', e.url,
           'secret_enc_b64', encode(e.secret_enc, 'base64'),
           'secret_prev_enc_b64', case when e.secret_prev_enc is null then null
                                       else encode(e.secret_prev_enc, 'base64') end,
           'envelope', hooks.build_envelope(c.outbox_id)
         )), '[]'::jsonb)
    into v_rows
    from claimed c
    join hooks.endpoints e on e.id = c.endpoint_id;

  return jsonb_build_object('deliveries', v_rows);
end;
$$;

comment on function ops_rpc.claim_webhook_batch(int) is
  'Atomically claims up to p_limit due deliveries with FOR UPDATE SKIP LOCKED, so two overlapping cron invocations never send the same event twice. Returns the signing material as ciphertext -- the runner decrypts with WEBHOOK_SECRET_KEY in Node, and Postgres never holds the key.';

revoke all on function ops_rpc.claim_webhook_batch(int) from public, anon, authenticated;
grant execute on function ops_rpc.claim_webhook_batch(int) to service_role;

-- ---------------------------------------------------------------------------------------
-- Runner: report
-- ---------------------------------------------------------------------------------------
create function ops_rpc.report_webhook_result(
  p_delivery_id uuid,
  p_attempt_no int,
  p_http_status int default null,
  p_error_kind text default null,
  p_error_detail text default null,
  p_latency_ms int default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_state text;
  v_retryable boolean;
  v_backoff_seconds numeric;
begin
  select * into d from hooks.deliveries where id = p_delivery_id;
  if d.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  insert into hooks.delivery_attempts (delivery_id, attempt_no, http_status, error_kind, error_detail, latency_ms)
  values (p_delivery_id, p_attempt_no, p_http_status, p_error_kind, left(p_error_detail, 2000), p_latency_ms)
  on conflict (delivery_id, attempt_no) do nothing;

  -- 3xx is a permanent failure, not a retry: the runner never follows a redirect, because
  -- following one re-opens SSRF after every address check has already passed.
  v_retryable := p_http_status is null                      -- network-level failure
              or p_http_status = 429
              or p_http_status >= 500;

  if p_http_status between 200 and 299 then
    v_state := 'SUCCEEDED';
  elsif v_retryable and d.attempts < 12 then
    v_state := 'PENDING';
  elsif v_retryable then
    v_state := 'DLQ';
  else
    v_state := 'FAILED_PERMANENT';
  end if;

  if v_state = 'PENDING' then
    -- Full jitter: delay is uniform in [0, cap]. Without it, a thousand deliveries that
    -- failed together retry together, and the retry storm becomes the outage.
    v_backoff_seconds := random() * least(21600, 10 * power(2, d.attempts));
    update hooks.deliveries
       set state = 'PENDING',
           next_attempt_at = clock_timestamp() + make_interval(secs => v_backoff_seconds),
           last_status = p_http_status,
           last_error = left(coalesce(p_error_kind || ': ' || coalesce(p_error_detail, ''), p_error_detail), 2000)
     where id = p_delivery_id;
  else
    update hooks.deliveries
       set state = v_state,
           settled_at = clock_timestamp(),
           last_status = p_http_status,
           last_error = left(coalesce(p_error_kind || ': ' || coalesce(p_error_detail, ''), p_error_detail), 2000)
     where id = p_delivery_id;
  end if;

  if v_state = 'SUCCEEDED' then
    update hooks.endpoints set consecutive_failures = 0 where id = d.endpoint_id;
  elsif v_state = 'FAILED_PERMANENT' then
    -- Only permanent (4xx) failures count toward auto-disable. A subscriber that is merely
    -- down returns 5xx, and taking their endpoint away for being temporarily unavailable
    -- would be the wrong response to the wrong signal.
    update hooks.endpoints
       set consecutive_failures = consecutive_failures + 1,
           status = case when consecutive_failures + 1 >= 20 then 'DISABLED' else status end,
           disabled_at = case when consecutive_failures + 1 >= 20 then clock_timestamp() else disabled_at end,
           disabled_reason = case when consecutive_failures + 1 >= 20
                                  then '20 consecutive permanent failures' else disabled_reason end
     where id = d.endpoint_id;
  end if;

  return jsonb_build_object('state', v_state);
end;
$$;

revoke all on function ops_rpc.report_webhook_result(uuid, int, int, text, text, int) from public, anon, authenticated;
grant execute on function ops_rpc.report_webhook_result(uuid, int, int, text, text, int) to service_role;

-- ---------------------------------------------------------------------------------------
-- Runner: observability + periodic cleanup
-- ---------------------------------------------------------------------------------------
create function ops_rpc.webhook_health()
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'pending', (select count(*) from hooks.deliveries where state = 'PENDING'),
    'in_flight', (select count(*) from hooks.deliveries where state = 'IN_FLIGHT'),
    'dlq', (select count(*) from hooks.deliveries where state = 'DLQ'),
    'oldest_pending_seconds',
      (select coalesce(extract(epoch from (clock_timestamp() - min(created_at)))::int, 0)
         from hooks.deliveries where state = 'PENDING'),
    'unfanned_outbox', (select count(*) from hooks.outbox where fanned_out_at is null)
  );
$$;

revoke all on function ops_rpc.webhook_health() from public, anon, authenticated;
grant execute on function ops_rpc.webhook_health() to service_role;

create function ops_rpc.purge_expired()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_idem int;
  v_attempts int;
  v_deliveries int;
  v_outbox int;
  v_quota int;
begin
  delete from m2m.idempotency_records where expires_at < now();
  get diagnostics v_idem = row_count;

  delete from hooks.delivery_attempts a
   using hooks.deliveries d
   where d.id = a.delivery_id
     and d.settled_at is not null
     and d.settled_at < now() - interval '30 days';
  get diagnostics v_attempts = row_count;

  delete from hooks.deliveries
   where settled_at is not null and settled_at < now() - interval '30 days';
  get diagnostics v_deliveries = row_count;

  -- An outbox row only goes once every delivery derived from it is gone. audit.audit_events
  -- itself is NEVER purged -- it is the source, and it is append-only forever.
  delete from hooks.outbox o
   where o.fanned_out_at is not null
     and o.created_at < now() - interval '30 days'
     and not exists (select 1 from hooks.deliveries d where d.outbox_id = o.id);
  get diagnostics v_outbox = row_count;

  delete from m2m.quota_counters where window_start < now() - interval '2 days';
  get diagnostics v_quota = row_count;

  return jsonb_build_object('idempotency', v_idem, 'attempts', v_attempts,
                            'deliveries', v_deliveries, 'outbox', v_outbox, 'quota', v_quota);
end;
$$;

revoke all on function ops_rpc.purge_expired() from public, anon, authenticated;
grant execute on function ops_rpc.purge_expired() to service_role;

grant usage on schema ops_rpc to service_role;

-- ---------------------------------------------------------------------------------------
-- Panel management of endpoints
-- ---------------------------------------------------------------------------------------
-- Deliberately human-only. An API key that can create a webhook endpoint has escalated
-- itself into an exfiltration channel for every event of its tenant.
create function api.create_webhook_endpoint(
  p_organization_id uuid,
  p_url text,
  p_secret_enc_b64 text,
  p_event_types text[] default '{}',
  p_description text default null,
  p_ordered_delivery boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_unknown int;
begin
  if not (select auth_ctx.has_org_permission(p_organization_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select count(*) into v_unknown
    from unnest(p_event_types) as t
   where not exists (select 1 from hooks.event_types et where et.webhook_type = t);
  if v_unknown > 0 then
    raise exception 'unknown_event_type' using errcode = '22P02';
  end if;

  if (select count(*) from hooks.endpoints
       where organization_id = p_organization_id and status = 'ACTIVE') >= 10 then
    raise exception 'too_many_endpoints' using errcode = '54000';
  end if;

  insert into hooks.endpoints (organization_id, url, secret_enc, event_types, description,
                               ordered_delivery, created_by)
  values (p_organization_id, p_url, decode(p_secret_enc_b64, 'base64'), p_event_types,
          p_description, p_ordered_delivery, (select auth.uid()))
  returning id into v_id;

  perform app.log_audit_event(
    p_organization_id, null, 'WEBHOOK_ENDPOINT_CREATED', 'hooks.endpoints', v_id,
    'USER', (select auth.uid()),
    jsonb_build_object('event_types', to_jsonb(p_event_types), 'ordered', p_ordered_delivery)
  );

  return v_id;
end;
$$;

revoke execute on function api.create_webhook_endpoint(uuid, text, text, text[], text, boolean) from public, anon;
grant execute on function api.create_webhook_endpoint(uuid, text, text, text[], text, boolean) to authenticated;

create function api.rotate_webhook_secret(p_endpoint_id uuid, p_new_secret_enc_b64 text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id from hooks.endpoints where id = p_endpoint_id;
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_org_permission(v_org_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- The outgoing secret is kept alongside the new one so the runner can sign with BOTH
  -- during the migration window. Rotating without an overlap means every event in flight
  -- fails verification at the subscriber.
  update hooks.endpoints
     set secret_prev_enc = secret_enc,
         secret_enc = decode(p_new_secret_enc_b64, 'base64'),
         secret_rotated_at = now()
   where id = p_endpoint_id;

  perform app.log_audit_event(
    v_org_id, null, 'WEBHOOK_SECRET_ROTATED', 'hooks.endpoints', p_endpoint_id,
    'USER', (select auth.uid()), '{}'::jsonb
  );
end;
$$;

revoke execute on function api.rotate_webhook_secret(uuid, text) from public, anon;
grant execute on function api.rotate_webhook_secret(uuid, text) to authenticated;

create function api.set_webhook_endpoint_status(p_endpoint_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  if p_status not in ('ACTIVE', 'DISABLED', 'REVOKED') then
    raise exception 'invalid_status' using errcode = '23514';
  end if;

  select organization_id into v_org_id from hooks.endpoints where id = p_endpoint_id;
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_org_permission(v_org_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  update hooks.endpoints
     set status = p_status,
         consecutive_failures = case when p_status = 'ACTIVE' then 0 else consecutive_failures end,
         disabled_at = case when p_status = 'ACTIVE' then null else clock_timestamp() end,
         disabled_reason = case when p_status = 'ACTIVE' then null else p_reason end
   where id = p_endpoint_id;

  perform app.log_audit_event(
    v_org_id, null, 'WEBHOOK_ENDPOINT_STATUS_CHANGED', 'hooks.endpoints', p_endpoint_id,
    'USER', (select auth.uid()), jsonb_build_object('status', p_status, 'reason', p_reason)
  );
end;
$$;

revoke execute on function api.set_webhook_endpoint_status(uuid, text, text) from public, anon;
grant execute on function api.set_webhook_endpoint_status(uuid, text, text) to authenticated;

create function api.replay_webhook_delivery(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id from hooks.deliveries where id = p_delivery_id;
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_org_permission(v_org_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  update hooks.deliveries
     set state = 'PENDING', attempts = 0, next_attempt_at = clock_timestamp(),
         settled_at = null, claimed_at = null
   where id = p_delivery_id;

  -- Never silent: a manual replay is an operator action on delivered-or-abandoned data and
  -- has to be as auditable as anything else.
  perform app.log_audit_event(
    v_org_id, null, 'WEBHOOK_REPLAYED', 'hooks.deliveries', p_delivery_id,
    'USER', (select auth.uid()), '{}'::jsonb
  );
end;
$$;

revoke execute on function api.replay_webhook_delivery(uuid) from public, anon;
grant execute on function api.replay_webhook_delivery(uuid) to authenticated;

create function api.list_webhook_endpoints(p_organization_id uuid)
returns table (
  id uuid, url text, description text, event_types text[], status text,
  ordered_delivery boolean, consecutive_failures int, created_at timestamptz,
  secret_rotated_at timestamptz, pending_count int, dlq_count int, last_success_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_org_permission(p_organization_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- secret_enc / secret_prev_enc are absent from the RETURNS list on purpose: the panel has
  -- no reason to see even the ciphertext, and the runner reads it through ops_rpc.
  return query
    select e.id, e.url, e.description, e.event_types, e.status, e.ordered_delivery,
           e.consecutive_failures, e.created_at, e.secret_rotated_at,
           (select count(*)::int from hooks.deliveries d
             where d.endpoint_id = e.id and d.state = 'PENDING'),
           (select count(*)::int from hooks.deliveries d
             where d.endpoint_id = e.id and d.state = 'DLQ'),
           (select max(d.settled_at) from hooks.deliveries d
             where d.endpoint_id = e.id and d.state = 'SUCCEEDED')
      from hooks.endpoints e
     where e.organization_id = p_organization_id
     order by e.created_at desc;
end;
$$;

revoke execute on function api.list_webhook_endpoints(uuid) from public, anon;
grant execute on function api.list_webhook_endpoints(uuid) to authenticated;

create function api.list_webhook_deliveries(
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
  select organization_id into v_org_id from hooks.endpoints where id = p_endpoint_id;
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

revoke execute on function api.list_webhook_deliveries(uuid, text, int) from public, anon;
grant execute on function api.list_webhook_deliveries(uuid, text, int) to authenticated;
