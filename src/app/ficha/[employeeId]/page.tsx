import { notFound, redirect } from "next/navigation";
import {
  verifySession,
  getEmployee,
  getCompany,
  getEmployeeDeliveries,
  getDeliveryItemsFor,
  getEvidenceSummary,
  getReturnsForItems,
  type Delivery,
  type DeliveryItem,
  type EmployeeStatus,
  type EpiReturnReasonCode,
  type EvidenceSummary,
} from "@/lib/supabase/dal";
import { formatCnpj } from "@/lib/br/cnpj";
import { formatDateTimeBr, formatDayBr, timeZoneLabel } from "@/lib/format/datetime";
import { PrintButton } from "./print-button";

/**
 * Ficha de Controle de Entrega de EPI -- the document NR-6 6.5.1 requires the employer to
 * keep, and the one a fiscal actually asks to see. One sheet per employee, listing every
 * PPE handed to them and how each receipt was signed.
 *
 * Deliberately pt-BR only, with no i18n wrapper: this is a Brazilian regulatory form, and
 * its field names are legal terms, not UI copy. Same rule already applied to the worker
 * flow (/e/*) and the public verification page (docs/architecture.md, i18n scope).
 *
 * Rendered as a plain page and printed with the browser (Ctrl+P -> "Salvar como PDF"),
 * not generated as a PDF server-side. A PDF library would be a dependency, a font-embedding
 * problem and a second layout to maintain, to produce the same A4 page the browser already
 * produces from this HTML.
 */

const UNIT_LABEL: Record<string, string> = {
  UN: "Un.",
  PAR: "Par",
  CX: "Cx.",
  M: "m",
  KG: "kg",
};

const STATUS_LABEL: Record<EmployeeStatus, string> = {
  ACTIVE: "Ativo",
  ON_LEAVE: "Afastado",
  TERMINATED: "Desligado",
};

const RETURN_REASON_LABEL: Record<EpiReturnReasonCode, string> = {
  WORN_OUT: "desgaste",
  REPLACED: "troca",
  TERMINATION: "desligamento",
  OTHER: "outro motivo",
};

export default async function FichaPage({ params }: { params: Promise<{ employeeId: string }> }) {
  const session = await verifySession();
  if (!session.isAuthenticated) {
    redirect("/login");
  }

  const { employeeId } = await params;
  const employee = await getEmployee(employeeId);
  if (!employee) {
    notFound();
  }

  const [company, employeeDeliveries] = await Promise.all([
    getCompany(employee.companyId),
    getEmployeeDeliveries(employee.id),
  ]);
  if (!company) {
    notFound();
  }

  // A draft was never handed over, and a cancelled one was undone -- neither belongs on a
  // sheet that claims to record what this person received. Everything else stays, including
  // disputed and superseded rows: a control sheet that quietly hides the contested lines is
  // worse than useless if it is ever challenged.
  const mine = employeeDeliveries
    .filter((d) => d.status !== "DRAFT" && d.status !== "CANCELLED")
    .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));

  // Only this person's own deliveries' items -- the earlier version read the whole
  // company's delivery-item history to build a sheet for one employee.
  const items = await getDeliveryItemsFor(mine.map((d) => d.id));
  const itemsByDelivery = new Map<string, DeliveryItem[]>();
  for (const item of items) {
    const list = itemsByDelivery.get(item.deliveryId);
    if (list) list.push(item);
    else itemsByDelivery.set(item.deliveryId, [item]);
  }

  // Only confirmed deliveries have sealed evidence; one lookup each, in parallel.
  const evidences = new Map<string, EvidenceSummary>();
  const confirmed = mine.filter((d) => d.status === "CONFIRMED");
  const summaries = await Promise.all(confirmed.map((d) => getEvidenceSummary(d.id)));
  confirmed.forEach((delivery, index) => {
    const summary = summaries[index];
    if (summary) evidences.set(delivery.id, summary);
  });

  const returns = await getReturnsForItems(items.map((item) => item.id));
  const returnByItemId = new Map(returns.map((r) => [r.deliveryItemId, r]));

  const rows = mine.flatMap((delivery) =>
    (itemsByDelivery.get(delivery.id) ?? []).map((item) => ({ delivery, item })),
  );

  return (
    <main className="ficha mx-auto max-w-[210mm] bg-white p-8 text-[#111] print:p-0">
      <PrintButton />

      <header className="flex items-start justify-between gap-6 border-b-2 border-[#111] pb-4">
        <div>
          <h1 className="text-[17px] font-bold uppercase">Ficha de Controle de Entrega de EPI</h1>
          <p className="mt-1 text-[11px]">
            Equipamento de Proteção Individual — registro exigido pela NR-6, item 6.5.1
          </p>
        </div>
        <div className="text-right text-[11px]">
          <p className="font-bold">{company.legalName}</p>
          {company.tradeName ? <p>{company.tradeName}</p> : null}
          <p>CNPJ {formatCnpj(company.cnpj)}</p>
        </div>
      </header>

      <section className="mt-4 border border-[#111]">
        <dl className="grid grid-cols-1 text-[11px] sm:grid-cols-4">
          <Field label="Nome do empregado" value={employee.fullName} className="sm:col-span-2" />
          <Field label="CPF" value={employee.cpfMasked} mono />
          <Field label="Matrícula" value={employee.registrationNumber ?? "—"} mono />
          <Field label="Cargo" value={employee.positionTitle ?? "—"} className="sm:col-span-2" />
          <Field label="Setor / Departamento" value={employee.department ?? "—"} />
          <Field label="Situação" value={STATUS_LABEL[employee.status]} />
        </dl>
      </section>

      <table className="mt-4 w-full border-collapse text-[10.5px]">
        <thead>
          <tr className="bg-[#eee]">
            <Th className="w-[68px]">Data</Th>
            <Th>Equipamento entregue</Th>
            <Th className="w-[64px]">CA</Th>
            <Th className="w-[38px] text-right">Qtd.</Th>
            <Th className="w-[40px]">Un.</Th>
            <Th className="w-[150px]">Recebimento</Th>
            <Th className="w-[112px]">Código de verificação</Th>
            <Th className="w-[95px]">Devolução</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="border border-[#111] p-4 text-center">
                Nenhuma entrega registrada para este empregado.
              </td>
            </tr>
          ) : (
            rows.map(({ delivery, item }) => {
              const itemReturn = returnByItemId.get(item.id);
              return (
                <tr key={item.id} className="break-inside-avoid">
                  <Td className="tabular-nums">{formatDayBr(delivery.deliveryDate)}</Td>
                  <Td>
                    {item.epiName}
                    {item.manufacturer || item.model ? (
                      <span className="text-[#555]">
                        {" — "}
                        {[item.manufacturer, item.model].filter(Boolean).join(" ")}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="font-mono">{item.caNumber}</Td>
                  <Td className="text-right tabular-nums">{item.quantity}</Td>
                  <Td>{UNIT_LABEL[item.unit] ?? item.unit}</Td>
                  <Td>{receiptLabel(delivery, company.timeZone)}</Td>
                  <Td className="font-mono">{evidences.get(delivery.id)?.verificationCode ?? "—"}</Td>
                  <Td className="tabular-nums">
                    {itemReturn
                      ? `${formatDayBr(itemReturn.returnedOn)} (${RETURN_REASON_LABEL[itemReturn.reasonCode]})`
                      : "—"}
                  </Td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <section className="mt-5 border-t border-[#111] pt-3 text-[9.5px] leading-relaxed text-[#333]">
        <p>
          O recebimento de cada equipamento acima foi registrado eletronicamente pelo próprio
          empregado, por meio de link individual com verificação de identidade, constituindo
          assinatura eletrônica simples nos termos do art. 4º, I, da Lei nº 14.063/2020. Cada
          entrega confirmada possui comprovante selado com código de verificação próprio,
          conferível publicamente, sem necessidade de acesso ao sistema, em{" "}
          <strong>/verify/&lt;código&gt;</strong>.
        </p>
        <p className="mt-2">
          Todos os horários referem-se ao {timeZoneLabel(company.timeZone)}. Documento gerado em{" "}
          {formatDateTimeBr(new Date(), company.timeZone)}. Este documento reflete o registro existente no sistema
          na data de sua emissão.
        </p>
        <p className="mt-4 text-[9px] text-[#666]">
          O CPF é armazenado de forma cifrada; esta ficha exibe apenas os dígitos centrais.
        </p>
      </section>
    </main>
  );
}

/** How this delivery's receipt was signed -- the column that replaces the handwritten
 * signature on the paper version. */
function receiptLabel(delivery: Delivery, timeZone: string | null): string {
  if (delivery.status === "CONFIRMED" && delivery.confirmedAt) {
    return `Confirmado em ${formatDateTimeBr(delivery.confirmedAt, timeZone)}`;
  }
  if (delivery.status === "CONTESTED" && delivery.contestedAt) {
    return `CONTESTADO em ${formatDateTimeBr(delivery.contestedAt, timeZone)}`;
  }
  if (delivery.status === "SUPERSEDED") return "Substituída por nova entrega";
  if (delivery.status === "ISSUED") return "Aguardando confirmação";
  return "—";
}

function Field({
  label,
  value,
  mono = false,
  className = "",
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={`border-b border-[#111] p-2 sm:border-r ${className}`}>
      <dt className="text-[8.5px] font-bold tracking-[0.08em] text-[#555] uppercase">{label}</dt>
      <dd className={`mt-0.5 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`border border-[#111] p-1.5 text-left font-bold ${className}`}>{children}</th>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`border border-[#111] p-1.5 align-top ${className}`}>{children}</td>;
}
