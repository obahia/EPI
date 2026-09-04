-- Phase D: deterministic EPI compliance engine (spec §12 CONFORMIDADE / §13 DASHBOARD
-- OPERACIONAL / §14 FICHA DO COLABORADOR). Formal contract negotiated and approved before
-- this file was written -- see the closure-audit conversation for the full derivation. This
-- comment only records the load-bearing decisions, not the whole reasoning.
--
-- External contract (never changes): CONFORME | ATENÇÃO | NÃO CONFORME, plus a 4th
-- presentation-only bucket INDETERMINADO for "could not be evaluated" (missing cargo/matrix)
-- -- INDETERMINADO is never counted as conforme or não-conforme in any aggregate/percentage.
--
-- Internal per-requirement states: SEM_CARGO, MATRIZ_VAZIA (both -> INDETERMINADO),
-- OPCIONAL (required=false, never gates the aggregate), NUNCA_ENTREGUE,
-- QUANTIDADE_INSUFICIENTE, ITEM_VENCIDO (all three -> NÃO CONFORME), PROXIMO_DA_TROCA
-- (-> ATENÇÃO), OK (-> CONFORME, also used for the "matrix has rows but none required"
-- case at the aggregate level, reason SEM_REQUISITOS_OBRIGATORIOS).
--
-- held_items = CONFIRMED delivery + matching epi_id + no app.epi_returns row for that item.
-- Deliberately identical to api.employee_epi_lifecycle's own base set: SUPERSEDED/DRAFT/
-- ISSUED/CONTESTED/CANCELLED never count, so a troca in progress (original SUPERSEDED,
-- replacement not yet CONFIRMED) is a real, correctly-reported compliance gap -- not a bug,
-- confirmed against spec §8's own flow (devolução do anterior precedes nova entrega) and
-- against api.create_replacement_delivery's already-shipped SUPERSEDED-at-creation behavior,
-- neither of which this migration may change.
--
-- effective_periodicity_days = coalesce(requirement.periodicity_days, item.lifespan_days).
-- due_date = confirmed_at::date + effective_periodicity_days (null if no periodicity at all
-- -- the item never expires). Boundary arithmetic (< for overdue, <= replacement_alert_days
-- for due-soon) is copied verbatim from api.employee_epi_lifecycle so the two views of the
-- same delivery item can never contradict each other on the same day.
--
-- required=false requirements are computed (state OPCIONAL) but never gate the aggregate and
-- never enter the compliance_percent denominator.

-- One row per (employee, requirement), for every employee of a company -- including those
-- with no position_id or an empty matrix (left-joined, not filtered out), so the aggregate
-- function below can tell "nothing to evaluate" apart from "evaluated and fine". Internal
-- only: not SECURITY DEFINER, never granted to authenticated -- always called from inside an
-- already-permission-checked api.* function, same convention as app.log_audit_event.
create function app.compliance_requirement_rows(p_company_id uuid, p_employee_id uuid default null)
returns table (
  employee_id uuid,
  employee_full_name text,
  employee_status text,
  position_id uuid,
  position_title text,
  requirement_id uuid,
  epi_id uuid,
  epi_name text,
  ca_number text,
  required boolean,
  required_quantity integer,
  held_quantity integer,
  fresh_quantity integer,
  earliest_due_date date,
  state text
)
language sql
stable
set search_path = ''
as $$
  with base_employees as (
    select e.id as employee_id, e.full_name as employee_full_name, e.status as employee_status,
           e.position_id
    from app.employees e
    where e.company_id = p_company_id
      and e.archived_at is null
      and (p_employee_id is null or e.id = p_employee_id)
  ),
  org as (
    select coalesce(o.replacement_alert_days, 30) as replacement_alert_days
    from app.organizations o
    join app.companies c on c.organization_id = o.id
    where c.id = p_company_id
    limit 1
  ),
  reqs as (
    select
      be.employee_id, be.employee_full_name, be.employee_status,
      be.position_id, jp.title as position_title,
      r.id as requirement_id, r.epi_id, ev.name as epi_name, ev.ca_number,
      r.required, r.quantity as required_quantity, r.periodicity_days
    from base_employees be
    left join app.job_positions jp on jp.id = be.position_id
    left join app.position_epi_requirements r on r.position_id = jp.id
    left join app.epi_versions ev on ev.epi_id = r.epi_id and ev.valid_to is null
  ),
  items_due as (
    select
      reqs.employee_id, reqs.requirement_id, i.quantity,
      case
        when coalesce(reqs.periodicity_days, i.lifespan_days) is null then null
        else d.confirmed_at::date + coalesce(reqs.periodicity_days, i.lifespan_days)
      end as due_date
    from reqs
    join app.epi_deliveries d on d.employee_id = reqs.employee_id
    join app.epi_delivery_items i on i.delivery_id = d.id and i.epi_id = reqs.epi_id
    left join app.epi_returns ret on ret.delivery_item_id = i.id
    where reqs.requirement_id is not null
      and d.status = 'CONFIRMED'
      and ret.id is null
  ),
  agg as (
    select
      employee_id, requirement_id,
      sum(quantity)::int as total_held,
      sum(quantity) filter (where due_date is null or due_date >= current_date)::int as fresh_quantity,
      min(due_date) filter (where due_date is not null and due_date >= current_date) as earliest_fresh_due
    from items_due
    group by employee_id, requirement_id
  )
  select
    reqs.employee_id, reqs.employee_full_name, reqs.employee_status,
    reqs.position_id, reqs.position_title,
    reqs.requirement_id, reqs.epi_id, reqs.epi_name, reqs.ca_number,
    reqs.required, reqs.required_quantity,
    coalesce(agg.total_held, 0), coalesce(agg.fresh_quantity, 0),
    agg.earliest_fresh_due,
    case
      when reqs.position_id is null then 'SEM_CARGO'
      when reqs.requirement_id is null then 'MATRIZ_VAZIA'
      when not reqs.required then 'OPCIONAL'
      when coalesce(agg.total_held, 0) = 0 then 'NUNCA_ENTREGUE'
      when agg.total_held < reqs.required_quantity then 'QUANTIDADE_INSUFICIENTE'
      when agg.fresh_quantity < reqs.required_quantity then 'ITEM_VENCIDO'
      when agg.earliest_fresh_due is not null
        and agg.earliest_fresh_due <= current_date + (select replacement_alert_days from org)
        then 'PROXIMO_DA_TROCA'
      else 'OK'
    end as state
  from reqs
  left join agg on agg.employee_id = reqs.employee_id and agg.requirement_id = reqs.requirement_id
$$;

comment on function app.compliance_requirement_rows(uuid, uuid) is
  'Canonical per-(employee, requirement) compliance computation -- the one source every api.*_compliance_* RPC reads from. p_employee_id NULL computes for every employee of the company. Internal only, never granted to authenticated.';

-- One row per employee: the 3-state aggregate (plus INDETERMINADO) derived from the rows
-- above by the single precedence rule the contract defines -- SEM_CARGO/MATRIZ_VAZIA first,
-- then worst-of(required rows), matrix-with-no-required-rows counts as CONFORME.
create function app.compliance_aggregate_rows(p_company_id uuid, p_employee_id uuid default null)
returns table (
  employee_id uuid,
  employee_full_name text,
  employee_status text,
  position_id uuid,
  position_title text,
  aggregate_state text,
  aggregate_reason text,
  required_total integer,
  required_ok integer,
  compliance_percent numeric
)
language sql
stable
set search_path = ''
as $$
  with rows as (
    select * from app.compliance_requirement_rows(p_company_id, p_employee_id)
  ),
  per_employee as (
    select
      employee_id, employee_full_name, employee_status, position_id, position_title,
      bool_or(state = 'SEM_CARGO') as has_sem_cargo,
      bool_or(state = 'MATRIZ_VAZIA') as has_matriz_vazia,
      count(*) filter (where required) as required_total,
      count(*) filter (where required and state in ('OK', 'PROXIMO_DA_TROCA')) as required_ok,
      bool_or(required and state in ('NUNCA_ENTREGUE', 'QUANTIDADE_INSUFICIENTE', 'ITEM_VENCIDO')) as has_nao_conforme,
      bool_or(required and state = 'PROXIMO_DA_TROCA') as has_atencao
    from rows
    group by employee_id, employee_full_name, employee_status, position_id, position_title
  )
  select
    employee_id, employee_full_name, employee_status, position_id, position_title,
    case
      when has_sem_cargo then 'INDETERMINADO'
      when has_matriz_vazia then 'INDETERMINADO'
      when required_total = 0 then 'CONFORME'
      when has_nao_conforme then 'NAO_CONFORME'
      when has_atencao then 'ATENCAO'
      else 'CONFORME'
    end as aggregate_state,
    case
      when has_sem_cargo then 'SEM_CARGO'
      when has_matriz_vazia then 'MATRIZ_VAZIA'
      when required_total = 0 then 'SEM_REQUISITOS_OBRIGATORIOS'
      when has_nao_conforme then 'REQUISITOS_PENDENTES'
      when has_atencao then 'PROXIMO_DA_TROCA'
      else 'OK'
    end as aggregate_reason,
    required_total::int, required_ok::int,
    case when required_total = 0 then null
         else round(required_ok::numeric / required_total::numeric * 100, 1) end as compliance_percent
  from per_employee
$$;

comment on function app.compliance_aggregate_rows(uuid, uuid) is
  'Canonical per-employee 3-state (+INDETERMINADO) aggregate, derived from app.compliance_requirement_rows by the one precedence rule the contract defines. Internal only, never granted to authenticated.';

-- New permission, seeded at the same tier as employee.read/position.read (every existing
-- role already has read access to employees and the matrix; compliance is a read
-- composition of both, not a new write capability).
insert into authz.role_permissions (role, permission) values
  ('VIEWER', 'compliance.read'),
  ('SST_OPERATOR', 'compliance.read'),
  ('COMPANY_ADMIN', 'compliance.read'),
  ('ORG_ADMIN', 'compliance.read');

-- api RPCs -----------------------------------------------------------------------------

-- Full per-requirement breakdown for one employee -- the ficha-360's "why" (spec §12: "a
-- arquitetura deve permitir explicar exatamente POR QUE"). compliance_enabled=false raises
-- feature_disabled -- it never returns a fabricated state, per the explicit rule that a
-- feature flag is not itself a compliance state.
create function api.employee_compliance_detail(p_employee_id uuid)
returns table (
  requirement_id uuid,
  epi_id uuid,
  epi_name text,
  ca_number text,
  required boolean,
  required_quantity integer,
  held_quantity integer,
  fresh_quantity integer,
  earliest_due_date date,
  state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_org_id uuid;
  v_compliance_enabled boolean;
begin
  select company_id into v_company_id from app.employees where id = p_employee_id and archived_at is null;
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'compliance.read')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select o.id, o.compliance_enabled into v_org_id, v_compliance_enabled
  from app.organizations o join app.companies c on c.organization_id = o.id
  where c.id = v_company_id;
  if not coalesce(v_compliance_enabled, false) then
    raise exception 'feature_disabled' using errcode = '23514';
  end if;

  return query
  select
    r.requirement_id, r.epi_id, r.epi_name, r.ca_number,
    r.required, r.required_quantity, r.held_quantity, r.fresh_quantity, r.earliest_due_date, r.state
  from app.compliance_requirement_rows(v_company_id, p_employee_id) r
  order by (not r.required), r.epi_name;
end;
$$;

comment on function api.employee_compliance_detail(uuid) is
  'Per-requirement compliance breakdown for one employee, the ficha-360''s explainability surface. Requires compliance.read + the organization''s compliance_enabled flag; raises feature_disabled (not a fabricated state) when the flag is off.';

revoke execute on function api.employee_compliance_detail(uuid) from public, anon;
grant execute on function api.employee_compliance_detail(uuid) to authenticated;

-- The single aggregate for one employee -- what the ficha header badge and any per-employee
-- list row render.
create function api.employee_compliance_summary(p_employee_id uuid)
returns table (
  aggregate_state text,
  aggregate_reason text,
  required_total integer,
  required_ok integer,
  compliance_percent numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_compliance_enabled boolean;
begin
  select company_id into v_company_id from app.employees where id = p_employee_id and archived_at is null;
  if v_company_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_permission(v_company_id, 'compliance.read')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select o.compliance_enabled into v_compliance_enabled
  from app.organizations o join app.companies c on c.organization_id = o.id
  where c.id = v_company_id;
  if not coalesce(v_compliance_enabled, false) then
    raise exception 'feature_disabled' using errcode = '23514';
  end if;

  return query
  select a.aggregate_state, a.aggregate_reason, a.required_total, a.required_ok, a.compliance_percent
  from app.compliance_aggregate_rows(v_company_id, p_employee_id) a;
end;
$$;

comment on function api.employee_compliance_summary(uuid) is
  'The 3-state (+INDETERMINADO) aggregate for one employee, from the same canonical rows api.employee_compliance_detail uses. Requires compliance.read + compliance_enabled.';

revoke execute on function api.employee_compliance_summary(uuid) from public, anon;
grant execute on function api.employee_compliance_summary(uuid) to authenticated;

-- One aggregate row per employee of a company -- the dashboard's "% conformes" / "quem
-- precisa de atenção" surface (spec §13). Same canonical computation, batched for the whole
-- company in one query (no N+1 over employee_compliance_summary).
create function api.company_compliance_summary(p_company_id uuid)
returns table (
  employee_id uuid,
  employee_full_name text,
  employee_status text,
  position_id uuid,
  position_title text,
  aggregate_state text,
  aggregate_reason text,
  required_total integer,
  required_ok integer,
  compliance_percent numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_compliance_enabled boolean;
begin
  if not (select auth_ctx.has_permission(p_company_id, 'compliance.read')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select o.compliance_enabled into v_compliance_enabled
  from app.organizations o join app.companies c on c.organization_id = o.id
  where c.id = p_company_id;
  if not coalesce(v_compliance_enabled, false) then
    raise exception 'feature_disabled' using errcode = '23514';
  end if;

  return query
  select
    a.employee_id, a.employee_full_name, a.employee_status, a.position_id, a.position_title,
    a.aggregate_state, a.aggregate_reason, a.required_total, a.required_ok, a.compliance_percent
  from app.compliance_aggregate_rows(p_company_id, null) a;
end;
$$;

comment on function api.company_compliance_summary(uuid) is
  'One compliance aggregate row per employee of a company, batched (no N+1). Requires compliance.read + compliance_enabled.';

revoke execute on function api.company_compliance_summary(uuid) from public, anon;
grant execute on function api.company_compliance_summary(uuid) to authenticated;
