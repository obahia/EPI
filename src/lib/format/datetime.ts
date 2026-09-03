/**
 * Date/time formatting for display. Every timestamp in this product is rendered in a
 * Brazilian time zone, never in the viewer's or the server's.
 *
 * The bug this replaces: `toLocaleString("pt-BR")` sets the *locale* (dd/mm/yyyy) but not
 * the *time zone*, which defaults to the runtime's. So the same delivery read
 * "14:35" on a Server Component (Vercel runs UTC) and "15:35" in a Client Component
 * opened from Lisbon -- and neither was the time it actually happened in Brazil. On a
 * document a fiscal may read, an hour is not a cosmetic difference.
 *
 * Audit finding DAT-01: a single hardcoded zone was also wrong for the minority of the
 * market outside Brasília time (Acre, for one, is UTC-5). Companies now carry a real zone
 * (`app.organizations.timezone`, joined into api.companies -- see Company.timeZone in
 * dal.ts), so formatDateTimeBr/formatShortDateTimeBr take it as an optional second
 * argument. `null`/`undefined` -- an unauthenticated surface with no company in scope
 * (the worker flow, /verify/*), or a company whose join somehow came back empty -- falls
 * back to BRAZIL_TIME_ZONE, which is still what most callers should pass explicitly today
 * rather than relying on the fallback, now that a real value is available.
 */

export const BRAZIL_TIME_ZONE = "America/Sao_Paulo";
export const BRAZIL_TIME_ZONE_LABEL = "horário de Brasília";

/** A human label for an IANA zone, e.g. "horário padrão do Acre" -- what a printed
 * document should say it used when that is not simply Brasília time. Falls back to
 * BRAZIL_TIME_ZONE_LABEL for the default zone and for anything Intl cannot name. */
export function timeZoneLabel(timeZone: string | null | undefined): string {
  const zone = timeZone || BRAZIL_TIME_ZONE;
  if (zone === BRAZIL_TIME_ZONE) return BRAZIL_TIME_ZONE_LABEL;
  try {
    const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: zone, timeZoneName: "long" }).formatToParts(
      new Date(),
    );
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    return name ? name.toLowerCase() : BRAZIL_TIME_ZONE_LABEL;
  } catch {
    return BRAZIL_TIME_ZONE_LABEL;
  }
}

/**
 * A `timestamptz` as "28/08/2026, 07:02:11" in `timeZone` (default BRAZIL_TIME_ZONE).
 *
 * Use for anything that happened at an instant: issued_at, confirmed_at, sealed_at,
 * created_at, expires_at, audit events.
 */
export function formatDateTimeBr(value: string | Date, timeZone?: string | null): string {
  return new Date(value).toLocaleString("pt-BR", { timeZone: timeZone || BRAZIL_TIME_ZONE });
}

/** Same as formatDateTimeBr but without seconds -- for dense table cells. */
export function formatShortDateTimeBr(value: string | Date, timeZone?: string | null): string {
  return new Date(value).toLocaleString("pt-BR", {
    timeZone: timeZone || BRAZIL_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A `date` column ("2026-08-28") as "28/08/2026".
 *
 * Deliberately string surgery, with no Date object anywhere near it. A calendar date has
 * no time zone: the delivery happened on the 28th, full stop. The old
 * `new Date(\`${d}T00:00:00\`)` pattern parsed it at *local* midnight, so formatting that
 * instant in São Paulo from a machine east of Brazil moves it back across midnight and
 * prints the 27th. Nothing to convert means nothing to get wrong.
 */
export function formatDayBr(dateOnly: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly);
  if (!match) return dateOnly;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/** A `date` column as "28/08" -- the compact form the deliveries list uses for batches. */
export function formatDayMonthBr(dateOnly: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(dateOnly);
  if (!match) return dateOnly;
  const [, month, day] = match;
  return `${day}/${month}`;
}
