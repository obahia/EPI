"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { resolveContest, type ResolveContestState } from "../actions";

const initialState: ResolveContestState = { error: null };

/** Inline "answer this contest" form for one delivery_contests row. Server-side, this is
 * fully permission-checked by api.resolve_contest (requires delivery.issue) -- any rejection
 * just surfaces as state.error here. */
export function ResolveContestForm({ deliveryId, contestId }: { deliveryId: string; contestId: string }) {
  const [state, formAction, pending] = useActionState(resolveContest, initialState);
  const fieldId = `resolutionNote-${contestId}`;

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <input type="hidden" name="contestId" value={contestId} />
      <div className="flex flex-col gap-1">
        <Label htmlFor={fieldId}>Resposta</Label>
        <textarea
          id={fieldId}
          name="resolutionNote"
          rows={3}
          maxLength={2000}
          className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Registrando…" : "Registrar resposta"}
      </Button>
    </form>
  );
}
