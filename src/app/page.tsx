import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SealMark } from "@/components/seal-mark";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-16 text-center">
      <SealMark className="size-14" />
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-medium tracking-tight">Selo</h1>
        <p className="max-w-md text-muted-foreground">Prova de entrega de EPI, selada.</p>
      </div>
      <Button asChild>
        <Link href="/login">Entrar</Link>
      </Button>
    </main>
  );
}
