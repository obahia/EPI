"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Employee } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import { updateEmployee, type EmployeeFormState } from "../actions";

const initialState: EmployeeFormState = { error: null };

// Matches the Input's pill treatment -- no shadcn Select component is installed in this
// project, and pulling one in for two dropdowns is more than this needs.
const selectClassName = cn(
  "h-11 w-full min-w-0 rounded-full border border-input bg-transparent px-4 text-sm outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

/** CPF is intentionally not editable here -- there is no CPF-edit path in FASE 1 (see
 * api.update_employee's own comment). Status leads the form: it is the field managers
 * actually come to this screen to change, and burying it under six text inputs was why it
 * read as "you cannot edit this person". */
export function EmployeeEditForm({ employee }: { employee: Employee }) {
  const t = useT();
  const [state, formAction, pending] = useActionState(updateEmployee, initialState);

  const statusOptions: { value: Employee["status"]; label: string }[] = [
    { value: "ACTIVE", label: t.employees.statusActive },
    { value: "ON_LEAVE", label: t.employees.statusOnLeave },
    { value: "TERMINATED", label: t.employees.statusTerminated },
  ];

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="employeeId" value={employee.id} />
      <input type="hidden" name="companyId" value={employee.companyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="status">{t.common.status}</Label>
        <select id="status" name="status" defaultValue={employee.status} className={selectClassName}>
          {statusOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="text-[12px] text-muted-foreground">{t.employees.statusHint}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="fullName">{t.employees.fullNameLabel}</Label>
          <Input id="fullName" name="fullName" className="h-11" defaultValue={employee.fullName} required />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="registrationNumber">{t.employees.registrationNumberLabel}</Label>
          <Input
            id="registrationNumber"
            name="registrationNumber"
            className="h-11"
            defaultValue={employee.registrationNumber ?? ""}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="phone">{t.employees.phoneLabel}</Label>
          <Input
            id="phone"
            name="phone"
            className="h-11"
            defaultValue={employee.phoneE164 ?? ""}
            placeholder={t.employees.phonePlaceholder}
          />
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="email">{t.common.email}</Label>
          <Input id="email" name="email" type="email" className="h-11" defaultValue={employee.email ?? ""} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="positionTitle">{t.employees.positionLabel}</Label>
          <Input
            id="positionTitle"
            name="positionTitle"
            className="h-11"
            defaultValue={employee.positionTitle ?? ""}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="department">{t.employees.departmentLabel}</Label>
          <Input id="department" name="department" className="h-11" defaultValue={employee.department ?? ""} />
        </div>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <div className="mt-1 flex flex-wrap items-center gap-2.5">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? t.employees.saving : t.employees.saveChanges}
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href={`/employees?company=${employee.companyId}`}>{t.common.cancel}</Link>
        </Button>
      </div>
    </form>
  );
}
