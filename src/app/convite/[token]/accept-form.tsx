"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { acceptInvitation, type AcceptState } from "./actions";

export function AcceptForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<AcceptState, FormData>(acceptInvitation, {
    error: null,
  });

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={pending} className="h-13 text-base">
        {pending ? "Aguarde…" : "Aceitar convite"}
      </Button>
    </form>
  );
}
