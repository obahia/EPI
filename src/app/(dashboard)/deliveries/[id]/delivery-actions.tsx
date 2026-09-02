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
import type { DeliveryStatus } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import { cancelDelivery, issueDelivery, type DeliveryFormState } from "../actions";

const initialState: DeliveryFormState = { error: null };

/**
 * Status-appropriate actions for the delivery detail page. DRAFT -> "Emitir" (issue_delivery)
 * and "Cancelar" (cancel_delivery) are two DISTINCT RPC calls/buttons, never collapsed into
 * one -- the DRAFT state is real even if a user moves through it in seconds. ISSUED only
 * gets "Cancelar". Any other status (CONFIRMED/CONTESTED/CANCELLED/SUPERSEDED) renders no
 * actions at all -- those aren't reachable from FASE 2's own UI yet, but this component
 * must render them sanely since FASE 3+ produces them against this SAME page.
 *
 * The mockup puts these in the page header rather than in a card of their own, so they
 * render as bare buttons and the cancel reason moved into a dialog.
 */
export function DeliveryActions({ deliveryId, status }: { deliveryId: string; status: DeliveryStatus }) {
  if (status !== "DRAFT" && status !== "ISSUED") {
    return null;
  }

  return (
    <>
      <CancelAction deliveryId={deliveryId} />
      {status === "DRAFT" ? <IssueForm deliveryId={deliveryId} /> : null}
    </>
  );
}

function IssueForm({ deliveryId }: { deliveryId: string }) {
  const t = useT();
  const [state, formAction, pending] = useActionState(issueDelivery, initialState);

  return (
    <form action={formAction} className="flex items-center gap-3">
      <input type="hidden" name="deliveryId" value={deliveryId} />
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? t.deliveries.issuing : t.deliveries.issue}
      </Button>
    </form>
  );
}

function CancelAction({ deliveryId }: { deliveryId: string }) {
  const t = useT();
  const [state, formAction, pending] = useActionState(cancelDelivery, initialState);
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="lg">
          {t.deliveries.cancelDelivery}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form action={formAction} className="flex flex-col gap-5">
          <input type="hidden" name="deliveryId" value={deliveryId} />
          <DialogHeader>
            <DialogTitle>{t.deliveries.cancelDelivery}</DialogTitle>
            <DialogDescription>{t.deliveries.cancelReasonLabel}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reason">{t.deliveries.cancelReasonLabel}</Label>
            <Input id="reason" name="reason" maxLength={500} />
          </div>
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {t.common.back}
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? t.deliveries.cancelling : t.deliveries.confirmCancel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
