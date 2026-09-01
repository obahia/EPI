import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-16 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">
        Plataforma de Entrega Digital de EPI
      </h1>
      <p className="max-w-md text-muted-foreground">
        Fundação do projeto (FASE 0) — sem funcionalidades de produto ainda.
      </p>
      <Button asChild>
        <Link href="/login">Entrar</Link>
      </Button>
    </main>
  );
}
