"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { isValidCaNumber } from "@/lib/epi/ca";
import type { Epi } from "@/lib/supabase/dal";
import { updateEpi, type EpiFormState } from "../actions";

const initialState: EpiFormState = { error: null };

const UNIT_OPTIONS = [
  { value: "UN", label: "Unidade" },
  { value: "PAR", label: "Par" },
  { value: "CX", label: "Caixa" },
  { value: "M", label: "Metro" },
  { value: "KG", label: "Quilo" },
];

const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
);

/** Editing calls api.update_epi, which opens a new epi_version under the hood (SCD2) --
 * from here it's just "edit and save". `returnCompanyId` is only used to build the
 * redirect back to the catalog list after saving, never sent to the RPC. */
export function EpiEditForm({ epi, returnCompanyId }: { epi: Epi; returnCompanyId: string }) {
  const [state, formAction, pending] = useActionState(updateEpi, initialState);
  const [caNumber, setCaNumber] = useState(epi.caNumber);
  const caInvalid = caNumber.length > 0 && !isValidCaNumber(caNumber);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="epiId" value={epi.id} />
      <input type="hidden" name="companyId" value={returnCompanyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Nome</Label>
        <Input id="name" name="name" defaultValue={epi.name} required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="caNumber">CA</Label>
        <Input
          id="caNumber"
          name="caNumber"
          required
          inputMode="numeric"
          aria-invalid={caInvalid}
          value={caNumber}
          onChange={(e) => setCaNumber(e.target.value)}
        />
        {caInvalid ? <p className="text-sm text-destructive">CA inválido (3 a 8 dígitos, apenas números).</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="manufacturer">Fabricante</Label>
        <Input id="manufacturer" name="manufacturer" defaultValue={epi.manufacturer ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="model">Modelo</Label>
        <Input id="model" name="model" defaultValue={epi.model ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">Descrição</Label>
        <Input id="description" name="description" defaultValue={epi.description ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="defaultUnit">Unidade padrão</Label>
        <select id="defaultUnit" name="defaultUnit" defaultValue={epi.defaultUnit} className={selectClassName}>
          {UNIT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending || caInvalid}>
        {pending ? "Salvando…" : "Salvar alterações"}
      </Button>
    </form>
  );
}
