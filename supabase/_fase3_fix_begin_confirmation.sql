drop function if exists worker.begin_confirmation(text, text);

create function worker.begin_confirmation(p_token_hash_b64 text, p_nonce text)
returns table (cpf_enc_b64 text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req app.confirmation_requests%rowtype;
  v_token_hash bytea := decode(p_token_hash_b64, 'base64');
begin
  if not app.check_rate_limit('begin:' || encode(v_token_hash, 'hex'), 20, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;

  select * into v_req from app.confirmation_requests where token_hash = v_token_hash;
  if not found or v_req.status not in ('VIEWED', 'IDENTITY_FAILED')
     or v_req.expires_at <= clock_timestamp()
     or v_req.nonce_consumed_at is not null
     or v_req.action_nonce is distinct from decode(p_nonce, 'base64')
  then
    raise exception 'link_not_available' using errcode = 'P0002';
  end if;
  if v_req.required_assurance_level <> 'AL1_LINK_KNOWLEDGE' then
    raise exception 'no_challenge_required' using errcode = '23514';
  end if;

  return query
  select encode(em.cpf_enc, 'base64')
  from app.epi_deliveries d
  join app.employees em on em.id = d.employee_id
  where d.id = v_req.delivery_id;
end;
$$;

comment on function worker.begin_confirmation(text, text) is
  'Read-only -- does NOT consume the nonce (worker.finish_confirmation does). Only called when required_assurance_level is AL1_LINK_KNOWLEDGE; an AL0_LINK_ONLY org''s worker flow never calls this at all, so cpf_enc is only ever fetched when a challenge is actually about to happen.';

revoke execute on function worker.begin_confirmation(text, text) from public, authenticated;
grant execute on function worker.begin_confirmation(text, text) to anon;
