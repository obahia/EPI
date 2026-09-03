"use client";

import { useActionState, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Panel, PanelKicker } from "@/components/panel";
import { useT } from "@/i18n/provider";
import { createConfirmationLink, type ConfirmationLinkState } from "../actions";
import { formatDateTimeBr } from "@/lib/format/datetime";

const initialState: ConfirmationLinkState = { error: null, path: null, expiresAt: null };

/**
 * Generates (or regenerates) the worker confirmation link for an ISSUED/CONTESTED delivery.
 * The Server Action only ever returns a relative `path` (see actions.ts's comment on
 * createConfirmationLink) -- the absolute URL is built HERE, client-side, from
 * window.location.origin, and never constructed or logged server-side. The QR is rendered
 * in the browser from that same URL for the same reason.
 *
 * Laid out from the mockup (screen 4d): the live link is the panel, on the peach field --
 * the URL itself, the two ways of getting it to the worker, and the QR to hold up to
 * their phone when they are standing right there.
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
  // Keyed by the url it was rendered for, so a stale QR is never shown beside a fresh
  // link -- and so the effect below only ever writes state from its async callback.
  const [qrFor, setQrFor] = useState<{ url: string; dataUrl: string } | null>(null);

  const url = state.path && origin ? `${origin}${state.path}` : null;
  const showRegenerateLabel = hasLiveLink || state.path !== null;
  const copied = copiedUrl !== null && copiedUrl === url;

  // toDataURL is async and the link only exists after the action resolves, so this is the
  // one thing here that genuinely needs an effect.
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    // The URL carries a 43-character token, so the symbol is dense. Render it large and
    // with a full 4-module quiet zone: at the 80px this used to be drawn at, each module
    // fell below one device pixel and phone cameras could not resolve it. Error correction
    // stays at "L" deliberately -- a higher level adds modules, which on a URL this long
    // makes every module smaller and the code *harder* to scan, not easier.
    QRCode.toDataURL(url, { margin: 4, width: 640, errorCorrectionLevel: "L" })
      .then((dataUrl) => {
        if (!cancelled) setQrFor({ url, dataUrl });
      })
      .catch(() => {
        // A QR is a convenience beside the link, never the only way to hand it over --
        // if it cannot be drawn the panel simply shows the URL and the buttons.
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function handleCopy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopiedUrl(url);
  }

  return (
    <Panel tone="warning" className="flex flex-col gap-4">
      <PanelKicker className="text-warning">
        {t.deliveries.confirmationLinkTitle}
        {url ? ` · ${t.deliveries.linkActive}` : null}
      </PanelKicker>

      {url ? (
        <>
          <p className="font-mono text-[12px] break-all">{url}</p>
          <div className="flex flex-wrap gap-2.5">
            <Button type="button" onClick={handleCopy}>
              {copied ? t.common.copied : t.deliveries.copyLink}
            </Button>
            <Button asChild variant="outline">
              <a
                href={`https://wa.me/?text=${encodeURIComponent(url)}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                WhatsApp
              </a>
            </Button>
          </div>

          <div className="flex flex-col items-center gap-3">
            {qrFor?.url === url ? (
              // eslint-disable-next-line @next/next/no-img-element -- a client-generated data: URI, nothing for the image optimizer to fetch
              <img
                src={qrFor.dataUrl}
                alt={t.deliveries.qrAlt}
                className="w-full max-w-64 rounded-xl bg-white"
              />
            ) : null}
            <p className="text-center text-[12px] leading-relaxed text-muted-foreground">
              {t.deliveries.qrHint}
              {state.expiresAt ? (
                <>
                  {" "}
                  {t.deliveries.expiresAtPrefix} {formatDateTimeBr(state.expiresAt)}.
                </>
              ) : null}
            </p>
          </div>
        </>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">{t.deliveries.linkPanelHint}</p>
      )}

      <form action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="deliveryId" value={deliveryId} />
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        <Button type="submit" variant={url ? "outline" : "default"} disabled={pending} className="self-start">
          {pending
            ? t.deliveries.generatingLink
            : showRegenerateLabel
              ? t.deliveries.regenerateLink
              : t.deliveries.generateLink}
        </Button>
      </form>
    </Panel>
  );
}
