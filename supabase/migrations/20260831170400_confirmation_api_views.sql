-- FASE 3: read-only projections for the delivery detail screen's confirmation/identity/
-- contest panels.

create view api.confirmation_requests
  with (security_invoker = true) as
select
  id, company_id, delivery_id, status, status_changed_at, required_assurance_level,
  achieved_assurance_level, identity_attempts, identity_max_attempts, viewed_at,
  confirmed_at, contested_at, expires_at, revoked_at, consumed_at, created_at, created_by
from app.confirmation_requests;

comment on view api.confirmation_requests is
  'Read-only projection -- token_hash, action_nonce never selected (there is no legitimate reason for the panel to see either). security_invoker means the underlying table''s RLS applies for the caller.';

grant select on api.confirmation_requests to authenticated;

create view api.identity_verifications
  with (security_invoker = true) as
select
  id, company_id, delivery_id, confirmation_request_id, provider, method, result,
  achieved_assurance_level, match_score, created_at
from app.identity_verifications;

comment on view api.identity_verifications is
  'Read-only projection -- image_sha256 (a hash pointer, not the image itself) is omitted; nothing here has ever been a raw biometric.';

grant select on api.identity_verifications to authenticated;

create view api.delivery_contests
  with (security_invoker = true) as
select
  id, company_id, delivery_id, confirmation_request_id, reason_code, comment,
  raised_assurance_level, created_at, resolved_at, resolved_by, resolution_note
from app.delivery_contests;

comment on view api.delivery_contests is
  'Read-only projection of contest history for a delivery. Writing resolved_at/resolved_by/resolution_note goes through api.resolve_contest, never a direct UPDATE.';

grant select on api.delivery_contests to authenticated;
