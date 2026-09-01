"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateCompany, type UpdateCompanyState } from "./actions";

const initialState: UpdateCompanyState = { error: null, success: false };

export function CompanyEditForm({
  companyId,
  legalName,
  tradeName,
}: {
  companyId: string;
  legalName: string;
  tradeName: string | null;
}) {
  const [state, formAction, pending] = useActionState(updateCompany, initialState);

  useEffect(() => {
    if (state.success) toast.success("Empresa atualizada.");
  }, [state.success]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="companyId" value={companyId} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="legalName">Razão social</Label>
        <Input id="legalName" name="legalName" defaultValue={legalName} required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="tradeName">Nome fantasia</Label>
        <Input id="tradeName" name="tradeName" defaultValue={tradeName ?? ""} />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Salvando…" : "Salvar alterações"}
        </Button>
      </div>
    </form>
  );
}
