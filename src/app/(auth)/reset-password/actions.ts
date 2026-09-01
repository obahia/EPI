"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

const resetSchema = z
  .object({
    password: z.string().min(8),
    passwordConfirm: z.string().min(8),
  })
  .refine((data) => data.password === data.passwordConfirm, { path: ["passwordConfirm"] });

export type ResetPasswordState = { error: string | null };

/**
 * Only reachable with the recovery session /auth/callback established -- updateUser
 * fails with no active session, which is exactly the "expired/invalid link" case.
 */
export async function updatePassword(_prevState: ResetPasswordState, formData: FormData): Promise<ResetPasswordState> {
  const t = getDictionary(await getLocale());
  const parsed = resetSchema.safeParse({
    password: formData.get("password"),
    passwordConfirm: formData.get("passwordConfirm"),
  });
  if (!parsed.success) {
    const mismatch = parsed.error.issues.some((i) => i.path[0] === "passwordConfirm");
    return { error: mismatch ? t.auth.resetMismatch : t.auth.resetError };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return { error: t.auth.resetLinkInvalid };
  }

  redirect("/dashboard");
}
