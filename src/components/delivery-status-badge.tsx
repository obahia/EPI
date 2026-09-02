"use client";

import { Badge, type badgeVariants } from "@/components/ui/badge";
import type { VariantProps } from "class-variance-authority";
import type { DeliveryStatus } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import type { Dict } from "@/i18n/dictionaries";

type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];

type StatusMeta = { label: string; variant: BadgeVariant; className?: string };

// Pure lookup, kept separate from the component so it's independently testable (see
// delivery-status-badge.test.ts). All 6 app.delivery_status values are mapped even though
// FASE 2 only ever produces DRAFT/ISSUED/CANCELLED -- CONFIRMED/CONTESTED/SUPERSEDED are
// reachable from the SAME detail page once FASE 3+ ships, so this must never throw on
// them. Colours are the mockup's status column: the two states that mean somebody still
// has to act are filled pills (terracotta for issued, rose for contested), confirmed is a
// soft olive pill, and the three settled-or-not-started states are plain muted text
// rather than a pill -- the mockup does not chip them.
const DELIVERY_STATUS_META: Record<DeliveryStatus, StatusMeta> = {
  DRAFT: { label: "Rascunho", variant: "ghost", className: "text-muted-foreground" },
  ISSUED: { label: "Emitida", variant: "default" },
  CONFIRMED: {
    label: "Confirmada",
    variant: "outline",
    className: "border-transparent bg-success-soft text-success",
  },
  CONTESTED: { label: "Contestada", variant: "destructive", className: "bg-destructive-soft" },
  CANCELLED: { label: "Cancelada", variant: "ghost", className: "text-muted-foreground" },
  SUPERSEDED: { label: "Substituída", variant: "ghost", className: "text-muted-foreground" },
};

/** label + Badge variant for one delivery status. Exported for testing; use
 * <DeliveryStatusBadge> below in JSX. */
export function getDeliveryStatusMeta(status: DeliveryStatus): StatusMeta {
  return DELIVERY_STATUS_META[status];
}

/** Locale-aware label for one delivery status, kept separate from getDeliveryStatusMeta
 * (whose pt-BR label stays pure/synchronous for delivery-status-badge.test.ts) so the
 * actual translation happens here, at render time, where useT() is available. */
function deliveryStatusLabel(t: Dict, status: DeliveryStatus): string {
  const map: Record<DeliveryStatus, string> = {
    DRAFT: t.deliveries.statusDraft,
    ISSUED: t.deliveries.statusIssued,
    CONFIRMED: t.deliveries.statusConfirmed,
    CONTESTED: t.deliveries.statusContested,
    CANCELLED: t.deliveries.statusCancelled,
    SUPERSEDED: t.deliveries.statusSuperseded,
  };
  return map[status];
}

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const t = useT();
  const meta = getDeliveryStatusMeta(status);
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {deliveryStatusLabel(t, status)}
    </Badge>
  );
}
