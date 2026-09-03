"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { Epi, Location } from "@/lib/supabase/dal";
import type { Dict } from "@/i18n/dictionaries";

const selectClassName = cn(
  "h-9 w-full min-w-0 rounded-full border border-input bg-card px-3.5 text-[13px] outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

/**
 * Location/EPI filters for the balance list and the movement history, implemented as a
 * plain pair of <select>s that rewrite the URL's own query params on change -- same
 * "server-rendered, every state a shareable URL" discipline as SearchField/
 * StatusFilterPills, just without a matching pill-per-value convention since the value
 * sets here (every location, every EPI in the catalog) are open-ended rather than a small
 * fixed enum.
 */
export function StockFilters({
  basePath,
  companyId,
  locations,
  epis,
  activeLocationId,
  activeEpiId,
  t,
}: {
  basePath: string;
  companyId: string;
  locations: Location[];
  epis: Epi[];
  activeLocationId?: string;
  activeEpiId?: string;
  t: Dict;
}) {
  const router = useRouter();

  function go(next: { location?: string; epi?: string }) {
    const search = new URLSearchParams({ company: companyId });
    const location = "location" in next ? next.location : activeLocationId;
    const epi = "epi" in next ? next.epi : activeEpiId;
    if (location) search.set("location", location);
    if (epi) search.set("epi", epi);
    router.push(`${basePath}?${search.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <select
        aria-label={t.stock.locationColumn}
        value={activeLocationId ?? ""}
        onChange={(event) => go({ location: event.target.value })}
        className={cn(selectClassName, "max-w-72")}
      >
        <option value="">{t.stock.allLocationsOption}</option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>

      <select
        aria-label={t.stock.epiColumn}
        value={activeEpiId ?? ""}
        onChange={(event) => go({ epi: event.target.value })}
        className={cn(selectClassName, "max-w-72")}
      >
        <option value="">{t.stock.allEpisOption}</option>
        {epis.map((epi) => (
          <option key={epi.id} value={epi.id}>
            {epi.name} — CA {epi.caNumber}
          </option>
        ))}
      </select>
    </div>
  );
}
