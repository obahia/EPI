-- DAT-01 follow-up: worker.verify_document is the one document surface a stranger --
-- auditor, fiscal, opposing counsel -- can open with no login at all, and it was still
-- rendering sealed_at in a hardcoded Brasília zone regardless of which company sealed it.
-- A company in Acre (UTC-5) showed a sealed_at up to two hours off from what actually
-- happened, on the exact page meant to let an outsider independently verify a receipt.
--
-- Adds the organization's IANA zone to the return row. Not a privacy concession: a time
-- zone name is no more sensitive than the company_name this function already discloses,
-- and disclosure here stays exactly what docs/architecture.md §8 already allows -- nothing
-- about the worker, the items, or the CA is added.

drop function worker.verify_document(text);

create function worker.verify_document(p_code text)
returns table (
  verification_code text,
  status             text,
  company_name       text,
  company_time_zone  text,
  sealed_at          timestamptz,
  hash_prefix        text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc evidence.documents%rowtype;
begin
  if not app.check_rate_limit('verify:' || upper(p_code), 30, 300) then
    raise exception 'rate_limited' using errcode = '57014';
  end if;

  select * into v_doc from evidence.documents d where d.verification_code = upper(p_code);
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  return query
  select
    v_doc.verification_code,
    'CONFIRMADO'::text,
    coalesce(c.trade_name, c.legal_name),
    o.timezone,
    ev.sealed_at,
    left(encode(ev.payload_sha256, 'hex'), 12)
  from evidence.evidence_versions ev
  join app.companies c on c.id = ev.company_id
  join app.organizations o on o.id = c.organization_id
  where ev.id = v_doc.evidence_version_id;
end;
$$;

comment on function worker.verify_document(text) is
  'The /verify/<code> page''s only data source. Never returns the worker''s name, CPF (masked or not), items, or CA -- docs/architecture.md §8''s minimal-disclosure list for this exact endpoint. company_time_zone (added here) is the one addition since that comment was written -- a zone name carries no more than company_name already does, and it is what lets this page state sealed_at correctly for a company outside Brasília time.';

revoke execute on function worker.verify_document(text) from public, authenticated;
grant execute on function worker.verify_document(text) to anon;
