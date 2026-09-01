import Link from "next/link";
import { redirect } from "next/navigation";
import { verifySession, getMyCompanies } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Company list. Most users (a DIRECT org's ORG_ADMIN) have exactly one company, so this
 * redirects straight to it -- the list view only matters for a PARTNER org-wide member
 * with several companies, which FASE 1 doesn't build a dedicated flow for yet (see the
 * task's ownership boundary notes: no speculative PARTNER UI).
 */
export default async function CompaniesPage() {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const companies = await getMyCompanies();

  if (companies.length === 1) {
    redirect(`/companies/${companies[0]!.id}`);
  }

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Empresas</h1>

      <Card>
        <CardHeader>
          <CardTitle>Suas empresas</CardTitle>
        </CardHeader>
        <CardContent>
          {companies.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma empresa ainda.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {companies.map((c) => (
                <li key={c.id} className="flex items-center justify-between rounded-md border p-3">
                  <Link href={`/companies/${c.id}`} className="font-medium underline-offset-4 hover:underline">
                    {c.legalName}
                  </Link>
                  <span className="text-xs text-muted-foreground">{c.status}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
