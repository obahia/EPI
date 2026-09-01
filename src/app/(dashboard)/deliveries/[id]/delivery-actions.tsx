"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DeliveryStatus } from "@/lib/supabase/dal";
import { cancelDelivery, issueDelivery, type DeliveryFormState } from "../actions";

const initialState: DeliveryFormState = { error: null };

/**
 * Status-appropriate actions for the delivery detail page. DRAFT -> "Emitir" (issue_delivery)
 * and "Cancelar" (cancel_delivery) are two DISTINCT RPC calls/buttons, never collapsed into
 * one -- the DRAFT state is real even if a user moves through it in seconds. ISSUED only
 * gets "Cancelar". Any other status (CONFIRMED/CONTESTED/CANCELLED/SUPERSEDED) renders no
 * actions at all -- those aren't reachable from FASE 2's own UI yet, but this component
 * must render them sanely since FASE 3+ produces them against this SAME page.
 */
export function DeliveryActions({ deliveryId, status }: { deliveryId: string; status: DeliveryStatus }) {
  if (status !== "DRAFT" && status !== "ISSUED") {
    return null;
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Ações</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {status === "DRAFT" ? <IssueForm deliveryId={deliveryId} /> : null}
        <CancelForm deliveryId={deliveryId} />
      </CardContent>
    </Card>
  );
}

function IssueForm({ deliveryId }: { deliveryId: string }) {
  const [state, formAction, pending] = useActionState(issueDelivery, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="deliveryId" value={deliveryId} />
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Emitindo…" : "Emitir"}
      </Button>
    </form>
  );
}

function CancelForm({ deliveryId }: { deliveryId: string }) {
  const [state, formAction, pending] = useActionState(cancelDelivery, initialState);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="destructive" onClick={() => setOpen(true)} className="self-start">
        Cancelar entrega
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="reason">Motivo do cancelamento (opcional)</Label>
        <Input id="reason" name="reason" maxLength={500} />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? "Cancelando…" : "Confirmar cancelamento"}
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
          Voltar
        </Button>
      </div>
    </form>
  );
}
