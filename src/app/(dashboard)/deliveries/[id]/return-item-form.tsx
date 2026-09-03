"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/provider";
import { recordEpiReturn, type RecordReturnState } from "../actions";
import type { EpiReturnReasonCode } from "@/lib/supabase/dal";
import { epiReturnReasonLabel } from "./labels";

const initialState: RecordReturnState = { error: null };

const REASON_CODES: EpiReturnReasonCode[] = ["WORN_OUT", "REPLACED", "TERMINATION", "OTHER"];

const selectClassName = cn(
  "h-11 w-full min-w-0 rounded-full border border-input bg-transparent px-4 text-sm outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Records a devolução (return) of one delivery line item -- manager-facing only, no
 * worker confirmation or sealed evidence (see the migration's own header comment for the
 * product decision behind that). Only rendered by the caller for a CONFIRMED delivery's
 * not-yet-returned items; the RPC itself re-enforces both.
 */
export function ReturnItemForm({ deliveryId, deliveryItemId }: { deliveryId: string; deliveryItemId: string }) {
  const t = useT();
  const [state, formAction, pending] = useActionState(recordEpiReturn, initialState);
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<EpiReturnReasonCode>("WORN_OUT");
  const reasonLabel = epiReturnReasonLabel(t);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="cursor-pointer text-[12.5px] font-bold text-primary-deep hover:underline">
          {t.deliveries.returnItem}
        </button>
      </DialogTrigger>
      <DialogContent>
        <form action={formAction} className="flex flex-col gap-5">
          <input type="hidden" name="deliveryItemId" value={deliveryItemId} />
          <input type="hidden" name="deliveryId" value={deliveryId} />
          <DialogHeader>
            <DialogTitle>{t.deliveries.returnItem}</DialogTitle>
            <DialogDescription>{t.deliveries.returnItemHint}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="returnedOn">{t.deliveries.returnedOnLabel}</Label>
            <Input id="returnedOn" name="returnedOn" type="date" defaultValue={today()} max={today()} required />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="reasonCode">{t.deliveries.returnReasonLabel}</Label>
            <select
              id="reasonCode"
              name="reasonCode"
              className={selectClassName}
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value as EpiReturnReasonCode)}
            >
              {REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {reasonLabel[code]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="note">
              {t.deliveries.returnNoteLabel}
              {reasonCode !== "OTHER" ? ` (${t.common.optional})` : null}
            </Label>
            <textarea
              id="note"
              name="note"
              rows={3}
              maxLength={2000}
              required={reasonCode === "OTHER"}
              className="w-full min-w-0 rounded-2xl border border-input bg-transparent px-4 py-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>

          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {t.common.back}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? t.deliveries.returnRecording : t.deliveries.confirmReturn}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
