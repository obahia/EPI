"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/i18n/provider";
import { createConfirmationLink, type ConfirmationLinkState } from "../actions";

const initialState: ConfirmationLinkState = { error: null, path: null, expiresAt: null };

/**
 * Generates (or regenerates) the worker confirmation link for an ISSUED/CONTESTED delivery.
 * The Server Action only ever returns a relative `path` (see actions.ts's comment on
 * createConfirmationLink) -- the absolute URL is built HERE, client-side, from
 * window.location.origin, and never constructed or logged server-side.
 */
export function ConfirmationLinkPanel({ deliveryId, hasLiveLink }: { deliveryId: string; hasLiveLink: boolean }) {
  const t = useT();
  const [state, formAction, pending] = useActionState(createConfirmationLink, initialState);
  // Lazy initializer runs synchronously during render (both the server's no-op pass, where
  // window is undefined, and the client's hydration pass, where it isn't) -- no effect needed.
  const [origin] = useState<string | null>(() => (typeof window === "undefined" ? null : window.location.origin));
  // Tracks *which* url was last copied (rather than a plain boolean) so a fresh link from a
  // regenerate naturally resets the button label without an effect.
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const url = state.path && origin ? `${origin}${state.path}` : null;
  const showRegenerateLabel = hasLiveLink || state.path !== null;
  const copied = copiedUrl !== null && copiedUrl === url;

  async function handleCopy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopiedUrl(url);
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t.deliveries.confirmationLinkTitle}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form action={formAction} className="flex flex-col gap-2">
          <input type="hidden" name="deliveryId" value={deliveryId} />
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          <Button type="submit" disabled={pending} className="self-start">
            {pending ? t.deliveries.generatingLink : showRegenerateLabel ? t.deliveries.regenerateLink : t.deliveries.generateLink}
          </Button>
        </form>

        {url ? (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
              <Button type="button" variant="outline" onClick={handleCopy}>
                {copied ? t.common.copied : t.common.copy}
              </Button>
            </div>
            {state.expiresAt ? (
              <p className="text-xs text-muted-foreground">
                {t.deliveries.expiresAtPrefix} {new Date(state.expiresAt).toLocaleString("pt-BR")}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
