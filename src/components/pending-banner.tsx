import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { PanelKicker } from "@/components/panel";
import type { Dict } from "@/i18n/dictionaries";

/**
 * The tile the operational dashboard leads with, implemented from the mockup: the
 * one number that means somebody still has to act gets the whole terracotta field --
 * flat, as the mockup draws it -- and the two "waiting longer than" counts as a
 * single line under it. Every other counter drops to the plain
 * tiles beside it. Confirmations all in? The tile goes olive and says so instead
 * of showing a proud zero.
 */
export function PendingBanner({
  pendingCount,
  over3Days,
  over7Days,
  deliveriesHref,
  t,
  className,
}: {
  pendingCount: number;
  over3Days: number;
  over7Days: number;
  deliveriesHref: string;
  t: Dict;
  className?: string;
}) {
  if (pendingCount === 0) {
    return (
      <section className={`flex flex-col justify-center gap-3 rounded-3xl bg-success-soft p-7 text-success ${className ?? ""}`}>
        <CheckCircle2 className="size-8 shrink-0" />
        <div>
          <p className="font-heading text-2xl font-extrabold tracking-tight">{t.companies.nothingPending}</p>
          <p className="mt-1 text-[13.5px] opacity-80">{t.companies.nothingPendingHint}</p>
        </div>
      </section>
    );
  }

  return (
    <Link
      href={deliveriesHref}
      className={`group flex flex-col justify-center rounded-3xl bg-primary p-7 text-primary-foreground transition-colors hover:bg-primary-deep ${className ?? ""}`}
    >
      <div>
        <PanelKicker className="opacity-85">{t.companies.pendingKickerLong}</PanelKicker>
        <p className="mt-2 font-heading text-7xl leading-none font-extrabold tracking-tighter tabular-nums">
          {pendingCount}
        </p>
        <p className="mt-4 text-[13.5px] opacity-85">
          {over3Days} {t.companies.over3DaysShort} · {over7Days} {t.companies.over7DaysShort}
        </p>
      </div>
    </Link>
  );
}
