-- PILOT READINESS P1-1: evidence.documents was missing the immutability layer its sibling
-- tables have had since FASE 5.
--
-- audit.audit_events and evidence.evidence_versions each carry a BEFORE UPDATE OR DELETE
-- trigger that raises even for the table owner. evidence.documents did not, and it is the row
-- that binds a printed receipt's verification_code to the sealed evidence behind it. Without
-- the trigger, repointing that row -- `update evidence.documents set evidence_version_id = ...`
-- -- would make an already-issued QR code verify against DIFFERENT content, with the sealed
-- evidence itself untouched and every hash still checking out. The forgery would be invisible
-- precisely because the part everyone inspects was never altered.
--
-- The gap was only ever reachable by someone with owner access to the database, which is also
-- true of evidence_versions -- and evidence_versions closes it anyway. That asymmetry was
-- documented nowhere, which is the part that made it worth fixing before a real customer's
-- evidence lives here. Found by scripts/security-audit.mjs, not by reading.
--
-- NO LEGITIMATE FLOW IS AFFECTED. There is exactly one writer of this table in the entire
-- codebase -- app.seal_evidence, called only from inside worker.finish_confirmation's own
-- transaction -- and it only ever INSERTs. There is no UPDATE and no DELETE of an
-- evidence.documents row anywhere, in any migration or any application path. INSERT stays
-- allowed; a trigger on UPDATE OR DELETE cannot touch it.

create trigger documents_no_update_delete
  before update or delete on evidence.documents
  for each row execute function audit.forbid_mutation();

comment on table evidence.documents is
  'The public-facing pointer: a short verification_code (12 chars, Crockford base32 -- excludes I/L/O/U to avoid visual confusion on a printed receipt, 32^12 combinations) that /verify/<code> looks up. A receipt is a RENDERING of the evidence_version it points to, not separately versioned -- docs/architecture.md §6 collapses documents+document_versions into this one table on purpose. IMMUTABLE ONCE ISSUED (Pilot Readiness P1-1): insert-only, with a BEFORE UPDATE OR DELETE trigger that raises even for the owner, because repointing this row at another evidence_version would make an already-printed QR verify against different content while the sealed evidence itself stayed pristine. No formal Crockford check-digit algorithm (a deliberate simplification, documented in docs/mvp-roadmap.md FASE 5) -- the code is a lookup key, not a secret, so a mistyped code just fails to resolve.';

-- Brought in line with evidence.evidence_versions, which already revokes from all four. None
-- of these roles held the privilege in practice (scripts/security-audit.mjs proves the grant
-- set is empty), but stating it means a future migration that grants something back has to do
-- so deliberately rather than by inheriting a default.
revoke insert, update, delete, truncate on evidence.documents
  from authenticated, anon, service_role, public;
