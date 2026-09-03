import Link from "next/link";
import { Panel, PanelKicker } from "@/components/panel";
import type { StockBalance } from "@/lib/supabase/dal";
import type { Dict } from "@/i18n/dictionaries";

/** "Estoque baixo" (docs task: Phase B closure) -- balances at or under a fixed threshold,
 * v1 simplest-correct-thing (no per-EPI configurable threshold yet). Same "returns null
 * when empty" shape as PendingReturns, and only ever rendered by the caller when the
 * organization has inventory_enabled (see companies/[id]/dashboard/page.tsx). */
export function LowStockPanel({
  balances,
  locationNameById,
  stockHref,
  className,
  t,
}: {
  balances: StockBalance[];
  locationNameById: Map<string, string>;
  stockHref: string;
  className?: string;
  t: Dict;
}) {
  if (balances.length === 0) return null;

  return (
    <Panel tone="warning" className={`flex flex-col ${className ?? ""}`}>
      <PanelKicker className="text-warning">{t.companies.lowStockTitle}</PanelKicker>

      <ul className="mt-4 flex flex-col gap-3.5">
        {balances.map((balance) => (
          <li
            key={`${balance.locationId ?? "none"}-${balance.epiId}-${balance.variantId ?? "none"}`}
            className="flex items-baseline justify-between gap-3.5"
          >
            <span className="min-w-0 flex-1">
              <Link href={stockHref} className="block truncate text-[14px] font-bold underline-offset-4 hover:underline">
                {balance.epiName}
                {balance.variantLabel ? ` · ${balance.variantLabel}` : ""}
              </Link>
              <span className="block truncate text-[12px] text-muted-foreground">
                {t.epis.caLabel} {balance.caNumber} ·{" "}
                {balance.locationId ? (locationNameById.get(balance.locationId) ?? "—") : t.stock.companyWideOption}
              </span>
            </span>
            <span className="shrink-0 text-[13px] font-bold tabular-nums text-destructive">{balance.quantity}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
