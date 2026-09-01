import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabasePublishableKey, getSupabaseUrl } from "./env";

/**
 * Server-side Supabase client (Server Components, Server Actions, Route Handlers). Uses
 * the publishable key + the caller's own session cookie -- RLS applies normally. For the
 * rare cross-tenant/admin operation that must bypass RLS, use the SEPARATE worker/admin
 * client module once it exists (FASE 3+) -- never reach for the secret key here.
 *
 * A Server Component cannot set cookies, so `setAll` below is allowed to no-op there;
 * proxy.ts is what actually persists a refreshed session cookie back to the browser. This
 * is the official @supabase/ssr pattern, not a shortcut -- see docs/architecture.md §4.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(getSupabaseUrl(), getSupabasePublishableKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component -- proxy.ts refreshes the session instead.
        }
      },
    },
  });
}
