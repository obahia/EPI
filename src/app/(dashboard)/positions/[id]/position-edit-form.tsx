"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { JobPosition } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import { updateJobPosition, type PositionFormState } from "../actions";

const initialState: PositionFormState = { error: null };

const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
);

/** Editing calls api.update_job_position -- an in-place update, unlike the EPI catalog's
 * SCD2 versioning (see the migration's own table comment). `returnCompanyId` only builds
 * the redirect back to the list, never sent to the RPC. */
export function PositionEditForm({ position, returnCompanyId }: { position: JobPosition; returnCompanyId: string }) {
  const t = useT();
  const [state, formAction, pending] = useActionState(updateJobPosition, initialState);

  const statusOptions: { value: JobPosition["status"]; label: string }[] = [
    { value: "ACTIVE", label: t.positions.statusActive },
    { value: "INACTIVE", label: t.positions.statusInactive },
  ];

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="positionId" value={position.id} />
      <input type="hidden" name="companyId" value={returnCompanyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="title">{t.positions.titleLabel}</Label>
        <Input id="title" name="title" defaultValue={position.title} required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">{t.positions.descriptionLabel}</Label>
        <Input id="description" name="description" defaultValue={position.description ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="status">{t.positions.statusLabel}</Label>
        <select id="status" name="status" defaultValue={position.status} className={selectClassName}>
          {statusOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? t.positions.saving : t.positions.saveChanges}
      </Button>
    </form>
  );
}
