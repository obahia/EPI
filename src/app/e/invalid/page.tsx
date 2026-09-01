export default function InvalidLinkPage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">Link não disponível</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Este link não existe mais, expirou ou já foi usado. Peça um novo link ao responsável pela sua empresa.
      </p>
    </main>
  );
}
