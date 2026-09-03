"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Location } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import { updateLocation, type LocationFormState } from "../actions";

const initialState: LocationFormState = { error: null };

const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
);

/** Editing calls api.update_location -- an in-place update, same as PositionEditForm's own
 * api.update_job_position. `returnCompanyId` only builds the redirect back to the list,
 * never sent to the RPC. */
export function LocationEditForm({ location, returnCompanyId }: { location: Location; returnCompanyId: string }) {
  const t = useT();
  const [state, formAction, pending] = useActionState(updateLocation, initialState);

  const street = typeof location.address?.street === "string" ? (location.address.street as string) : "";
  const city = typeof location.address?.city === "string" ? (location.address.city as string) : "";

  const statusOptions: { value: Location["status"]; label: string }[] = [
    { value: "ACTIVE", label: t.locations.statusActive },
    { value: "INACTIVE", label: t.locations.statusInactive },
  ];

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="locationId" value={location.id} />
      <input type="hidden" name="companyId" value={returnCompanyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="name">{t.locations.nameLabel}</Label>
        <Input id="name" name="name" defaultValue={location.name} required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="code">
          {t.locations.codeLabel} <span className="text-muted-foreground">({t.common.optional})</span>
        </Label>
        <Input id="code" name="code" defaultValue={location.code ?? ""} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="street">
          {t.locations.streetLabel} <span className="text-muted-foreground">({t.common.optional})</span>
        </Label>
        <Input id="street" name="street" defaultValue={street} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="city">
          {t.locations.cityLabel} <span className="text-muted-foreground">({t.common.optional})</span>
        </Label>
        <Input id="city" name="city" defaultValue={city} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="status">{t.locations.statusLabel}</Label>
        <select id="status" name="status" defaultValue={location.status} className={selectClassName}>
          {statusOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? t.locations.saving : t.locations.saveChanges}
      </Button>
    </form>
  );
}
