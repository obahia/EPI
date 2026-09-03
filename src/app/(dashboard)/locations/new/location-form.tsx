"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n/provider";
import { createLocation, type LocationFormState } from "../actions";

const initialState: LocationFormState = { error: null };

/** New location ("local/unidade"). Address is kept deliberately simple -- a couple of
 * plain text inputs (street/city) folded into the jsonb `address` column api.create_location
 * takes, not a full address builder (CEP lookup, state/country selects, etc.) -- this
 * phase has no requirement for that. */
export function LocationCreateForm({ companyId }: { companyId: string }) {
  const t = useT();
  const [state, formAction, pending] = useActionState(createLocation, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="companyId" value={companyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="name">{t.locations.nameLabel}</Label>
        <Input id="name" name="name" required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="code">
          {t.locations.codeLabel} <span className="text-muted-foreground">({t.common.optional})</span>
        </Label>
        <Input id="code" name="code" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="street">
          {t.locations.streetLabel} <span className="text-muted-foreground">({t.common.optional})</span>
        </Label>
        <Input id="street" name="street" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="city">
          {t.locations.cityLabel} <span className="text-muted-foreground">({t.common.optional})</span>
        </Label>
        <Input id="city" name="city" />
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? t.locations.saving : t.locations.registerLocation}
      </Button>
    </form>
  );
}
