import Link from "next/link";
import type { Delivery, EvidenceSummary } from "@/lib/supabase/dal";
import { SealMark } from "@/components/seal-mark";
import { Button } from "@/components/ui/button";
import type { Dict } from "@/i18n/dictionaries";
import { formatDateTimeBr } from "@/lib/format/datetime";

/**
 * The sealed receipt, implemented from the Selo Desktop redesign's comprovante
 * screen: once a delivery is confirmed the page stops being a work queue and
 * becomes the document a fiscalização asks for, so the verification code and the
 * hash lead at document size on their own field, above the record. The sunburst
 * behind it is the same mark the brand uses, at watermark scale.
 */
export function SealedReceipt({
  delivery,
  evidence,
  t,
}: {
  delivery: Delivery;
  evidence: EvidenceSummary;
  t: Dict;
}) {
  return (
    <section className="relative overflow-hidden rounded-3xl bg-card px-8 py-7">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-44 -bottom-52 size-155 rounded-full"
        style={{
          background:
            "repeating-conic-gradient(from 0deg, color-mix(in srgb, var(--success) 14%, transparent) 0deg 3deg, transparent 3deg 22.5deg)",
        }}
      />

      <div className="relative flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[11px] font-bold tracking-[0.11em] text-success uppercase">
            {t.deliveries.evidenceTitle}
          </p>
          <h2 className="mt-2 font-heading text-3xl font-extrabold tracking-tight">
            {delivery.employeeFullName}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.deliveries.sealedAtLabel}: {formatDateTimeBr(evidence.sealedAt)}
          </p>
        </div>
        <SealMark className="size-19" />
      </div>

      <div className="relative mt-6 flex flex-wrap items-end gap-x-10 gap-y-5 border-t border-border pt-5">
        <div className="min-w-0">
          <p className="text-[10px] font-bold tracking-[0.1em] text-muted-foreground uppercase">
            {t.deliveries.verificationCodeLabel}
          </p>
          <p className="mt-1 font-mono text-2xl font-bold tracking-[0.06em]">{evidence.verificationCode}</p>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold tracking-[0.1em] text-muted-foreground uppercase">
            {t.deliveries.hashStartLabel}
          </p>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{evidence.payloadSha256Hex}</p>
        </div>

        <Button asChild variant="outline">
          <Link href={`/verify/${evidence.verificationCode}`}>{t.deliveries.viewPublicVerification}</Link>
        </Button>
      </div>

      <p className="relative mt-4 text-xs text-muted-foreground">{t.deliveries.publicVerificationNote}</p>
    </section>
  );
}
