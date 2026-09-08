-- Phase F: webhooks. The properties that matter are (a) an event is queued if and only if
-- the business change committed, (b) an event never crosses a tenant boundary, (c) the
-- payload carries no PII, and (d) the retry state machine cannot lose or duplicate work.

create extension if not exists pgtap with schema extensions;

begin;

select plan(28);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-00000000000a',
   'authenticated', 'authenticated', 'admin-hook-a@tenant.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Hook A"}', now(), now(), '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-00000000000b',
   'authenticated', 'authenticated', 'admin-hook-b@tenant.test',
   extensions.crypt('x', extensions.gen_salt('bf')), now(),
   '{}', '{"full_name":"Hook B"}', now(), now(), '', '', '', '', false, false);

create temporary table fx (label text primary key, id uuid not null);
grant all on fx to authenticated;
create temporary table probe (label text primary key, val text);
grant all on probe to authenticated;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  select company_id into v_company_id
  from api.onboard_organization('Hook A LTDA', '66777888000111', 'Hook A LTDA', '66777888000111', null);
  insert into fx values ('company_a', v_company_id);
  reset role;
end $$;

do $$
declare v_company_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
  select company_id into v_company_id
  from api.onboard_organization('Hook B LTDA', '77888999000199', 'Hook B LTDA', '77888999000199', null);
  insert into fx values ('company_b', v_company_id);
  reset role;
end $$;

insert into fx select 'org_a', organization_id from app.companies where id = (select id from fx where label = 'company_a');
insert into fx select 'org_b', organization_id from app.companies where id = (select id from fx where label = 'company_b');

-- ---------------------------------------------------------------------------------------
-- 1. Nothing is enqueued for an organization with no endpoint. This is the state of every
--    organization today, so it is the case that must cost nothing.
-- ---------------------------------------------------------------------------------------
do $$
begin
  perform app.log_audit_event(
    (select id from fx where label = 'org_a'), (select id from fx where label = 'company_a'),
    'EMPLOYEE_CREATED', 'app.employees', gen_random_uuid(), 'USER', null, '{}'::jsonb);
end $$;

select is(
  (select count(*)::int from hooks.outbox where organization_id = (select id from fx where label = 'org_a')),
  0,
  'an organization with no active endpoint enqueues nothing at all'
);

-- ---------------------------------------------------------------------------------------
-- 2. With an endpoint, publishable events are enqueued and unpublishable ones are not
-- ---------------------------------------------------------------------------------------
insert into hooks.endpoints (id, organization_id, url, secret_enc, event_types)
values
  ('e0000000-0000-4000-8000-00000000000a', (select id from fx where label = 'org_a'),
   'https://hooks-a.example.com/selo', repeat('x', 40)::bytea, '{}'),
  ('e0000000-0000-4000-8000-00000000000b', (select id from fx where label = 'org_b'),
   'https://hooks-b.example.com/selo', repeat('y', 40)::bytea, '{}');

do $$
declare v_employee_id uuid := gen_random_uuid();
begin
  insert into fx values ('event_entity', v_employee_id);
  perform app.log_audit_event(
    (select id from fx where label = 'org_a'), (select id from fx where label = 'company_a'),
    'EMPLOYEE_CREATED', 'app.employees', v_employee_id, 'USER', null,
    jsonb_build_object('data_origin', 'MANUAL', 'has_position', false, 'has_location', false));

  -- LINK_VIEWED is a real internal event type that is deliberately NOT publishable: who
  -- opened a confirmation link and when is our audit trail, not a subscriber's business.
  perform app.log_audit_event(
    (select id from fx where label = 'org_a'), (select id from fx where label = 'company_a'),
    'LINK_VIEWED', 'app.confirmation_requests', gen_random_uuid(), 'WORKER', null, '{}'::jsonb);
end $$;

select is(
  (select count(*)::int from hooks.outbox o where o.event_type = 'EMPLOYEE_CREATED'),
  1,
  'a publishable event is enqueued once the organization has an active endpoint'
);

select is(
  (select count(*)::int from hooks.outbox where event_type = 'LINK_VIEWED'),
  0,
  'hooks.event_types is the enqueue allowlist -- an internal event type never enters the outbox'
);

select ok(
  not exists (select 1 from hooks.event_types where webhook_type in ('delivery.refused', 'compliance.changed')),
  'delivery.refused and compliance.changed are absent, deliberately -- no event has those semantics yet'
);

-- ---------------------------------------------------------------------------------------
-- 3. Atomicity: the outbox row lives and dies with the audit row
-- ---------------------------------------------------------------------------------------
do $$
begin
  begin
    perform app.log_audit_event(
      (select id from fx where label = 'org_a'), (select id from fx where label = 'company_a'),
      'DELIVERY_CREATED', 'app.epi_deliveries', gen_random_uuid(), 'USER', null, '{}'::jsonb);
    -- Force the surrounding subtransaction to roll back, exactly as a failing business
    -- operation would after its audit event was written.
    raise exception 'rollback_me';
  exception when others then
    null;
  end;
end $$;

select is(
  (select count(*)::int from hooks.outbox where event_type = 'DELIVERY_CREATED'),
  0,
  'a rolled-back transaction leaves NO outbox row -- the enqueue is not a separate write that can survive'
);

select is(
  (select count(*)::int from audit.audit_events where event_type = 'DELIVERY_CREATED'
     and organization_id = (select id from fx where label = 'org_a')),
  0,
  'and leaves no audit event either -- so the two can never disagree'
);

select is(
  (select count(*)::int from hooks.outbox o
     left join audit.audit_events a on a.id = o.audit_event_id
    where a.id is null),
  0,
  'every outbox row points at an audit event that exists (and audit events can never be deleted)'
);

-- ---------------------------------------------------------------------------------------
-- 4. Fan-out
-- ---------------------------------------------------------------------------------------
do $$
begin
  perform hooks.fan_out(100);
end $$;

select is(
  (select count(*)::int from hooks.deliveries),
  1,
  'fan-out creates one delivery per subscribed endpoint'
);

select is(
  (select count(*)::int
     from hooks.deliveries d
     join hooks.outbox o on o.id = d.outbox_id
     join hooks.endpoints e on e.id = d.endpoint_id
    where e.organization_id <> o.organization_id),
  0,
  'NO delivery ever pairs an event with an endpoint of another organization'
);

select is(
  (select d.endpoint_id from hooks.deliveries d),
  'e0000000-0000-4000-8000-00000000000a'::uuid,
  'org B''s endpoint receives nothing from org A'
);

-- An endpoint that subscribes to a specific list only receives that list.
do $$
declare v_id uuid;
begin
  update hooks.endpoints set event_types = array['delivery.confirmed']
   where id = 'e0000000-0000-4000-8000-00000000000a';

  perform app.log_audit_event(
    (select id from fx where label = 'org_a'), (select id from fx where label = 'company_a'),
    'EMPLOYEE_UPDATED', 'app.employees', gen_random_uuid(), 'USER', null,
    jsonb_build_object('changed_fields', to_jsonb(array['phone_e164'])));
  perform hooks.fan_out(100);

  update hooks.endpoints set event_types = '{}' where id = 'e0000000-0000-4000-8000-00000000000a';
end $$;

select is(
  (select count(*)::int from hooks.deliveries d
     join hooks.outbox o on o.id = d.outbox_id
    where o.event_type = 'EMPLOYEE_UPDATED'),
  0,
  'an endpoint subscribed only to delivery.confirmed is not sent employee.updated'
);

-- ---------------------------------------------------------------------------------------
-- 5. Payload
-- ---------------------------------------------------------------------------------------
do $$
declare v_envelope jsonb;
begin
  select hooks.build_envelope(o.id) into v_envelope
    from hooks.outbox o where o.event_type = 'EMPLOYEE_CREATED' limit 1;
  insert into probe values ('envelope', v_envelope::text);
end $$;

select ok(
  (select (val::jsonb) ? 'id' and (val::jsonb) ? 'type' and (val::jsonb) ? 'sequence'
      and (val::jsonb) ? 'occurred_at' and (val::jsonb) ? 'entity'
   from probe where label = 'envelope'),
  'the envelope carries id, type, sequence, occurred_at and entity'
);

select is(
  (select (val::jsonb)->>'type' from probe where label = 'envelope'),
  'employee.created',
  'the public event name is used, not the internal audit type'
);

select ok(
  (select val !~* '(cpf|full_name|phone|email|signature|canonical|payload_sha|token|nonce)'
   from probe where label = 'envelope'),
  'the envelope contains no CPF, name, phone, email, signature, canonical bytes, token or nonce'
);

select is(
  (select ((val::jsonb)->>'sequence')::bigint from probe where label = 'envelope'),
  (select a.seq from audit.audit_events a
    join fx f on f.label = 'event_entity' and f.id = a.entity_id
   where a.event_type = 'EMPLOYEE_CREATED'),
  'sequence is audit.audit_events.seq -- the per-tenant total order consumers sort on'
);

-- ---------------------------------------------------------------------------------------
-- 6. Claim / report state machine
-- ---------------------------------------------------------------------------------------
do $$
declare v_batch jsonb;
begin
  v_batch := ops_rpc.claim_webhook_batch(10);
  insert into probe values ('claim_count', jsonb_array_length(v_batch->'deliveries')::text);
  insert into probe values ('claim_delivery', v_batch->'deliveries'->0->>'delivery_id');
  insert into probe values ('claim_attempt', v_batch->'deliveries'->0->>'attempt_no');
  insert into probe values ('claim_secret', v_batch->'deliveries'->0->>'secret_enc_b64');
end $$;

select is((select val from probe where label = 'claim_attempt'), '1',
  'claiming increments the attempt counter');

select ok(
  (select val is not null and val <> '' from probe where label = 'claim_secret'),
  'the runner receives the signing secret as ciphertext -- Postgres never holds the key that decrypts it'
);

select is(
  (select state from hooks.deliveries where id = (select val::uuid from probe where label = 'claim_delivery')),
  'IN_FLIGHT',
  'a claimed delivery is IN_FLIGHT, so a concurrent runner cannot claim it again'
);

do $$
declare v_id uuid := (select val::uuid from probe where label = 'claim_delivery');
begin
  -- 500: retryable, so back to PENDING with a future next_attempt_at.
  perform ops_rpc.report_webhook_result(v_id, 1, 500, 'HTTP', 'upstream exploded', 42);
  insert into probe values ('after_500', (select state from hooks.deliveries where id = v_id));
  insert into probe values ('backoff_future',
    (select (next_attempt_at > clock_timestamp())::text from hooks.deliveries where id = v_id));
end $$;

select is((select val from probe where label = 'after_500'), 'PENDING', '5xx is retryable');
select is((select val from probe where label = 'backoff_future'), 'true',
  'the retry is scheduled into the future with jitter, not immediately');

do $$
declare v_id uuid := (select val::uuid from probe where label = 'claim_delivery');
begin
  update hooks.deliveries set state = 'IN_FLIGHT' where id = v_id;
  -- 301: a redirect is a PERMANENT failure. Following it would re-open SSRF after every
  -- address check has already passed.
  perform ops_rpc.report_webhook_result(v_id, 2, 301, 'REDIRECT', 'moved', 10);
  insert into probe values ('after_301', (select state from hooks.deliveries where id = v_id));
end $$;

select is((select val from probe where label = 'after_301'), 'FAILED_PERMANENT',
  'a 3xx is permanent -- the runner never follows a redirect');

do $$
declare v_id uuid := (select val::uuid from probe where label = 'claim_delivery');
begin
  update hooks.deliveries set state = 'IN_FLIGHT', attempts = 12, settled_at = null where id = v_id;
  perform ops_rpc.report_webhook_result(v_id, 3, null, 'TIMEOUT', 'no response', 10000);
  insert into probe values ('after_exhausted', (select state from hooks.deliveries where id = v_id));
end $$;

select is((select val from probe where label = 'after_exhausted'), 'DLQ',
  'a retryable failure on the last attempt lands in the DLQ rather than retrying forever');

do $$
declare v_id uuid := (select val::uuid from probe where label = 'claim_delivery');
begin
  update hooks.endpoints set consecutive_failures = 19 where id = 'e0000000-0000-4000-8000-00000000000a';
  update hooks.deliveries set state = 'IN_FLIGHT', attempts = 1, settled_at = null where id = v_id;
  perform ops_rpc.report_webhook_result(v_id, 4, 410, 'HTTP', 'gone', 5);
  insert into probe values ('endpoint_status',
    (select status from hooks.endpoints where id = 'e0000000-0000-4000-8000-00000000000a'));
end $$;

select is((select val from probe where label = 'endpoint_status'), 'DISABLED',
  'twenty consecutive PERMANENT failures disable the endpoint (5xx never does -- that is just downtime)');

do $$
declare v_id uuid := (select val::uuid from probe where label = 'claim_delivery');
begin
  begin
    update hooks.delivery_attempts set http_status = 200 where delivery_id = v_id;
    insert into probe values ('attempt_mutable', 'ALLOWED');
  exception when others then
    insert into probe values ('attempt_mutable', sqlstate);
  end;
end $$;

select is((select val from probe where label = 'attempt_mutable'), '42501',
  'hooks.delivery_attempts is append-only -- an attempt log that can be edited is not a log');


-- ---------------------------------------------------------------------------------------
-- 7. A revoked endpoint must not leave work queued forever.
--    claim_webhook_batch only ever looks at ACTIVE endpoints, so a PENDING delivery on a
--    revoked one is unreachable -- it sat PENDING indefinitely and kept
--    oldest_pending_seconds growing, which would have armed the runner lateness alarm
--    permanently on a queue that was idle. Found by an end-to-end run, not by reading.
-- ---------------------------------------------------------------------------------------
do $$
declare v_id uuid := (select val::uuid from probe where label = 'claim_delivery');
begin
  update hooks.deliveries set state = 'PENDING', settled_at = null, attempts = 1 where id = v_id;
  update hooks.endpoints set status = 'ACTIVE', consecutive_failures = 0, disabled_at = null,
         disabled_reason = null where id = 'e0000000-0000-4000-8000-00000000000a';
  insert into probe values ('health_pending_before',
    ((ops_rpc.webhook_health())->>'pending'));
end $$;

select is((select val from probe where label = 'health_pending_before'), '1',
  'a PENDING delivery on an ACTIVE endpoint counts as backlog');

do $$
declare v_id uuid := (select val::uuid from probe where label = 'claim_delivery');
begin
  update hooks.endpoints set status = 'REVOKED' where id = 'e0000000-0000-4000-8000-00000000000a';
  insert into probe values ('health_pending_after', ((ops_rpc.webhook_health())->>'pending'));
  insert into probe values ('health_orphaned', ((ops_rpc.webhook_health())->>'orphaned'));
  insert into probe values ('health_oldest', ((ops_rpc.webhook_health())->>'oldest_pending_seconds'));
end $$;

select is((select val from probe where label = 'health_pending_after'), '0',
  'work parked behind a non-ACTIVE endpoint is NOT counted as backlog');

select is((select val from probe where label = 'health_orphaned'), '1',
  'it is reported separately as orphaned rather than hidden -- an operator may still want to see it');

select is((select val from probe where label = 'health_oldest'), '0',
  'and it does not drive oldest_pending_seconds, which is what arms the lateness alarm');

select * from finish();

rollback;
