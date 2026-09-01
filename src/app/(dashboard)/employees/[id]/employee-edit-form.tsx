"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Employee } from "@/lib/supabase/dal";
import { updateEmployee, type EmployeeFormState } from "../actions";

const initialState: EmployeeFormState = { error: null };

const STATUS_OPTIONS: { value: Employee["status"]; label: string }[] = [
  { value: "ACTIVE", label: "Ativo" },
  { value: "ON_LEAVE", label: "Afastado" },
  { value: "TERMINATED", label: "Desligado" },
];

// Matches the shadcn Input's visual style -- no shadcn Select component is installed yet
// in this project, and pulling one in for a single dropdown is more than FASE 1 needs.
const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
);

/** CPF is intentionally not editable here -- there is no CPF-edit path in FASE 1 (see
 * api.update_employee's own comment). */
export function EmployeeEditForm({ employee }: { employee: Employee }) {
  const [state, formAction, pending] = useActionState(updateEmployee, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="employeeId" value={employee.id} />
      <input type="hidden" name="companyId" value={employee.companyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="fullName">Nome completo</Label>
        <Input id="fullName" name="fullName" defaultValue={employee.fullName} required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="registrationNumber">Matrícula</Label>
        <Input id="registrationNumber" name="registrationNumber" defaultValue={employee.registrationNumber ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="phone">Telefone</Label>
        <Input id="phone" name="phone" defaultValue={employee.phoneE164 ?? ""} placeholder="(11) 98765-4321" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" name="email" type="email" defaultValue={employee.email ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="positionTitle">Cargo</Label>
        <Input id="positionTitle" name="positionTitle" defaultValue={employee.positionTitle ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="department">Departamento</Label>
        <Input id="department" name="department" defaultValue={employee.department ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="status">Status</Label>
        <select id="status" name="status" defaultValue={employee.status} className={selectClassName}>
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Salvando…" : "Salvar alterações"}
      </Button>
    </form>
  );
}
