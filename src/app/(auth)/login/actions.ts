"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

const signUpSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8),
    passwordConfirm: z.string().min(8),
  })
  .refine((data) => data.password === data.passwordConfirm, { path: ["passwordConfirm"] });

export type AuthActionState = { error: string | null };

/**
 * The only destination a login is allowed to carry, matched literally rather than merely
 * "starts with a slash": an open redirect on a sign-in page is exactly how a phishing flow
 * borrows a real domain. Phase G needs one destination -- an invitation link that survives
 * the sign-in or sign-up the invited person has to do first -- so one is what is allowed.
 */
const INVITATION_PATH = /^\/convite\/[A-Za-z0-9_-]{43}$/;

function safeNext(formData: FormData): string {
  const next = formData.get("next");
  return typeof next === "string" && INVITATION_PATH.test(next) ? next : "/dashboard";
}

/**
 * Password auth, deliberately: this is FASE 0 and no email-sending provider is
 * configured on the Supabase project yet, so a magic-link/OTP flow would have nothing to
 * deliver through. Revisit once FASE 1+ wires up transactional email. See
 * docs/architecture.md §4 -- the manager panel's auth METHOD is not architecturally
 * load-bearing, only that it goes through Supabase Auth + getClaims().
 */
export async function signIn(_prevState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const t = getDictionary(await getLocale());
  const parsed = credentialsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: t.auth.invalidCredentials };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return { error: t.auth.signInError };
  }

  redirect(safeNext(formData));
}

/**
 * Self-serve signup exists only because this is FASE 0 scaffolding with no invite flow
 * yet (that belongs to FASE 1's membership management). app.handle_new_auth_user()
 * auto-provisions the matching app.users row on the database side.
 */
export async function signUp(_prevState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const t = getDictionary(await getLocale());
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const mismatch = parsed.error.issues.some((i) => i.path[0] === "passwordConfirm");
    return { error: mismatch ? t.auth.resetMismatch : t.auth.invalidCredentialsMin };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({ email: parsed.data.email, password: parsed.data.password });
  if (error) {
    return { error: t.auth.signUpError };
  }

  redirect(safeNext(formData));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
