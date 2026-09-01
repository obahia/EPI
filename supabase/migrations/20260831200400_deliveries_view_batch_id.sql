-- FASE 6: adds batch_id to api.epi_deliveries (created in FASE 2, before app.epi_deliveries
-- had this column). CREATE OR REPLACE VIEW can add a new trailing column to an
-- already-applied view without DROP, as long as every pre-existing column keeps its
-- position/name/type -- this is that case.

create or replace view api.epi_deliveries
  with (security_invoker = true) as
select
  d.id, d.organization_id, d.company_id, d.employee_id, d.chain_id, d.chain_version,
  d.corrects_delivery_id, d.superseded_by_delivery_id, d.status, d.delivery_date, d.note,
  d.issued_at, d.frozen_at, d.confirmed_at, d.contested_at, d.cancelled_at, d.cancel_reason,
  d.created_by, d.created_at, d.updated_at,
  e.full_name as employee_full_name,
  d.batch_id
from app.epi_deliveries d
join app.employees e on e.id = d.employee_id;

comment on view api.epi_deliveries is
  'Delivery list/detail projection, joined to the employee''s current name for display. security_invoker means RLS on epi_deliveries (and, via the join, employees) applies for the caller. batch_id (FASE 6) is null for individually-created deliveries.';
