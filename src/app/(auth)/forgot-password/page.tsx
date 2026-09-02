"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SealMark } from "@/components/seal-mark";
import { useT } from "@/i18n/provider";
import { requestPasswordReset, type ForgotPasswordState } from "./actions";

const initialState: ForgotPasswordState = { status: "idle", error: null };

export default function ForgotPasswordPage() {
  const t = useT();
  const [state, formAction, pending] = useActionState(requestPasswordReset, initialState);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-sm flex-col items-center">
        <SealMark className="mb-6 size-12" />
        <Card className="w-full border-border/80 shadow-sm">
          <CardHeader>
            <CardTitle className="text-2xl">{t.auth.forgotTitle}</CardTitle>
            <CardDescription>{t.auth.forgotDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            {state.status === "sent" ? (
              <p className="text-sm text-foreground">{t.auth.forgotSent}</p>
            ) : (
              <form action={formAction} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="email">{t.auth.emailLabel}</Label>
                  <Input id="email" name="email" type="email" autoComplete="email" required />
                </div>
                {state.status === "error" ? <p className="text-sm text-destructive">{state.error}</p> : null}
                <Button type="submit" disabled={pending}>
                  {pending ? t.common.loading : t.auth.forgotCta}
                </Button>
              </form>
            )}
            <Link
              href="/login"
              className="mt-4 inline-block text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              {t.auth.backToLogin}
            </Link>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
