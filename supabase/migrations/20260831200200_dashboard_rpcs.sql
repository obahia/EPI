-- FASE 6: operational dashboard -- answers questions ("is there an unconfirmed delivery
-- that's been sitting for a week?"), not decorative charts. One aggregate RPC (cheap,
-- indexed) plus a company-wide activity feed reusing the audit trail already built in
-- FASE 3.

create function api.dashboard_summary(p_company_id uuid, p_since date default (current_date - 30))
returns table (
  active_employees_count       int,
  deliveries_in_period          int,
  confirmed_count                int,
  pending_count                   int,
  contested_count                 int,
  cancelled_count                  int,
  pending_over_3_days_count       int,
  pending_over_7_days_count       int
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_permission(p_company_id, 'delivery.read')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select
    (select count(*)::int from app.employees where company_id = p_company_id and status = 'ACTIVE' and archived_at is null),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and delivery_date >= p_since),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and delivery_date >= p_since and status = 'CONFIRMED'),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and delivery_date >= p_since and status = 'ISSUED'),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and delivery_date >= p_since and status = 'CONTESTED'),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and delivery_date >= p_since and status = 'CANCELLED'),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and status = 'ISSUED' and issued_at < clock_timestamp() - interval '3 days'),
    (select count(*)::int from app.epi_deliveries where company_id = p_company_id and status = 'ISSUED' and issued_at < clock_timestamp() - interval '7 days');
end;
$$;

comment on function api.dashboard_summary(uuid, date) is
  'Operational counters for one company, over the trailing window ending today (p_since, default 30 days back for the period counts -- the two "pending over N days" counts are NOT period-bound, since a delivery stuck for 8 days matters regardless of when it was created). Every count is a simple indexed aggregate -- no decorative chart data, just the numbers a manager actually needs (docs/mvp-roadmap.md FASE 6).';

revoke execute on function api.dashboard_summary(uuid, date) from public, anon;
grant execute on function api.dashboard_summary(uuid, date) to authenticated;

-- Company-wide activity feed -- the same audit trail api.delivery_audit_events reads
-- per-delivery, here across every delivery/confirmation_request/batch for one company.
create function api.company_audit_events(p_company_id uuid, p_limit int default 50)
returns table (
  id uuid, seq bigint, event_type text, actor_kind text, actor_user_id uuid,
  entity_table text, entity_id uuid, data jsonb, created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_permission(p_company_id, 'audit.read')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_limit < 1 or p_limit > 200 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  return query
  select ae.id, ae.seq, ae.event_type, ae.actor_kind, ae.actor_user_id, ae.entity_table, ae.entity_id, ae.data, ae.created_at
  from audit.audit_events ae
  where ae.company_id = p_company_id
  order by ae.created_at desc
  limit p_limit;
end;
$$;

comment on function api.company_audit_events(uuid, int) is
  'The dashboard''s "últimas atividades" feed -- every audit event for one company, newest first, capped at 200 rows per call (paginate by calling again with a smaller p_limit and filtering client-side by created_at if a manager needs to go further back -- this is a glance-at-recent-activity feed, not an audit export).';

revoke execute on function api.company_audit_events(uuid, int) from public, anon;
grant execute on function api.company_audit_events(uuid, int) to authenticated;

-- Read-only projections for the batch list/detail screens.
create view api.delivery_batches
  with (security_invoker = true) as
select id, organization_id, company_id, delivery_date, note, total_count, confirmed_count,
       contested_count, cancelled_count, created_by, created_at
from app.delivery_batches;

comment on view api.delivery_batches is
  'Read-only projection of app.delivery_batches. security_invoker means RLS on the base table applies for the caller.';

grant select on api.delivery_batches to authenticated;
