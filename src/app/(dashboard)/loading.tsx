/**
 * Instant navigation feedback for every route under (dashboard). Next.js shows THIS the
 * moment a click fires -- before the target page's Server Components have even started
 * their Supabase round trips -- and streams the real content in over it once ready.
 *
 * Without it (the state until now), clicking a sidebar link left the OLD page frozen on
 * screen for however long the new page's fetches took (verifySession + getMyCompanies in
 * the layout, then whatever the page itself awaits -- several sequential round trips on
 * a page like /deliveries), with no visual sign anything was happening. That dead pause
 * is what read as "demora um pouco pra trocar": the fix here does not make the fetches
 * faster, it makes the wait visible instead of silent, which is most of what "feels slow"
 * actually is.
 *
 * Shaped to loosely echo PageHeader (kicker + title bar) and Panel (rounded-3xl blocks)
 * so the skeleton doesn't flash as a visibly different layout before the real one lands.
 * One shared skeleton for the whole route group rather than one per page: every dashboard
 * page opens with this same kicker+title+panel shape, so a single generic version covers
 * all of them without a maintenance burden per route.
 */
export default function DashboardLoading() {
  return (
    <main className="flex flex-1 flex-col gap-5 p-4 md:p-7.5" aria-busy="true" aria-live="polite">
      <span className="sr-only">A carregar…</span>

      <div className="flex flex-col gap-3">
        <div className="h-3 w-32 animate-pulse rounded-full bg-foreground/8" />
        <div className="h-9 w-64 animate-pulse rounded-full bg-foreground/10" />
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
        <div className="h-28 animate-pulse rounded-3xl bg-foreground/6 xl:col-span-1 xl:row-span-2" />
        <div className="h-24 animate-pulse rounded-3xl bg-foreground/6" />
        <div className="h-24 animate-pulse rounded-3xl bg-foreground/6" />
        <div className="h-24 animate-pulse rounded-3xl bg-foreground/6" />
        <div className="h-24 animate-pulse rounded-3xl bg-foreground/6" />
      </div>

      <div className="h-72 animate-pulse rounded-3xl bg-foreground/6" />
    </main>
  );
}
