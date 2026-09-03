import { Panel, PanelKicker } from "@/components/panel";
import type { ConfirmationRequest } from "@/lib/supabase/dal";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { assuranceLevelLabel, confirmationStatusLabel } from "./labels";
import { formatDateTimeBr } from "@/lib/format/datetime";

/**
 * Most recent confirmation_request for a delivery, plus a collapsed list of any earlier ones
 * (a resend creates a new row rather than mutating the old one -- see dal.ts's comment on
 * getConfirmationRequests). Pure display of already-fetched data, no Server Action involved.
 *
 * Implemented from the mockup's "nível de identificação exigido" panel: the level the
 * worker has to clear leads in plain words, the attempts left under it, and the timestamps
 * follow as a quiet label/value list.
 */
export async function ConfirmationStatusPanel({
  requests,
  timeZone,
}: {
  requests: ConfirmationRequest[];
  /** The company's own IANA zone (Company.timeZone) -- falls back to Brasília time in
   * formatDateTimeBr when null/undefined. */
  timeZone?: string | null;
}) {
  const current = requests[0];
  if (!current) {
    return null;
  }
  const previous = requests.slice(1);
  const fmt = (value: string) => formatDateTimeBr(value, timeZone);

  const t = getDictionary(await getLocale());
  const statusLabel = confirmationStatusLabel(t);
  const levelLabel = assuranceLevelLabel(t);

  const rows: { label: string; value: string }[] = [{ label: t.common.status, value: statusLabel[current.status] }];

  if (current.achievedAssuranceLevel) {
    rows.push({ label: t.deliveries.achievedLevelLabel, value: levelLabel[current.achievedAssuranceLevel] });
  }
  if (current.viewedAt) {
    rows.push({ label: t.deliveries.viewedAtLabel, value: fmt(current.viewedAt) });
  }
  if (current.confirmedAt) {
    rows.push({ label: t.deliveries.confirmedAtLabel, value: fmt(current.confirmedAt) });
  }
  if (current.contestedAt) {
    rows.push({ label: t.deliveries.contestedAtLabel, value: fmt(current.contestedAt) });
  }
  rows.push({ label: t.deliveries.expiresAtPrefix, value: fmt(current.expiresAt) });

  return (
    <Panel className="flex flex-col gap-4">
      <div>
        <PanelKicker className="text-muted-foreground">{t.deliveries.requiredLevelLabel}</PanelKicker>
        <p className="mt-2 font-heading text-lg font-extrabold tracking-tight">
          {levelLabel[current.requiredAssuranceLevel]}
        </p>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          {current.identityMaxAttempts} {t.deliveries.attemptsPerLink} · {current.identityAttempts}{" "}
          {t.deliveries.attemptsUsed}
        </p>
      </div>

      <dl className="flex flex-col gap-1.5 border-t border-border/45 pt-4 text-[12.5px]">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-right font-bold">{row.value}</dd>
          </div>
        ))}
      </dl>

      {previous.length > 0 ? (
        <details className="text-[12px] text-muted-foreground">
          <summary className="cursor-pointer font-bold select-none">
            + {previous.length}{" "}
            {previous.length > 1 ? t.deliveries.previousLinksPlural : t.deliveries.previousLinkSingular}
          </summary>
          <ul className="mt-2 flex flex-col gap-1 pl-3">
            {previous.map((request) => (
              <li key={request.id}>
                {fmt(request.createdAt)} — {statusLabel[request.status]}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}
