"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Epi, EpiVariant, Location } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import { transferStock, type TransferFormState } from "../actions";

const initialState: TransferFormState = { error: null };

const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
);

/**
 * Transfers a quantity of one EPI (optionally, one variant) between two locations via
 * api.transfer_stock. Either side left blank means the company-wide bucket (location_id
 * NULL) -- the RPC rejects the same bucket on both sides (including blank/blank), see
 * transferStock's own comment on why that's left to the RPC rather than checked here.
 */
export function TransferForm({
  companyId,
  locations,
  epis,
  variantsByEpi,
}: {
  companyId: string;
  locations: Location[];
  epis: Epi[];
  variantsByEpi: Record<string, EpiVariant[]>;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState(transferStock, initialState);
  const [epiId, setEpiId] = useState("");
  const variants = epiId ? (variantsByEpi[epiId] ?? []) : [];

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="companyId" value={companyId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="fromLocationId">{t.stock.fromLocationLabel}</Label>
        <select id="fromLocationId" name="fromLocationId" defaultValue="" className={selectClassName}>
          <option value="">{t.stock.companyWideLabel}</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="toLocationId">{t.stock.toLocationLabel}</Label>
        <select id="toLocationId" name="toLocationId" defaultValue="" className={selectClassName}>
          <option value="">{t.stock.companyWideLabel}</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="epiId">{t.stock.epiLabel}</Label>
        <select
          id="epiId"
          name="epiId"
          required
          value={epiId}
          onChange={(event) => setEpiId(event.target.value)}
          className={selectClassName}
        >
          <option value="" disabled>
            {t.stock.selectEpiPlaceholder}
          </option>
          {epis.map((epi) => (
            <option key={epi.id} value={epi.id}>
              {epi.name} — CA {epi.caNumber}
            </option>
          ))}
        </select>
      </div>

      {variants.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="variantId">{t.stock.variantLabel}</Label>
          <select id="variantId" name="variantId" defaultValue="" className={selectClassName}>
            <option value="">{t.stock.noVariantOption}</option>
            {variants.map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variant.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <input type="hidden" name="variantId" value="" />
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="quantity">{t.stock.quantityLabel}</Label>
        <Input id="quantity" name="quantity" type="number" min={1} max={100000} defaultValue={1} required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="reason">
          {t.stock.reasonLabel} <span className="text-muted-foreground">({t.common.optional})</span>
        </Label>
        <Input id="reason" name="reason" />
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending || epis.length === 0}>
        {pending ? t.stock.transferring : t.stock.doTransfer}
      </Button>
    </form>
  );
}
