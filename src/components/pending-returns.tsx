import Link from "next/link";
import { Panel, PanelKicker } from "@/components/panel";
import type { PendingReturn } from "@/lib/supabase/dal";
import type { Dict } from "@/i18n/dictionaries";
import { formatShortDateTimeBr } from "@/lib/format/datetime";

/**
 * Open devolução pendencies (spec §9: "se não for devolvido, gerar pendência") -- a "troca"
 * whose EPI is flagged requires_return_on_replacement but never got an api.epi_returns row.
 * Same "named, not just counted" shape as NeedsAttention: who, which EPI, and since when --
 * each row links to the REPLACING delivery (where ReturnItemForm actually lives), not the
 * superseded one, since that's where the return would be recorded.
 */
export function PendingReturns({
  returns,
  timeZone,
  className,
  t,
}: {
  returns: PendingReturn[];
  /** The company's own IANA zone (Company.timeZone) -- falls back to Brasília time in
   * formatShortDateTimeBr when null/undefined. */
  timeZone?: string | null;
  className?: string;
  t: Dict;
}) {
  if (returns.length === 0) return null;

  return (
    <Panel tone="warning" className={`flex flex-col ${className ?? ""}`}>
      <PanelKicker className="text-warning">{t.companies.pendingReturnsTitle}</PanelKicker>

      <ul className="mt-4 flex flex-col gap-3.5">
        {returns.map((r) => (
          <li key={r.deliveryItemId} className="flex items-baseline justify-between gap-3.5">
            <span className="min-w-0 flex-1">
              <Link
                href={`/deliveries/${r.replacedByDeliveryId ?? r.deliveryId}`}
                className="block truncate text-[14px] font-bold underline-offset-4 hover:underline"
              >
                {r.employeeFullName}
              </Link>
              <span className="block truncate text-[12px] text-muted-foreground">
                {r.epiName} · {t.epis.caLabel} {r.caNumber}
              </span>
            </span>
            <span className="shrink-0 text-[12px] text-muted-foreground">
              {formatShortDateTimeBr(r.supersededAt, timeZone)}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
