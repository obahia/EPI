import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { verifySession, getCompany } from "@/lib/supabase/dal";
import { formatCnpj } from "@/lib/br/cnpj";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CompanyEditForm } from "./company-edit-form";

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const { id } = await params;
  const company = await getCompany(id);
  if (!company) {
    notFound();
  }

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{company.legalName}</h1>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/employees?company=${company.id}`}>Ver funcionários</Link>
          </Button>
          <Button asChild>
            <Link href={`/companies/${company.id}/dashboard`}>Painel operacional</Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dados da empresa</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between rounded-md border p-3">
            <span className="text-muted-foreground">CNPJ</span>
            <span className="font-mono">{formatCnpj(company.cnpj)}</span>
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <span className="text-muted-foreground">Status</span>
            <span className="font-medium">{company.status}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Editar</CardTitle>
        </CardHeader>
        <CardContent>
          <CompanyEditForm companyId={company.id} legalName={company.legalName} tradeName={company.tradeName} />
        </CardContent>
      </Card>
    </main>
  );
}
