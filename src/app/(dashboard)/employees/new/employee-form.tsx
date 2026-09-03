"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { isValidCpf } from "@/lib/br/cpf";
import type { JobPosition, Location } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import { createEmployee, type EmployeeFormState } from "../actions";

const initialState: EmployeeFormState = { error: null };

// Matches the Input's pill treatment -- no shadcn Select component is installed in this
// project (same rationale as employees/[id]/employee-edit-form.tsx's own selectClassName).
const selectClassName = cn(
  "h-9 w-full min-w-0 rounded-full border border-input bg-transparent px-3.5 text-sm outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

/**
 * Manual creation form. CPF is a raw <input> validated client-side (isValidCpf) purely for
 * immediate feedback -- the Server Action (createEmployee) re-validates independently and
 * is the only place that ever computes the hash/encryption, so a bypassed client check
 * can't smuggle an invalid CPF through.
 */
export function EmployeeCreateForm({
  companyId,
  positions,
  locations,
}: {
  companyId: string;
  positions: JobPosition[];
  locations: Location[];
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState(createEmployee, initialState);
  const [cpf, setCpf] = useState("");
  const cpfInvalid = cpf.length > 0 && !isValidCpf(cpf);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="companyId" value={companyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="fullName">{t.employees.fullNameLabel}</Label>
        <Input id="fullName" name="fullName" required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="cpf">{t.employees.cpfLabel}</Label>
        <Input
          id="cpf"
          name="cpf"
          required
          placeholder={t.employees.cpfPlaceholder}
          aria-invalid={cpfInvalid}
          value={cpf}
          onChange={(e) => setCpf(e.target.value)}
        />
        {cpfInvalid ? <p className="text-sm text-destructive">{t.employees.invalidCpfMessage}</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="registrationNumber">{t.employees.registrationNumberLabel}</Label>
        <Input id="registrationNumber" name="registrationNumber" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="phone">{t.employees.phoneLabel}</Label>
        <Input id="phone" name="phone" placeholder={t.employees.phonePlaceholder} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">{t.common.email}</Label>
        <Input id="email" name="email" type="email" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="positionId">{t.employees.positionCatalogLabel}</Label>
        <select id="positionId" name="positionId" defaultValue="" className={selectClassName}>
          <option value="">{t.employees.noPositionOption}</option>
          {positions.map((position) => (
            <option key={position.id} value={position.id}>
              {position.title}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="locationId">{t.employees.locationCatalogLabel}</Label>
        <select id="locationId" name="locationId" defaultValue="" className={selectClassName}>
          <option value="">{t.employees.noLocationOption}</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="positionTitle">{t.employees.positionLabel}</Label>
        <Input id="positionTitle" name="positionTitle" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="department">{t.employees.departmentLabel}</Label>
        <Input id="department" name="department" />
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending || cpfInvalid}>
        {pending ? t.employees.saving : t.employees.registerEmployee}
      </Button>
    </form>
  );
}
