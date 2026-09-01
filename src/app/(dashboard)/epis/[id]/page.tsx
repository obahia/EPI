import { notFound, redirect } from "next/navigation";
import { verifySession, getEpi } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EpiEditForm } from "./epi-edit-form";

export default async function EpiPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ company?: string }>;
}) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const { id } = await params;
  const epi = await getEpi(id);
  if (!epi) {
    notFound();
  }

  const { company: companyParam } = await searchParams;
  const returnCompanyId = companyParam ?? epi.companyId ?? "";

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{epi.name}</h1>
        <p className="font-mono text-sm text-muted-foreground">CA {epi.caNumber}</p>
      </div>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Editar EPI</CardTitle>
        </CardHeader>
        <CardContent>
          <EpiEditForm epi={epi} returnCompanyId={returnCompanyId} />
        </CardContent>
      </Card>
    </main>
  );
}
