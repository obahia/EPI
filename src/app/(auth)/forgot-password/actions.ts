"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

/**
 * Wired to real Supabase Auth the same as signIn/signUp -- see login/actions.ts. No
 * transactional-email provider is configured on the project yet, so the message won't
 * actually be delivered until that's set up; the flow itself is correct and ready.
 */
const forgotSchema = z.object({ email: z.email() });

export type ForgotPasswordState = { status: "idle" | "sent" | "error"; error: string | null };

export async function requestPasswordReset(
  _prevState: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const t = getDictionary(await getLocale());
  const parsed = forgotSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { status: "error", error: t.auth.forgotError };
  }

  const supabase = await createClient();
  const headerList = await headers();
  const origin = `${headerList.get("x-forwarded-proto") ?? "https"}://${headerList.get("host")}`;

  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });

  // Never reveal whether the address has an account -- same response either way.
  if (error && error.code !== "user_not_found") {
    return { status: "error", error: t.auth.forgotError };
  }

  return { status: "sent", error: null };
}
