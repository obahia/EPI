"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabasePublishableKey, getSupabaseUrl } from "./env";

/**
 * Browser-side Supabase client. Only ever uses the publishable key -- never import
 * env.ts's getSupabaseSecretKey() from anything reachable in a Client Component.
 * See docs/architecture.md §4/§15.
 */
export function createClient() {
  return createBrowserClient(getSupabaseUrl(), getSupabasePublishableKey());
}
