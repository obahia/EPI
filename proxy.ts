import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 proxy (formerly middleware.ts). Runs on the Node.js runtime by default.
 *
 * This does ONLY an optimistic session refresh -- it never queries our own tables and is
 * never the authorization boundary. Real authorization happens in the Data Access Layer
 * (src/lib/supabase/dal.ts) close to the data, backed by RLS. See docs/architecture.md §4
 * for why: proxy matchers can silently stop covering a route after a refactor, and two
 * Next.js CVEs in the last 18 months were proxy/middleware bypasses.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Triggers a token refresh when needed; also required so cookies actually get
  // persisted via setAll above. Optimistic only -- not a data read.
  await supabase.auth.getClaims();

  return response;
}

export const config = {
  matcher: [
    /*
     * Match every route except static assets and image optimization files. The worker
     * link routes (/e/*) and the public /verify/* route are intentionally NOT excluded
     * here -- session refresh is harmless for anonymous routes, it just finds no session.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
