"use client";

import { useActionState, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Employee, Epi, EpiVariant, DeliveryReasonCode } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import type { Dict } from "@/i18n/dictionaries";
import { createDelivery, type DeliveryFormState } from "../actions";

const initialState: DeliveryFormState = { error: null };

const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
);

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

type ItemRow = { key: string; epiId: string };

/**
 * Individual delivery creation: employee (plain <select>, per docs/mvp-roadmap.md FASE 2
 * -- a combobox library is more than this needs) + a reason_code select + a repeatable
 * EPI/quantity/variant line-item list + date + optional note. Each row submits as its own
 * `epiId`/`quantity`/`variantId` form field triplet (see the Server Action's comment) so no
 * client-side JSON assembly is needed -- `epiId` stays tracked in local state per row (unlike
 * the rest of this form's uncontrolled inputs) purely so the variant picker can be shown or
 * hidden per row without a page reload.
 */
export function DeliveryCreateForm({
  companyId,
  employees,
  epis,
  variantsByEpi,
}: {
  companyId: string;
  employees: Employee[];
  epis: Epi[];
  variantsByEpi: Record<string, EpiVariant[]>;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState(createDelivery, initialState);
  const idPrefix = useId();
  const [rows, setRows] = useState<ItemRow[]>([{ key: `${idPrefix}-0`, epiId: "" }]);
  const nextRowIndex = useRef(1);

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
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="companyId" value={companyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="employeeId">{t.deliveries.employeeColumn}</Label>
        <select id="employeeId" name="employeeId" required defaultValue="" className={selectClassName}>
          <option value="" disabled>
            {t.deliveries.selectEmployeePlaceholder}
          </option>
          {employees.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.fullName}
            </option>
          ))}
        </select>
        {employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.deliveries.noEmployeesForCompany}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="deliveryDate">{t.deliveries.deliveryDateLabel}</Label>
        <Input id="deliveryDate" name="deliveryDate" type="date" defaultValue={todayIso()} required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="reasonCode">{t.deliveries.reasonCodeLabel}</Label>
        <select id="reasonCode" name="reasonCode" defaultValue="FIRST_ISSUE" className={selectClassName}>
          {REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {reasonCodeLabel(t, code)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="reasonNote">{t.deliveries.reasonNoteLabel}</Label>
        <Input id="reasonNote" name="reasonNote" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="note">{t.common.note}</Label>
        <Input id="note" name="note" />
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

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending || employees.length === 0 || epis.length === 0}>
        {pending ? t.deliveries.creating : t.deliveries.createDelivery}
      </Button>
    </form>
  );
}
