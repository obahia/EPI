import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SealMark } from "@/components/seal-mark";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

export default async function NotFound() {
  const t = getDictionary(await getLocale());

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-16 text-center">
      <SealMark broken className="size-16" />
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">{t.notFound.eyebrow}</p>
        <h1 className="font-heading text-3xl font-medium tracking-tight text-balance">{t.notFound.title}</h1>
        <p className="max-w-md text-muted-foreground">{t.notFound.description}</p>
      </div>
      <Button asChild>
        <Link href="/dashboard">{t.notFound.cta}</Link>
      </Button>
    </main>
  );
}
