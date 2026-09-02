import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The band every page opens with, implemented from the mockup: an optional
 * "back" link above everything, an uppercase kicker carrying the counts or the
 * period, the title, an optional subtitle under it, and the page's actions
 * pushed to the right edge. `titleSuffix` is for the one case the mockup shows
 * on the delivery detail -- a status pill sitting inline beside the name.
 */
export function PageHeader({
  back,
  kicker,
  title,
  titleSuffix,
  subtitle,
  actions,
  className,
}: {
  back?: { href: string; label: string };
  kicker?: React.ReactNode;
  title: string;
  titleSuffix?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {back ? (
        <Link
          href={back.href}
          className="w-fit text-[13px] font-bold text-primary-deep underline-offset-4 hover:underline"
        >
          ← {back.label}
        </Link>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          {kicker ? (
            <p className="text-[10.5px] font-bold tracking-[0.12em] text-muted-foreground uppercase">{kicker}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-heading text-4xl font-extrabold tracking-tight">{title}</h1>
            {titleSuffix}
          </div>
          {subtitle ? <p className="text-[13.5px] text-muted-foreground">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2.5">{actions}</div> : null}
      </div>
    </div>
  );
}
