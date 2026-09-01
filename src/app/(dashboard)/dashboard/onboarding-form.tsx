"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isValidCnpj } from "@/lib/br/cnpj";
import { onboardOrganization, type OnboardingState } from "./onboarding-actions";

const initialState: OnboardingState = { error: null };

/**
 * Shown on the dashboard when the current user has zero memberships (see
 * src/app/(dashboard)/dashboard/page.tsx). Creates a DIRECT organization + its one company
 * in a single call to api.onboard_organization. The company fields default to mirror the
 * organization's (the common DIRECT-org case: one legal entity, one company) but stay
 * editable -- once the user types into a company field directly, it stops following the
 * organization field.
 */
export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(onboardOrganization, initialState);

  const [orgLegalName, setOrgLegalName] = useState("");
  const [orgCnpj, setOrgCnpj] = useState("");
  const [companyLegalName, setCompanyLegalName] = useState("");
  const [companyLegalNameTouched, setCompanyLegalNameTouched] = useState(false);
  const [companyCnpj, setCompanyCnpj] = useState("");
  const [companyCnpjTouched, setCompanyCnpjTouched] = useState(false);

  const orgCnpjInvalid = orgCnpj.length > 0 && !isValidCnpj(orgCnpj);
  const companyCnpjInvalid = companyCnpj.length > 0 && !isValidCnpj(companyCnpj);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comece cadastrando sua empresa</CardTitle>
        <CardDescription>
          Isto cria sua organização e sua primeira empresa. Você poderá adicionar mais empresas depois.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">Organização</p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="orgLegalName">Razão social</Label>
              <Input
                id="orgLegalName"
                name="orgLegalName"
                required
                value={orgLegalName}
                onChange={(e) => {
                  setOrgLegalName(e.target.value);
                  if (!companyLegalNameTouched) setCompanyLegalName(e.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="orgCnpj">CNPJ</Label>
              <Input
                id="orgCnpj"
                name="orgCnpj"
                required
                placeholder="00.000.000/0000-00"
                aria-invalid={orgCnpjInvalid}
                value={orgCnpj}
                onChange={(e) => {
                  setOrgCnpj(e.target.value);
                  if (!companyCnpjTouched) setCompanyCnpj(e.target.value);
                }}
              />
              {orgCnpjInvalid ? <p className="text-sm text-destructive">CNPJ inválido.</p> : null}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">Empresa</p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="companyLegalName">Razão social</Label>
              <Input
                id="companyLegalName"
                name="companyLegalName"
                required
                value={companyLegalName}
                onChange={(e) => {
                  setCompanyLegalNameTouched(true);
                  setCompanyLegalName(e.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="companyCnpj">CNPJ</Label>
              <Input
                id="companyCnpj"
                name="companyCnpj"
                required
                placeholder="00.000.000/0000-00"
                aria-invalid={companyCnpjInvalid}
                value={companyCnpj}
                onChange={(e) => {
                  setCompanyCnpjTouched(true);
                  setCompanyCnpj(e.target.value);
                }}
              />
              {companyCnpjInvalid ? <p className="text-sm text-destructive">CNPJ inválido.</p> : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="companyTradeName">Nome fantasia (opcional)</Label>
              <Input id="companyTradeName" name="companyTradeName" />
            </div>
          </div>

          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

          <Button type="submit" disabled={pending}>
            {pending ? "Criando…" : "Criar organização"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
