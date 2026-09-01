"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { setLocale } from "@/i18n/actions";
import { useLocale, useT } from "@/i18n/provider";
import type { Locale } from "@/i18n/dictionaries";

export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(next: Locale) {
    if (next === locale) return;
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  }

  return (
    <div
      className={cn("inline-flex items-center rounded-md border border-border bg-muted/50 p-0.5 text-xs", className)}
      role="group"
      aria-label={t.languageSwitcher.label}
    >
      {(["pt", "en"] as const).map((code) => (
        <button
          key={code}
          type="button"
          disabled={pending}
          onClick={() => choose(code)}
          aria-pressed={locale === code}
          className={cn(
            "cursor-pointer rounded-[calc(var(--radius-md)-2px)] px-2 py-1 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
            locale === code ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
