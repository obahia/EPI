-- FASE 2: read-only projections for the delivery list/detail screens.

create view api.epi_deliveries
  with (security_invoker = true) as
select
  d.id, d.organization_id, d.company_id, d.employee_id, d.chain_id, d.chain_version,
  d.corrects_delivery_id, d.superseded_by_delivery_id, d.status, d.delivery_date, d.note,
  d.issued_at, d.frozen_at, d.confirmed_at, d.contested_at, d.cancelled_at, d.cancel_reason,
  d.created_by, d.created_at, d.updated_at,
  e.full_name as employee_full_name
from app.epi_deliveries d
join app.employees e on e.id = d.employee_id;

comment on view api.epi_deliveries is
  'Delivery list/detail projection, joined to the employee''s current name for display. security_invoker means RLS on epi_deliveries (and, via the join, employees) applies for the caller.';

grant select on api.epi_deliveries to authenticated;

create view api.epi_delivery_items
  with (security_invoker = true) as
select
  id, delivery_id, company_id, line_no, epi_id, epi_version_id,
  epi_name, ca_number, manufacturer, model, quantity, unit, created_at
from app.epi_delivery_items;

comment on view api.epi_delivery_items is
  'Read-only projection of the snapshotted line items -- exactly what was (or will be) presented to the worker, immune to later catalog edits.';

grant select on api.epi_delivery_items to authenticated;
