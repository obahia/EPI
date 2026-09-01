"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Building2, Users, ShieldCheck, Truck, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { SealMark } from "@/components/seal-mark";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useT } from "@/i18n/provider";
import { signOut } from "@/app/(auth)/login/actions";

const LINKS = [
  { href: "/dashboard", icon: LayoutDashboard, key: "dashboard" as const },
  { href: "/companies", icon: Building2, key: "companies" as const },
  { href: "/employees", icon: Users, key: "employees" as const },
  { href: "/epis", icon: ShieldCheck, key: "epis" as const },
  { href: "/deliveries", icon: Truck, key: "deliveries" as const },
];

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const pathname = usePathname();

  return (
    <>
      <div className="flex items-center gap-2 px-5 py-5">
        <SealMark className="size-6" />
        <span className="font-heading text-lg font-medium tracking-tight">{t.brand.name}</span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-3">
        {LINKS.map(({ href, icon: Icon, key }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {t.nav[key]}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-3 border-t border-sidebar-border px-3 py-4">
        <LanguageSwitcher className="self-start" />
        <form action={signOut}>
          <Button type="submit" variant="outline" size="sm" className="w-full justify-start">
            {t.common.signOut}
          </Button>
        </form>
      </div>
    </>
  );
}

export function DashboardSidebar() {
  const t = useT();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <SidebarNav />
      </aside>

      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3 md:hidden">
        <div className="flex items-center gap-2">
          <SealMark className="size-6" />
          <span className="font-heading text-lg font-medium tracking-tight">{t.brand.name}</span>
        </div>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" aria-label={t.common.openMenu}>
              <Menu className="size-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-0">
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
      </header>
    </>
  );
}
