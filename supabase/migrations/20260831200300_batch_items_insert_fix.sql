-- FASE 6: api.create_delivery_batch (previous migration) creates deliveries directly as
-- ISSUED (see that migration's comment for why) and inserts their line items in the SAME
-- transaction, atomically, before any worker could possibly have viewed anything. FASE 2's
-- app.enforce_items_draft_only() (supabase/migrations/20260831160400_epi_deliveries.sql,
-- already applied live) blocks ANY write -- including INSERT -- unless the parent delivery
-- is DRAFT, which broke the batch flow entirely.
--
-- The invariant that trigger actually needs to protect is narrower than what it enforces
-- today: "no CHANGE to an item after issuance" (UPDATE/DELETE), not "no INSERT unless
-- DRAFT". No RPC in this codebase ever inserts a NEW item onto a PRE-EXISTING delivery --
-- api.create_delivery (individual) creates the delivery as DRAFT then inserts its items,
-- all within its own transaction; api.create_delivery_batch does the same with ISSUED
-- instead of DRAFT. Both are safe because item insertion always happens atomically
-- alongside the delivery's own creation. `authenticated` has no INSERT/UPDATE/DELETE grant
-- on app.epi_delivery_items at all regardless (see that same migration) -- this trigger is
-- defense-in-depth against a future RPC bug, not the only thing standing between a caller
-- and a rogue write.

drop trigger if exists epi_delivery_items_draft_only on app.epi_delivery_items;
drop function if exists app.enforce_items_draft_only();

create function app.enforce_items_draft_only()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_delivery_id uuid;
  v_status app.delivery_status;
begin
  if TG_OP = 'INSERT' then
    return NEW;
  end if;

  v_delivery_id := coalesce(NEW.delivery_id, OLD.delivery_id);
  select status into v_status from app.epi_deliveries where id = v_delivery_id;
  if v_status is distinct from 'DRAFT' then
    raise exception 'delivery items are only editable while the delivery is DRAFT (current status: %)', v_status
      using errcode = '23514';
  end if;
  return coalesce(NEW, OLD);
end;
$$;

comment on function app.enforce_items_draft_only() is
  'INSERT is allowed regardless of the parent delivery''s status -- a batch delivery is created directly as ISSUED with its items inserted in the same transaction (docs/mvp-roadmap.md FASE 6). UPDATE/DELETE remain DRAFT-only: that is the invariant this trigger actually protects (no silent change to an item once a delivery may have been shown to a worker).';

create trigger epi_delivery_items_draft_only
  before insert or update or delete on app.epi_delivery_items
  for each row execute function app.enforce_items_draft_only();
