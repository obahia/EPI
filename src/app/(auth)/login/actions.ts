"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export type AuthActionState = { error: string | null };

/**
 * Password auth, deliberately: this is FASE 0 and no email-sending provider is
 * configured on the Supabase project yet, so a magic-link/OTP flow would have nothing to
 * deliver through. Revisit once FASE 1+ wires up transactional email. See
 * docs/architecture.md §4 -- the manager panel's auth METHOD is not architecturally
 * load-bearing, only that it goes through Supabase Auth + getClaims().
 */
export async function signIn(_prevState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const parsed = credentialsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: "E-mail ou senha inválidos." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return { error: "Não foi possível entrar. Confira e-mail e senha." };
  }

  redirect("/dashboard");
}

/**
 * Self-serve signup exists only because this is FASE 0 scaffolding with no invite flow
 * yet (that belongs to FASE 1's membership management). app.handle_new_auth_user()
 * auto-provisions the matching app.users row on the database side.
 */
export async function signUp(_prevState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const parsed = credentialsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: "E-mail ou senha inválidos (mínimo 8 caracteres)." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp(parsed.data);
  if (error) {
    return { error: "Não foi possível criar a conta." };
  }

  redirect("/dashboard");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
