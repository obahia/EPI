"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { isValidCaNumber } from "@/lib/epi/ca";
import { useT } from "@/i18n/provider";
import { createEpi, type EpiFormState } from "../actions";

const initialState: EpiFormState = { error: null };

// Matches the shadcn Input's visual style -- no shadcn Select component is installed yet
// (same rationale as employees/[id]/employee-edit-form.tsx's own selectClassName).
const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
);

/**
 * New EPI catalog entry. `canCreateOrgWide` gates whether the "catálogo compartilhado da
 * organização vs. desta empresa" toggle is even shown -- api.create_epi requires org-wide
 * ORG_ADMIN for a NULL company_id, and a company-scoped user should never be offered a
 * choice they can't actually use.
 */
export function EpiCreateForm({
  organizationId,
  companyId,
  canCreateOrgWide,
}: {
  organizationId: string;
  companyId: string;
  canCreateOrgWide: boolean;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState(createEpi, initialState);
  const [caNumber, setCaNumber] = useState("");
  const [scope, setScope] = useState<"company" | "org">("company");
  const caInvalid = caNumber.length > 0 && !isValidCaNumber(caNumber);

  const unitOptions = [
    { value: "UN", label: t.epis.unitUn },
    { value: "PAR", label: t.epis.unitPar },
    { value: "CX", label: t.epis.unitCx },
    { value: "M", label: t.epis.unitM },
    { value: "KG", label: t.epis.unitKg },
  ];

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="companyId" value={companyId} />

      {canCreateOrgWide ? (
        <div className="flex flex-col gap-2">
          <Label>{t.epis.catalogLabel}</Label>
          <div className="flex flex-col gap-1 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                value="company"
                checked={scope === "company"}
                onChange={() => setScope("company")}
              />
              {t.epis.scopeCompanyOnly}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                value="org"
                checked={scope === "org"}
                onChange={() => setScope("org")}
              />
              {t.epis.scopeOrgWide}
            </label>
          </div>
        </div>
      ) : (
        <input type="hidden" name="scope" value="company" />
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="name">{t.common.name}</Label>
        <Input id="name" name="name" required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="caNumber">{t.epis.caLabel}</Label>
        <Input
          id="caNumber"
          name="caNumber"
          required
          placeholder="12345"
          inputMode="numeric"
          aria-invalid={caInvalid}
          value={caNumber}
          onChange={(e) => setCaNumber(e.target.value)}
        />
        {caInvalid ? <p className="text-sm text-destructive">{t.epis.caInvalidMessage}</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="manufacturer">{t.epis.manufacturerLabel}</Label>
        <Input id="manufacturer" name="manufacturer" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="model">{t.epis.modelLabel}</Label>
        <Input id="model" name="model" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">{t.epis.descriptionLabel}</Label>
        <Input id="description" name="description" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="defaultUnit">{t.epis.defaultUnitLabel}</Label>
        <select id="defaultUnit" name="defaultUnit" defaultValue="UN" className={selectClassName}>
          {unitOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="defaultLifespanDays">{t.epis.defaultLifespanDaysLabel}</Label>
        <Input id="defaultLifespanDays" name="defaultLifespanDays" type="number" min={1} max={3650} />
        <p className="text-sm text-muted-foreground">{t.epis.defaultLifespanDaysHint}</p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="requiresReturnOnReplacement" value="true" />
        {t.epis.requiresReturnOnReplacementLabel}
      </label>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending || caInvalid}>
        {pending ? t.epis.saving : t.epis.registerEpi}
      </Button>
    </form>
  );
}
