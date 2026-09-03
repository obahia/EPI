-- Audit finding DAT-01: every timestamp the app renders was pinned to a single hardcoded
-- America/Sao_Paulo (src/lib/format/datetime.ts), correct for the large majority of the
-- market but wrong for a company in Acre (UTC-5) or any other non-Brasília zone -- on a
-- document a fiscal reads, that is not a cosmetic difference. app.organizations already
-- has a `timezone` column (not null, defaulted to 'America/Sao_Paulo' since FASE 0) that
-- nothing in the application has ever read or exposed. This adds it to api.companies
-- rather than introducing a second column on app.companies: a company's timezone is a
-- property of the legal entity operating it, one setting per organization is the right
-- grain, and CREATE OR REPLACE VIEW can add a trailing column without dropping the view
-- (same pattern as 20260831200400's batch_id addition).
--
-- LEFT JOIN, not JOIN: if a caller could somehow see a company row but not its parent
-- organization row (should never happen under organizations_select's own policy, but this
-- view must never let a join silently drop a company from a list over it), the company
-- still returns, with time_zone null -- callers already fall back to
-- BRAZIL_TIME_ZONE_LABEL's default when unset.

create or replace view api.companies
  with (security_invoker = true) as
select c.id, c.organization_id, c.organization_kind, c.cnpj, c.legal_name, c.trade_name,
       c.status, c.archived_at, c.created_at, c.updated_at,
       o.timezone as time_zone
from app.companies c
left join app.organizations o on o.id = c.organization_id;

comment on view api.companies is
  'Company list/detail projection. security_invoker means RLS on companies (and, via the join, organizations) applies for the caller. time_zone (added here) is the parent organization''s app.organizations.timezone -- there is no per-company override today.';

grant select on api.companies to authenticated;
