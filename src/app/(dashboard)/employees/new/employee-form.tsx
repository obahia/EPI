"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isValidCpf } from "@/lib/br/cpf";
import { createEmployee, type EmployeeFormState } from "../actions";

const initialState: EmployeeFormState = { error: null };

/**
 * Manual creation form. CPF is a raw <input> validated client-side (isValidCpf) purely for
 * immediate feedback -- the Server Action (createEmployee) re-validates independently and
 * is the only place that ever computes the hash/encryption, so a bypassed client check
 * can't smuggle an invalid CPF through.
 */
export function EmployeeCreateForm({ companyId }: { companyId: string }) {
  const [state, formAction, pending] = useActionState(createEmployee, initialState);
  const [cpf, setCpf] = useState("");
  const cpfInvalid = cpf.length > 0 && !isValidCpf(cpf);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="companyId" value={companyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="fullName">Nome completo</Label>
        <Input id="fullName" name="fullName" required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="cpf">CPF</Label>
        <Input
          id="cpf"
          name="cpf"
          required
          placeholder="000.000.000-00"
          aria-invalid={cpfInvalid}
          value={cpf}
          onChange={(e) => setCpf(e.target.value)}
        />
        {cpfInvalid ? <p className="text-sm text-destructive">CPF inválido.</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="registrationNumber">Matrícula</Label>
        <Input id="registrationNumber" name="registrationNumber" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="phone">Telefone</Label>
        <Input id="phone" name="phone" placeholder="(11) 98765-4321" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" name="email" type="email" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="positionTitle">Cargo</Label>
        <Input id="positionTitle" name="positionTitle" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="department">Departamento</Label>
        <Input id="department" name="department" />
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending || cpfInvalid}>
        {pending ? "Salvando…" : "Cadastrar funcionário"}
      </Button>
    </form>
  );
}
