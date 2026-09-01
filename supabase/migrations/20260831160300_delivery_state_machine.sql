-- FASE 2: the DELIVERY state machine, as data (app.state_transitions, created empty in
-- FASE 0) plus the generic trigger function that enforces it. See docs/architecture.md §8.
--
-- The full machine is seeded now, including edges FASE 2 has no UI for yet
-- (REQUEST_CONFIRMED/REQUEST_CONTESTED fire from the confirmation flow, FASE 3; SUPERSEDE
-- fires from a correction flow, FASE 5) -- the machine is meant to be complete and
-- queryable as data from the start, not grown edge-by-edge per phase. Only ISSUE and
-- CANCEL are reachable from FASE 2's own RPCs.

create type app.delivery_status as enum ('DRAFT', 'ISSUED', 'CONFIRMED', 'CONTESTED', 'CANCELLED', 'SUPERSEDED');
comment on type app.delivery_status is
  'The business-fact lifecycle of a delivery. Deliberately separate from the confirmation ATTEMPT lifecycle (FASE 3''s confirmation_requests.status) -- see docs/architecture.md §8 for why merging them was rejected: a resend would have to overwrite the record of the first attempt.';

insert into app.state_transitions (machine, machine_version, from_state, event, to_state, actor_kinds, required_permission, is_terminal, introduced_in) values
  ('DELIVERY', 1, 'DRAFT',     'ISSUE',             'ISSUED',     array['USER'],   'delivery.issue',  false, '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'DRAFT',     'CANCEL',            'CANCELLED',  array['USER'],   'delivery.cancel', true,  '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'ISSUED',    'CANCEL',            'CANCELLED',  array['USER'],   'delivery.cancel', true,  '20260831160300_delivery_state_machine.sql'),
  -- FASE 3: fired by the worker confirmation flow (app.confirm_delivery / app.contest_delivery), not built yet.
  ('DELIVERY', 1, 'ISSUED',    'REQUEST_CONFIRMED', 'CONFIRMED',  array['SYSTEM'], null,              false, '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'ISSUED',    'REQUEST_CONTESTED', 'CONTESTED',  array['SYSTEM'], null,              false, '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'ISSUED',    'REISSUE',           'ISSUED',     array['USER'],   'delivery.issue',  false, '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'CONTESTED', 'REISSUE',           'CONTESTED',  array['USER'],   'delivery.issue',  false, '20260831160300_delivery_state_machine.sql'),
  -- FASE 5: fired by the correction/supersede flow, not built yet.
  ('DELIVERY', 1, 'CONFIRMED', 'SUPERSEDE',         'SUPERSEDED', array['USER'],   'delivery.issue',  true,  '20260831160300_delivery_state_machine.sql'),
  ('DELIVERY', 1, 'CONTESTED', 'SUPERSEDE',         'SUPERSEDED', array['USER'],   'delivery.issue',  true,  '20260831160300_delivery_state_machine.sql');

-- Generic enforcement trigger, reused for CONFIRMATION_REQUEST in FASE 3 (any table with a
-- `status` + `last_event` column and a `frozen_at` column can attach it, passing its own
-- machine name via TG_ARGV[0]).
create function app.enforce_state_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_transition app.state_transitions%rowtype;
begin
  if NEW.status is not distinct from OLD.status then
    if OLD.frozen_at is not null then
      raise exception 'row % is frozen and cannot be modified', OLD.id using errcode = '23514';
    end if;
    return NEW;
  end if;

  -- Belt-and-braces beyond the column-level REVOKE: catches a bug in a FUTURE RPC that
  -- updates `status` outside a dedicated transition_*() call, since every RPC runs as the
  -- table owner (bypassing grants) and this check does not rely on grants at all.
  if current_setting('app.transition_ok', true) is distinct from OLD.id::text then
    raise exception 'status may only change inside a transition function' using errcode = '42501';
  end if;

  select * into v_transition from app.state_transitions t
   where t.machine = TG_ARGV[0] and t.machine_version = 1
     and t.from_state = OLD.status::text and t.event = NEW.last_event;

  if not found or v_transition.to_state <> NEW.status::text then
    raise exception 'illegal transition %: % --%--> %', TG_ARGV[0], OLD.status, NEW.last_event, NEW.status
      using errcode = '23514';
  end if;

  NEW.status_changed_at := clock_timestamp();
  return NEW;
end;
$$;

comment on function app.enforce_state_transition() is
  'Generic (OLD.status, event, NEW.status) validator against app.state_transitions. A CHECK constraint cannot see OLD (cannot validate a MOVE, only a value) and a generated column cannot depend on the previous row -- a trigger is the only mechanism that can. Requires the calling RPC to perform `perform set_config(''app.transition_ok'', id::text, true)` immediately before the UPDATE.';
