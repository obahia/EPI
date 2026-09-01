import { cookies } from "next/headers";
import { hashWorkerToken } from "@/lib/crypto/worker-token";
import { createWorkerClient } from "@/lib/supabase/worker-client";
import { ReviewForm } from "./review-form";
import { ReceiptView } from "./receipt-view";

type OpenLinkRow = {
  confirmation_request_id: string;
  view_status: string;
  action_nonce: string | null;
  company_name: string;
  employee_full_name: string;
  delivery_date: string;
  note: string | null;
  required_assurance_level: string;
  identity_attempts: number;
  identity_max_attempts: number;
  items: { epi_name: string; ca_number: string; manufacturer: string | null; model: string | null; quantity: number; unit: string }[];
  verification_code: string | null;
};

function InvalidNotice() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">Link não disponível</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Este link não existe mais, expirou ou já foi usado. Peça um novo link ao responsável pela sua empresa.
      </p>
    </main>
  );
}

/**
 * The worker review/confirm/contest screen. Token-less URL (docs/architecture.md §8) --
 * reads the raw token from the HttpOnly cookie set by src/app/e/[token]/route.ts, never
 * from the URL. Calls worker.open_link again here (idempotent, reissues a fresh nonce every
 * call) to get the data to render; verifies the resolved confirmation_request_id matches
 * this page's own [id] so a copied/shared URL without the matching cookie shows nothing.
 */
export default async function WorkerReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const token = cookieStore.get("epi_wt")?.value;

  if (!token) {
    return <InvalidNotice />;
  }

  const tokenHashB64 = hashWorkerToken(token).toString("base64");
  const supabase = createWorkerClient();
  const { data, error } = await supabase
    .schema("worker")
    .rpc("open_link", { p_token_hash_b64: tokenHashB64, p_client_ip: null })
    .single();

  if (error || !data) {
    return <InvalidNotice />;
  }

  const row = data as OpenLinkRow;

  if (row.confirmation_request_id !== id) {
    return <InvalidNotice />;
  }

  if (row.view_status === "CONFIRMED" || row.view_status === "CONTESTED") {
    return (
      <ReceiptView
        status={row.view_status as "CONFIRMED" | "CONTESTED"}
        companyName={row.company_name}
        employeeFullName={row.employee_full_name}
        deliveryDate={row.delivery_date}
        note={row.note}
        items={row.items}
        verificationCode={row.verification_code}
      />
    );
  }

  return (
    <ReviewForm
      key={row.action_nonce ?? row.confirmation_request_id}
      viewId={row.confirmation_request_id}
      nonce={row.action_nonce ?? ""}
      companyName={row.company_name}
      employeeFullName={row.employee_full_name}
      deliveryDate={row.delivery_date}
      note={row.note}
      requiredAssuranceLevel={row.required_assurance_level}
      identityAttempts={row.identity_attempts}
      identityMaxAttempts={row.identity_max_attempts}
      items={row.items}
    />
  );
}
