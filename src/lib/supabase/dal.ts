import "server-only";
import { cache } from "react";
import { createClient } from "./server";

/**
 * Data Access Layer: the ONLY place session/auth is checked, and the only place that
 * should query Supabase for anything sensitive. See docs/architecture.md §4 -- proxy.ts
 * does an optimistic cookie check only; real authorization happens here, as close to the
 * data as possible, backed by RLS as the non-bypassable last layer regardless.
 *
 * verifySession() is `cache()`-wrapped so multiple calls within one request/render pass
 * reuse the same lookup instead of re-verifying per component.
 */
export const verifySession = cache(async () => {
  const supabase = await createClient();
  // getClaims(), never getSession(): getSession() reads local storage/cookies without
  // revalidating the token server-side; getClaims() verifies the JWT (locally, with
  // asymmetric signing keys -- no network round trip needed).
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data?.claims) {
    return { isAuthenticated: false as const, userId: null };
  }

  return { isAuthenticated: true as const, userId: data.claims.sub };
});

export type CurrentUser = {
  id: string;
  fullName: string;
  email: string;
};

/**
 * The current user's own narrow profile, or null if unauthenticated. Selects only the
 * display fields a layout/header needs -- never a raw `select('*')`.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return null;

  const supabase = await createClient();
  // .schema('api') is explicit rather than relying on which schema config.toml lists
  // first as the PostgREST default -- self-documenting and robust to reordering.
  const { data, error } = await supabase
    .schema("api")
    .from("users")
    .select("id, full_name, email")
    .eq("id", session.userId)
    .single();

  if (error || !data) return null;

  const row = data as { id: string; full_name: string; email: string };
  return { id: row.id, fullName: row.full_name, email: row.email };
});

export type Membership = {
  id: string;
  organizationId: string;
  companyId: string | null;
  role: "VIEWER" | "SST_OPERATOR" | "COMPANY_ADMIN" | "ORG_ADMIN";
};

/** The current user's own live memberships, via the api.my_memberships() RPC (never a
 * direct read of authz.memberships -- see docs/architecture.md §7). */
export const getMyMemberships = cache(async (): Promise<Membership[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase.schema("api").rpc("my_memberships");

  if (error || !data) return [];

  return (
    data as {
      id: string;
      organization_id: string;
      company_id: string | null;
      role: Membership["role"];
    }[]
  ).map((m) => ({
    id: m.id,
    organizationId: m.organization_id,
    companyId: m.company_id,
    role: m.role,
  }));
});

export type Company = {
  id: string;
  organizationId: string;
  organizationKind: "PARTNER" | "DIRECT";
  cnpj: string;
  legalName: string;
  tradeName: string | null;
  status: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** IANA zone of the parent organization (app.organizations.timezone), e.g.
   * "America/Sao_Paulo". Null only if the join in api.companies somehow found no parent
   * row -- callers should fall back to BRAZIL_TIME_ZONE from src/lib/format/datetime.ts. */
  timeZone: string | null;
};

type CompanyRow = {
  id: string;
  organization_id: string;
  organization_kind: Company["organizationKind"];
  cnpj: string;
  legal_name: string;
  trade_name: string | null;
  status: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  time_zone: string | null;
};

const COMPANY_COLUMNS =
  "id, organization_id, organization_kind, cnpj, legal_name, trade_name, status, archived_at, created_at, updated_at, time_zone";

function mapCompanyRow(row: CompanyRow): Company {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationKind: row.organization_kind,
    cnpj: row.cnpj,
    legalName: row.legal_name,
    tradeName: row.trade_name,
    status: row.status,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timeZone: row.time_zone,
  };
}

/** The companies visible to the current user via api.companies (RLS-scoped: only
 * companies reachable through one of the caller's own memberships). */
export const getMyCompanies = cache(async (): Promise<Company[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("companies")
    .select(COMPANY_COLUMNS)
    .order("legal_name", { ascending: true });

  if (error || !data) return [];

  return (data as CompanyRow[]).map(mapCompanyRow);
});

/** A single company by id, or null if it doesn't exist or isn't visible to the current
 * user (RLS -- never distinguishes "not found" from "not yours" to the caller). */
export const getCompany = cache(async (companyId: string): Promise<Company | null> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("companies")
    .select(COMPANY_COLUMNS)
    .eq("id", companyId)
    .maybeSingle();

  if (error || !data) return null;

  return mapCompanyRow(data as CompanyRow);
});

export type EmployeeStatus = "ACTIVE" | "ON_LEAVE" | "TERMINATED";
export type DataOrigin = "MANUAL" | "IMPORT" | "SYNC_WOTY" | "API";

export type Employee = {
  id: string;
  organizationId: string;
  companyId: string;
  fullName: string;
  cpfMasked: string;
  registrationNumber: string | null;
  phoneE164: string | null;
  email: string | null;
  positionTitle: string | null;
  department: string | null;
  status: EmployeeStatus;
  terminatedOn: string | null;
  dataOrigin: DataOrigin;
  externalSource: string | null;
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
};

type EmployeeRow = {
  id: string;
  organization_id: string;
  company_id: string;
  full_name: string;
  cpf_masked: string;
  registration_number: string | null;
  phone_e164: string | null;
  email: string | null;
  position_title: string | null;
  department: string | null;
  status: EmployeeStatus;
  terminated_on: string | null;
  data_origin: DataOrigin;
  external_source: string | null;
  external_ref: string | null;
  created_at: string;
  updated_at: string;
};

const EMPLOYEE_COLUMNS =
  "id, organization_id, company_id, full_name, cpf_masked, registration_number, phone_e164, email, position_title, department, status, terminated_on, data_origin, external_source, external_ref, created_at, updated_at";

function mapEmployeeRow(row: EmployeeRow): Employee {
  return {
    id: row.id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    fullName: row.full_name,
    cpfMasked: row.cpf_masked,
    registrationNumber: row.registration_number,
    phoneE164: row.phone_e164,
    email: row.email,
    positionTitle: row.position_title,
    department: row.department,
    status: row.status,
    terminatedOn: row.terminated_on,
    dataOrigin: row.data_origin,
    externalSource: row.external_source,
    externalRef: row.external_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Employees of one company, via api.employees (RLS-scoped). Never selects cpf_hash/
 * cpf_enc -- that view has no such columns at all (see docs/architecture.md §6/§16). */
export const getEmployees = cache(async (companyId: string): Promise<Employee[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("employees")
    .select(EMPLOYEE_COLUMNS)
    .eq("company_id", companyId)
    .order("full_name", { ascending: true });

  if (error || !data) return [];

  return (data as EmployeeRow[]).map(mapEmployeeRow);
});

/** A single employee by id, or null if it doesn't exist or isn't visible (RLS). */
export const getEmployee = cache(async (employeeId: string): Promise<Employee | null> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("employees")
    .select(EMPLOYEE_COLUMNS)
    .eq("id", employeeId)
    .maybeSingle();

  if (error || !data) return null;

  return mapEmployeeRow(data as EmployeeRow);
});

export type EpiUnit = "UN" | "PAR" | "CX" | "M" | "KG";

export type Epi = {
  id: string;
  organizationId: string;
  companyId: string | null; // null = org-wide shared catalog entry
  isActive: boolean;
  archivedAt: string | null;
  createdAt: string;
  currentVersionId: string;
  version: number;
  name: string;
  caNumber: string;
  manufacturer: string | null;
  model: string | null;
  description: string | null;
  defaultUnit: EpiUnit;
  versionValidFrom: string;
};

type EpiRow = {
  id: string;
  organization_id: string;
  company_id: string | null;
  is_active: boolean;
  archived_at: string | null;
  created_at: string;
  current_version_id: string;
  version: number;
  name: string;
  ca_number: string;
  manufacturer: string | null;
  model: string | null;
  description: string | null;
  default_unit: EpiUnit;
  version_valid_from: string;
};

const EPI_COLUMNS =
  "id, organization_id, company_id, is_active, archived_at, created_at, current_version_id, version, name, ca_number, manufacturer, model, description, default_unit, version_valid_from";

function mapEpiRow(row: EpiRow): Epi {
  return {
    id: row.id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    isActive: row.is_active,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    currentVersionId: row.current_version_id,
    version: row.version,
    name: row.name,
    caNumber: row.ca_number,
    manufacturer: row.manufacturer,
    model: row.model,
    description: row.description,
    defaultUnit: row.default_unit,
    versionValidFrom: row.version_valid_from,
  };
}

/** The EPI catalog visible for one company, via api.epis: the org-wide shared catalog
 * (company_id IS NULL) plus that company's own private entries -- never a sibling
 * company's private catalog, even when the caller belongs to more than one company. */
export const getEpis = cache(async (companyId: string): Promise<Epi[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("epis")
    .select(EPI_COLUMNS)
    .or(`company_id.is.null,company_id.eq.${companyId}`)
    .order("name", { ascending: true });

  if (error || !data) return [];

  return (data as EpiRow[]).map(mapEpiRow);
});

/** A single EPI catalog entry by id, or null if it doesn't exist or isn't visible (RLS). */
export const getEpi = cache(async (epiId: string): Promise<Epi | null> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("epis")
    .select(EPI_COLUMNS)
    .eq("id", epiId)
    .maybeSingle();

  if (error || !data) return null;

  return mapEpiRow(data as EpiRow);
});

export type DeliveryStatus = "DRAFT" | "ISSUED" | "CONFIRMED" | "CONTESTED" | "CANCELLED" | "SUPERSEDED";

export type Delivery = {
  id: string;
  organizationId: string;
  companyId: string;
  employeeId: string;
  chainId: string;
  chainVersion: number;
  correctsDeliveryId: string | null;
  supersededByDeliveryId: string | null;
  status: DeliveryStatus;
  deliveryDate: string;
  note: string | null;
  issuedAt: string | null;
  frozenAt: string | null;
  confirmedAt: string | null;
  contestedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  employeeFullName: string;
  /** The batch this delivery was issued in, or null when it was created one-off. */
  batchId: string | null;
};

type DeliveryRow = {
  id: string;
  organization_id: string;
  company_id: string;
  employee_id: string;
  chain_id: string;
  chain_version: number;
  corrects_delivery_id: string | null;
  superseded_by_delivery_id: string | null;
  status: DeliveryStatus;
  delivery_date: string;
  note: string | null;
  issued_at: string | null;
  frozen_at: string | null;
  confirmed_at: string | null;
  contested_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  employee_full_name: string;
  batch_id: string | null;
};

const DELIVERY_COLUMNS =
  "id, organization_id, company_id, employee_id, chain_id, chain_version, corrects_delivery_id, superseded_by_delivery_id, status, delivery_date, note, issued_at, frozen_at, confirmed_at, contested_at, cancelled_at, cancel_reason, created_by, created_at, updated_at, employee_full_name, batch_id";

function mapDeliveryRow(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    chainId: row.chain_id,
    chainVersion: row.chain_version,
    correctsDeliveryId: row.corrects_delivery_id,
    supersededByDeliveryId: row.superseded_by_delivery_id,
    status: row.status,
    deliveryDate: row.delivery_date,
    note: row.note,
    issuedAt: row.issued_at,
    frozenAt: row.frozen_at,
    confirmedAt: row.confirmed_at,
    contestedAt: row.contested_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    employeeFullName: row.employee_full_name,
    batchId: row.batch_id,
  };
}

/** Deliveries for one company, via api.epi_deliveries (RLS-scoped), newest first. */
export const getDeliveries = cache(async (companyId: string): Promise<Delivery[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("epi_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  return (data as DeliveryRow[]).map(mapDeliveryRow);
});

export type DeliveryPage = {
  rows: Delivery[];
  /** Total matching the same filters, ignoring the page window -- for "showing X of Y". */
  total: number;
};

export type DeliveryQuery = {
  status?: DeliveryStatus;
  /** Matches the employee's name or an item's CA number. */
  q?: string;
  limit: number;
  offset: number;
};

/**
 * One page of a company's deliveries, filtered and counted in Postgres.
 *
 * Replaces reading the whole table and slicing in JS. A company that issues one batch of
 * 20,000 deliveries (the cap api.create_delivery_batch allows) would otherwise ship every
 * one of those rows to the server component on every page view.  gives the
 * footer its total without a second round trip.
 */
export const getDeliveriesPage = cache(async (companyId: string, query: DeliveryQuery): Promise<DeliveryPage> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return { rows: [], total: 0 };

  const supabase = await createClient();
  let builder = supabase
    .schema("api")
    .from("epi_deliveries")
    .select(DELIVERY_COLUMNS, { count: "exact" })
    .eq("company_id", companyId);

  if (query.status) builder = builder.eq("status", query.status);

  const needle = query.q?.trim();
  if (needle) {
    // PostgREST's `or=` filter is a comma/parenthesis-delimited grammar, so those
    // characters (and the LIKE wildcards) are stripped rather than escaped -- a search box
    // has no legitimate use for them, and letting them through would let a search term
    // rewrite the filter.
    const escaped = needle.replace(/[%_,().]/g, " ").trim();
    if (escaped) {
      // A CA number lives on the items, not on the delivery, so the item hits are resolved
      // first and folded into the same filter as the name match. Capped: a search that
      // matched thousands of deliveries is not a search anyone is reading.
      const { data: itemRows } = await supabase
        .schema("api")
        .from("epi_delivery_items")
        .select("delivery_id")
        .eq("company_id", companyId)
        .ilike("ca_number", `%${escaped}%`)
        .limit(500);

      const ids = [...new Set(((itemRows ?? []) as { delivery_id: string }[]).map((r) => r.delivery_id))];
      builder = ids.length
        ? builder.or(`employee_full_name.ilike.%${escaped}%,id.in.(${ids.join(",")})`)
        : builder.ilike("employee_full_name", `%${escaped}%`);
    }
  }

  const { data, error, count } = await builder
    .order("created_at", { ascending: false })
    .range(query.offset, query.offset + query.limit - 1);

  if (error || !data) return { rows: [], total: 0 };

  return { rows: (data as DeliveryRow[]).map(mapDeliveryRow), total: count ?? 0 };
});

/** How many deliveries a company has in each status -- what the filter pills count. Five
 * head-only counts, so no row ever leaves Postgres for this. */
export const getDeliveryStatusCounts = cache(
  async (companyId: string): Promise<{ total: number; byStatus: Record<DeliveryStatus, number> }> => {
    const session = await verifySession();
    const empty = {
      DRAFT: 0, ISSUED: 0, CONFIRMED: 0, CONTESTED: 0, CANCELLED: 0, SUPERSEDED: 0,
    } as Record<DeliveryStatus, number>;
    if (!session.isAuthenticated) return { total: 0, byStatus: empty };

    const supabase = await createClient();
    const statuses: DeliveryStatus[] = ["DRAFT", "ISSUED", "CONFIRMED", "CONTESTED", "CANCELLED", "SUPERSEDED"];

    const [totalResult, ...results] = await Promise.all([
      supabase.schema("api").from("epi_deliveries").select("id", { count: "exact", head: true }).eq("company_id", companyId),
      ...statuses.map((status) =>
        supabase
          .schema("api")
          .from("epi_deliveries")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .eq("status", status),
      ),
    ]);

    const byStatus = { ...empty };
    statuses.forEach((status, index) => {
      byStatus[status] = results[index]?.count ?? 0;
    });
    return { total: totalResult.count ?? 0, byStatus };
  },
);

/** Deliveries of ONE employee, newest first -- served by deliveries_emp_idx. The employee
 * detail page and the ficha need this and nothing else; both used to read the whole
 * company's deliveries and filter in JS. */
export const getEmployeeDeliveries = cache(async (employeeId: string): Promise<Delivery[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("epi_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("employee_id", employeeId)
    .order("delivery_date", { ascending: false });

  if (error || !data) return [];

  return (data as DeliveryRow[]).map(mapDeliveryRow);
});

/** The longest-waiting unconfirmed deliveries -- the dashboard names three of these. Bounded
 * by  in Postgres rather than by sorting the whole table in JS. */
export const getOldestWaitingDeliveries = cache(
  async (companyId: string, limit: number = 3): Promise<Delivery[]> => {
    const session = await verifySession();
    if (!session.isAuthenticated) return [];

    const supabase = await createClient();
    const { data, error } = await supabase
      .schema("api")
      .from("epi_deliveries")
      .select(DELIVERY_COLUMNS)
      .eq("company_id", companyId)
      .eq("status", "ISSUED")
      .not("issued_at", "is", null)
      .order("issued_at", { ascending: true })
      .limit(limit);

    if (error || !data) return [];

    return (data as DeliveryRow[]).map(mapDeliveryRow);
  },
);

/**
 * How many deliveries each employee of a company has, as a map.
 *
 * Selects ONLY employee_id, so this is one narrow column rather than the whole delivery
 * row -- but it is still one row per delivery, and that is a deliberate stopping point: a
 * proper GROUP BY needs an RPC, which needs a migration. Revisit when the roster column
 * actually hurts.
 */
export const getDeliveryCountsByEmployee = cache(async (companyId: string): Promise<Map<string, number>> => {
  const session = await verifySession();
  const counts = new Map<string, number>();
  if (!session.isAuthenticated) return counts;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("epi_deliveries")
    .select("employee_id")
    .eq("company_id", companyId);

  if (error || !data) return counts;

  for (const row of data as { employee_id: string }[]) {
    counts.set(row.employee_id, (counts.get(row.employee_id) ?? 0) + 1);
  }
  return counts;
});

/** A single delivery by id, or null if it doesn't exist or isn't visible (RLS). */
export const getDelivery = cache(async (deliveryId: string): Promise<Delivery | null> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("epi_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("id", deliveryId)
    .maybeSingle();

  if (error || !data) return null;

  return mapDeliveryRow(data as DeliveryRow);
});

export type DeliveryItem = {
  id: string;
  deliveryId: string;
  companyId: string;
  lineNo: number;
  epiId: string | null;
  epiVersionId: string;
  epiName: string;
  caNumber: string;
  manufacturer: string | null;
  model: string | null;
  quantity: number;
  unit: EpiUnit;
  createdAt: string;
};

type DeliveryItemRow = {
  id: string;
  delivery_id: string;
  company_id: string;
  line_no: number;
  epi_id: string | null;
  epi_version_id: string;
  epi_name: string;
  ca_number: string;
  manufacturer: string | null;
  model: string | null;
  quantity: number;
  unit: EpiUnit;
  created_at: string;
};

const DELIVERY_ITEM_COLUMNS =
  "id, delivery_id, company_id, line_no, epi_id, epi_version_id, epi_name, ca_number, manufacturer, model, quantity, unit, created_at";

function mapDeliveryItemRow(row: DeliveryItemRow): DeliveryItem {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    companyId: row.company_id,
    lineNo: row.line_no,
    epiId: row.epi_id,
    epiVersionId: row.epi_version_id,
    epiName: row.epi_name,
    caNumber: row.ca_number,
    manufacturer: row.manufacturer,
    model: row.model,
    quantity: row.quantity,
    unit: row.unit,
    createdAt: row.created_at,
  };
}

/** Line items of one delivery, via api.epi_delivery_items (RLS-scoped), in display order. */
export const getDeliveryItems = cache(async (deliveryId: string): Promise<DeliveryItem[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("epi_delivery_items")
    .select(DELIVERY_ITEM_COLUMNS)
    .eq("delivery_id", deliveryId)
    .order("line_no", { ascending: true });

  if (error || !data) return [];

  return (data as DeliveryItemRow[]).map(mapDeliveryItemRow);
});

/**
 * Line items for a known set of deliveries, in one round trip.
 *
 * Callers show an items column beside deliveries they are already rendering, so the set is
 * whatever is on screen -- a page of rows, or one employee's history. This deliberately
 * takes ids rather than a company: the earlier company-wide version pulled every item the
 * company had ever recorded in order to annotate seven table rows.
 */
export const getDeliveryItemsFor = cache(async (deliveryIds: readonly string[]): Promise<DeliveryItem[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated || deliveryIds.length === 0) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("epi_delivery_items")
    .select(DELIVERY_ITEM_COLUMNS)
    .in("delivery_id", deliveryIds as string[])
    .order("line_no", { ascending: true });

  if (error || !data) return [];

  return (data as DeliveryItemRow[]).map(mapDeliveryItemRow);
});

export type DeliveryItemSummary = {
  /** How many distinct EPI lines the delivery has. */
  lines: number;
  /** Total units across those lines. */
  units: number;
  /** First line's EPI name -- what the dashboard names when it says who is waiting. */
  firstEpiName: string;
};

/** Indexes getDeliveryItemsFor() output by delivery. */
export function summarizeDeliveryItems(items: DeliveryItem[]): Map<string, DeliveryItemSummary> {
  const byDelivery = new Map<string, DeliveryItemSummary>();
  for (const item of items) {
    const entry = byDelivery.get(item.deliveryId);
    if (entry) {
      entry.lines += 1;
      entry.units += item.quantity;
    } else {
      byDelivery.set(item.deliveryId, { lines: 1, units: item.quantity, firstEpiName: item.epiName });
    }
  }
  return byDelivery;
}

export type AssuranceLevel =
  | "AL0_LINK_ONLY"
  | "AL1_LINK_KNOWLEDGE"
  | "AL2_SELFIE_LIVENESS"
  | "AL3_FACE_MATCH_ENROLLED"
  | "AL4_GOV_VERIFIED";

export type ConfirmationRequestStatus =
  | "PENDING"
  | "SENT"
  | "VIEWED"
  | "IDENTITY_PENDING"
  | "IDENTITY_VERIFIED"
  | "IDENTITY_FAILED"
  | "CONFIRMED"
  | "CONTESTED"
  | "DELIVERY_FAILED"
  | "EXPIRED"
  | "REVOKED";

export type ConfirmationRequest = {
  id: string;
  companyId: string;
  deliveryId: string;
  status: ConfirmationRequestStatus;
  statusChangedAt: string;
  requiredAssuranceLevel: AssuranceLevel;
  achievedAssuranceLevel: AssuranceLevel | null;
  identityAttempts: number;
  identityMaxAttempts: number;
  viewedAt: string | null;
  confirmedAt: string | null;
  contestedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
  createdBy: string | null;
};

type ConfirmationRequestRow = {
  id: string;
  company_id: string;
  delivery_id: string;
  status: ConfirmationRequestStatus;
  status_changed_at: string;
  required_assurance_level: AssuranceLevel;
  achieved_assurance_level: AssuranceLevel | null;
  identity_attempts: number;
  identity_max_attempts: number;
  viewed_at: string | null;
  confirmed_at: string | null;
  contested_at: string | null;
  expires_at: string;
  revoked_at: string | null;
  consumed_at: string | null;
  created_at: string;
  created_by: string | null;
};

function mapConfirmationRequestRow(row: ConfirmationRequestRow): ConfirmationRequest {
  return {
    id: row.id,
    companyId: row.company_id,
    deliveryId: row.delivery_id,
    status: row.status,
    statusChangedAt: row.status_changed_at,
    requiredAssuranceLevel: row.required_assurance_level,
    achievedAssuranceLevel: row.achieved_assurance_level,
    identityAttempts: row.identity_attempts,
    identityMaxAttempts: row.identity_max_attempts,
    viewedAt: row.viewed_at,
    confirmedAt: row.confirmed_at,
    contestedAt: row.contested_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/** Every confirmation_request a delivery has ever had (a resend creates a new row),
 * newest first -- via api.confirmation_requests (RLS-scoped). */
export const getConfirmationRequests = cache(async (deliveryId: string): Promise<ConfirmationRequest[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("confirmation_requests")
    .select(
      "id, company_id, delivery_id, status, status_changed_at, required_assurance_level, achieved_assurance_level, identity_attempts, identity_max_attempts, viewed_at, confirmed_at, contested_at, expires_at, revoked_at, consumed_at, created_at, created_by",
    )
    .eq("delivery_id", deliveryId)
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  return (data as ConfirmationRequestRow[]).map(mapConfirmationRequestRow);
});

export type DeliveryContest = {
  id: string;
  companyId: string;
  deliveryId: string;
  confirmationRequestId: string;
  reasonCode: "NOT_RECEIVED" | "WRONG_ITEM" | "WRONG_QUANTITY" | "ALREADY_RETURNED" | "OTHER";
  comment: string | null;
  raisedAssuranceLevel: AssuranceLevel;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
};

type DeliveryContestRow = {
  id: string;
  company_id: string;
  delivery_id: string;
  confirmation_request_id: string;
  reason_code: DeliveryContest["reasonCode"];
  comment: string | null;
  raised_assurance_level: AssuranceLevel;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
};

function mapDeliveryContestRow(row: DeliveryContestRow): DeliveryContest {
  return {
    id: row.id,
    companyId: row.company_id,
    deliveryId: row.delivery_id,
    confirmationRequestId: row.confirmation_request_id,
    reasonCode: row.reason_code,
    comment: row.comment,
    raisedAssuranceLevel: row.raised_assurance_level,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
  };
}

/** Contest history for a delivery (there is at most one live contest per delivery in FASE 3,
 * since a delivery freezes on CONTESTED, but the type stays a list -- a future REISSUE/
 * correction flow can produce another). Via api.delivery_contests (RLS-scoped). */
export const getDeliveryContests = cache(async (deliveryId: string): Promise<DeliveryContest[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("delivery_contests")
    .select(
      "id, company_id, delivery_id, confirmation_request_id, reason_code, comment, raised_assurance_level, created_at, resolved_at, resolved_by, resolution_note",
    )
    .eq("delivery_id", deliveryId)
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  return (data as DeliveryContestRow[]).map(mapDeliveryContestRow);
});

export type EpiReturnReasonCode = "WORN_OUT" | "REPLACED" | "TERMINATION" | "OTHER";

/** One recorded devolução (return) of a single delivery line item -- manager-recorded
 * fact, no worker confirmation or sealed evidence (see the migration's own header comment,
 * 20260831200900_epi_returns.sql, for why this is intentionally lighter-weight than a
 * delivery confirmation). */
export type EpiReturn = {
  id: string;
  companyId: string;
  deliveryId: string;
  deliveryItemId: string;
  returnedOn: string;
  reasonCode: EpiReturnReasonCode;
  note: string | null;
  createdBy: string;
  createdAt: string;
};

type EpiReturnRow = {
  id: string;
  company_id: string;
  delivery_id: string;
  delivery_item_id: string;
  returned_on: string;
  reason_code: EpiReturnReasonCode;
  note: string | null;
  created_by: string;
  created_at: string;
};

const EPI_RETURN_COLUMNS =
  "id, company_id, delivery_id, delivery_item_id, returned_on, reason_code, note, created_by, created_at";

function mapEpiReturnRow(row: EpiReturnRow): EpiReturn {
  return {
    id: row.id,
    companyId: row.company_id,
    deliveryId: row.delivery_id,
    deliveryItemId: row.delivery_item_id,
    returnedOn: row.returned_on,
    reasonCode: row.reason_code,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Every return recorded against a known set of delivery items, in one round trip.
 * Callers already have the item ids on hand (a delivery's own items, or one employee's
 * items across every delivery on the ficha) -- mirrors getDeliveryItemsFor's own shape. */
export const getReturnsForItems = cache(async (itemIds: readonly string[]): Promise<EpiReturn[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated || itemIds.length === 0) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("epi_returns")
    .select(EPI_RETURN_COLUMNS)
    .in("delivery_item_id", itemIds as string[]);

  if (error || !data) return [];

  return (data as EpiReturnRow[]).map(mapEpiReturnRow);
});

export type AuditEvent = {
  id: string;
  seq: number;
  eventType: string;
  actorKind: "USER" | "WORKER" | "SYSTEM" | "PROVIDER" | "PLATFORM";
  actorUserId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
};

type AuditEventRow = {
  id: string;
  seq: number;
  event_type: string;
  actor_kind: AuditEvent["actorKind"];
  actor_user_id: string | null;
  data: Record<string, unknown>;
  created_at: string;
};

/** Full audit timeline for a delivery (its own events + every confirmation_request it has
 * had), oldest first, via the api.delivery_audit_events RPC (requires audit.read). */
export const getDeliveryAuditEvents = cache(async (deliveryId: string): Promise<AuditEvent[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase.schema("api").rpc("delivery_audit_events", { p_delivery_id: deliveryId });

  if (error || !data) return [];

  return (data as AuditEventRow[]).map((row) => ({
    id: row.id,
    seq: row.seq,
    eventType: row.event_type,
    actorKind: row.actor_kind,
    actorUserId: row.actor_user_id,
    data: row.data,
    createdAt: row.created_at,
  }));
});

export type EvidenceSummary = {
  evidenceVersionId: string;
  verificationCode: string;
  payloadSha256Hex: string;
  sealedAt: string;
  payload: Record<string, unknown>;
};

type EvidenceSummaryRow = {
  evidence_version_id: string;
  verification_code: string;
  payload_sha256_hex: string;
  sealed_at: string;
  payload: Record<string, unknown>;
};

/** The sealed evidence for a CONFIRMED delivery, or null if it was never confirmed (a
 * CONTESTED/CANCELLED/etc. delivery has no evidence.evidence_versions row -- only a
 * confirmation ever seals one). Via the api.get_evidence_summary RPC (requires
 * delivery.read on the delivery's company). */
export const getEvidenceSummary = cache(async (deliveryId: string): Promise<EvidenceSummary | null> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .rpc("get_evidence_summary", { p_delivery_id: deliveryId })
    .maybeSingle();

  if (error || !data) return null;

  const row = data as EvidenceSummaryRow;
  return {
    evidenceVersionId: row.evidence_version_id,
    verificationCode: row.verification_code,
    payloadSha256Hex: row.payload_sha256_hex,
    sealedAt: row.sealed_at,
    payload: row.payload,
  };
});

export type DeliveryBatch = {
  id: string;
  organizationId: string;
  companyId: string;
  deliveryDate: string;
  note: string | null;
  totalCount: number;
  confirmedCount: number;
  contestedCount: number;
  cancelledCount: number;
  createdBy: string;
  createdAt: string;
};

type DeliveryBatchRow = {
  id: string;
  organization_id: string;
  company_id: string;
  delivery_date: string;
  note: string | null;
  total_count: number;
  confirmed_count: number;
  contested_count: number;
  cancelled_count: number;
  created_by: string;
  created_at: string;
};

function mapDeliveryBatchRow(row: DeliveryBatchRow): DeliveryBatch {
  return {
    id: row.id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    deliveryDate: row.delivery_date,
    note: row.note,
    totalCount: row.total_count,
    confirmedCount: row.confirmed_count,
    contestedCount: row.contested_count,
    cancelledCount: row.cancelled_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Mass-delivery batches for one company, newest first, via api.delivery_batches (RLS-scoped). */
export const getDeliveryBatches = cache(async (companyId: string): Promise<DeliveryBatch[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("delivery_batches")
    .select(
      "id, organization_id, company_id, delivery_date, note, total_count, confirmed_count, contested_count, cancelled_count, created_by, created_at",
    )
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  return (data as DeliveryBatchRow[]).map(mapDeliveryBatchRow);
});

/** A single batch by id, or null if it doesn't exist or isn't visible (RLS). */
export const getDeliveryBatch = cache(async (batchId: string): Promise<DeliveryBatch | null> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("delivery_batches")
    .select(
      "id, organization_id, company_id, delivery_date, note, total_count, confirmed_count, contested_count, cancelled_count, created_by, created_at",
    )
    .eq("id", batchId)
    .maybeSingle();

  if (error || !data) return null;

  return mapDeliveryBatchRow(data as DeliveryBatchRow);
});

/** Deliveries belonging to one batch, via api.epi_deliveries (already RLS-scoped, FASE 2). */
export const getBatchDeliveries = cache(async (batchId: string): Promise<Delivery[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .from("epi_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("batch_id", batchId)
    .order("employee_full_name", { ascending: true });

  if (error || !data) return [];

  return (data as DeliveryRow[]).map(mapDeliveryRow);
});

export type DashboardSummary = {
  activeEmployeesCount: number;
  deliveriesInPeriod: number;
  confirmedCount: number;
  pendingCount: number;
  contestedCount: number;
  cancelledCount: number;
  pendingOver3DaysCount: number;
  pendingOver7DaysCount: number;
};

type DashboardSummaryRow = {
  active_employees_count: number;
  deliveries_in_period: number;
  confirmed_count: number;
  pending_count: number;
  contested_count: number;
  cancelled_count: number;
  pending_over_3_days_count: number;
  pending_over_7_days_count: number;
};

/** Operational counters for one company (docs/mvp-roadmap.md FASE 6) -- answers "is
 * anything stuck," not decorative charts. `sinceDays` bounds the period counts only; the two
 * "pending over N days" counts are never period-bound. */
export const getDashboardSummary = cache(
  async (companyId: string, sinceDays: number = 30): Promise<DashboardSummary | null> => {
    const session = await verifySession();
    if (!session.isAuthenticated) return null;

    const since = new Date();
    since.setDate(since.getDate() - sinceDays);
    const sinceIso = since.toISOString().slice(0, 10);

    const supabase = await createClient();
    const { data, error } = await supabase
      .schema("api")
      .rpc("dashboard_summary", { p_company_id: companyId, p_since: sinceIso })
      .maybeSingle();

    if (error || !data) return null;

    const row = data as DashboardSummaryRow;
    return {
      activeEmployeesCount: row.active_employees_count,
      deliveriesInPeriod: row.deliveries_in_period,
      confirmedCount: row.confirmed_count,
      pendingCount: row.pending_count,
      contestedCount: row.contested_count,
      cancelledCount: row.cancelled_count,
      pendingOver3DaysCount: row.pending_over_3_days_count,
      pendingOver7DaysCount: row.pending_over_7_days_count,
    };
  },
);

/** Company-wide "últimas atividades" feed, newest first, via the api.company_audit_events
 * RPC (requires audit.read). */
export const getCompanyAuditEvents = cache(async (companyId: string, limit: number = 50): Promise<AuditEvent[]> => {
  const session = await verifySession();
  if (!session.isAuthenticated) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("api")
    .rpc("company_audit_events", { p_company_id: companyId, p_limit: limit });

  if (error || !data) return [];

  return (data as AuditEventRow[]).map((row) => ({
    id: row.id,
    seq: row.seq,
    eventType: row.event_type,
    actorKind: row.actor_kind,
    actorUserId: row.actor_user_id,
    data: row.data,
    createdAt: row.created_at,
  }));
});
