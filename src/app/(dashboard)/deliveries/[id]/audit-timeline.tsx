import { Panel, PanelTitle } from "@/components/panel";
import type { AuditEvent } from "@/lib/supabase/dal";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { actorKindLabel, auditEventLabel } from "./labels";

function fmt(value: string): string {
  return new Date(value).toLocaleString("pt-BR");
}

/** Simple vertical timeline answering "o que aconteceu com esta entrega" -- not exhaustive
 * UI, just a glance-friendly feed of the delivery's own events plus every confirmation_request
 * it has had (getDeliveryAuditEvents already merges those server-side).
 *
 * Drawn as the mockup draws it: no rail, just a dot per event, terracotta on the newest one
 * so the eye lands on what happened last. */
export async function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return null;
  }

  const t = getDictionary(await getLocale());
  const actorLabel = actorKindLabel(t);

  return (
    <Panel>
      <PanelTitle>{t.deliveries.historyTitle}</PanelTitle>
      <ol className="mt-4.5 flex flex-col gap-4">
        {events.map((event, index) => (
          <li key={event.id} className="flex items-start gap-3.5">
            <span
              className={`mt-1.5 size-2.5 shrink-0 rounded-full ${index === 0 ? "bg-primary" : "bg-muted-foreground/35"}`}
            />
            <div className="min-w-0">
              <p className="text-[14px] font-bold">{auditEventLabel(t, event.eventType)}</p>
              <p className="text-[12.5px] text-muted-foreground">
                {fmt(event.createdAt)} · {actorLabel[event.actorKind]}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
