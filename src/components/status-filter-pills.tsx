import Link from "next/link";
import { cn } from "@/lib/utils";

export type PillTone = "default" | "primary" | "success" | "destructive";

export type StatusFilterOption = {
  /** `undefined` on the "all" pill -- it drops the param instead of setting it. */
  value?: string;
  label: string;
  count: number;
  /** Tints the pill while it is *not* selected, the way the mockup colours the
   * status filters after the status they stand for. */
  tone?: PillTone;
};

const TONES: Record<PillTone, string> = {
  default: "bg-foreground/6 text-muted-foreground hover:bg-foreground/10",
  primary: "bg-primary/10 text-primary-deep hover:bg-primary/16",
  success: "bg-success-soft text-success hover:bg-success-soft/70",
  destructive: "bg-destructive-soft text-destructive hover:bg-destructive-soft/70",
};

/**
 * The segmented row of counted pills a list page is filtered with, implemented from
 * the mockup. Plain links carrying a search param, so filtering stays server-rendered
 * and every state is a shareable URL. The selected pill goes ink; the rest carry the
 * colour of the status they select.
 */
export function StatusFilterPills({
  options,
  active,
  basePath,
  params,
}: {
  options: StatusFilterOption[];
  active: string | undefined;
  basePath: string;
  /** Params to keep on every pill (the selected company and search term, typically). */
  params?: Record<string, string | undefined>;
}) {
  function href(value: string | undefined): string {
    const search = new URLSearchParams();
    for (const [key, val] of Object.entries(params ?? {})) {
      if (val) search.set(key, val);
    }
    if (value) search.set("status", value);
    const query = search.toString();
    return query ? `${basePath}?${query}` : basePath;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const selected = option.value === active;
        return (
          <Link
            key={option.label}
            href={href(option.value)}
            aria-current={selected ? "true" : undefined}
            className={cn(
              "inline-flex h-8.5 items-center gap-1.5 rounded-full px-4 text-[13px] font-bold transition-colors",
              selected ? "bg-foreground text-background" : TONES[option.tone ?? "default"],
            )}
          >
            {option.label}
            <span className="font-extrabold opacity-65 tabular-nums">{option.count}</span>
          </Link>
        );
      })}
    </div>
  );
}
