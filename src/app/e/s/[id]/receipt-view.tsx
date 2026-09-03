import { headers } from "next/headers";
import QRCode from "qrcode";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatDayBr } from "@/lib/format/datetime";

type Item = { epi_name: string; ca_number: string; manufacturer: string | null; model: string | null; quantity: number; unit: string };

async function buildVerifyUrl(code: string): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (process.env.NODE_ENV === "production" ? "https" : "http");
  return `${proto}://${host}/verify/${code}`;
}

/** Read-only outcome screen -- a worker who bookmarks/reopens the link after confirming or
 * contesting always finds this, never an error (docs/architecture.md §8). verificationCode
 * is only ever present for CONFIRMED (a contest never seals evidence -- see
 * docs/mvp-roadmap.md FASE 5), and its QR points at the PUBLIC /verify page, never at a
 * signed file URL or anything requiring auth -- anyone can verify a receipt is real. */
export async function ReceiptView({
  status,
  companyName,
  employeeFullName,
  deliveryDate,
  note,
  items,
  verificationCode,
}: {
  status: "CONFIRMED" | "CONTESTED";
  companyName: string;
  employeeFullName: string;
  deliveryDate: string;
  note: string | null;
  items: Item[];
  verificationCode: string | null;
}) {
  const verifyUrl = verificationCode ? await buildVerifyUrl(verificationCode) : null;
  const qrDataUrl = verifyUrl ? await QRCode.toDataURL(verifyUrl, { margin: 1, width: 180 }) : null;

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{companyName}</p>
        <h1 className="text-lg font-semibold">
          {status === "CONFIRMED" ? "Recebimento confirmado" : "Entrega contestada"}
        </h1>
        <Badge
          variant={status === "CONFIRMED" ? "outline" : "destructive"}
          className={status === "CONFIRMED" ? "w-fit border-green-600/40 text-green-700 dark:text-green-400" : "w-fit"}
        >
          {status === "CONFIRMED" ? "Confirmado" : "Contestado"}
        </Badge>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{employeeFullName}</CardTitle>
          <CardDescription>
            Entrega de {formatDayBr(deliveryDate)}
            {note ? ` — ${note}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {items.map((item, i) => (
            <div key={i} className="flex items-start justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0">
              <div>
                <p className="text-sm font-medium">{item.epi_name}</p>
                <p className="text-xs text-muted-foreground">
                  CA {item.ca_number}
                  {item.manufacturer ? ` · ${item.manufacturer}` : ""}
                  {item.model ? ` · ${item.model}` : ""}
                </p>
              </div>
              <p className="shrink-0 text-sm font-medium">
                {item.quantity} {item.unit}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      {verificationCode && qrDataUrl ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Comprovante</CardTitle>
            <CardDescription>Código de verificação — guarde ou fotografe esta tela.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI, not an optimizable remote image */}
            <img src={qrDataUrl} alt={`QR de verificação ${verificationCode}`} width={180} height={180} />
            <p className="font-mono text-sm tracking-widest">{verificationCode}</p>
          </CardContent>
        </Card>
      ) : null}

      <p className="text-center text-xs text-muted-foreground">
        {status === "CONFIRMED"
          ? "Este recebimento já foi registrado. Nenhuma ação adicional é necessária."
          : "O responsável pela sua empresa foi notificado sobre esta contestação."}
      </p>
    </main>
  );
}
