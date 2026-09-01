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
// them. shadcn's Badge (src/components/ui/badge.tsx) only ships default/secondary/
// destructive/outline/ghost/link -- there is no "success" variant, so CONFIRMED borrows a
// green className on top of "outline" instead of inventing a new variant name.
const DELIVERY_STATUS_META: Record<DeliveryStatus, StatusMeta> = {
  DRAFT: { label: "Rascunho", variant: "outline" },
  ISSUED: { label: "Emitida", variant: "default" },
  CONFIRMED: {
    label: "Confirmada",
    variant: "outline",
    className: "border-success/30 bg-success-soft text-success",
  },
  CONTESTED: { label: "Contestada", variant: "destructive" },
  CANCELLED: { label: "Cancelada", variant: "outline" },
  SUPERSEDED: { label: "Substituída", variant: "outline" },
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
