import type {
  AssuranceLevel,
  AuditEvent,
  ConfirmationRequestStatus,
  DeliveryContest,
  EpiReturnReasonCode,
} from "@/lib/supabase/dal";
import type { Dict } from "@/i18n/dictionaries";

// Locale-aware labels for the manager-facing confirmation/contest/audit UI. Kept as pure
// lookups (same pattern as delivery-status-badge.tsx's DELIVERY_STATUS_META) so they're
// trivial to extend as FASE 4 introduces the remaining assurance levels / event types --
// each takes the current dictionary so callers (Server Components with getDictionary(), or
// Client Components with useT()) can produce a translated Record.

/** All 11 app.confirmation_request_status values, even though FASE 3 only ever produces
 * SENT/VIEWED/IDENTITY_FAILED/CONFIRMED/CONTESTED/EXPIRED/REVOKED -- PENDING/IDENTITY_PENDING/
 * IDENTITY_VERIFIED/DELIVERY_FAILED are reachable in theory from the same rows this page reads. */
export function confirmationStatusLabel(t: Dict): Record<ConfirmationRequestStatus, string> {
  return {
    PENDING: t.deliveries.confirmationStatusPending,
    SENT: t.deliveries.confirmationStatusSent,
    VIEWED: t.deliveries.confirmationStatusViewed,
    IDENTITY_PENDING: t.deliveries.confirmationStatusIdentityPending,
    IDENTITY_VERIFIED: t.deliveries.confirmationStatusIdentityVerified,
    IDENTITY_FAILED: t.deliveries.confirmationStatusIdentityFailed,
    CONFIRMED: t.deliveries.confirmationStatusConfirmed,
    CONTESTED: t.deliveries.confirmationStatusContested,
    DELIVERY_FAILED: t.deliveries.confirmationStatusDeliveryFailed,
    EXPIRED: t.deliveries.confirmationStatusExpired,
    REVOKED: t.deliveries.confirmationStatusRevoked,
  };
}

/** Statuses for which a confirmation_request is still "live" (a worker could still act on
 * it) -- used to decide whether the link panel offers "Gerar link" or "Gerar novo link". */
export const LIVE_CONFIRMATION_STATUSES = new Set<ConfirmationRequestStatus>(["SENT", "VIEWED", "IDENTITY_FAILED"]);

/** All 5 assurance levels; AL2-AL4 are reserved for FASE 4 and unreachable today, but must
 * render sanely if they ever show up. */
export function assuranceLevelLabel(t: Dict): Record<AssuranceLevel, string> {
  return {
    AL0_LINK_ONLY: t.deliveries.assuranceLevelLinkOnly,
    AL1_LINK_KNOWLEDGE: t.deliveries.assuranceLevelLinkKnowledge,
    AL2_SELFIE_LIVENESS: t.deliveries.assuranceLevelSelfieLiveness,
    AL3_FACE_MATCH_ENROLLED: t.deliveries.assuranceLevelFaceMatchEnrolled,
    AL4_GOV_VERIFIED: t.deliveries.assuranceLevelGovVerified,
  };
}

export function contestReasonLabel(t: Dict): Record<DeliveryContest["reasonCode"], string> {
  return {
    NOT_RECEIVED: t.deliveries.contestReasonNotReceived,
    WRONG_ITEM: t.deliveries.contestReasonWrongItem,
    WRONG_QUANTITY: t.deliveries.contestReasonWrongQuantity,
    ALREADY_RETURNED: t.deliveries.contestReasonAlreadyReturned,
    OTHER: t.deliveries.contestReasonOther,
  };
}

export function epiReturnReasonLabel(t: Dict): Record<EpiReturnReasonCode, string> {
  return {
    WORN_OUT: t.deliveries.returnReasonWornOut,
    REPLACED: t.deliveries.returnReasonReplaced,
    TERMINATION: t.deliveries.returnReasonTermination,
    OTHER: t.deliveries.returnReasonOther,
  };
}

export function actorKindLabel(t: Dict): Record<AuditEvent["actorKind"], string> {
  return {
    USER: t.deliveries.actorKindUser,
    WORKER: t.deliveries.actorKindWorker,
    SYSTEM: t.deliveries.actorKindSystem,
    PROVIDER: t.deliveries.actorKindProvider,
    PLATFORM: t.deliveries.actorKindPlatform,
  };
}

/** Localized label for one audit event_type; falls back to the raw string for any type not
 * in the lookup above (this feed also carries whatever FASE 4 adds later). */
export function auditEventLabel(t: Dict, eventType: string): string {
  const map: Record<string, string> = {
    CONFIRMATION_CREATED: t.deliveries.auditEventConfirmationCreated,
    LINK_VIEWED: t.deliveries.auditEventLinkViewed,
    IDENTITY_VERIFIED: t.deliveries.auditEventIdentityVerified,
    IDENTITY_FAILED: t.deliveries.auditEventIdentityFailed,
    DELIVERY_CONFIRMED: t.deliveries.auditEventDeliveryConfirmed,
    DELIVERY_CONTESTED: t.deliveries.auditEventDeliveryContested,
    CONFIRMATION_EXPIRED: t.deliveries.auditEventConfirmationExpired,
    CONFIRMATION_REVOKED: t.deliveries.auditEventConfirmationRevoked,
    CONTEST_RESPONDED: t.deliveries.auditEventContestResponded,
    EVIDENCE_SEALED: t.deliveries.auditEventEvidenceSealed,
    BATCH_CREATED: t.deliveries.auditEventBatchCreated,
    DELIVERY_CREATED: t.deliveries.auditEventDeliveryCreated,
    DELIVERY_ISSUED: t.deliveries.auditEventDeliveryIssued,
    DELIVERY_CANCELLED: t.deliveries.auditEventDeliveryCancelled,
    EMPLOYEES_IMPORTED: t.deliveries.auditEventEmployeesImported,
  };
  return map[eventType] ?? eventType;
}
