"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { hashWorkerToken } from "@/lib/crypto/worker-token";
import { createWorkerClient } from "@/lib/supabase/worker-client";
import { describeWorkerRpcError } from "@/lib/supabase/worker-rpc-error";
import { getIdentityProvider } from "@/lib/identity/registry";
import type { AssuranceLevel } from "@/lib/identity/provider";
import { canonicalizeEvidencePayload, formatTimestampUtc } from "@/lib/evidence/canon";
import { buildEvidencePayload, type EvidenceSource } from "@/lib/evidence/payload";

/**
 * The worker path's ONLY mutating actions. The raw token is read from the HttpOnly cookie
 * server-side (never from form input -- see src/app/e/[token]/route.ts), hashed, and only
 * the hash ever reaches Postgres. See docs/architecture.md §8 for the nonce/replay model
 * these implement.
 */

export type ConfirmState = { error: string | null; attemptsRemaining: number | null };

function getWorkerToken(): Promise<string | null> {
  return cookies().then((store) => store.get("epi_wt")?.value ?? null);
}

export async function submitConfirm(_prevState: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const token = await getWorkerToken();
  if (!token) {
    return { error: "Sessão expirada. Abra o link novamente.", attemptsRemaining: null };
  }

  const viewId = formData.get("viewId");
  const nonce = formData.get("nonce");
  const requiredLevel = formData.get("requiredAssuranceLevel");
  const cpfLast3 = formData.get("cpfLast3");

  if (typeof viewId !== "string" || typeof nonce !== "string" || typeof requiredLevel !== "string") {
    return { error: "Dados inválidos. Atualize a página.", attemptsRemaining: null };
  }

  const tokenHashB64 = hashWorkerToken(token).toString("base64");
  const supabase = createWorkerClient();
  const requiredAssuranceLevel = requiredLevel as AssuranceLevel;

  let cpfEncBase64: string | undefined;

  if (requiredAssuranceLevel === "AL1_LINK_KNOWLEDGE") {
    if (typeof cpfLast3 !== "string" || !/^\d{3}$/.test(cpfLast3)) {
      return { error: "Digite os 3 últimos números do seu CPF.", attemptsRemaining: null };
    }

    const { data: beginData, error: beginError } = await supabase
      .schema("worker")
      .rpc("begin_confirmation", { p_token_hash_b64: tokenHashB64, p_nonce: nonce })
      .single();

    if (beginError || !beginData) {
      revalidatePath(`/e/s/${viewId}`);
      return { error: describeWorkerRpcError(beginError!), attemptsRemaining: null };
    }

    cpfEncBase64 = (beginData as { cpf_enc_b64: string }).cpf_enc_b64;
  }

  // Runs through the IdentityVerificationProvider abstraction (src/lib/identity) -- swapping
  // which adapter handles a given assurance level never touches this file. The provider
  // decrypts/compares/discards internally; only the boolean result ever leaves it.
  let identityPassed: boolean;
  let identityMethod: "LINK_ONLY" | "LINK_KNOWLEDGE" | "SELFIE_LIVENESS" | "FACE_MATCH_ENROLLED" | "GOV_VERIFIED" | null = null;
  try {
    const result = await getIdentityProvider(requiredAssuranceLevel).check({
      cpfEncBase64,
      knowledgeAnswer: typeof cpfLast3 === "string" ? cpfLast3 : undefined,
    });
    identityPassed = result.passed;
    identityMethod = result.method;
  } catch {
    revalidatePath(`/e/s/${viewId}`);
    return { error: "Este tipo de verificação ainda não está disponível.", attemptsRemaining: null };
  }

  // Only build+seal evidence on an actual pass -- a wrong-digits attempt never reaches here
  // (see the RPC call below, which passes null payload params for that case; Postgres
  // itself rejects a CONFIRM with a missing payload -- see evidence_payload_required).
  let evidenceRpcParams: {
    p_payload: Record<string, unknown> | null;
    p_canonical_bytes_b64: string | null;
    p_payload_sha256_b64: string | null;
    p_confirmed_at_utc: string | null;
  } = { p_payload: null, p_canonical_bytes_b64: null, p_payload_sha256_b64: null, p_confirmed_at_utc: null };

  if (identityPassed) {
    const { data: sourceData, error: sourceError } = await supabase
      .schema("worker")
      .rpc("get_evidence_source", { p_token_hash_b64: tokenHashB64, p_nonce: nonce })
      .single();

    if (sourceError || !sourceData) {
      revalidatePath(`/e/s/${viewId}`);
      return { error: describeWorkerRpcError(sourceError!), attemptsRemaining: null };
    }

    const source = sourceData as unknown as EvidenceSource;
    const confirmedAtUtc = formatTimestampUtc(new Date());
    const payload = buildEvidencePayload({
      source,
      confirmationRequestId: viewId,
      method: identityMethod!,
      achievedAssuranceLevel: requiredAssuranceLevel,
      confirmedAtUtc,
    });
    const { canonicalBytes, sha256 } = canonicalizeEvidencePayload(payload);

    evidenceRpcParams = {
      p_payload: payload,
      p_canonical_bytes_b64: canonicalBytes.toString("base64"),
      p_payload_sha256_b64: sha256.toString("base64"),
      p_confirmed_at_utc: confirmedAtUtc,
    };
  }

  const { data, error } = await supabase
    .schema("worker")
    .rpc("finish_confirmation", {
      p_token_hash_b64: tokenHashB64,
      p_nonce: nonce,
      p_action: "CONFIRM",
      p_identity_passed: identityPassed,
      p_contest_reason_code: null,
      p_contest_comment: null,
      ...evidenceRpcParams,
    })
    .single();

  if (error || !data) {
    revalidatePath(`/e/s/${viewId}`);
    return { error: describeWorkerRpcError(error!), attemptsRemaining: null };
  }

  const row = data as { result: string; delivery_status: string | null; verification_code: string | null };

  if (row.result === "CONFIRMED") {
    redirect(`/e/s/${viewId}`);
  }
  if (row.result === "IDENTITY_MISMATCH") {
    revalidatePath(`/e/s/${viewId}`);
    return { error: "CPF incorreto. Confira os últimos 3 números e tente novamente.", attemptsRemaining: null };
  }
  if (row.result === "ATTEMPTS_EXHAUSTED") {
    revalidatePath(`/e/s/${viewId}`);
    return { error: "Limite de tentativas atingido. Peça um novo link ao responsável pela empresa.", attemptsRemaining: 0 };
  }

  revalidatePath(`/e/s/${viewId}`);
  return { error: "Não foi possível confirmar. Atualize a página.", attemptsRemaining: null };
}

export type ContestState = { error: string | null };

export async function submitContest(_prevState: ContestState, formData: FormData): Promise<ContestState> {
  const token = await getWorkerToken();
  if (!token) {
    return { error: "Sessão expirada. Abra o link novamente." };
  }

  const viewId = formData.get("viewId");
  const nonce = formData.get("nonce");
  const reasonCode = formData.get("reasonCode");
  const comment = formData.get("comment");

  if (typeof viewId !== "string" || typeof nonce !== "string" || typeof reasonCode !== "string" || !reasonCode) {
    return { error: "Selecione um motivo." };
  }

  const tokenHashB64 = hashWorkerToken(token).toString("base64");
  const supabase = createWorkerClient();

  const { error } = await supabase
    .schema("worker")
    .rpc("finish_confirmation", {
      p_token_hash_b64: tokenHashB64,
      p_nonce: nonce,
      p_action: "CONTEST",
      p_identity_passed: null,
      p_contest_reason_code: reasonCode,
      p_contest_comment: typeof comment === "string" && comment.trim() ? comment.trim() : null,
    });

  if (error) {
    revalidatePath(`/e/s/${viewId}`);
    return { error: describeWorkerRpcError(error) };
  }

  redirect(`/e/s/${viewId}`);
}
