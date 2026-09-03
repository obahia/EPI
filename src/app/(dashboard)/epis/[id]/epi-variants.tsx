"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EpiVariant } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import { createEpiVariant, type EpiVariantFormState } from "../actions";

const initialState: EpiVariantFormState = { error: null };

/** Lists an EPI's size/SKU variants + an inline create form. Variants have no edit/delete
 * UI here (api.deactivate_epi_variant exists but toggling lifecycle is out of scope for
 * this pass) -- just what's needed to build up the list a delivery's variant picker reads
 * from (see deliveries/new/delivery-form.tsx). */
export function EpiVariants({ epiId, variants }: { epiId: string; variants: EpiVariant[] }) {
  const t = useT();
  const [state, formAction, pending] = useActionState(createEpiVariant, initialState);

  return (
    <div className="flex flex-col gap-4">
      {variants.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.epis.noVariantsYet}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.epis.variantLabelColumn}</TableHead>
              <TableHead>{t.epis.variantSkuColumn}</TableHead>
              <TableHead>{t.common.status}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {variants.map((variant) => (
              <TableRow key={variant.id}>
                <TableCell className="font-bold">{variant.label}</TableCell>
                <TableCell className="font-mono text-[12.5px] text-muted-foreground">
                  {variant.sku ?? "—"}
                </TableCell>
                <TableCell>
                  {variant.isActive ? (
                    <Badge variant="outline" className="border-transparent bg-success-soft text-success">
                      {t.epis.statusActive}
                    </Badge>
                  ) : (
                    <Badge variant="ghost" className="text-muted-foreground">
                      {t.epis.statusInactive}
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="epiId" value={epiId} />

        <div className="flex flex-col gap-2">
          <Label htmlFor="variantLabel">{t.epis.variantLabelColumn}</Label>
          <Input id="variantLabel" name="label" required maxLength={30} placeholder={t.epis.variantLabelPlaceholder} className="w-32" />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="variantSku">{t.epis.variantSkuColumn}</Label>
          <Input id="variantSku" name="sku" maxLength={60} className="w-40" />
        </div>

        <Button type="submit" variant="outline" disabled={pending}>
          {t.epis.addVariant}
        </Button>
      </form>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
    </div>
  );
}
