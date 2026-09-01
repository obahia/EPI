import Link from "next/link";
import { redirect } from "next/navigation";
import { verifySession, getCurrentUser, getMyMemberships } from "@/lib/supabase/dal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { OnboardingForm } from "./onboarding-form";

export default async function DashboardPage() {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const [user, memberships] = await Promise.all([getCurrentUser(), getMyMemberships()]);

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <h1 className="font-heading text-2xl font-medium tracking-tight">{t.dashboard.title}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t.dashboard.session}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {user ? (
            <p>
              {t.dashboard.authenticatedAs}{" "}
              <span className="font-medium text-foreground">{user.fullName}</span> ({user.email})
            </p>
          ) : (
            <p>{t.dashboard.sessionNoProfile}</p>
          )}
        </CardContent>
      </Card>

      {memberships.length === 0 ? (
        <OnboardingForm />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t.dashboard.yourOrganizations}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2 text-sm">
                {memberships.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between rounded-md border border-border p-3"
                  >
                    <span className="font-mono text-xs text-muted-foreground">{m.organizationId}</span>
                    <span className="font-medium">{m.role}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/companies">{t.nav.companies}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/employees">{t.nav.employees}</Link>
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
