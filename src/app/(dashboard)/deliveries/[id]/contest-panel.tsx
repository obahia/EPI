import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DeliveryContest } from "@/lib/supabase/dal";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { contestReasonLabel } from "./labels";
import { ResolveContestForm } from "./resolve-contest-form";

function fmt(value: string): string {
  return new Date(value).toLocaleString("pt-BR");
}

/** Only rendered when the delivery has at least one contest. Unresolved contests get an
 * inline answer form (resolveContest); resolved ones just show what was already written. */
export async function ContestPanel({ deliveryId, contests }: { deliveryId: string; contests: DeliveryContest[] }) {
  if (contests.length === 0) {
    return null;
  }

  const t = getDictionary(await getLocale());
  const reasonLabel = contestReasonLabel(t);

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t.deliveries.contestTitle}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {contests.map((contest) => (
          <div key={contest.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{reasonLabel[contest.reasonCode]}</span>
              <span className="text-xs text-muted-foreground">{fmt(contest.createdAt)}</span>
            </div>
            {contest.comment ? <p className="text-muted-foreground">{contest.comment}</p> : null}

            {contest.resolvedAt ? (
              <div className="mt-1 rounded-md bg-muted/50 p-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t.deliveries.responseRecordedAtPrefix} {fmt(contest.resolvedAt)}
                </p>
                <p className="text-sm">{contest.resolutionNote}</p>
              </div>
            ) : (
              <ResolveContestForm deliveryId={deliveryId} contestId={contest.id} />
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
