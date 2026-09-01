import Link from "next/link";

/**
 * Thin nav shared by every authenticated route. Deliberately not doing the auth check
 * here -- each page under (dashboard) already calls verifySession()/redirect("/login")
 * itself (see docs/architecture.md §4: authorization lives close to the data, never in a
 * layout or middleware). This is presentation only.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <nav className="flex items-center gap-4 border-b px-8 py-3 text-sm">
        <Link href="/dashboard" className="font-medium">
          EPI
        </Link>
        <Link href="/companies" className="text-muted-foreground hover:text-foreground">
          Empresas
        </Link>
        <Link href="/employees" className="text-muted-foreground hover:text-foreground">
          Funcionários
        </Link>
        <Link href="/epis" className="text-muted-foreground hover:text-foreground">
          EPIs
        </Link>
        <Link href="/deliveries" className="text-muted-foreground hover:text-foreground">
          Entregas
        </Link>
      </nav>
      {children}
    </div>
  );
}
