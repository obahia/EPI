import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Panel, PanelKicker } from "@/components/panel";
import type { Delivery, DeliveryItemSummary } from "@/lib/supabase/dal";
import type { Dict } from "@/i18n/dictionaries";

/** Whole days a delivery has been waiting, counted from when it was issued. */
function daysWaiting(delivery: Delivery): number {
  if (!delivery.issuedAt) return 0;
  const ms = Date.now() - new Date(delivery.issuedAt).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 86_400_000) : 0;
}

/**
 * The dashboard's right-hand column, implemented from the mockup: the longest-waiting
 * confirmations named rather than counted -- how many days, who, and which EPI -- on
 * the rose field, closing with the one action that moves all of them at once. A count
 * tells you there is a problem; this tells you whose door to knock on.
 */
export function NeedsAttention({
  deliveries,
  itemsByDelivery,
  deliveriesHref,
  t,
  className,
}: {
  /** Longest-waiting first; the caller decides how many. */
  deliveries: Delivery[];
  itemsByDelivery: Map<string, DeliveryItemSummary>;
  deliveriesHref: string;
  t: Dict;
  className?: string;
}) {
  if (deliveries.length === 0) return null;

  return (
    <Panel tone="warning" className={`flex flex-col ${className ?? ""}`}>
      <PanelKicker className="text-warning">{t.companies.needsAttention}</PanelKicker>

      <ul className="mt-4 flex flex-col gap-3.5">
        {deliveries.map((delivery) => {
          const epiName = itemsByDelivery.get(delivery.id)?.firstEpiName;
          return (
            <li key={delivery.id} className="flex items-baseline gap-3.5">
              <span className="w-8 shrink-0 font-heading text-2xl font-extrabold tracking-tighter tabular-nums">
                {daysWaiting(delivery)}
              </span>
              <span className="min-w-0 flex-1">
                <Link
                  href={`/deliveries/${delivery.id}`}
                  className="block truncate text-[14px] font-bold underline-offset-4 hover:underline"
                >
                  {delivery.employeeFullName}
                </Link>
                <span className="block truncate text-[12px] text-muted-foreground">
                  {t.companies.daysWaiting}
                  {epiName ? ` · ${epiName}` : ""}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <Button asChild size="lg" className="mt-6 w-full">
        <Link href={deliveriesHref}>{t.companies.reviewPending}</Link>
      </Button>
    </Panel>
  );
}
