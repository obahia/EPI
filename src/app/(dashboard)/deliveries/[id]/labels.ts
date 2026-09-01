import type { AssuranceLevel, AuditEvent, ConfirmationRequestStatus, DeliveryContest } from "@/lib/supabase/dal";

// pt-BR labels for the manager-facing confirmation/contest/audit UI. Kept as pure lookups
// (same pattern as delivery-status-badge.tsx's DELIVERY_STATUS_META) so they're trivial to
// extend as FASE 4 introduces the remaining assurance levels / event types.

/** All 11 app.confirmation_request_status values, even though FASE 3 only ever produces
 * SENT/VIEWED/IDENTITY_FAILED/CONFIRMED/CONTESTED/EXPIRED/REVOKED -- PENDING/IDENTITY_PENDING/
 * IDENTITY_VERIFIED/DELIVERY_FAILED are reachable in theory from the same rows this page reads. */
export const CONFIRMATION_STATUS_LABEL: Record<ConfirmationRequestStatus, string> = {
  PENDING: "Pendente",
  SENT: "Enviado",
  VIEWED: "Visualizado",
  IDENTITY_PENDING: "Verificação em andamento",
  IDENTITY_VERIFIED: "Identidade verificada",
  IDENTITY_FAILED: "Falha na verificação",
  CONFIRMED: "Confirmado",
  CONTESTED: "Contestado",
  DELIVERY_FAILED: "Falha na entrega",
  EXPIRED: "Expirado",
  REVOKED: "Revogado",
};

/** Statuses for which a confirmation_request is still "live" (a worker could still act on
 * it) -- used to decide whether the link panel offers "Gerar link" or "Gerar novo link". */
export const LIVE_CONFIRMATION_STATUSES = new Set<ConfirmationRequestStatus>(["SENT", "VIEWED", "IDENTITY_FAILED"]);

/** All 5 assurance levels; AL2-AL4 are reserved for FASE 4 and unreachable today, but must
 * render sanely if they ever show up. */
export const ASSURANCE_LEVEL_LABEL: Record<AssuranceLevel, string> = {
  AL0_LINK_ONLY: "Apenas link",
  AL1_LINK_KNOWLEDGE: "Link + verificação",
  AL2_SELFIE_LIVENESS: "Selfie com prova de vida",
  AL3_FACE_MATCH_ENROLLED: "Reconhecimento facial",
  AL4_GOV_VERIFIED: "Verificado (gov.br)",
};

export const CONTEST_REASON_LABEL: Record<DeliveryContest["reasonCode"], string> = {
  NOT_RECEIVED: "Não recebido",
  WRONG_ITEM: "Item errado",
  WRONG_QUANTITY: "Quantidade errada",
  ALREADY_RETURNED: "Já devolvido",
  OTHER: "Outro",
};

export const ACTOR_KIND_LABEL: Record<AuditEvent["actorKind"], string> = {
  USER: "Gestor",
  WORKER: "Funcionário",
  SYSTEM: "Sistema",
  PROVIDER: "Provedor",
  PLATFORM: "Plataforma",
};

const AUDIT_EVENT_LABEL: Record<string, string> = {
  CONFIRMATION_CREATED: "Link de confirmação gerado",
  LINK_VIEWED: "Link visualizado",
  IDENTITY_VERIFIED: "Identidade verificada",
  IDENTITY_FAILED: "Falha na verificação de identidade",
  DELIVERY_CONFIRMED: "Entrega confirmada",
  DELIVERY_CONTESTED: "Entrega contestada",
  CONFIRMATION_EXPIRED: "Link de confirmação expirado",
  CONFIRMATION_REVOKED: "Link de confirmação revogado",
  CONTEST_RESPONDED: "Resposta à contestação registrada",
  EVIDENCE_SEALED: "Comprovante selado",
};

/** Localized label for one audit event_type; falls back to the raw string for any type not
 * in the lookup above (this feed also carries whatever FASE 4 adds later). */
export function auditEventLabel(eventType: string): string {
  return AUDIT_EVENT_LABEL[eventType] ?? eventType;
}
