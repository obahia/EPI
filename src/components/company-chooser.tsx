import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * PARTNER-org pill switcher shown above a list page when the manager has more than
 * one company -- shared by employees/epis/deliveries/deliveries-batches list pages,
 * which all had the exact same markup hand-duplicated before this.
 */
export function CompanyChooser({
  companies,
  activeCompanyId,
  basePath,
  title,
}: {
  companies: { id: string; legalName: string }[];
  activeCompanyId: string | undefined;
  basePath: string;
  title: string;
}) {
  if (companies.length <= 1) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-wrap gap-2 text-sm">
          {companies.map((c) => (
            <li key={c.id}>
              <Link
                href={`${basePath}?company=${c.id}`}
                className={cn(
                  "rounded-md border border-border px-3 py-1.5",
                  activeCompanyId === c.id && "border-primary bg-primary/5 font-medium",
                )}
              >
                {c.legalName}
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
