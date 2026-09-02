"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  ChevronDown,
  LayoutDashboard,
  Layers,
  Menu,
  ShieldCheck,
  Truck,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { SealMark } from "@/components/seal-mark";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useLocale, useT } from "@/i18n/provider";
import { signOut } from "@/app/(auth)/login/actions";

/**
 * The single piece of app chrome, implemented from the mockup (screens 4b-4h): a
 * 260px cream column carrying, top to bottom, the wordmark, the company you are
 * looking at (with the switcher hanging off it), the six navigation targets as
 * full-width labelled rows, and your own identity pinned to the bottom.
 *
 * It replaces the earlier ink icon rail *and* the global header band that sat
 * above the content: the mockup has no top bar, so the company switcher and the
 * identity block live here and search moved into the pages that own a list.
 * Below `md` the column collapses into a Sheet behind a menu button.
 */

/** Order and labels are the mockup's: Painel, Entregas, Lotes, EPIs, Funcionários,
 * Empresas -- work first, registries after. Icons are Lucide at stroke 2.75, which is
 * what the mockup's own closing note specifies. */
const LINKS = [
  { href: "/dashboard", key: "dashboard" as const, icon: LayoutDashboard },
  { href: "/deliveries", key: "deliveries" as const, icon: Truck },
  { href: "/deliveries/batches", key: "batches" as const, icon: Layers },
  { href: "/epis", key: "epis" as const, icon: ShieldCheck },
  { href: "/employees", key: "employees" as const, icon: Users },
  { href: "/companies", key: "companies" as const, icon: Building2 },
];

/** The mockup's rail sets its labels in regular weight and only the active row goes bold.
 * Figtree is a geometric sans -- carrying it at extrabold across all six rows is what made
 * the column read as a fast-food logotype rather than as navigation. */
const NAV_ICON_STROKE = 2.75;

export type SidebarIdentity = {
  fullName: string;
  role: string;
  companyName: string | null;
  hasMultipleCompanies: boolean;
};

export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * Which single nav target the current path belongs to -- computed once for the whole
 * rail rather than asked per link, so two rows can never light up at the same time.
 *
 * Two paths need saying out loud. `/companies/[id]/dashboard` is what "Painel" points at
 * (that redirect lives in /dashboard), so it belongs to Painel and must NOT also claim
 * "Empresas" just because it sits under /companies. And "Entregas" and "Lotes" share the
 * /deliveries prefix, so the longest matching href wins.
 */
export function activeNavHref(pathname: string): string | null {
  if (/^\/companies\/[^/]+\/dashboard(\/|$)/.test(pathname)) return "/dashboard";

  let best: string | null = null;
  for (const { href } of LINKS) {
    if (pathname === href || pathname.startsWith(`${href}/`)) {
      if (best === null || href.length > best.length) best = href;
    }
  }
  return best;
}

function SidebarBody({ identity, onNavigate }: { identity: SidebarIdentity | null; onNavigate?: () => void }) {
  const t = useT();
  const locale = useLocale();
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-sidebar px-4.5 pt-5.5 pb-4.5 text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-1.5">
        <SealMark className="size-8" />
        <span className="font-heading text-xl font-extrabold tracking-tight">{t.brand.name}</span>
      </div>

      {identity?.companyName ? (
        <div className="mt-7">
          <p className="px-1.5 text-[10px] font-bold tracking-[0.12em] text-muted-foreground uppercase">
            {t.dashboard.companyKicker}
          </p>
          <CompanyCard
            name={identity.companyName}
            switchable={identity.hasMultipleCompanies}
            onNavigate={onNavigate}
          />
        </div>
      ) : null}

      <nav className="mt-6 flex flex-1 flex-col gap-0.5">
        {LINKS.map(({ href, key, icon: Icon }) => {
          const active = activeNavHref(pathname) === href;
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-full px-4.5 py-2.5 text-[14.5px] transition-colors",
                active
                  ? "bg-sidebar-accent font-bold text-sidebar-accent-foreground"
                  : "font-normal text-muted-foreground hover:bg-sidebar-foreground/6 hover:text-sidebar-foreground",
              )}
            >
              <Icon className="size-4.5 shrink-0" strokeWidth={NAV_ICON_STROKE} aria-hidden="true" />
              {t.nav[key]}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-3.5">
        <LanguageSwitcher className="self-start" />
        {identity ? (
          <div className="flex items-center gap-2.5 border-t border-sidebar-border pt-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-[13px] font-extrabold text-sidebar-primary-foreground">
              {initials(identity.fullName)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-bold">{identity.fullName}</p>
              <p className="text-[10.5px] font-bold tracking-[0.06em] text-muted-foreground uppercase">
                {identity.role} · {locale.toUpperCase()}
              </p>
            </div>
            <form action={signOut}>
              <button type="submit" className="cursor-pointer text-[13px] font-bold hover:underline">
                {t.common.signOut}
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The company you are looking at. The mockup hangs "trocar empresa" straight off the
 * name, so the switcher is the card rather than a control beside it -- and it is a plain
 * link to /companies when there is more than one company to switch to. */
function CompanyCard({
  name,
  switchable,
  onNavigate,
}: {
  name: string;
  switchable: boolean;
  onNavigate?: () => void;
}) {
  const t = useT();

  const inner = (
    <>
      <p className="truncate text-[14px] font-extrabold tracking-tight">{name}</p>
      <p className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
        {switchable ? t.dashboard.switchCompany : t.dashboard.companyKicker.toLowerCase()}
        {switchable ? <ChevronDown className="size-3 shrink-0" /> : null}
      </p>
    </>
  );

  const className = "mt-1.5 block w-full rounded-2xl bg-background px-4 py-3 text-left";

  return switchable ? (
    <Link href="/companies" onClick={onNavigate} className={cn(className, "transition-colors hover:bg-background/70")}>
      {inner}
    </Link>
  ) : (
    <div className={className}>{inner}</div>
  );
}

export function AppSidebar({ identity }: { identity: SidebarIdentity | null }) {
  const t = useT();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <aside className="hidden w-65 shrink-0 md:block">
        <SidebarBody identity={identity} />
      </aside>

      <header className="flex items-center justify-between border-b border-border bg-sidebar px-4 py-3 md:hidden">
        <div className="flex items-center gap-2">
          <SealMark className="size-7" />
          <span className="font-heading text-lg font-extrabold tracking-tight">{t.brand.name}</span>
        </div>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" aria-label={t.common.openMenu}>
              <Menu className="size-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="border-sidebar-border bg-sidebar p-0">
            <SidebarBody identity={identity} onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
      </header>
    </>
  );
}
