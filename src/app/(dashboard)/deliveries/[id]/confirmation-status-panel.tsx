import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConfirmationRequest } from "@/lib/supabase/dal";
import { ASSURANCE_LEVEL_LABEL, CONFIRMATION_STATUS_LABEL } from "./labels";

function fmt(value: string): string {
  return new Date(value).toLocaleString("pt-BR");
}

/**
 * Most recent confirmation_request for a delivery, plus a collapsed list of any earlier ones
 * (a resend creates a new row rather than mutating the old one -- see dal.ts's comment on
 * getConfirmationRequests). Pure display of already-fetched data, no Server Action involved.
 */
export function ConfirmationStatusPanel({ requests }: { requests: ConfirmationRequest[] }) {
  const current = requests[0];
  if (!current) {
    return null;
  }
  const previous = requests.slice(1);

  const rows: { label: string; value: string }[] = [
    { label: "Nível exigido", value: ASSURANCE_LEVEL_LABEL[current.requiredAssuranceLevel] },
    {
      label: "Nível obtido",
      value: current.achievedAssuranceLevel ? ASSURANCE_LEVEL_LABEL[current.achievedAssuranceLevel] : "—",
    },
  ];

  if (current.status === "IDENTITY_FAILED") {
    rows.push({ label: "Tentativas", value: `${current.identityAttempts} / ${current.identityMaxAttempts}` });
  }
  if (current.viewedAt) {
    rows.push({ label: "Visualizado em", value: fmt(current.viewedAt) });
  }
  if (current.confirmedAt) {
    rows.push({ label: "Confirmado em", value: fmt(current.confirmedAt) });
  }
  if (current.contestedAt) {
    rows.push({ label: "Contestado em", value: fmt(current.contestedAt) });
  }
  rows.push({ label: "Expira em", value: fmt(current.expiresAt) });

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Confirmação</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Status</span>
          <Badge variant="outline">{CONFIRMATION_STATUS_LABEL[current.status]}</Badge>
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
              + {previous.length} link{previous.length > 1 ? "s" : ""} anterior{previous.length > 1 ? "es" : ""}
            </summary>
            <ul className="mt-2 flex flex-col gap-1 pl-3">
              {previous.map((request) => (
                <li key={request.id}>
                  {fmt(request.createdAt)} — {CONFIRMATION_STATUS_LABEL[request.status]}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
