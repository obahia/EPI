"use client";

import { useActionState, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Panel } from "@/components/panel";
import { cn } from "@/lib/utils";
import type { Epi, EpiVariant, DeliveryReasonCode } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import type { Dict } from "@/i18n/dictionaries";
import { createReplacementDelivery, type ReplaceDeliveryState } from "../actions";

const initialState: ReplaceDeliveryState = { error: null, code: null };

const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
);

// Same 9-value reason list/labels as delivery-form.tsx's own REASON_CODES/reasonCodeLabel --
// duplicated rather than shared across files (same small-lookup-per-file convention as
// return-item-form.tsx's own RETURN_REASON_CODES).
const REASON_CODES: DeliveryReasonCode[] = [
  "FIRST_ISSUE",
  "PERIODIC_REPLACEMENT",
  "WEAR",
  "DAMAGE",
  "LOSS",
  "SIZE_CHANGE",
  "ROLE_CHANGE",
  "EXPIRATION",
  "OTHER",
];

function reasonCodeLabel(t: Dict, code: DeliveryReasonCode): string {
  const map: Record<DeliveryReasonCode, string> = {
    FIRST_ISSUE: t.deliveries.reasonCodeFirstIssue,
    PERIODIC_REPLACEMENT: t.deliveries.reasonCodePeriodicReplacement,
    WEAR: t.deliveries.reasonCodeWear,
    DAMAGE: t.deliveries.reasonCodeDamage,
    LOSS: t.deliveries.reasonCodeLoss,
    SIZE_CHANGE: t.deliveries.reasonCodeSizeChange,
    ROLE_CHANGE: t.deliveries.reasonCodeRoleChange,
    EXPIRATION: t.deliveries.reasonCodeExpiration,
    OTHER: t.deliveries.reasonCodeOther,
  };
  return map[code];
}

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** pt: "Este colaborador recebeu este EPI há 12 dias, a vida útil configurada é 90 dias.
 * Deseja continuar mesmo assim?" -- assembled from small translatable fragments (no
 * templating engine here, same discipline as needs-attention.tsx's own day counters). */
function earlyReplacementMessage(t: Dict, daysSinceConfirmed: number, lifespanDays: number): string {
  return [
    t.deliveries.earlyReplacementSubject,
    t.deliveries.earlyReplacementReceivedPrefix,
    daysSinceConfirmed,
    `${t.deliveries.earlyReplacementDaysAgoSuffix},`,
    t.deliveries.earlyReplacementLifespanPrefix,
    lifespanDays,
    `${t.deliveries.earlyReplacementLifespanSuffix}.`,
    t.deliveries.earlyReplacementQuestion,
  ].join(" ");
}

type ItemRow = { key: string; epiId: string };

/**
 * "Trocar EPI" (troca): only rendered by the caller for a CONFIRMED/CONTESTED delivery --
 * mirrors delivery-form.tsx's item-picker (repeatable epiId/quantity/variantId row triplets,
 * see that file's own comment for why) since api.create_replacement_delivery's p_items has
 * the identical shape as api.create_delivery's.
 *
 * `earlyWarning` is precomputed by the caller from the ORIGINAL delivery's own items
 * (the earliest-due tracked item, matching the RPC's own v_earliest_due logic) -- null
 * when nothing on the original tracks a lifespan, in which case the RPC can never raise
 * the early-replacement errors below at all.
 */
export function ReplaceDeliveryForm({
  originalDeliveryId,
  epis,
  variantsByEpi,
  earlyWarning,
}: {
  originalDeliveryId: string;
  epis: Epi[];
  variantsByEpi: Record<string, EpiVariant[]>;
  earlyWarning: { daysSinceConfirmed: number; lifespanDays: number } | null;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState(createReplacementDelivery, initialState);
  const idPrefix = useId();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ItemRow[]>([{ key: `${idPrefix}-0`, epiId: "" }]);
  const nextRowIndex = useRef(1);

  // The RPC has to actually say the organization's `warn` policy requires it before this
  // ever shows -- never shown speculatively based on earlyWarning alone (allow/block
  // policies never produce this code, and a same-day resubmit re-validates from scratch).
  const needsEarlyConfirmation = state.code === "confirmation_required" || state.code === "reason_note_required";

  function addRow() {
    setRows((prev) => [...prev, { key: `${idPrefix}-${nextRowIndex.current++}`, epiId: "" }]);
  }

  function removeRow(key: string) {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  }

  function setRowEpi(key: string, epiId: string) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, epiId } : r)));
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="lg">
          {t.deliveries.replaceEpi}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form action={formAction} className="flex flex-col gap-5">
          <input type="hidden" name="originalDeliveryId" value={originalDeliveryId} />
          {/* Derived purely from the LAST server response, never a separate client-tracked
              boolean -- a plain resubmit of this same form is what carries it forward. */}
          <input type="hidden" name="confirmEarly" value={needsEarlyConfirmation ? "true" : "false"} />

          <DialogHeader>
            <DialogTitle>{t.deliveries.replaceEpi}</DialogTitle>
            <DialogDescription>{t.deliveries.replaceDeliveryHint}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor={`${idPrefix}-deliveryDate`}>{t.deliveries.deliveryDateLabel}</Label>
            <Input id={`${idPrefix}-deliveryDate`} name="deliveryDate" type="date" defaultValue={todayIso()} required />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={`${idPrefix}-reasonCode`}>{t.deliveries.reasonCodeLabel}</Label>
            <select
              id={`${idPrefix}-reasonCode`}
              name="reasonCode"
              defaultValue="PERIODIC_REPLACEMENT"
              className={selectClassName}
            >
              {REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {reasonCodeLabel(t, code)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={`${idPrefix}-note`}>{t.common.note}</Label>
            <Input id={`${idPrefix}-note`} name="note" />
          </div>

          <div className="flex flex-col gap-2">
            <Label>{t.deliveries.itemsLabel}</Label>
            <div className="flex flex-col gap-2">
              {rows.map((row, i) => {
                const variants = row.epiId ? (variantsByEpi[row.epiId] ?? []) : [];
                return (
                  <div key={row.key} className="flex flex-wrap items-center gap-2">
                    <select
                      name="epiId"
                      required
                      value={row.epiId}
                      onChange={(e) => setRowEpi(row.key, e.target.value)}
                      aria-label={`${t.deliveries.itemEpiAriaLabelPrefix} ${i + 1}`}
                      className={selectClassName}
                    >
                      <option value="" disabled>
                        {t.deliveries.selectEpiPlaceholder}
                      </option>
                      {epis.map((epi) => (
                        <option key={epi.id} value={epi.id}>
                          {epi.name} — CA {epi.caNumber}
                        </option>
                      ))}
                    </select>
                    <Input
                      name="quantity"
                      type="number"
                      min={1}
                      max={10000}
                      defaultValue={1}
                      required
                      aria-label={`${t.deliveries.itemQuantityAriaLabelPrefix} ${i + 1}`}
                      className="w-24"
                    />
                    {variants.length > 0 ? (
                      <select
                        name="variantId"
                        defaultValue=""
                        aria-label={`${t.deliveries.itemVariantAriaLabelPrefix} ${i + 1}`}
                        className={selectClassName}
                      >
                        <option value="">{t.deliveries.noVariantOption}</option>
                        {variants.map((variant) => (
                          <option key={variant.id} value={variant.id}>
                            {variant.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input type="hidden" name="variantId" value="" />
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => removeRow(row.key)}
                      disabled={rows.length === 1}
                    >
                      {t.common.remove}
                    </Button>
                  </div>
                );
              })}
            </div>
            {epis.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.deliveries.noActiveEpisForCompany}</p>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={addRow} className="self-start">
              {t.deliveries.addItem}
            </Button>
          </div>

          {/* Early-replacement warning: appears only once the RPC has actually said the
              organization's warn policy requires it. The SAME p_reason_note field doubles as
              this justification (see api.create_replacement_delivery's own comment) -- so
              this is the only reasonNote input in the form, just relocated and made
              mandatory once it's needed. */}
          {needsEarlyConfirmation ? (
            <Panel tone="warning" className="flex flex-col gap-3">
              <p className="text-sm font-bold">{t.deliveries.earlyReplacementTitle}</p>
              <p className="text-sm">
                {earlyWarning
                  ? earlyReplacementMessage(t, earlyWarning.daysSinceConfirmed, earlyWarning.lifespanDays)
                  : t.deliveries.earlyReplacementGenericMessage}
              </p>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${idPrefix}-reasonNote`}>{t.deliveries.earlyReplacementReasonNoteLabel}</Label>
                <textarea
                  id={`${idPrefix}-reasonNote`}
                  name="reasonNote"
                  required
                  minLength={3}
                  maxLength={1000}
                  rows={3}
                  className="w-full min-w-0 rounded-2xl border border-input bg-transparent px-4 py-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              </div>
            </Panel>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${idPrefix}-reasonNote`}>{t.deliveries.reasonNoteLabel}</Label>
              <Input id={`${idPrefix}-reasonNote`} name="reasonNote" />
            </div>
          )}

          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {t.common.back}
            </Button>
            <Button type="submit" disabled={pending || epis.length === 0}>
              {pending
                ? t.deliveries.replacing
                : needsEarlyConfirmation
                  ? t.deliveries.confirmEarlyReplace
                  : t.deliveries.confirmReplace}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
