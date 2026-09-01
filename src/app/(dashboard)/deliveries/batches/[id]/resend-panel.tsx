"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { resendBatchPending, type ResendBatchState } from "../../batch-actions";

const initialState: ResendBatchState = { error: null, links: null };

/**
 * Resends every still-pending delivery in a batch. Same "server returns a relative path,
 * client builds the absolute URL" rule as confirmation-link-panel.tsx -- the fresh worker
 * links only ever exist in this one response, so this renders inline rather than
 * redirecting away before the manager can copy them.
 */
export function ResendBatchPanel({ batchId }: { batchId: string }) {
  const [state, formAction, pending] = useActionState(resendBatchPending, initialState);
  const [origin] = useState<string | null>(() => (typeof window === "undefined" ? null : window.location.origin));
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  async function handleCopy(path: string) {
    if (!origin) return;
    await navigator.clipboard.writeText(`${origin}${path}`);
    setCopiedPath(path);
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Reenviar pendentes</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form action={formAction} className="flex flex-col gap-2">
          <input type="hidden" name="batchId" value={batchId} />
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          <Button type="submit" disabled={pending} className="self-start">
            {pending ? "Reenviando…" : "Reenviar pendentes"}
          </Button>
        </form>

        {state.links !== null ? (
          state.links.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma entrega pendente para reenviar.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {state.links.map((link) => {
                const url = origin ? `${origin}${link.path}` : link.path;
                return (
                  <div key={link.path} className="flex items-center gap-2">
                    <span className="w-48 shrink-0 truncate text-sm">{link.employeeFullName}</span>
                    <Input
                      readOnly
                      value={url}
                      onFocus={(e) => e.currentTarget.select()}
                      className="font-mono text-xs"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => handleCopy(link.path)}>
                      {copiedPath === link.path ? "Copiado" : "Copiar"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
