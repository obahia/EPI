import { notFound, redirect } from "next/navigation";
import { verifySession, getEmployee } from "@/lib/supabase/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { EmployeeEditForm } from "./employee-edit-form";

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const t = getDictionary(await getLocale());
  const { id } = await params;
  const employee = await getEmployee(id);
  if (!employee) {
    notFound();
  }

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="font-heading text-2xl font-medium tracking-tight">{employee.fullName}</h1>
        <p className="font-mono text-sm text-muted-foreground">{employee.cpfMasked}</p>
      </div>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>{t.employees.editEmployee}</CardTitle>
        </CardHeader>
        <CardContent>
          <EmployeeEditForm employee={employee} />
        </CardContent>
      </Card>
    </main>
  );
}
