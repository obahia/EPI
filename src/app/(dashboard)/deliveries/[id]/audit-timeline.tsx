import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AuditEvent } from "@/lib/supabase/dal";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { actorKindLabel, auditEventLabel } from "./labels";

function fmt(value: string): string {
  return new Date(value).toLocaleString("pt-BR");
}

/** Simple vertical timeline answering "o que aconteceu com esta entrega" -- not exhaustive
 * UI, just a glance-friendly feed of the delivery's own events plus every confirmation_request
 * it has had (getDeliveryAuditEvents already merges those server-side). */
export async function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return null;
  }

  const t = getDictionary(await getLocale());
  const actorLabel = actorKindLabel(t);

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t.deliveries.historyTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-3 border-l border-border pl-4">
          {events.map((event) => (
            <li key={event.id} className="relative text-sm">
              <span className="absolute top-1.5 -left-[19px] size-2 rounded-full bg-muted-foreground/50" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{auditEventLabel(t, event.eventType)}</span>
                <span className="text-xs text-muted-foreground">{actorLabel[event.actorKind]}</span>
              </div>
              <p className="text-xs text-muted-foreground">{fmt(event.createdAt)}</p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
