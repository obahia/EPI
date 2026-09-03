-- Audit finding OBS-01: worker.open_link already receives p_client_ip and uses it for rate
-- limiting, but never persists it -- every LINK_VIEWED audit event was logged with either
-- {"read_only": true} or an empty object, and the mockup's own history line ("Link
-- de confirmação aberto pelo funcionário ... IP registrado no evento de auditoria") was not
-- actually true. IP + timestamp is the one signal that catches the realistic fraud here --
-- one person opening forty confirmation links in three minutes from the same office IP,
-- where every individual identity check the system runs still passes, because the right
-- person's credential is genuinely being entered each time. No biometric vendor can see that
-- pattern; the audit log already could, once it actually keeps what it is handed.
--
-- Re-declared for the same reason 20260831190100 re-declared this function: adding a return
-- column or changing behavior needs DROP + CREATE, not ALTER, for a function this shape.

drop function if exists worker.open_link(text, inet);

create function worker.open_link(p_token_hash_b64 text, p_client_ip inet default null)
returns table (
  confirmation_request_id  uuid,
  view_status               app.confirmation_request_status,
  action_nonce              text,
  company_name              text,
  employee_full_name        text,
  delivery_date              date,
  note                       text,
  required_assurance_level  app.assurance_level,
  identity_attempts          smallint,
  identity_max_attempts     smallint,
  items                      jsonb,
  verification_code         text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req app.confirmation_requests%rowtype;
  v_token_hash bytea := decode(p_token_hash_b64, 'base64');
  -- Built once, reused at every log_audit_event call site below -- host(inet) is null-safe
  -- (null in, null out), so this is exactly what was recorded whether or not a caller
  -- supplied an IP.
  v_audit_data jsonb := jsonb_build_object('client_ip', host(p_client_ip));
begin
  if not app.check_rate_limit('open:' || encode(v_token_hash, 'hex'), 20, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;
  if p_client_ip is not null and not app.check_rate_limit('open_ip:' || host(p_client_ip), 60, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;

  select * into v_req from app.confirmation_requests where token_hash = v_token_hash;

  if not found or v_req.status in ('EXPIRED', 'REVOKED') then
    raise exception 'link_not_available' using errcode = 'P0002';
  end if;

  if v_req.status in ('CONFIRMED', 'CONTESTED') then
    perform app.log_audit_event(
      v_req.organization_id, v_req.company_id, 'LINK_VIEWED', 'confirmation_requests', v_req.id,
      'WORKER', null, v_audit_data || jsonb_build_object('read_only', true)
    );
    return query
    select
      v_req.id, v_req.status, null::text,
      coalesce(c.trade_name, c.legal_name), e.full_name, d.delivery_date, d.note,
      v_req.required_assurance_level, v_req.identity_attempts, v_req.identity_max_attempts,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'epi_name', i.epi_name, 'ca_number', i.ca_number, 'manufacturer', i.manufacturer,
          'model', i.model, 'quantity', i.quantity, 'unit', i.unit
        ) order by i.line_no), '[]'::jsonb)
        from app.epi_delivery_items i where i.delivery_id = d.id
      ),
      (
        select doc.verification_code
        from evidence.evidence_versions ev
        join evidence.documents doc on doc.evidence_version_id = ev.id
        where ev.delivery_id = d.id
        order by ev.chain_version desc
        limit 1
      )
    from app.epi_deliveries d
    join app.companies c on c.id = d.company_id
    join app.employees e on e.id = d.employee_id
    where d.id = v_req.delivery_id;
    return;
  end if;

  if v_req.expires_at <= clock_timestamp() then
    perform set_config('app.transition_ok', v_req.id::text, true);
    update app.confirmation_requests set status = 'EXPIRED', last_event = 'EXPIRE' where id = v_req.id;
    perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'CONFIRMATION_EXPIRED', 'confirmation_requests', v_req.id, 'SYSTEM', null, v_audit_data);
    raise exception 'link_not_available' using errcode = 'P0002';
  end if;

  if v_req.status = 'SENT' then
    perform set_config('app.transition_ok', v_req.id::text, true);
    update app.confirmation_requests
    set status = 'VIEWED', last_event = 'VIEW', viewed_at = clock_timestamp(),
        action_nonce = extensions.gen_random_bytes(16), nonce_consumed_at = null
    where id = v_req.id
    returning * into v_req;
  else
    update app.confirmation_requests
    set action_nonce = extensions.gen_random_bytes(16), nonce_consumed_at = null
    where id = v_req.id
    returning * into v_req;
  end if;

  perform app.log_audit_event(v_req.organization_id, v_req.company_id, 'LINK_VIEWED', 'confirmation_requests', v_req.id, 'WORKER', null, v_audit_data);

  return query
  select
    v_req.id,
    v_req.status,
    encode(v_req.action_nonce, 'base64'),
    coalesce(c.trade_name, c.legal_name),
    e.full_name,
    d.delivery_date,
    d.note,
    v_req.required_assurance_level, v_req.identity_attempts, v_req.identity_max_attempts,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'epi_name', i.epi_name, 'ca_number', i.ca_number, 'manufacturer', i.manufacturer,
        'model', i.model, 'quantity', i.quantity, 'unit', i.unit
      ) order by i.line_no), '[]'::jsonb)
      from app.epi_delivery_items i where i.delivery_id = d.id
    ),
    null::text
  from app.epi_deliveries d
  join app.companies c on c.id = d.company_id
  join app.employees e on e.id = d.employee_id
  where d.id = v_req.delivery_id;
end;
$$;

comment on function worker.open_link(text, inet) is
  'Every load of /e/<token> and /e/s/<view-id> calls this. Repeatable (viewing never consumes anything) -- reissues action_nonce every call so an old rendered page can never submit. Never reveals the CPF challenge material -- see worker.begin_confirmation. verification_code is populated only in the CONFIRMED read-only branch (evidence is only ever sealed for a genuine confirmation, never a contest). Persists p_client_ip into every LINK_VIEWED/CONFIRMATION_EXPIRED audit event''s data (host(inet) is null-safe, so a caller that omits the IP simply logs client_ip: null, same as before this migration).';

revoke execute on function worker.open_link(text, inet) from public, authenticated;
grant execute on function worker.open_link(text, inet) to anon;
