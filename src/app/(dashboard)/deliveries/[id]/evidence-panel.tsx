import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EvidenceSummary } from "@/lib/supabase/dal";
import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";

/**
 * Manager-facing summary of the sealed evidence for a CONFIRMED delivery -- the code, the
 * sealed timestamp, and a hash prefix, plus a link to the same public /verify page a third
 * party would see. No QR code here (the worker's own receipt screen already shows one) and
 * no raw payload rendering (see EvidenceSummary.payload -- kept for future use only).
 */
export async function EvidencePanel({ evidence }: { evidence: EvidenceSummary }) {
  const t = getDictionary(await getLocale());

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t.deliveries.evidenceTitle}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <div className="contents">
            <dt className="text-muted-foreground">{t.deliveries.verificationCodeLabel}</dt>
            <dd className="font-mono tracking-widest">{evidence.verificationCode}</dd>
          </div>
          <div className="contents">
            <dt className="text-muted-foreground">{t.deliveries.sealedAtLabel}</dt>
            <dd>{new Date(evidence.sealedAt).toLocaleString("pt-BR")}</dd>
          </div>
          <div className="contents">
            <dt className="text-muted-foreground">{t.deliveries.hashStartLabel}</dt>
            <dd className="font-mono text-xs">{evidence.payloadSha256Hex.slice(0, 20)}…</dd>
          </div>
        </dl>

        <Link href={`/verify/${evidence.verificationCode}`} className="text-sm text-primary underline underline-offset-4">
          {t.deliveries.viewPublicVerification}
        </Link>
        <p className="text-xs text-muted-foreground">{t.deliveries.publicVerificationNote}</p>
      </CardContent>
    </Card>
  );
}
