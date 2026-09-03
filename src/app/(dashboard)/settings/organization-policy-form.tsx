"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/provider";
import type { OrganizationPolicy } from "@/lib/supabase/dal";
import { updateOrganizationPolicy, type OrganizationPolicyState } from "./actions";

const initialState: OrganizationPolicyState = { error: null, success: false };

// Matches the shadcn Input's visual style -- no shadcn Select component is installed yet
// (same rationale as epis/new/epi-form.tsx's own selectClassName).
const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
);

/** Plain form for the six org-wide policy/feature-flag fields -- ORG_ADMIN only, see
 * SettingsPage's own gating. Deliberately simple: no fancy UI, just labeled fields. */
export function OrganizationPolicyForm({
  organizationId,
  policy,
}: {
  organizationId: string;
  policy: OrganizationPolicy;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState(updateOrganizationPolicy, initialState);

  useEffect(() => {
    if (state.success) toast.success(t.settings.updated);
  }, [state.success, t.settings.updated]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="earlyReplacementPolicy">{t.settings.earlyReplacementPolicyLabel}</Label>
        <select
          id="earlyReplacementPolicy"
          name="earlyReplacementPolicy"
          defaultValue={policy.earlyReplacementPolicy}
          className={selectClassName}
        >
          <option value="allow">{t.settings.earlyReplacementPolicyAllow}</option>
          <option value="warn">{t.settings.earlyReplacementPolicyWarn}</option>
          <option value="block">{t.settings.earlyReplacementPolicyBlock}</option>
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="replacementAlertDays">{t.settings.replacementAlertDaysLabel}</Label>
        <Input
          id="replacementAlertDays"
          name="replacementAlertDays"
          type="number"
          min={1}
          max={365}
          defaultValue={policy.replacementAlertDays}
          required
        />
      </div>

      <div className="flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="stockNegativeAllowed" defaultChecked={policy.stockNegativeAllowed} />
          {t.settings.stockNegativeAllowedLabel}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="inventoryEnabled" defaultChecked={policy.inventoryEnabled} />
          {t.settings.inventoryEnabledLabel}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="complianceEnabled" defaultChecked={policy.complianceEnabled} />
          {t.settings.complianceEnabledLabel}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="roleMatrixEnabled" defaultChecked={policy.roleMatrixEnabled} />
          {t.settings.roleMatrixEnabledLabel}
        </label>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? t.settings.saving : t.settings.saveChanges}
        </Button>
      </div>
    </form>
  );
}
