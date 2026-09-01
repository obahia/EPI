import Link from "next/link";
import { redirect } from "next/navigation";
import { verifySession, getCurrentUser, getMyMemberships } from "@/lib/supabase/dal";
import { signOut } from "@/app/(auth)/login/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OnboardingForm } from "./onboarding-form";

export default async function DashboardPage() {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const [user, memberships] = await Promise.all([getCurrentUser(), getMyMemberships()]);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Painel</h1>
        <form action={signOut}>
          <Button type="submit" variant="outline">
            Sair
          </Button>
        </form>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sessão</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {user ? (
            <p>
              Autenticado como <span className="font-medium text-foreground">{user.fullName}</span> ({user.email})
            </p>
          ) : (
            <p>Sessão válida, mas o perfil ainda não carregou.</p>
          )}
        </CardContent>
      </Card>

      {memberships.length === 0 ? (
        <OnboardingForm />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Suas organizações</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2 text-sm">
                {memberships.map((m) => (
                  <li key={m.id} className="flex items-center justify-between rounded-md border p-3">
                    <span className="font-mono text-xs text-muted-foreground">{m.organizationId}</span>
                    <span className="font-medium">{m.role}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/companies">Empresas</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/employees">Funcionários</Link>
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
