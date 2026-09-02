"use client";

import { useActionState, useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SealMark } from "@/components/seal-mark";
import { useT } from "@/i18n/provider";
import { updatePassword, type ResetPasswordState } from "./actions";

const initialState: ResetPasswordState = { error: null };

export default function ResetPasswordPage() {
  const t = useT();
  const [state, formAction, pending] = useActionState(updatePassword, initialState);
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isPasswordConfirmVisible, setIsPasswordConfirmVisible] = useState(false);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-sm flex-col items-center">
        <SealMark className="mb-6 size-12" />
        <Card className="w-full border-border/80 shadow-sm">
          <CardHeader>
            <CardTitle className="text-2xl">{t.auth.resetTitle}</CardTitle>
            <CardDescription>{t.auth.resetDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={formAction} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">{t.auth.resetPasswordLabel}</Label>
                <div className="relative">
                  <Input
                    className="pe-9"
                    id="password"
                    name="password"
                    type={isPasswordVisible ? "text" : "password"}
                    autoComplete="new-password"
                    minLength={8}
                    required
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
              <div className="flex flex-col gap-2">
                <Label htmlFor="passwordConfirm">{t.auth.resetPasswordConfirmLabel}</Label>
                <div className="relative">
                  <Input
                    className="pe-9"
                    id="passwordConfirm"
                    name="passwordConfirm"
                    type={isPasswordConfirmVisible ? "text" : "password"}
                    autoComplete="new-password"
                    minLength={8}
                    required
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
              </div>
              {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
              <Button type="submit" disabled={pending}>
                {pending ? t.common.loading : t.auth.resetCta}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
