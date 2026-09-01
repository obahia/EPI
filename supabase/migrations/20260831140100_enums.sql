-- FASE 0: core enums.
--
-- Fixed value domains are Postgres enums (compact, indexable, impossible values excluded
-- at the type level). The RULES governing state MACHINES (from_state/event/to_state) are
-- kept as plain text in a data table instead (see the FASE 2/3 state_transitions
-- migration) so new transitions can be added by INSERT, without DDL -- see
-- docs/architecture.md §8.

create type app.org_kind as enum ('PARTNER', 'DIRECT');
comment on type app.org_kind is 'PARTNER = SST clinic/white-label reseller owning N client companies. DIRECT = a company that bought directly, owns exactly 1 company.';

create type app.role as enum ('VIEWER', 'SST_OPERATOR', 'COMPANY_ADMIN', 'ORG_ADMIN');
comment on type app.role is 'Ordered least -> most privileged. Employee is never a role here -- an employee is not an authenticated user (docs/architecture.md §3).';

-- Ordered so `achieved_assurance_level >= required_assurance_level` works natively as a
-- CHECK constraint once delivery/confirmation tables exist (FASE 2/3).
create type app.assurance_level as enum (
  'AL0_LINK_ONLY',
  'AL1_LINK_KNOWLEDGE',
  'AL2_SELFIE_LIVENESS',
  'AL3_FACE_MATCH_ENROLLED',
  'AL4_GOV_VERIFIED'
);
comment on type app.assurance_level is
  'Identity assurance ladder, docs/architecture.md §9/§16. AL1 (link + knowledge/OTP challenge, non-biometric) is the recommended default per the LGPD/ANPD research in §16 -- biometric levels (AL2+) are opt-in per organization, never the mandatory path.';

create type app.data_origin as enum ('MANUAL', 'IMPORT', 'SYNC_WOTY', 'API');
comment on type app.data_origin is 'Where an employee/company row''s data came from. SYNC_WOTY rows are provider-owned -- see docs/architecture.md §11.';
