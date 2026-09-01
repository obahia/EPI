"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { SealMark } from "@/components/seal-mark";
import { useT } from "@/i18n/provider";
import { signIn, signUp, type AuthActionState } from "./actions";

const initialState: AuthActionState = { error: null };

type Mode = "signin" | "signup";

export default function LoginPage() {
  const t = useT();
  const [mode, setMode] = useState<Mode>("signin");

  return (
    <Card className="mx-4 w-full max-w-sm pb-0 shadow-2xs">
      <CardHeader className="mt-4 mb-2 flex flex-col items-center gap-1 space-y-1 text-center">
        <SealMark className="mb-2 size-10" />
        <h2 className="font-heading text-balance text-2xl font-medium">
          {mode === "signin" ? t.auth.signInTitle : t.auth.signUpTitle}
        </h2>
        <p className="text-pretty text-sm text-muted-foreground">
          {mode === "signin" ? t.auth.signInSubtitle : t.auth.signUpSubtitle}
        </p>
      </CardHeader>

      {/* Keyed by mode: forces a fresh instance (fresh useActionState/local state) on
          every sign-in <-> sign-up switch, so an error from one mode never leaks into
          the other -- useActionState has no external reset, remounting is the only way. */}
      <LoginForm key={mode} mode={mode} />

      <CardFooter className="flex justify-center py-4!">
        <p className="text-pretty text-center text-sm text-muted-foreground">
          {mode === "signin" ? (
            <>
              {t.auth.signUpPrompt}{" "}
              <button type="button" onClick={() => setMode("signup")} className="cursor-pointer text-primary hover:underline">
                {t.auth.signUpCta}
              </button>
            </>
          ) : (
            <>
              {t.auth.signInPrompt}{" "}
              <button type="button" onClick={() => setMode("signin")} className="cursor-pointer text-primary hover:underline">
                {t.auth.signInCta}
              </button>
            </>
          )}
        </p>
      </CardFooter>
    </Card>
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
    <CardContent className="space-y-6">
      <form action={formAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">{t.auth.emailLabel}</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">{t.auth.passwordLabel}</Label>
            {mode === "signin" ? (
              <Link href="/forgot-password" className="text-sm text-primary hover:underline">
                {t.auth.forgotPassword}
              </Link>
            ) : null}
          </div>
          <div className="relative">
            <Input
              className="pe-9"
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
              className="absolute inset-y-0 end-0 flex h-full w-9 cursor-pointer items-center justify-center rounded-e-md text-muted-foreground/80 outline-none transition-[color,box-shadow] hover:text-foreground focus:z-10 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => setIsPasswordVisible((prev) => !prev)}
              type="button"
            >
              {isPasswordVisible ? (
                <EyeOffIcon aria-hidden="true" size={16} />
              ) : (
                <EyeIcon aria-hidden="true" size={16} />
              )}
            </button>
          </div>
        </div>

        {mode === "signup" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="passwordConfirm">{t.auth.passwordConfirmLabel}</Label>
            <div className="relative">
              <Input
                className="pe-9"
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
                className="absolute inset-y-0 end-0 flex h-full w-9 cursor-pointer items-center justify-center rounded-e-md text-muted-foreground/80 outline-none transition-[color,box-shadow] hover:text-foreground focus:z-10 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={() => setIsPasswordConfirmVisible((prev) => !prev)}
                type="button"
              >
                {isPasswordConfirmVisible ? (
                  <EyeOffIcon aria-hidden="true" size={16} />
                ) : (
                  <EyeIcon aria-hidden="true" size={16} />
                )}
              </button>
            </div>
            {passwordsMismatch ? <p className="text-sm text-destructive">{t.auth.resetMismatch}</p> : null}
          </div>
        ) : null}

        {mode === "signin" ? (
          <div className="flex items-center space-x-2">
            <Checkbox defaultChecked id="remember" />
            <Label className="text-sm font-normal" htmlFor="remember">
              {t.auth.rememberMe}
            </Label>
          </div>
        ) : null}

        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

        <Button className="w-full" type="submit" disabled={pending || passwordsMismatch}>
          {pending ? t.common.loading : mode === "signin" ? t.auth.signInCta : t.auth.signUpCta}
        </Button>
      </form>
    </CardContent>
  );
}
