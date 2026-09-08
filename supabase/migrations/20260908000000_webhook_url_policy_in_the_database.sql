-- Phase F security fix, found by an end-to-end webhook run against production.
--
-- The structural URL policy for webhook endpoints -- https only, port 443 only, no
-- userinfo, no IP literal, no internal hostname -- existed ONLY in TypeScript, inside the
-- Server Action (src/app/(dashboard)/settings/integrations/actions.ts). The database's own
-- guard was just `url ~ '^https://[a-zA-Z0-9]'`.
--
-- api.create_webhook_endpoint is granted to `authenticated`, so any ORG_ADMIN calling the
-- RPC directly through PostgREST -- which is one fetch away, not a hypothetical -- bypassed
-- the whole policy. A test that expected three rejections got three ACCEPTED endpoints:
--
--     https://93.184.216.34/hook      IP literal
--     https://api.internal/hook       internal hostname
--     https://exemplo.com:8443/hook   non-443 port
--
-- No SSRF actually occurred: the runner re-validates every URL at delivery time and refuses
-- (src/lib/webhooks/ssrf.ts), and that second layer is what held. But an endpoint that
-- cannot be delivered to should never have been storable, the operator got no feedback, and
-- relying on the delivery-time check alone makes the creation-time check decorative.
--
-- The policy now lives where every writer must pass it, including a direct table INSERT.

create function hooks.is_public_https_url(p_url text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_rest text;
  v_authority text;
  v_host text;
begin
  if p_url is null or length(p_url) > 2000 then return false; end if;
  if left(p_url, 8) <> 'https://' then return false; end if;

  -- Authority is everything up to the first '/', '?' or '#' after the scheme.
  v_rest := substr(p_url, 9);
  v_authority := split_part(split_part(split_part(v_rest, '/', 1), '?', 1), '#', 1);
  if v_authority = '' then return false; end if;

  -- https://user:pass@host -- credentials in a stored URL are never acceptable.
  if position('@' in v_authority) > 0 then return false; end if;

  if position(':' in v_authority) > 0 then
    -- A colon is either an explicit port or an unbracketed IPv6 literal. Only ':443' passes.
    if split_part(v_authority, ':', 2) <> '443' then return false; end if;
    if split_part(v_authority, ':', 3) <> '' then return false; end if;
    v_host := split_part(v_authority, ':', 1);
  else
    v_host := v_authority;
  end if;

  v_host := lower(rtrim(v_host, '.'));
  if v_host = '' then return false; end if;

  -- A bracketed host is an IPv6 literal. Refused outright: an endpoint that names an address
  -- rather than a host has no legitimate use here, and allowing it would mean implementing
  -- the whole address policy twice -- once here and once in the runner.
  if left(v_host, 1) = '[' then return false; end if;
  if v_host ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' then return false; end if;

  -- No dot means a bare internal name (an intranet host, a container alias).
  if position('.' in v_host) = 0 then return false; end if;
  if v_host = 'localhost' then return false; end if;
  if v_host ~ '(\.localhost|\.local|\.internal|\.cluster\.local|\.svc|\.home\.arpa)$' then
    return false;
  end if;

  return true;
end;
$$;

comment on function hooks.is_public_https_url(text) is
  'Structural URL policy for webhook endpoints, mirroring checkWebhookUrl in src/lib/webhooks/ssrf.ts. Deliberately duplicated rather than trusted to the application: the RPC that creates endpoints is callable by any ORG_ADMIN straight through PostgREST, so a policy that lives only in a Server Action is a policy with a documented bypass. This is the structural half only -- DNS resolution and address validation cannot happen in an IMMUTABLE function and remain the runner''s job, re-checked on every single attempt.';

-- NOT VALID on purpose. It enforces on every INSERT and UPDATE from now on, but skips the
-- initial scan -- the epi-dev project already holds the three malformed rows the test above
-- created (now revoked). A fresh database, which is what CI builds, has no such rows.
-- Validating later, after those rows are removed, is a one-line follow-up.
alter table hooks.endpoints
  add constraint endpoints_url_public_https_ck
  check (hooks.is_public_https_url(url)) not valid;

-- The RPC checks first so the caller gets a named signal instead of a raw constraint
-- violation, which the API error contract can then map deliberately.
create or replace function api.create_webhook_endpoint(
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

  if not hooks.is_public_https_url(p_url) then
    raise exception 'invalid_webhook_url' using errcode = '23514';
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

-- Reactivating an endpoint must re-check the URL too: a row stored before this migration
-- (or one whose policy has since tightened) must not be brought back into service just
-- because it already exists.
create or replace function api.set_webhook_endpoint_status(p_endpoint_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_url text;
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

  if p_status = 'ACTIVE' and not hooks.is_public_https_url(v_url) then
    raise exception 'invalid_webhook_url' using errcode = '23514';
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
