-- FASE 0: the state-machine RULE TABLE, created empty. Populated by data-only migrations
-- in FASE 2 (delivery machine) and FASE 3 (confirmation_request machine) -- see
-- docs/architecture.md §8. Kept as plain text columns (not enums) for from_state/event/
-- to_state so a new transition is a one-row INSERT, never a DDL change; the STATUS
-- columns on the actual entity tables (added in FASE 2/3) are enums, giving impossible
-- values as well as impossible transitions.

create table app.state_transitions (
  machine          text not null check (machine in ('DELIVERY', 'CONFIRMATION_REQUEST')),
  machine_version  integer not null default 1,
  from_state       text not null,
  event            text not null check (event ~ '^[A-Z][A-Z0-9_]{2,49}$'),
  to_state         text not null,
  actor_kinds      text[] not null,  -- who may fire it: {'USER'}, {'WORKER'}, {'SYSTEM'}, {'PROVIDER'}
  required_permission text,
  is_terminal      boolean not null default false,
  introduced_in    text not null,    -- migration filename, for provenance
  primary key (machine, machine_version, from_state, event)
);

comment on table app.state_transitions is
  'The two state machines (DELIVERY, CONFIRMATION_REQUEST) as DATA, not as a CASE statement buried in a trigger. The primary key makes non-determinism (two different to_states for the same from_state+event) a key violation, not a code-review finding. See docs/architecture.md §8 for the full transition tables, added by migration in FASE 2/3.';

alter table app.state_transitions enable row level security;
alter table app.state_transitions force row level security;
-- No tenant dimension, no grant to authenticated/anon: read only by the transition RPCs
-- (SECURITY DEFINER, FASE 2/3) and by migrations. Enabling RLS keeps the CI invariant
-- check uniform.
revoke all on app.state_transitions from authenticated, anon;
