"use client";

import { Fragment, useActionState, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Employee, Epi } from "@/lib/supabase/dal";
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

const EMPLOYEE_STATUS_LABEL: Record<Employee["status"], string> = {
  ACTIVE: "Ativo",
  ON_LEAVE: "Afastado",
  TERMINATED: "Desligado",
};

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
  const [state, formAction, pending] = useActionState(createDeliveryBatch, initialState);
  const idPrefix = useId();
  const [rows, setRows] = useState<ItemRow[]>([{ key: `${idPrefix}-0` }]);
  const nextRowIndex = useRef(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [origin] = useState<string | null>(() => (typeof window === "undefined" ? null : window.location.origin));
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

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
          Lote criado com {state.links.length} {state.links.length === 1 ? "entrega" : "entregas"}.
        </p>
        <div className="flex flex-col gap-2">
          {state.links.map((link) => {
            const url = origin ? `${origin}${link.path}` : link.path;
            return (
              <div key={link.path} className="flex items-center gap-2">
                <span className="w-48 shrink-0 truncate text-sm">{link.employeeFullName}</span>
                <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
                <Button type="button" variant="outline" size="sm" onClick={() => handleCopy(link.path)}>
                  {copiedPath === link.path ? "Copiado" : "Copiar"}
                </Button>
              </div>
            );
          })}
        </div>
        {state.batchId ? (
          <Button asChild variant="outline" className="self-start">
            <Link href={`/deliveries/batches/${state.batchId}`}>Ver lote</Link>
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="companyId" value={companyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="deliveryDate">Data da entrega</Label>
        <Input id="deliveryDate" name="deliveryDate" type="date" defaultValue={todayIso()} required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="note">Observação</Label>
        <Input id="note" name="note" />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Itens</Label>
        <div className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <div key={row.key} className="flex items-center gap-2">
              <select
                name="epiId"
                required
                defaultValue=""
                aria-label={`EPI do item ${i + 1}`}
                className={selectClassName}
              >
                <option value="" disabled>
                  Selecione um EPI
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
                aria-label={`Quantidade do item ${i + 1}`}
                className="w-24"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => removeRow(row.key)}
                disabled={rows.length === 1}
              >
                Remover
              </Button>
            </div>
          ))}
        </div>
        {epis.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum EPI ativo no catálogo desta empresa ainda.</p>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={addRow} className="self-start">
          Adicionar item
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>
            Funcionários ({selectedIds.size} {selectedIds.size === 1 ? "selecionado" : "selecionados"})
          </Label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={selectAllActive}>
              Selecionar todos os ativos
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearSelection}
              disabled={selectedIds.size === 0}
            >
              Limpar seleção
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
                <span className="text-xs text-muted-foreground">{EMPLOYEE_STATUS_LABEL[emp.status]}</span>
              </label>
            </li>
          ))}
        </ul>
        {employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum funcionário cadastrado nesta empresa ainda.</p>
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
        {pending ? "Criando…" : "Criar lote"}
      </Button>
    </form>
  );
}
