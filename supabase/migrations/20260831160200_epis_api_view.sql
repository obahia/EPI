-- FASE 2: read-only projection joining an epi to its current version -- the shape the
-- catalog list/picker actually wants, without the caller needing to know about the SCD2
-- versioning underneath.

create view api.epis
  with (security_invoker = true) as
select
  e.id, e.organization_id, e.company_id, e.is_active, e.archived_at, e.created_at,
  v.id as current_version_id, v.version, v.name, v.ca_number, v.manufacturer, v.model,
  v.description, v.default_unit, v.valid_from as version_valid_from
from app.epis e
join app.epi_versions v on v.epi_id = e.id and v.valid_to is null
where e.archived_at is null;

comment on view api.epis is
  'One row per active EPI catalog entry, joined to its current version. security_invoker means RLS on both underlying tables applies for the caller.';

grant select on api.epis to authenticated;
