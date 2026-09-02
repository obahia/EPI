import { NextResponse, type NextRequest } from "next/server";
import { hashWorkerToken } from "@/lib/crypto/worker-token";
import { createWorkerClient } from "@/lib/supabase/worker-client";

export const runtime = "nodejs";

/**
 * GET /e/<token> -- the ONLY place the raw token ever appears in a URL. Hashes it, calls
 * worker.open_link once (this is what actually validates the token and drives SENT->VIEWED),
 * then exchanges it for an HttpOnly cookie and 303-redirects to a token-less path
 * (docs/architecture.md §8) -- neutralizes Referer/history/link-preview leakage. Every
 * subsequent request (including the review page itself) reads the token from the cookie,
 * never the URL again.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return NextResponse.redirect(new URL("/e/invalid", request.url), { status: 303 });
  }

  const tokenHash = hashWorkerToken(token);
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

  const supabase = createWorkerClient();
  const { data, error } = await supabase
    .schema("worker")
    .rpc("open_link", { p_token_hash_b64: tokenHash.toString("base64"), p_client_ip: clientIp })
    .single();

  if (error || !data) {
    return NextResponse.redirect(new URL("/e/invalid", request.url), { status: 303 });
  }

  const row = data as { confirmation_request_id: string; expires_at: string };
  const response = NextResponse.redirect(new URL(`/e/s/${row.confirmation_request_id}`, request.url), { status: 303 });

  const maxAgeSeconds = Math.max(
    60,
    Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000),
  );
  // `lax`, NOT `strict`. The worker always arrives here from somewhere else -- a WhatsApp
  // message, an SMS, a QR scan -- which is a cross-site navigation. A `strict` cookie is
  // withheld on the request that follows this redirect, so the very first load of
  // /e/s/<id> saw no cookie and rendered "Link não disponível"; only a manual refresh
  // (a same-site navigation) worked. `lax` still withholds the cookie on cross-site POSTs,
  // which is the CSRF protection that actually matters here: confirming and contesting are
  // Server Actions (POST), and they are additionally guarded by the one-time nonce, the
  // expiry, the rate limit, and the [id]-vs-token match check in page.tsx.
  response.cookies.set("epi_wt", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/e",
    maxAge: maxAgeSeconds,
  });

  return response;
}
