import { notFound } from "next/navigation";
import { WebauthnProbe } from "./probe";

/**
 * THROWAWAY DIAGNOSTIC -- delete this route once the question below is answered.
 *
 * Answers one thing before anyone builds passkey confirmation: does WebAuthn actually
 * work in the browsers a construction worker will really open the link in? The
 * confirmation link arrives by WhatsApp, so it opens in WhatsApp's embedded browser
 * (WKWebView on iOS, Android WebView), not in Safari or Chrome. Embedded browsers have
 * historically had partial or absent WebAuthn support, and docs/mvp-roadmap.md FASE 4
 * already flags the sibling finding about getUserMedia there as unverified by primary
 * source.
 *
 * If the platform authenticator is unavailable inside WhatsApp, a passkey flow has to
 * either push the worker out to a real browser (friction, on site, with a helmet on) or
 * stay a secondary factor. That decision changes the whole design, so it comes first.
 *
 * Deliberately: no login, no server call, no database, nothing stored anywhere. Open it
 * on a real phone, from a real WhatsApp message. It is a browser capability report.
 *
 * Gated by a query-string key rather than NODE_ENV. A blanket "blocked outside
 * development" would defeat the point: the one thing this page has to prove is whether
 * WebAuthn works inside WhatsApp's embedded browser on the REAL production domain over
 * REAL HTTPS -- localhost cannot answer that. So the route stays reachable in production,
 * but not to a stranger who finds the URL: DEV_PROBE_KEY must be set and match `?key=`,
 * and with no key configured the route 404s unconditionally (fails closed, not open).
 */
export default async function WebauthnProbePage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string }>;
}) {
  const expected = process.env.DEV_PROBE_KEY;
  const { key } = await searchParams;
  if (!expected || key !== expected) {
    notFound();
  }

  return (
    <main className="mx-auto flex min-h-svh max-w-lg flex-col gap-5 px-5 py-8">
      <div>
        <h1 className="font-heading text-2xl font-extrabold tracking-tight">Teste de WebAuthn</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Abra esta página <strong>pelo link no WhatsApp</strong>, no telemóvel, sem copiar o
          endereço para o navegador — é exatamente assim que o funcionário vai abrir.
        </p>
      </div>

      <WebauthnProbe />
    </main>
  );
}
