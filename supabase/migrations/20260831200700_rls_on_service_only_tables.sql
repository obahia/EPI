-- Real gap caught by the pgTAP schema-invariant suite (000_schema_invariants.sql, assertion
-- 1: "every table in app/authz/evidence/audit/integ has row level security enabled") once
-- CI actually ran it for the first time against a real Postgres.
--
-- app.link_rate_limits and audit.chain_heads were both created with `revoke all on ...
-- from authenticated, anon, public` and NO `enable row level security` -- so today neither
-- is actually reachable by anything other than the SECURITY DEFINER functions that own
-- them (app.check_rate_limit / app.log_audit_event), which run as the table owner and are
-- exempt from RLS regardless of whether it is on. Nothing is exploitable right now.
--
-- The invariant exists precisely for what happens NEXT: if a future migration adds, say,
-- `grant select on app.link_rate_limits to authenticated` for an admin rate-limit dashboard,
-- without separately remembering RLS, the table becomes fully readable with no per-row
-- restriction at all -- silently, because REVOKE ALL was the only thing protecting it. RLS
-- enabled now, with zero policies, is the defense-in-depth backstop docs/architecture.md §7
-- describes: a future GRANT alone still yields zero rows to anyone but the owner, exactly
-- like every other table in these five schemas already behaves.
--
-- Same treatment as their sibling audit.audit_events (20260831170100_audit_events.sql):
-- ENABLE + FORCE + zero policies. FORCE also binds the table owner, but every current
-- reader/writer of these two tables is a SECURITY DEFINER function executing as a
-- superuser role (postgres/supabase_admin), and superusers bypass RLS unconditionally
-- regardless of FORCE -- so this changes nothing about who can use app.check_rate_limit or
-- app.log_audit_event today.

alter table app.link_rate_limits enable row level security;
alter table app.link_rate_limits force row level security;

alter table audit.chain_heads enable row level security;
alter table audit.chain_heads force row level security;
