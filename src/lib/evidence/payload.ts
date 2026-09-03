import "server-only";
import { EPI_CANON_VERSION } from "./canon";
import type { AssuranceLevel, IdentityCheckMethod } from "@/lib/identity/provider";
import type { EvidenceSignature } from "./signature";

export type EvidenceSourceItem = {
  line_no: number;
  epi_name: string;
  ca_number: string;
  manufacturer: string | null;
  model: string | null;
  quantity: number;
  unit: string;
};

export type EvidenceSource = {
  delivery_id: string;
  company_legal_name: string;
  company_cnpj: string;
  employee_full_name: string;
  employee_cpf_masked: string;
  delivery_date: string;
  note: string | null;
  items: EvidenceSourceItem[];
};

/**
 * Builds the epi-canon/1 payload object (docs/architecture.md §12) from data fetched
 * server-side via worker.get_evidence_source -- NEVER from client-submitted form fields,
 * which a tampered request could forge into fabricated evidence. Absent values (note,
 * manufacturer, model) are OMITTED as keys, never set to `null` -- see canon.ts rule 3.
 *
 * `signature` is the one deliberate exception to "never client-submitted": a drawn signature
 * can only ever come from the worker's own browser. It's validated (PNG magic bytes + size
 * cap) at the trust boundary in src/lib/evidence/signature.ts before it ever reaches here --
 * this function just places the already-validated shape into the payload.
 */
export function buildEvidencePayload(params: {
  source: EvidenceSource;
  confirmationRequestId: string;
  method: IdentityCheckMethod;
  achievedAssuranceLevel: AssuranceLevel;
  confirmedAtUtc: string;
  signature: EvidenceSignature;
}): Record<string, unknown> {
  const { source, confirmationRequestId, method, achievedAssuranceLevel, confirmedAtUtc, signature } = params;

  const items = source.items.map((item) => {
    const out: Record<string, unknown> = {
      line_no: item.line_no,
      epi_name: item.epi_name,
      ca_number: item.ca_number,
      quantity: item.quantity,
      unit: item.unit,
    };
    if (item.manufacturer) out.manufacturer = item.manufacturer;
    if (item.model) out.model = item.model;
    return out;
  });

  const company: Record<string, unknown> = { legal_name: source.company_legal_name };
  if (source.company_cnpj) company.cnpj = source.company_cnpj;

  const payload: Record<string, unknown> = {
    _canon: EPI_CANON_VERSION,
    delivery_id: source.delivery_id,
    confirmation_request_id: confirmationRequestId,
    company,
    employee: { full_name: source.employee_full_name, cpf_masked: source.employee_cpf_masked },
    delivery_date: source.delivery_date,
    items,
    declaration_text: `Eu, ${source.employee_full_name}, declaro que recebi os equipamentos de proteção individual (EPI) listados neste documento, entregues por ${source.company_legal_name}.`,
    identity: { method, achieved_assurance_level: achievedAssuranceLevel },
    confirmed_at_utc: confirmedAtUtc,
    signature,
  };
  if (source.note) payload.note = source.note;

  return payload;
}
