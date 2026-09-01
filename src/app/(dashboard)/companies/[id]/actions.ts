"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeRpcError } from "@/lib/supabase/rpc-error";

export type UpdateCompanyState = { error: string | null; success: boolean };

const schema = z.object({
  companyId: z.uuid(),
  legalName: z.string().trim().min(2, "Nome muito curto").max(200),
  tradeName: z.string().trim().max(200).optional(),
});

/** Updates legal_name/trade_name via api.update_company. CNPJ is immutable through this
 * RPC by design (docs/architecture.md §3) -- there is deliberately no field for it here. */
export async function updateCompany(
  _prevState: UpdateCompanyState,
  formData: FormData,
): Promise<UpdateCompanyState> {
  const parsed = schema.safeParse({
    companyId: formData.get("companyId"),
    legalName: formData.get("legalName"),
    tradeName: formData.get("tradeName") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos.", success: false };
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("update_company", {
    p_company_id: parsed.data.companyId,
    p_legal_name: parsed.data.legalName,
    p_trade_name: parsed.data.tradeName || null,
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível salvar as alterações."), success: false };
  }

  revalidatePath(`/companies/${parsed.data.companyId}`);
  return { error: null, success: true };
}
