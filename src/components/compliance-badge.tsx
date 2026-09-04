"use client";

import { Badge, type badgeVariants } from "@/components/ui/badge";
import type { VariantProps } from "class-variance-authority";
import type { ComplianceAggregateState, ComplianceRequirementState } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import type { Dict } from "@/i18n/dictionaries";

type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
type StatusMeta = { label: string; variant: BadgeVariant; className?: string };

// Same tone convention as epi-lifecycle-badge.tsx / delivery-status-badge.tsx: soft olive for
// good news, soft amber for "will need attention soon", filled rose for a real violation,
// plain muted text for "nothing was evaluated" (never a colored pill -- INDETERMINADO is not
// a verdict, coloring it like one would misrepresent it as such).
const AGGREGATE_META: Record<ComplianceAggregateState, Omit<StatusMeta, "label">> = {
  CONFORME: { variant: "outline", className: "border-transparent bg-success-soft text-success" },
  ATENCAO: { variant: "outline", className: "border-transparent bg-warning-soft text-warning" },
  NAO_CONFORME: { variant: "destructive", className: "bg-destructive-soft" },
  INDETERMINADO: { variant: "ghost", className: "text-muted-foreground" },
};

export function ComplianceAggregateBadge({ state }: { state: ComplianceAggregateState }) {
  const t = useT();
  const meta = AGGREGATE_META[state];
  const label: Record<ComplianceAggregateState, string> = {
    CONFORME: t.compliance.aggregateConforme,
    ATENCAO: t.compliance.aggregateAtencao,
    NAO_CONFORME: t.compliance.aggregateNaoConforme,
    INDETERMINADO: t.compliance.aggregateIndeterminado,
  };
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {label[state]}
    </Badge>
  );
}

const REQUIREMENT_META: Record<ComplianceRequirementState, Omit<StatusMeta, "label">> = {
  SEM_CARGO: { variant: "ghost", className: "text-muted-foreground" },
  MATRIZ_VAZIA: { variant: "ghost", className: "text-muted-foreground" },
  OPCIONAL: { variant: "ghost", className: "text-muted-foreground" },
  NUNCA_ENTREGUE: { variant: "destructive", className: "bg-destructive-soft" },
  QUANTIDADE_INSUFICIENTE: { variant: "destructive", className: "bg-destructive-soft" },
  ITEM_VENCIDO: { variant: "destructive", className: "bg-destructive-soft" },
  PROXIMO_DA_TROCA: { variant: "outline", className: "border-transparent bg-warning-soft text-warning" },
  OK: { variant: "outline", className: "border-transparent bg-success-soft text-success" },
};

/** Per-requirement state label -- SEM_CARGO/MATRIZ_VAZIA never render at the requirement
 * level (the ficha shows one indeterminate message for the whole employee instead, see
 * compliance-panel.tsx), so this only needs labels for OPCIONAL and the 6 real states. */
export function complianceRequirementLabel(t: Dict, state: ComplianceRequirementState): string {
  const map: Record<ComplianceRequirementState, string> = {
    SEM_CARGO: t.compliance.aggregateIndeterminado,
    MATRIZ_VAZIA: t.compliance.aggregateIndeterminado,
    OPCIONAL: t.compliance.optionalTag,
    NUNCA_ENTREGUE: t.compliance.stateNuncaEntregue,
    QUANTIDADE_INSUFICIENTE: t.compliance.stateQuantidadeInsuficiente,
    ITEM_VENCIDO: t.compliance.stateItemVencido,
    PROXIMO_DA_TROCA: t.compliance.stateProximoDaTroca,
    OK: t.compliance.stateOk,
  };
  return map[state];
}

export function ComplianceRequirementBadge({ state }: { state: ComplianceRequirementState }) {
  const t = useT();
  const meta = REQUIREMENT_META[state];
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {complianceRequirementLabel(t, state)}
    </Badge>
  );
}
