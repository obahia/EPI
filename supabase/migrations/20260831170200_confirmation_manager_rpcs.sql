-- FASE 3: manager-facing RPC to (re)generate a worker confirmation link. Only the token
-- HASH ever reaches this function -- the raw token is generated in Node
-- (src/lib/crypto/worker-token.ts) and returned straight to the manager's browser response,
-- never stored server-side beyond that single response.
--
-- p_token_hash_b64 is base64 TEXT, not `bytea` directly -- same reasoning as
-- 20260831150200_employee_rpcs.sql's cpf_hash_b64/cpf_enc_b64: a PostgREST JSON-RPC call
-- would otherwise have to send Postgres's own hex-text bytea wire format (`\x...`), a
-- needless coupling to a Postgres-internal detail. decode(x, 'base64') below is exactly
-- what src/lib/crypto/worker-token.ts's Buffer.toString('base64') output expects.

create function api.create_confirmation_link(
  p_delivery_id uuid,
  p_token_hash_b64 text,
  p_ttl_hours int default null
)
returns table (confirmation_request_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_org_id uuid;
  v_status app.delivery_status;
  v_org_ttl int;
  v_required app.assurance_level;
  v_ttl int;
  v_expires timestamptz;
  v_id uuid;
  v_old record;
  v_token_hash bytea;
begin
  select company_id, organization_id, status into v_company_id, v_org_id, v_status
  from app.epi_deliveries where id = p_delivery_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.issue')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_status not in ('ISSUED', 'CONTESTED') then
    raise exception 'delivery_not_open_for_confirmation' using errcode = '23514';
  end if;

  v_token_hash := decode(p_token_hash_b64, 'base64');
  if octet_length(v_token_hash) <> 32 then
    raise exception 'invalid_token_hash' using errcode = '22023';
  end if;

  select link_ttl_hours, default_assurance_level into v_org_ttl, v_required
  from app.organizations where id = v_org_id;
  v_ttl := coalesce(p_ttl_hours, v_org_ttl, 168);
  v_expires := clock_timestamp() + make_interval(hours => v_ttl);

  -- Todo reenvio roda o token: revoke any still-live request for this delivery in the SAME
  -- transaction the new one is issued in (docs/architecture.md §8). The partial unique index
  -- confirmation_requests_one_live_per_delivery would reject the insert below otherwise.
  for v_old in
    select id from app.confirmation_requests
    where delivery_id = p_delivery_id and status in ('SENT', 'VIEWED', 'IDENTITY_FAILED')
    for update
  loop
    perform set_config('app.transition_ok', v_old.id::text, true);
    update app.confirmation_requests
    set status = 'REVOKED', last_event = 'REVOKE', revoked_at = clock_timestamp()
    where id = v_old.id;

    perform app.log_audit_event(v_org_id, v_company_id, 'CONFIRMATION_REVOKED', 'confirmation_requests', v_old.id, 'USER', (select auth.uid()), '{}'::jsonb);
  end loop;

  insert into app.confirmation_requests (
    organization_id, company_id, delivery_id, token_hash, status,
    required_assurance_level, action_nonce, expires_at, created_by
  ) values (
    v_org_id, v_company_id, p_delivery_id, v_token_hash, 'SENT',
    v_required, extensions.gen_random_bytes(16), v_expires, (select auth.uid())
  ) returning id into v_id;

  perform app.log_audit_event(v_org_id, v_company_id, 'CONFIRMATION_CREATED', 'confirmation_requests', v_id, 'USER', (select auth.uid()), jsonb_build_object('delivery_id', p_delivery_id));

  return query select v_id, v_expires;
end;
$$;

comment on function api.create_confirmation_link(uuid, text, int) is
  'Creates (or regenerates -- see the revoke loop) the confirmation_request for an ISSUED/CONTESTED delivery. Caller (Node) has already generated the raw token and hashed it; only the hash is ever passed here. The raw token/link is assembled and shown to the manager by the Server Action that calls this, never persisted server-side beyond that single response.';

revoke execute on function api.create_confirmation_link(uuid, text, int) from public, anon;
grant execute on function api.create_confirmation_link(uuid, text, int) to authenticated;

create function api.resolve_contest(p_contest_id uuid, p_resolution_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_delivery_id uuid;
begin
  select company_id, delivery_id into v_company_id, v_delivery_id
  from app.delivery_contests where id = p_contest_id;

  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'delivery.issue')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_resolution_note is null or length(btrim(p_resolution_note)) < 3 then
    raise exception 'resolution_note_required' using errcode = '23514';
  end if;

  update app.delivery_contests
  set resolved_at = clock_timestamp(), resolved_by = (select auth.uid()), resolution_note = p_resolution_note
  where id = p_contest_id and resolved_at is null;

  if not found then
    raise exception 'already_resolved' using errcode = '23514';
  end if;

  perform app.log_audit_event(
    (select organization_id from app.companies where id = v_company_id),
    v_company_id, 'CONTEST_RESPONDED', 'epi_deliveries', v_delivery_id, 'USER', (select auth.uid()),
    jsonb_build_object('contest_id', p_contest_id)
  );
end;
$$;

comment on function api.resolve_contest(uuid, text) is
  'Records the manager''s written response to a contest. Does not change delivery status (a REISSUE with a corrected delivery is the actual path past a contest, not built yet) -- this only closes the loop on "someone read this and responded", visible in the audit timeline.';

revoke execute on function api.resolve_contest(uuid, text) from public, anon;
grant execute on function api.resolve_contest(uuid, text) to authenticated;
