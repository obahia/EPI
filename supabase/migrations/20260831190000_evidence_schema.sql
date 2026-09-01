-- FASE 5: evidence.evidence_versions -- the sealed, canonical proof of what a worker was
-- shown and confirmed (docs/architecture.md §12). Normalized + JSONB + raw canonical bytes,
-- all three, deliberately non-redundant: normalized columns exist for indexed lookup,
-- payload jsonb for structured reads, canonical_bytes so recomputing the hash in 2036 never
-- depends on twelve tables and this era's code behaving identically -- the bytes ARE the
-- source of truth, everything else is a projection of them.
--
-- Only CONFIRMED deliveries get sealed -- a CONTESTED delivery has nothing to attest, its
-- own record lives in app.delivery_contests. Corrections/SUPERSEDE (chain_version > 1,
-- prev_evidence_sha256 populated) are not built this phase -- the columns exist so a future
-- correction flow needs no migration, but chain_version is always 1 today.

create table evidence.evidence_versions (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null,
  company_id                uuid not null,
  delivery_id               uuid not null,
  confirmation_request_id   uuid not null,
  chain_id                  uuid not null,
  chain_version             integer not null check (chain_version >= 1),
  canon_version             text not null default 'epi-canon/1',
  payload                   jsonb not null,
  canonical_bytes           bytea not null,
  payload_sha256            bytea not null check (octet_length(payload_sha256) = 32),
  prev_evidence_sha256      bytea,
  audit_seq                 bigint not null,
  audit_event_hash          bytea not null,
  sealed_at                 timestamptz not null,
  created_at                timestamptz not null default clock_timestamp(),
  constraint evidence_versions_payload_hash_ck check (payload_sha256 = extensions.digest(canonical_bytes, 'sha256')),
  constraint evidence_versions_chain_key unique (chain_id, chain_version)
);

comment on table evidence.evidence_versions is
  'One row per sealed confirmation. Immutable: no INSERT/UPDATE/DELETE grant to any role including service_role, a BEFORE UPDATE OR DELETE trigger that raises even for a superuser, RLS forced with zero policies (default-deny for everyone but the owner), and this schema is outside PGRST_DB_SCHEMAS. Reads only via api.get_evidence_summary / worker.verify_document (both SECURITY DEFINER). We claim tamper-EVIDENT, not tamper-PROOF -- see docs/architecture.md §12.';
comment on column evidence.evidence_versions.canonical_bytes is
  'The literal UTF-8 bytes that were SHA-256''d -- reconstituting the payload from twelve tables in 2036 depends on code from 2026 behaving identically; storing the bytes removes that dependency entirely.';
comment on column evidence.evidence_versions.sealed_at is
  'The SAME instant recorded inside payload.confirmed_at_utc (docs/architecture.md §12 rule 4) -- generated once in Node (src/lib/evidence/canon.ts''s formatTimestampUtc) and passed to both, never independently computed twice.';

create index evidence_versions_delivery_idx on evidence.evidence_versions (delivery_id);

revoke insert, update, delete, truncate on evidence.evidence_versions from authenticated, anon, service_role, public;

create trigger evidence_versions_no_update_delete
  before update or delete on evidence.evidence_versions
  for each row execute function audit.forbid_mutation();

alter table evidence.evidence_versions enable row level security;
alter table evidence.evidence_versions force row level security;
-- No policy: RLS forced + zero policies = zero rows for every role but the owner. Reads go
-- through SECURITY DEFINER RPCs only (same pattern as audit.audit_events).

create table evidence.documents (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  company_id          uuid not null,
  evidence_version_id uuid not null references evidence.evidence_versions (id) on delete restrict,
  verification_code   text not null unique check (verification_code ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  created_at          timestamptz not null default clock_timestamp()
);

comment on table evidence.documents is
  'The public-facing pointer: a short verification_code (12 chars, Crockford base32 -- excludes I/L/O/U to avoid visual confusion on a printed receipt, 32^12 combinations) that /verify/<code> looks up. A receipt is a RENDERING of the evidence_version it points to, not separately versioned -- docs/architecture.md §6 collapses documents+document_versions into this one table on purpose. No formal Crockford check-digit algorithm (a deliberate simplification, documented in docs/mvp-roadmap.md FASE 5) -- the code is a lookup key, not a secret, so a mistyped code just fails to resolve, no security consequence either way.';

create index documents_evidence_version_idx on evidence.documents (evidence_version_id);

revoke insert, update, delete on evidence.documents from authenticated, anon;

alter table evidence.documents enable row level security;
alter table evidence.documents force row level security;
-- No policy here either: the manager-facing read goes through api.get_evidence_summary
-- (SECURITY DEFINER, next migration), the public read through worker.verify_document
-- (also SECURITY DEFINER, anon-callable, minimal-disclosure per docs/architecture.md §8).
