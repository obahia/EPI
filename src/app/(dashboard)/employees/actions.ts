"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isValidCpf, onlyDigits, maskCpf } from "@/lib/br/cpf";
import { normalizePhoneE164 } from "@/lib/br/phone";
import { hashCpf, encryptCpf } from "@/lib/crypto/cpf-secrets";
import { describeRpcError } from "@/lib/supabase/rpc-error";

export type EmployeeFormState = { error: string | null };

const createSchema = z.object({
  companyId: z.uuid(),
  fullName: z.string().trim().min(2, "Nome muito curto").max(150),
  cpf: z.string().refine(isValidCpf, "CPF inválido"),
  registrationNumber: z.string().trim().max(40).optional(),
  phone: z.string().trim().optional(),
  email: z.email("E-mail inválido").optional().or(z.literal("")),
  positionTitle: z.string().trim().max(120).optional(),
  department: z.string().trim().max(120).optional(),
});

/**
 * Manual employee creation. CPF handling per docs/architecture.md §6/§8: validate
 * server-side (never trust the client's isValidCpf check alone), then hash/encrypt/mask
 * here -- the raw CPF digits never leave this function, never get logged, and never reach
 * api.create_employee itself (only cpf_hash_b64/cpf_enc_b64/cpf_masked do).
 */
export async function createEmployee(_prevState: EmployeeFormState, formData: FormData): Promise<EmployeeFormState> {
  const parsed = createSchema.safeParse({
    companyId: formData.get("companyId"),
    fullName: formData.get("fullName"),
    cpf: formData.get("cpf"),
    registrationNumber: formData.get("registrationNumber") || undefined,
    phone: formData.get("phone") || undefined,
    email: formData.get("email") || undefined,
    positionTitle: formData.get("positionTitle") || undefined,
    department: formData.get("department") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  let phoneE164: string | null = null;
  if (parsed.data.phone) {
    phoneE164 = normalizePhoneE164(parsed.data.phone);
    if (!phoneE164) {
      return { error: "Telefone inválido." };
    }
  }

  const cpfDigits = onlyDigits(parsed.data.cpf);
  const cpfHashB64 = hashCpf(cpfDigits).toString("base64");
  const cpfEncB64 = encryptCpf(cpfDigits).toString("base64");
  const cpfMasked = maskCpf(cpfDigits);

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("create_employee", {
    p_company_id: parsed.data.companyId,
    p_full_name: parsed.data.fullName,
    p_cpf_hash_b64: cpfHashB64,
    p_cpf_enc_b64: cpfEncB64,
    p_cpf_masked: cpfMasked,
    p_registration_number: parsed.data.registrationNumber || null,
    p_phone_e164: phoneE164,
    p_email: parsed.data.email || null,
    p_position_title: parsed.data.positionTitle || null,
    p_department: parsed.data.department || null,
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível cadastrar o funcionário.") };
  }

  revalidatePath("/employees");
  redirect(`/employees?company=${parsed.data.companyId}`);
}

const updateSchema = z.object({
  employeeId: z.uuid(),
  companyId: z.uuid(),
  fullName: z.string().trim().min(2, "Nome muito curto").max(150),
  registrationNumber: z.string().trim().max(40).optional(),
  phone: z.string().trim().optional(),
  email: z.email("E-mail inválido").optional().or(z.literal("")),
  positionTitle: z.string().trim().max(120).optional(),
  department: z.string().trim().max(120).optional(),
  status: z.enum(["ACTIVE", "ON_LEAVE", "TERMINATED"]),
});

/** Updates editable employee fields via api.update_employee. Never touches CPF -- there
 * is no CPF-edit path in FASE 1, by design (see the RPC's own comment in
 * supabase/migrations/20260831150200_employee_rpcs.sql). */
export async function updateEmployee(_prevState: EmployeeFormState, formData: FormData): Promise<EmployeeFormState> {
  const parsed = updateSchema.safeParse({
    employeeId: formData.get("employeeId"),
    companyId: formData.get("companyId"),
    fullName: formData.get("fullName"),
    registrationNumber: formData.get("registrationNumber") || undefined,
    phone: formData.get("phone") || undefined,
    email: formData.get("email") || undefined,
    positionTitle: formData.get("positionTitle") || undefined,
    department: formData.get("department") || undefined,
    status: formData.get("status"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  let phoneE164: string | null = null;
  if (parsed.data.phone) {
    phoneE164 = normalizePhoneE164(parsed.data.phone);
    if (!phoneE164) {
      return { error: "Telefone inválido." };
    }
  }

  const supabase = await createClient();
  const { error } = await supabase.schema("api").rpc("update_employee", {
    p_employee_id: parsed.data.employeeId,
    p_full_name: parsed.data.fullName,
    p_registration_number: parsed.data.registrationNumber || null,
    p_phone_e164: phoneE164,
    p_email: parsed.data.email || null,
    p_position_title: parsed.data.positionTitle || null,
    p_department: parsed.data.department || null,
    p_status: parsed.data.status,
  });

  if (error) {
    return { error: describeRpcError(error, "Não foi possível salvar as alterações.") };
  }

  revalidatePath("/employees");
  revalidatePath(`/employees/${parsed.data.employeeId}`);
  redirect(`/employees?company=${parsed.data.companyId}`);
}
