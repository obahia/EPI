import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Maps a Postgres error raised by a worker.* RPC to a short pt-BR message. Deliberately
 * more generic than describeRpcError (the manager-facing mapper) -- the worker surface is
 * anonymous and anti-enumeration matters here (docs/architecture.md §8): "link_not_available"
 * covers not-found/expired/revoked/wrong-state with the SAME message on purpose.
 */
export function describeWorkerRpcError(error: PostgrestError): string {
  if (error.message?.includes("link_not_available")) {
    return "Este link não está mais disponível. Peça um novo link ao responsável pela empresa.";
  }
  if (error.message?.includes("stale_submission")) {
    return "Esta página expirou. Atualize e tente novamente.";
  }
  if (error.message?.includes("rate_limited")) {
    return "Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.";
  }
  if (error.message?.includes("contest_reason_required")) {
    return "Selecione um motivo.";
  }
  return "Não foi possível concluir. Atualize a página e tente novamente.";
}
