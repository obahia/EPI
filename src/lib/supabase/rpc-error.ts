import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Maps a Postgres error code raised by one of the api.* RPCs (see the migrations under
 * supabase/migrations/2026083115*.sql) to a short pt-BR message safe to show a user.
 * Server Actions should always go through this instead of surfacing `error.message`
 * directly -- a raw Postgres error can leak internal detail (constraint names, schema
 * names) that has no business reaching the browser.
 */
export function describeRpcError(error: PostgrestError, fallback: string): string {
  switch (error.code) {
    case "42710": // already_onboarded
      return "Sua conta já está associada a uma organização.";
    case "42501": // insufficient_privilege
      // Break-glass gives ONE signal for "not staff", "no grant" and "grant expired". The
      // caller learns that they cannot read this tenant, and nothing about why.
      if (error.message?.includes("no_live_platform_grant")) {
        return "Nenhuma concessão de acesso ativa para esta organização.";
      }
      return "Você não tem permissão para executar esta ação.";
    case "23505": // unique_violation (cpf_already_registered, ca_already_registered, duplicate CNPJ, etc.)
      if (error.message?.includes("cpf_already_registered")) {
        return "CPF já cadastrado nesta empresa.";
      }
      if (error.message?.includes("ca_already_registered")) {
        return "Já existe um EPI com este número de CA neste catálogo.";
      }
      if (error.message?.includes("already_returned")) {
        return "Este item já foi devolvido anteriormente.";
      }
      if (error.message?.includes("position_title_already_exists")) {
        return "Já existe um cargo com este título neste catálogo.";
      }
      if (error.message?.includes("variant_label_already_exists")) {
        return "Já existe uma variante com este rótulo para este EPI.";
      }
      if (error.message?.includes("already_member")) {
        return "Esta pessoa já faz parte da equipe neste escopo.";
      }
      if (error.message?.includes("invitation_already_open")) {
        return "Já existe um convite aberto para este e-mail neste escopo.";
      }
      return "Já existe um registro com esses dados.";
    case "23514": // check_violation (delivery_has_no_items, too_many_items via a CHECK, delivery_not_draft, delivery_not_cancellable, etc.)
      if (error.message?.includes("delivery_has_no_items")) {
        return "A entrega precisa de pelo menos um item.";
      }
      if (error.message?.includes("delivery_not_draft") || error.message?.includes("delivery_not_cancellable")) {
        return "Esta entrega não está mais no estado esperado para esta ação. Atualize a página.";
      }
      if (error.message?.includes("delivery_not_confirmed")) {
        return "Só é possível devolver itens de uma entrega já confirmada pelo funcionário.";
      }
      if (error.message?.includes("note_required_for_other")) {
        return "Descreva o motivo da devolução (mínimo 3 caracteres).";
      }
      if (error.message?.includes("original_not_replaceable")) {
        return "Esta entrega não pode ser trocada (somente entregas confirmadas ou contestadas podem ser trocadas).";
      }
      if (error.message?.includes("early_replacement_blocked")) {
        return "A troca antecipada deste EPI não é permitida pela política da organização.";
      }
      if (error.message?.includes("reason_note_required_for_early_replacement")) {
        return "Descreva o motivo da troca antecipada (mínimo 3 caracteres).";
      }
      if (error.message?.includes("insufficient_stock")) {
        return "Estoque insuficiente para esta operação.";
      }
      if (error.message?.includes("transfer_locations_must_differ")) {
        return "A origem e o destino da transferência precisam ser diferentes.";
      }
      if (error.message?.includes("quantity_must_be_positive") || error.message?.includes("quantity_cannot_be_zero")) {
        return "Informe uma quantidade válida.";
      }
      if (error.message?.includes("last_org_admin")) {
        return "Esta é a última pessoa com acesso total à organização. Promova outra antes de remover ou rebaixar esta.";
      }
      if (error.message?.includes("invitation_already_accepted")) {
        return "Este convite já foi aceito e não pode mais ser cancelado.";
      }
      if (error.message?.includes("invalid_email")) {
        return "Informe um e-mail válido.";
      }
      if (error.message?.includes("invalid_ttl")) {
        return "Prazo de validade inválido.";
      }
      if (error.message?.includes("four_eyes_required")) {
        return "Ninguém concede acesso de plataforma a si mesmo — peça a outra pessoa da equipe.";
      }
      if (error.message?.includes("reason_too_short")) {
        return "Descreva o motivo com pelo menos 20 caracteres — é o texto que o cliente vai ler.";
      }
      if (error.message?.includes("company_not_in_organization")) {
        return "Esta empresa não pertence a essa organização.";
      }
      if (error.message?.includes("cannot_revoke_self")) {
        return "Você não pode remover a si mesmo da equipe de plataforma.";
      }
      return fallback;
    case "22023": // invalid_text_representation / raised domain-validation errors
      if (error.message?.includes("invalid_movement_type_for_manual_entry")) {
        return "Este tipo de movimentação não pode ser lançado manualmente.";
      }
      if (error.message?.includes("invalid_status")) {
        return "Status inválido.";
      }
      return fallback;
    case "54000": // program_limit_exceeded -- reused for two different caps, disambiguate by message
      if (error.message?.includes("too_many_items")) {
        return "Máximo de 200 itens por entrega.";
      }
      return "Lote grande demais (máximo de 20.000 linhas por envio).";
    case "22P02": // invalid_text_representation -- a role string that is not an app.role
      if (error.message?.includes("unknown_role")) {
        return "Perfil de acesso inválido.";
      }
      return fallback;
    case "P0002": // not_found
      // Deliberately one message for unknown, expired, revoked, already-accepted and
      // wrong-recipient: api.accept_invitation raises the same signal for all five, and
      // distinguishing them here would undo that on the way out.
      if (error.message?.includes("not_a_platform_admin")) {
        return "Esta pessoa não faz parte da equipe de plataforma.";
      }
      if (error.message?.includes("not_a_member")) {
        return "Esta pessoa não tem acesso a esta organização. O suporte só pode promover alguém que a organização já admitiu.";
      }
      if (error.message?.includes("invitation_not_available")) {
        return "Este convite não está mais disponível. Peça um novo para quem administra a organização.";
      }
      return "Registro não encontrado.";
    case "28000": // not_authenticated
      return "Sua sessão expirou. Entre novamente.";
    default:
      return fallback;
  }
}
