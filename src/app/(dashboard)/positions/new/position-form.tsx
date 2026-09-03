"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n/provider";
import { createJobPosition, type PositionFormState } from "../actions";

const initialState: PositionFormState = { error: null };

/**
 * New job position ("cargo"). `canCreateOrgWide` gates the "catálogo compartilhado da
 * organização vs. desta empresa" toggle exactly like epis/new/epi-form.tsx's own --
 * api.create_job_position requires org-wide ORG_ADMIN for a NULL company_id.
 */
export function PositionCreateForm({
  organizationId,
  companyId,
  canCreateOrgWide,
}: {
  organizationId: string;
  companyId: string;
  canCreateOrgWide: boolean;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState(createJobPosition, initialState);
  const [scope, setScope] = useState<"company" | "org">("company");

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="companyId" value={companyId} />

      {canCreateOrgWide ? (
        <div className="flex flex-col gap-2">
          <Label>{t.positions.catalogLabel}</Label>
          <div className="flex flex-col gap-1 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                value="company"
                checked={scope === "company"}
                onChange={() => setScope("company")}
              />
              {t.positions.scopeCompanyOnly}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                value="org"
                checked={scope === "org"}
                onChange={() => setScope("org")}
              />
              {t.positions.scopeOrgWide}
            </label>
          </div>
        </div>
      ) : (
        <input type="hidden" name="scope" value="company" />
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="title">{t.positions.titleLabel}</Label>
        <Input id="title" name="title" required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">{t.positions.descriptionLabel}</Label>
        <Input id="description" name="description" />
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? t.positions.saving : t.positions.registerPosition}
      </Button>
    </form>
  );
}
