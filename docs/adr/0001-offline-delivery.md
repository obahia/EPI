# ADR 0001: Offline delivery — architecture, not implemented this phase

**Status:** Accepted (foundation-only). **Date:** 2026-09-03. **Phase:** C (PPE Lifecycle).

## Context

Spec §26 asks Selo to support recording an EPI delivery while the almoxarifado device has no
connectivity, syncing once it reconnects. The spec's own instruction is explicit: implement
this robustly in phases if the current architecture allows it safely, **otherwise leave an
ADR + technical foundation** rather than ship an insecure or partial sync. This ADR is that
deferral, made deliberately rather than by omission.

A naive "cache the form, replay on reconnect" implementation would be actively unsafe here:
every invariant this codebase has spent five phases protecting — tenant isolation, the
delivery state machine, atomic stock decrement, the hash-chained evidence/audit trail — is
enforced **server-side, inside a single Postgres transaction**, at the moment
`api.create_delivery`/`api.issue_delivery` runs. None of that exists on a phone with no
network. Building "offline delivery" without solving the five problems below first would
just move the same bugs a live customer would hit from "days" to "hours."

## The five problems a real implementation must solve

1. **Identity.** `api.create_delivery` authorizes via `auth_ctx.has_permission`, which reads
   the caller's JWT-derived `auth.uid()` against `authz.memberships` — this requires a live
   Postgres round trip today. An offline client needs a way to prove "I was an authorized
   SST_OPERATOR for this company at the time I recorded this" without a server call at
   record-time, and to have that proof re-verified (not just trusted) on sync.
2. **Estoque.** Phase B's stock guard (`app.apply_stock_movement`) is exactly the
   check-and-set-in-one-statement pattern that makes two concurrent deliveries correctly
   fail to both claim the last unit (this session's own pgTAP + CI-concurrency test proves
   it). Two offline devices, both showing "3 units available" from a stale local cache,
   can both let a manager create a delivery for the last unit. There is no way to prevent
   this at record-time without connectivity — it can only be *resolved* at sync-time, and
   the resolution (whose delivery wins, what happens to the loser) needs a real UX design,
   not just a "sorry" toast.
3. **Conflitos.** Beyond stock: the same delivery could be recorded on two devices (a
   manager's phone AND their tablet), the employee could be edited concurrently, the EPI
   catalog could change between record-time and sync-time. A conflict-resolution policy
   (last-write-wins per field? server-always-wins? manual merge UI?) has to be chosen
   deliberately per entity, not assumed uniform.
4. **Idempotência.** A device that syncs, gets a `200`, but never receives the response
   (a dropped connection mid-ACK) will retry. `api.create_delivery` has no idempotency key
   today — every call creates a new delivery. An offline sync path needs a client-generated
   idempotency key (e.g. a UUID minted at record-time) that the server can use to detect
   "I've already applied this exact offline record" and return the original result instead
   of creating a duplicate delivery + a duplicate stock movement.
5. **Evidência e timestamps.** The evidence payload's canonicalization
   (`src/lib/evidence/canon.ts`) requires fixed-precision UTC timestamps built from
   **server-authoritative** data (`worker.get_evidence_source`), not client-supplied ones —
   an offline-recorded `delivery_date`/`created_at` is client-clock-supplied and
   unverifiable until sync. The confirmation/evidence flow itself (`worker.*`) is
   inherently online already (a worker needs the link to exist server-side to open it) —
   offline support is scoped to the **manager's DRAFT-recording step only**, never the
   worker confirmation step, which stays as-is.

## Decision

Do not implement offline sync in Phase C. Instead:

- Every RPC an offline client would eventually call (`api.create_delivery`,
  `api.issue_delivery`) already returns a stable, checkable result shape and raises named
  errors (`insufficient_stock`, `one_or_more_items_invalid`, etc.) — a future sync client can
  build on these without RPC changes.
- The PWA's existing service worker (`src/components/service-worker.tsx`) stays scoped to
  asset caching only; it must not grow a background-sync queue until the five problems above
  have real answers.
- A future implementation should treat idempotency as the first primitive to add (a
  nullable `client_idempotency_key uuid` column + unique index on `api.create_delivery`'s
  underlying table would be the minimal schema change), since every other problem
  (conflict resolution, stock reconciliation) depends on being able to safely retry.

## Consequences

Selo's delivery flow remains online-only through Phase C and beyond, until a dedicated phase
addresses this ADR's five problems with their own design review — consistent with this
project's practice of deferring (not faking) work that depends on an unresolved design
question (see the identity-provider registry's AL2–AL4 stubs, or the WOTY integration's empty
`integ` schema, for the same pattern applied elsewhere).
