"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { isValidCaNumber } from "@/lib/epi/ca";
import { createEpi, type EpiFormState } from "../actions";

const initialState: EpiFormState = { error: null };

const UNIT_OPTIONS = [
  { value: "UN", label: "Unidade" },
  { value: "PAR", label: "Par" },
  { value: "CX", label: "Caixa" },
  { value: "M", label: "Metro" },
  { value: "KG", label: "Quilo" },
];

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
  const [state, formAction, pending] = useActionState(createEpi, initialState);
  const [caNumber, setCaNumber] = useState("");
  const [scope, setScope] = useState<"company" | "org">("company");
  const caInvalid = caNumber.length > 0 && !isValidCaNumber(caNumber);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="companyId" value={companyId} />

      {canCreateOrgWide ? (
        <div className="flex flex-col gap-2">
          <Label>Catálogo</Label>
          <div className="flex flex-col gap-1 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                value="company"
                checked={scope === "company"}
                onChange={() => setScope("company")}
              />
              Apenas desta empresa
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                value="org"
                checked={scope === "org"}
                onChange={() => setScope("org")}
              />
              Compartilhado com toda a organização
            </label>
          </div>
        </div>
      ) : (
        <input type="hidden" name="scope" value="company" />
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Nome</Label>
        <Input id="name" name="name" required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="caNumber">CA</Label>
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
        {caInvalid ? <p className="text-sm text-destructive">CA inválido (3 a 8 dígitos, apenas números).</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="manufacturer">Fabricante</Label>
        <Input id="manufacturer" name="manufacturer" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="model">Modelo</Label>
        <Input id="model" name="model" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">Descrição</Label>
        <Input id="description" name="description" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="defaultUnit">Unidade padrão</Label>
        <select id="defaultUnit" name="defaultUnit" defaultValue="UN" className={selectClassName}>
          {UNIT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending || caInvalid}>
        {pending ? "Salvando…" : "Cadastrar EPI"}
      </Button>
    </form>
  );
}
