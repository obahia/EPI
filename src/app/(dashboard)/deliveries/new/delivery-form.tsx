"use client";

import { useActionState, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Employee, Epi } from "@/lib/supabase/dal";
import { createDelivery, type DeliveryFormState } from "../actions";

const initialState: DeliveryFormState = { error: null };

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

type ItemRow = { key: string };

/**
 * Individual delivery creation: employee (plain <select>, per docs/mvp-roadmap.md FASE 2
 * -- a combobox library is more than this needs) + a repeatable EPI/quantity line-item
 * list + date + optional note. Each row submits as its own `epiId`/`quantity` form field
 * pair (see the Server Action's comment) so no client-side JSON assembly is needed.
 */
export function DeliveryCreateForm({
  companyId,
  employees,
  epis,
}: {
  companyId: string;
  employees: Employee[];
  epis: Epi[];
}) {
  const [state, formAction, pending] = useActionState(createDelivery, initialState);
  const idPrefix = useId();
  const [rows, setRows] = useState<ItemRow[]>([{ key: `${idPrefix}-0` }]);
  const nextRowIndex = useRef(1);

  function addRow() {
    setRows((prev) => [...prev, { key: `${idPrefix}-${nextRowIndex.current++}` }]);
  }

  function removeRow(key: string) {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="companyId" value={companyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="employeeId">Funcionário</Label>
        <select id="employeeId" name="employeeId" required defaultValue="" className={selectClassName}>
          <option value="" disabled>
            Selecione um funcionário
          </option>
          {employees.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.fullName}
            </option>
          ))}
        </select>
        {employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum funcionário cadastrado nesta empresa ainda.</p>
        ) : null}
      </div>

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

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending || employees.length === 0 || epis.length === 0}>
        {pending ? "Criando…" : "Criar entrega"}
      </Button>
    </form>
  );
}
