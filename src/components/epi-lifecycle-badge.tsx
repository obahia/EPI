"use client";

import { Badge, type badgeVariants } from "@/components/ui/badge";
import type { VariantProps } from "class-variance-authority";
import type { EpiLifecycleStatus } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import type { Dict } from "@/i18n/dictionaries";

type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];

type StatusMeta = { label: string; variant: BadgeVariant; className?: string };

// Pure lookup, mirrors DELIVERY_STATUS_META in delivery-status-badge.tsx exactly (same
// convention: kept separate from the component so it's independently testable). VIGENTE
// reads as good news, same soft olive pill as a CONFIRMED delivery; PROXIMO_DA_TROCA is the
// amber warning pill (same tone NeedsAttention/PendingReturns already use); TROCA_NECESSARIA
// is the same filled rose the mockup uses for CONTESTED; DEVOLVIDO/DESCARTADO are settled
// states, plain muted text rather than a pill.
const EPI_LIFECYCLE_STATUS_META: Record<EpiLifecycleStatus, StatusMeta> = {
  VIGENTE: { label: "Vigente", variant: "outline", className: "border-transparent bg-success-soft text-success" },
  PROXIMO_DA_TROCA: {
    label: "Próximo da troca",
    variant: "outline",
    className: "border-transparent bg-warning-soft text-warning",
  },
  TROCA_NECESSARIA: { label: "Troca necessária", variant: "destructive", className: "bg-destructive-soft" },
  DEVOLVIDO: { label: "Devolvido", variant: "ghost", className: "text-muted-foreground" },
  DESCARTADO: { label: "Descartado", variant: "ghost", className: "text-muted-foreground" },
};

/** label + Badge variant for one EPI lifecycle status. Exported for testing, same pattern
 * as getDeliveryStatusMeta; use <EpiLifecycleBadge> below in JSX. */
export function getEpiLifecycleStatusMeta(status: EpiLifecycleStatus): StatusMeta {
  return EPI_LIFECYCLE_STATUS_META[status];
}

/** Locale-aware label, kept separate from getEpiLifecycleStatusMeta for the same reason as
 * delivery-status-badge.tsx's own deliveryStatusLabel. */
function epiLifecycleStatusLabel(t: Dict, status: EpiLifecycleStatus): string {
  const map: Record<EpiLifecycleStatus, string> = {
    VIGENTE: t.employees.lifecycleStatusVigente,
    PROXIMO_DA_TROCA: t.employees.lifecycleStatusProximoDaTroca,
    TROCA_NECESSARIA: t.employees.lifecycleStatusTrocaNecessaria,
    DEVOLVIDO: t.employees.lifecycleStatusDevolvido,
    DESCARTADO: t.employees.lifecycleStatusDescartado,
  };
  return map[status];
}

export function EpiLifecycleBadge({ status }: { status: EpiLifecycleStatus }) {
  const t = useT();
  const meta = getEpiLifecycleStatusMeta(status);
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {epiLifecycleStatusLabel(t, status)}
    </Badge>
  );
}
