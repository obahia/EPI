import Link from "next/link";
import { Check, AlertCircle, Link2, FileText, Layers, Users } from "lucide-react";
import { Panel, PanelTitle } from "@/components/panel";
import type { AuditEvent } from "@/lib/supabase/dal";
import { auditEventLabel } from "@/app/(dashboard)/deliveries/[id]/labels";
import type { Dict } from "@/i18n/dictionaries";
import { formatDateTimeBr } from "@/lib/format/datetime";

/**
 * The company-wide activity feed, implemented from the mockup: one round icon per
 * event tinted by what the event means -- confirmed, disputed, batched, or merely
 * logged -- and a soft tag on the right naming what kind of thing happened, so the
 * column scans in a glance. AuditTimeline stays the exhaustive per-delivery view;
 * this is the dashboard's summary of it.
 */
export function RecentActivity({
  events,
  historyHref,
  timeZone,
  t,
  className,
}: {
  events: AuditEvent[];
  historyHref: string;
  /** The company's own IANA zone (Company.timeZone) -- falls back to Brasília time in
   * formatDateTimeBr when null/undefined. */
  timeZone?: string | null;
  t: Dict;
  className?: string;
}) {
  return (
    <Panel className={className}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>{t.companies.recentActivity}</PanelTitle>
        <Link
          href={historyHref}
          className="text-[13px] font-bold text-primary-deep underline-offset-4 hover:underline"
        >
          {t.companies.fullHistory}
        </Link>
      </div>

      <ul className="mt-4.5 flex flex-col gap-3.5">
        {events.map((event) => {
          const { Icon, iconClass, tag, tagClass } = presentation(event.eventType, t);
          return (
            <li key={event.id} className="flex items-center gap-3.5">
              <span className={`flex size-8.5 shrink-0 items-center justify-center rounded-full ${iconClass}`}>
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-bold">{auditEventLabel(t, event.eventType)}</p>
                <p className="text-[12.5px] text-muted-foreground">
                  {formatDateTimeBr(event.createdAt, timeZone)}
                </p>
              </div>
              <span
                className={`hidden shrink-0 rounded-full px-3 py-1 text-[11.5px] font-bold sm:inline ${tagClass}`}
              >
                {tag}
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function presentation(
  eventType: string,
  t: Dict,
): { Icon: typeof Check; iconClass: string; tag: string; tagClass: string } {
  if (eventType === "DELIVERY_CONFIRMED" || eventType === "EVIDENCE_SEALED") {
    return {
      Icon: Check,
      iconClass: "bg-success-soft text-success",
      tag: t.companies.tagSealed,
      tagClass: "bg-success-soft text-success",
    };
  }
  if (eventType === "DELIVERY_CONTESTED" || eventType === "IDENTITY_FAILED") {
    return {
      Icon: AlertCircle,
      iconClass: "bg-destructive-soft text-destructive",
      tag: t.companies.tagToResolve,
      tagClass: "bg-destructive-soft text-destructive",
    };
  }
  if (eventType === "BATCH_CREATED") {
    return {
      Icon: Layers,
      iconClass: "bg-warning-soft text-warning",
      tag: t.companies.tagBatch,
      tagClass: "bg-warning-soft text-warning",
    };
  }
  if (eventType.startsWith("EMPLOYEE")) {
    return {
      Icon: Users,
      iconClass: "bg-secondary text-muted-foreground",
      tag: t.companies.tagTeam,
      tagClass: "bg-secondary text-muted-foreground",
    };
  }
  if (eventType.startsWith("CONFIRMATION") || eventType === "LINK_VIEWED") {
    return {
      Icon: Link2,
      iconClass: "bg-secondary text-muted-foreground",
      tag: t.companies.tagLink,
      tagClass: "bg-secondary text-muted-foreground",
    };
  }
  return {
    Icon: FileText,
    iconClass: "bg-secondary text-muted-foreground",
    tag: t.companies.tagRecord,
    tagClass: "bg-secondary text-muted-foreground",
  };
}
