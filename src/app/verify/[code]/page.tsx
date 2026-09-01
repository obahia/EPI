import { createWorkerClient } from "@/lib/supabase/worker-client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type VerifyResultRow = {
  verification_code: string;
  status: string;
  company_name: string;
  sealed_at: string;
  hash_prefix: string;
};

/**
 * Public, unauthenticated verification page -- anyone with a code (from a printed receipt
 * or its QR) can confirm a delivery was really sealed, without any login. Minimal
 * disclosure by design (docs/architecture.md §8): worker.verify_document never returns the
 * employee's name, CPF, items, or CA -- only enough to say "yes, this is real."
 */
export default async function VerifyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const supabase = createWorkerClient();

  const { data, error } = await supabase
    .schema("worker")
    .rpc("verify_document", { p_code: code })
    .single();

  const result = !error && data ? (data as VerifyResultRow) : null;

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col items-center justify-center gap-4 px-4 py-6 text-center">
      <h1 className="text-lg font-semibold">Verificação de comprovante</h1>

      {result ? (
        <Card className="w-full text-left">
          <CardHeader>
            <CardTitle className="font-mono text-base">{result.verification_code}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Badge variant="outline" className="w-fit border-green-600/40 text-green-700 dark:text-green-400">
              {result.status}
            </Badge>
            <dl className="flex flex-col gap-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Empresa</dt>
                <dd>{result.company_name}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Selado em</dt>
                <dd>{new Date(result.sealed_at).toLocaleString("pt-BR")}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Início do hash</dt>
                <dd className="font-mono text-xs">{result.hash_prefix}…</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      ) : (
        <p className="max-w-sm text-sm text-muted-foreground">
          Código não encontrado. Verifique se digitou corretamente.
        </p>
      )}
    </main>
  );
}
