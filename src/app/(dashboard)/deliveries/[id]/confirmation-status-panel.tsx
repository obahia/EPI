import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConfirmationRequest } from "@/lib/supabase/dal";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { assuranceLevelLabel, confirmationStatusLabel } from "./labels";

function fmt(value: string): string {
  return new Date(value).toLocaleString("pt-BR");
}

/**
 * Most recent confirmation_request for a delivery, plus a collapsed list of any earlier ones
 * (a resend creates a new row rather than mutating the old one -- see dal.ts's comment on
 * getConfirmationRequests). Pure display of already-fetched data, no Server Action involved.
 */
export async function ConfirmationStatusPanel({ requests }: { requests: ConfirmationRequest[] }) {
  const current = requests[0];
  if (!current) {
    return null;
  }
  const previous = requests.slice(1);

  const t = getDictionary(await getLocale());
  const statusLabel = confirmationStatusLabel(t);
  const levelLabel = assuranceLevelLabel(t);

  const rows: { label: string; value: string }[] = [
    { label: t.deliveries.requiredLevelLabel, value: levelLabel[current.requiredAssuranceLevel] },
    {
      label: t.deliveries.achievedLevelLabel,
      value: current.achievedAssuranceLevel ? levelLabel[current.achievedAssuranceLevel] : "—",
    },
  ];

  if (current.status === "IDENTITY_FAILED") {
    rows.push({ label: t.deliveries.attemptsLabel, value: `${current.identityAttempts} / ${current.identityMaxAttempts}` });
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
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t.deliveries.confirmationTitle}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t.common.status}</span>
          <Badge variant="outline">{statusLabel[current.status]}</Badge>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>

        {previous.length > 0 ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">
              + {previous.length} {previous.length > 1 ? t.deliveries.previousLinksPlural : t.deliveries.previousLinkSingular}
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
      </CardContent>
    </Card>
  );
}
