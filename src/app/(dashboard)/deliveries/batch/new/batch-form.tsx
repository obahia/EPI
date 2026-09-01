"use client";

import { Fragment, useActionState, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Employee, Epi } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import type { Dict } from "@/i18n/dictionaries";
import { createDeliveryBatch, type CreateBatchState } from "../../batch-actions";

const initialState: CreateBatchState = { error: null, links: null, batchId: null };

const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
);

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function employeeStatusLabel(t: Dict): Record<Employee["status"], string> {
  return {
    ACTIVE: t.deliveries.employeeStatusActive,
    ON_LEAVE: t.deliveries.employeeStatusOnLeave,
    TERMINATED: t.deliveries.employeeStatusTerminated,
  };
}

type ItemRow = { key: string };

/**
 * Mass-delivery batch creation (docs/mvp-roadmap.md FASE 6). Same EPI/quantity repeatable
 * row pattern as the single-delivery form (delivery-form.tsx), plus a checkbox roster of
 * employees. Selection is tracked in React state so that, for each CHECKED employee, one
 * `employeeId` hidden input and one matching `employeeFullName` hidden input are rendered
 * together from the SAME filtered array -- this keeps the two positionally aligned, which
 * is what the Server Action relies on to zip them back together.
 *
 * On success, the server response's `links` carry only relative worker paths -- the
 * absolute URL is built HERE from window.location.origin, same rule as
 * confirmation-link-panel.tsx, never constructed server-side.
 */
export function BatchCreateForm({
  companyId,
  employees,
  epis,
}: {
  companyId: string;
  employees: Employee[];
  epis: Epi[];
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState(createDeliveryBatch, initialState);
  const idPrefix = useId();
  const [rows, setRows] = useState<ItemRow[]>([{ key: `${idPrefix}-0` }]);
  const nextRowIndex = useRef(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [origin] = useState<string | null>(() => (typeof window === "undefined" ? null : window.location.origin));
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const statusLabel = employeeStatusLabel(t);

  function addRow() {
    setRows((prev) => [...prev, { key: `${idPrefix}-${nextRowIndex.current++}` }]);
  }

  function removeRow(key: string) {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  }

  function toggleEmployee(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function selectAllActive() {
    setSelectedIds(new Set(employees.filter((e) => e.status === "ACTIVE").map((e) => e.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  const selectedEmployees = useMemo(() => employees.filter((e) => selectedIds.has(e.id)), [employees, selectedIds]);

  async function handleCopy(path: string) {
    if (!origin) return;
    await navigator.clipboard.writeText(`${origin}${path}`);
    setCopiedPath(path);
  }

  if (state.links) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          {t.deliveries.batchCreatedPrefix} {state.links.length}{" "}
          {state.links.length === 1 ? t.deliveries.deliverySingular : t.deliveries.deliveryPlural}.
        </p>
        <div className="flex flex-col gap-2">
          {state.links.map((link) => {
            const url = origin ? `${origin}${link.path}` : link.path;
            return (
              <div key={link.path} className="flex items-center gap-2">
                <span className="w-48 shrink-0 truncate text-sm">{link.employeeFullName}</span>
                <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
                <Button type="button" variant="outline" size="sm" onClick={() => handleCopy(link.path)}>
                  {copiedPath === link.path ? t.common.copied : t.common.copy}
                </Button>
              </div>
            );
          })}
        </div>
        {state.batchId ? (
          <Button asChild variant="outline" className="self-start">
            <Link href={`/deliveries/batches/${state.batchId}`}>{t.deliveries.viewBatch}</Link>
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="companyId" value={companyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="deliveryDate">{t.deliveries.deliveryDateLabel}</Label>
        <Input id="deliveryDate" name="deliveryDate" type="date" defaultValue={todayIso()} required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="note">{t.common.note}</Label>
        <Input id="note" name="note" />
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t.deliveries.itemsLabel}</Label>
        <div className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <div key={row.key} className="flex items-center gap-2">
              <select
                name="epiId"
                required
                defaultValue=""
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
          ))}
        </div>
        {epis.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.deliveries.noActiveEpisForCompany}</p>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={addRow} className="self-start">
          {t.deliveries.addItem}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>
            {t.deliveries.employeesLabel} ({selectedIds.size}{" "}
            {selectedIds.size === 1 ? t.deliveries.selectedSingular : t.deliveries.selectedPlural})
          </Label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={selectAllActive}>
              {t.deliveries.selectAllActive}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearSelection}
              disabled={selectedIds.size === 0}
            >
              {t.common.clearSelection}
            </Button>
          </div>
        </div>
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto rounded-md border p-2">
          {employees.map((emp) => (
            <li key={emp.id}>
              <label className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted">
                <input
                  type="checkbox"
                  checked={selectedIds.has(emp.id)}
                  onChange={() => toggleEmployee(emp.id)}
                  className="size-4"
                />
                <span className="flex-1">{emp.fullName}</span>
                <span className="text-xs text-muted-foreground">{statusLabel[emp.status]}</span>
              </label>
            </li>
          ))}
        </ul>
        {employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.deliveries.noEmployeesForCompany}</p>
        ) : null}
      </div>

      {selectedEmployees.map((emp) => (
        <Fragment key={emp.id}>
          <input type="hidden" name="employeeId" value={emp.id} />
          <input type="hidden" name="employeeFullName" value={emp.fullName} />
        </Fragment>
      ))}

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button
        type="submit"
        disabled={pending || employees.length === 0 || epis.length === 0 || selectedEmployees.length === 0}
      >
        {pending ? t.deliveries.creating : t.deliveries.createBatch}
      </Button>
    </form>
  );
}
