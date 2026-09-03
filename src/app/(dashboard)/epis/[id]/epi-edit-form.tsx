"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { isValidCaNumber } from "@/lib/epi/ca";
import type { Epi } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import { updateEpi, type EpiFormState } from "../actions";

const initialState: EpiFormState = { error: null };

const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
);

/** Editing calls api.update_epi, which opens a new epi_version under the hood (SCD2) --
 * from here it's just "edit and save". `returnCompanyId` is only used to build the
 * redirect back to the catalog list after saving, never sent to the RPC. */
export function EpiEditForm({ epi, returnCompanyId }: { epi: Epi; returnCompanyId: string }) {
  const t = useT();
  const [state, formAction, pending] = useActionState(updateEpi, initialState);
  const [caNumber, setCaNumber] = useState(epi.caNumber);
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
      <input type="hidden" name="epiId" value={epi.id} />
      <input type="hidden" name="companyId" value={returnCompanyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="name">{t.common.name}</Label>
        <Input id="name" name="name" defaultValue={epi.name} required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="caNumber">{t.epis.caLabel}</Label>
        <Input
          id="caNumber"
          name="caNumber"
          required
          inputMode="numeric"
          aria-invalid={caInvalid}
          value={caNumber}
          onChange={(e) => setCaNumber(e.target.value)}
        />
        {caInvalid ? <p className="text-sm text-destructive">{t.epis.caInvalidMessage}</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="manufacturer">{t.epis.manufacturerLabel}</Label>
        <Input id="manufacturer" name="manufacturer" defaultValue={epi.manufacturer ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="model">{t.epis.modelLabel}</Label>
        <Input id="model" name="model" defaultValue={epi.model ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">{t.epis.descriptionLabel}</Label>
        <Input id="description" name="description" defaultValue={epi.description ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="defaultUnit">{t.epis.defaultUnitLabel}</Label>
        <select id="defaultUnit" name="defaultUnit" defaultValue={epi.defaultUnit} className={selectClassName}>
          {unitOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="defaultLifespanDays">{t.epis.defaultLifespanDaysLabel}</Label>
        <Input
          id="defaultLifespanDays"
          name="defaultLifespanDays"
          type="number"
          min={1}
          max={3650}
          defaultValue={epi.defaultLifespanDays ?? ""}
        />
        <p className="text-sm text-muted-foreground">{t.epis.defaultLifespanDaysHint}</p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="requiresReturnOnReplacement"
          value="true"
          defaultChecked={epi.requiresReturnOnReplacement}
        />
        {t.epis.requiresReturnOnReplacementLabel}
      </label>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending || caInvalid}>
        {pending ? t.epis.saving : t.epis.saveChanges}
      </Button>
    </form>
  );
}
