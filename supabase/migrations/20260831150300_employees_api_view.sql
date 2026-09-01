-- FASE 1: expose employees for reading through the curated `api` schema. Writes stay
-- RPC-only (api.create_employee / api.update_employee / api.import_employees_commit) --
-- there is deliberately no INSERT/UPDATE grant on this view, consistent with
-- docs/architecture.md §7: PostgREST direct writes are never how state changes here.
--
-- cpf_hash and cpf_enc are NOT selected -- there is no legitimate reason for the panel to
-- ever receive them over HTTP. Only cpf_masked (display) is exposed.

create view api.employees
  with (security_invoker = true) as
select
  id, organization_id, company_id, full_name, cpf_masked, registration_number,
  phone_e164, email, position_title, department, status, terminated_on,
  data_origin, external_source, external_ref, created_at, updated_at
from app.employees
where archived_at is null;

comment on view api.employees is
  'Read-only projection of app.employees. Never selects cpf_hash/cpf_enc -- cpf_masked is the only CPF representation that ever crosses HTTP. See docs/architecture.md §6/§16.';

grant select on api.employees to authenticated;
