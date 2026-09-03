"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { SealMark } from "@/components/seal-mark";
import { useT } from "@/i18n/provider";
import { signIn, signUp, type AuthActionState } from "./actions";

const initialState: AuthActionState = { error: null };

/** The mockup's fields: tall pills on a filled cream field rather than outlined boxes. */
const FIELD_CLASS =
  "h-13 rounded-full border-primary/35 bg-[color-mix(in_srgb,var(--foreground)_10%,var(--background))] px-5 text-base";

export type Mode = "signin" | "signup";

/**
 * Implemented from the mockup (screen 4a): a split screen, not a centered card --
 * the form on the cream ground at the left, the marketing panel on the deeper
 * cream at the right, sunburst bleeding out of its top corner and the NR-6 line
 * anchored to its bottom. The one thing it drops from the mockup is that panel's
 * pair of demo figures (142 entregas, 85% em 48 h): they are placeholder numbers,
 * and an unauthenticated page must not present fabricated stats as real.
 *
 * `initialMode` comes from `?mode=signup` (see page.tsx) -- the landing page's
 * "Começar grátis" buttons deep-link here so they actually open the sign-up
 * form instead of silently landing on sign-in.
 */
export function LoginView({ initialMode }: { initialMode: Mode }) {
  const t = useT();
  const [mode, setMode] = useState<Mode>(initialMode);

  return (
    <main className="flex flex-1">
      <div className="flex flex-1 flex-col justify-center px-6 py-16 sm:px-12 lg:px-24 xl:px-32">
        <div className="flex w-full max-w-md flex-col">
          <div className="mb-8 flex items-center gap-3">
            <SealMark className="size-10" />
            <span className="font-heading text-xl font-extrabold tracking-tight">{t.brand.name}</span>
          </div>

          {mode === "signin" ? (
            <>
              <h1 className="font-heading text-4xl font-extrabold tracking-tight text-balance sm:text-5xl">
                {t.auth.marketingHeadline}
              </h1>
              <p className="mt-5 max-w-sm text-lg text-muted-foreground">{t.auth.marketingSubtitle}</p>
            </>
          ) : (
            <>
              <h1 className="font-heading text-4xl font-extrabold tracking-tight">{t.auth.signUpTitle}</h1>
              <p className="mt-2 text-muted-foreground">{t.auth.signUpSubtitle}</p>
            </>
          )}

          <LoginForm key={mode} mode={mode} />

          <p className="mt-4 text-sm text-muted-foreground">
            {mode === "signin" ? (
              <>
                {t.auth.signUpPrompt}{" "}
                <button
                  type="button"
                  onClick={() => setMode("signup")}
                  className="cursor-pointer font-bold text-primary-deep underline underline-offset-4"
                >
                  {t.auth.signUpCta}
                </button>
              </>
            ) : (
              <>
                {t.auth.signInPrompt}{" "}
                <button
                  type="button"
                  onClick={() => setMode("signin")}
                  className="cursor-pointer font-bold text-primary-deep underline underline-offset-4"
                >
                  {t.auth.signInCta}
                </button>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="relative hidden w-[38%] max-w-[520px] shrink-0 flex-col justify-end overflow-hidden bg-secondary p-14 lg:flex">
        <div
          className="absolute -top-24 -right-36 size-[440px] rounded-full"
          style={{
            background: "repeating-conic-gradient(from 0deg, color-mix(in srgb, var(--primary) 28%, transparent) 0deg 3deg, transparent 3deg 22.5deg)",
          }}
          aria-hidden="true"
        />
        <div
          className="absolute top-2 -right-10 size-[280px] rounded-full border-8"
          style={{ borderColor: "color-mix(in srgb, var(--primary) 28%, transparent)" }}
          aria-hidden="true"
        />
        <div className="relative">
          <p className="text-xs font-bold tracking-[0.09em] text-primary-deep uppercase">{t.auth.marketingKicker}</p>
          <p className="mt-3 max-w-xs font-heading text-2xl font-extrabold tracking-tight">
            {t.auth.marketingQuote}
          </p>
        </div>
      </div>
    </main>
  );
}

function LoginForm({ mode }: { mode: Mode }) {
  const t = useT();
  const [state, formAction, pending] = useActionState(mode === "signin" ? signIn : signUp, initialState);
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isPasswordConfirmVisible, setIsPasswordConfirmVisible] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const passwordsMismatch = mode === "signup" && passwordConfirm.length > 0 && password !== passwordConfirm;

  return (
    <form action={formAction} className="mt-8 flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t.auth.emailLabel}</Label>
        <Input id="email" name="email" type="email" autoComplete="email" className={FIELD_CLASS} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">{t.auth.passwordLabel}</Label>
        <div className="relative">
          <Input
            className={`${FIELD_CLASS} pe-10`}
            id="password"
            name="password"
            type={isPasswordVisible ? "text" : "password"}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            aria-controls="password"
            aria-label={isPasswordVisible ? t.auth.hidePassword : t.auth.showPassword}
            aria-pressed={isPasswordVisible}
            className="absolute inset-y-0 end-0 flex h-full w-10 cursor-pointer items-center justify-center rounded-e-full text-muted-foreground/80 outline-none transition-[color,box-shadow] hover:text-foreground focus:z-10 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => setIsPasswordVisible((prev) => !prev)}
            type="button"
          >
            {isPasswordVisible ? <EyeOffIcon aria-hidden="true" size={17} /> : <EyeIcon aria-hidden="true" size={17} />}
          </button>
        </div>
      </div>

      {mode === "signup" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="passwordConfirm">{t.auth.passwordConfirmLabel}</Label>
          <div className="relative">
            <Input
              className={`${FIELD_CLASS} pe-10`}
              id="passwordConfirm"
              name="passwordConfirm"
              type={isPasswordConfirmVisible ? "text" : "password"}
              autoComplete="new-password"
              minLength={8}
              required
              aria-invalid={passwordsMismatch}
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
            />
            <button
              aria-controls="passwordConfirm"
              aria-label={isPasswordConfirmVisible ? t.auth.hidePassword : t.auth.showPassword}
              aria-pressed={isPasswordConfirmVisible}
              className="absolute inset-y-0 end-0 flex h-full w-10 cursor-pointer items-center justify-center rounded-e-full text-muted-foreground/80 outline-none transition-[color,box-shadow] hover:text-foreground focus:z-10 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => setIsPasswordConfirmVisible((prev) => !prev)}
              type="button"
            >
              {isPasswordConfirmVisible ? (
                <EyeOffIcon aria-hidden="true" size={17} />
              ) : (
                <EyeIcon aria-hidden="true" size={17} />
              )}
            </button>
          </div>
          {passwordsMismatch ? <p className="text-sm text-destructive">{t.auth.resetMismatch}</p> : null}
        </div>
      ) : null}

      {mode === "signin" ? (
        <div className="mt-1 flex items-center justify-between gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox id="remember" />
            {t.auth.rememberMe}
          </label>
          <Link href="/forgot-password" className="text-sm font-bold text-primary-deep underline underline-offset-4">
            {t.auth.forgotPassword}
          </Link>
        </div>
      ) : null}

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button className="mt-2 h-14 text-base" type="submit" disabled={pending || passwordsMismatch}>
        {pending ? t.common.loading : mode === "signin" ? t.auth.signInCta : t.auth.signUpCta}
      </Button>
    </form>
  );
}
