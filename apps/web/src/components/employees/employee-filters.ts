import type { DeviceStatusBadge, InviteStatus } from "@workmode/shared/enums";
import { EMPLOYEE_SORT_FIELDS, type EmployeeSortField } from "@workmode/validation/employees";
import { isResourceId } from "@/config/navigation";

/**
 * Employees list filters ⇄ URL search params ⇄ `GET /api/employees` query. Pure so the mapping is unit
 * tested: `/employees?filter=needsAttention` (linked from Overview) must land on the same rows the badge
 * counts.
 */

export const EMPLOYEE_QUICK_FILTERS = [
  "connected",
  "awaitingSetup",
  "permissionsMissing",
  "working",
  "onBreak",
  "needsAttention",
] as const;
export type EmployeeQuickFilter = (typeof EMPLOYEE_QUICK_FILTERS)[number];

export interface QuickFilterMeta {
  readonly label: string;
  readonly description: string;
  /** `inviteStatus` values sent to the API (lifecycle filter). */
  readonly inviteStatus?: readonly InviteStatus[];
  /** `deviceStatus` values sent to the API (derived badge filter, §9). */
  readonly deviceStatus?: readonly DeviceStatusBadge[];
}

export const QUICK_FILTER_META: Record<EmployeeQuickFilter, QuickFilterMeta> = {
  connected: {
    label: "Connected",
    description: "Setup complete: Work Mode runs during their shifts.",
    inviteStatus: ["CONNECTED"],
  },
  awaitingSetup: {
    label: "Awaiting setup",
    description:
      "Not connected yet: not invited, invited, or joined without finishing Screen Time setup (what Overview counts).",
    inviteStatus: ["NOT_INVITED", "INVITED", "JOINED", "SETUP_INCOMPLETE"],
  },
  permissionsMissing: {
    label: "Permissions missing",
    description: "Screen Time authorisation isn't approved or no apps are selected.",
    deviceStatus: ["PERMISSIONS_MISSING"],
  },
  working: {
    label: "Working",
    description: "On shift right now.",
    deviceStatus: ["WORKING", "WORK_MODE_ACTIVE"],
  },
  onBreak: {
    label: "On break",
    description: "On a break the device has confirmed.",
    deviceStatus: ["ON_BREAK"],
  },
  needsAttention: {
    label: "Needs attention",
    description:
      "Something is wrong: permissions, sync, an error or a state that disagrees with the schedule.",
    deviceStatus: ["NEEDS_ATTENTION", "PERMISSIONS_MISSING", "SYNC_DELAYED", "OFFLINE"],
  },
};

export function isQuickFilter(value: unknown): value is EmployeeQuickFilter {
  return typeof value === "string" && (EMPLOYEE_QUICK_FILTERS as readonly string[]).includes(value);
}

export type EmployeeSortKey = EmployeeSortField | `-${EmployeeSortField}`;

export function isEmployeeSortKey(value: unknown): value is EmployeeSortKey {
  if (typeof value !== "string") return false;
  const field = value.startsWith("-") ? value.slice(1) : value;
  return (EMPLOYEE_SORT_FIELDS as readonly string[]).includes(field);
}

export const EMPLOYEE_PAGE_SIZES = [10, 25, 50, 100] as const;

export interface EmployeeListParams {
  readonly filter: EmployeeQuickFilter | null;
  readonly search: string;
  readonly page: number;
  readonly pageSize: number;
  readonly locationId: string | null;
  readonly departmentId: string | null;
  readonly teamId: string | null;
  readonly policyId: string | null;
  readonly sort: EmployeeSortKey;
}

export const DEFAULT_EMPLOYEE_LIST_PARAMS: EmployeeListParams = {
  filter: null,
  search: "",
  page: 1,
  pageSize: 25,
  locationId: null,
  departmentId: null,
  teamId: null,
  policyId: null,
  sort: "lastName",
};

/** URL parameter names (kept short and stable: they appear in links from other pages). */
export const EMPLOYEE_URL_PARAMS = {
  filter: "filter",
  search: "q",
  page: "page",
  pageSize: "pageSize",
  locationId: "locationId",
  departmentId: "departmentId",
  teamId: "teamId",
  policyId: "policyId",
  sort: "sort",
} as const;

type SearchParamsLike =
  URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

function readParam(params: SearchParamsLike, name: string): string | null {
  if (params instanceof URLSearchParams) return params.get(name);
  const value = params[name];
  if (Array.isArray(value)) return (value[0] as string | undefined) ?? null;
  return typeof value === "string" ? value : null;
}

function readPositiveInt(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function readId(value: string | null): string | null {
  return isResourceId(value) ? value : null;
}

/** Parses the URL into list params; anything invalid falls back to the default rather than erroring. */
export function parseEmployeeListParams(params: SearchParamsLike): EmployeeListParams {
  const filter = readParam(params, EMPLOYEE_URL_PARAMS.filter);
  const sort = readParam(params, EMPLOYEE_URL_PARAMS.sort);
  const pageSizeRaw = readPositiveInt(
    readParam(params, EMPLOYEE_URL_PARAMS.pageSize),
    DEFAULT_EMPLOYEE_LIST_PARAMS.pageSize,
    200,
  );
  const pageSize = (EMPLOYEE_PAGE_SIZES as readonly number[]).includes(pageSizeRaw)
    ? pageSizeRaw
    : DEFAULT_EMPLOYEE_LIST_PARAMS.pageSize;
  return {
    filter: isQuickFilter(filter) ? filter : null,
    search: (readParam(params, EMPLOYEE_URL_PARAMS.search) ?? "").trim().slice(0, 100),
    page: readPositiveInt(readParam(params, EMPLOYEE_URL_PARAMS.page), 1, 100_000),
    pageSize,
    locationId: readId(readParam(params, EMPLOYEE_URL_PARAMS.locationId)),
    departmentId: readId(readParam(params, EMPLOYEE_URL_PARAMS.departmentId)),
    teamId: readId(readParam(params, EMPLOYEE_URL_PARAMS.teamId)),
    policyId: readId(readParam(params, EMPLOYEE_URL_PARAMS.policyId)),
    sort: isEmployeeSortKey(sort) ? sort : DEFAULT_EMPLOYEE_LIST_PARAMS.sort,
  };
}

/** Query string (without `?`) for the params; defaults are omitted so plain `/employees` stays clean. */
export function serializeEmployeeListParams(params: EmployeeListParams): string {
  const out = new URLSearchParams();
  if (params.filter) out.set(EMPLOYEE_URL_PARAMS.filter, params.filter);
  if (params.search.trim()) out.set(EMPLOYEE_URL_PARAMS.search, params.search.trim());
  if (params.page > 1) out.set(EMPLOYEE_URL_PARAMS.page, String(params.page));
  if (params.pageSize !== DEFAULT_EMPLOYEE_LIST_PARAMS.pageSize)
    out.set(EMPLOYEE_URL_PARAMS.pageSize, String(params.pageSize));
  if (params.locationId) out.set(EMPLOYEE_URL_PARAMS.locationId, params.locationId);
  if (params.departmentId) out.set(EMPLOYEE_URL_PARAMS.departmentId, params.departmentId);
  if (params.teamId) out.set(EMPLOYEE_URL_PARAMS.teamId, params.teamId);
  if (params.policyId) out.set(EMPLOYEE_URL_PARAMS.policyId, params.policyId);
  if (params.sort !== DEFAULT_EMPLOYEE_LIST_PARAMS.sort)
    out.set(EMPLOYEE_URL_PARAMS.sort, params.sort);
  return out.toString();
}

/** True when anything other than paging/sorting narrows the list (drives the "no results" vs "no employees" state). */
export function hasActiveEmployeeFilters(params: EmployeeListParams): boolean {
  return (
    params.filter !== null ||
    params.search.trim() !== "" ||
    params.locationId !== null ||
    params.departmentId !== null ||
    params.teamId !== null ||
    params.policyId !== null
  );
}

/** Query object for `GET /api/employees` (arrays repeat the key, which `queryListSchema` accepts). */
export interface EmployeeApiQuery {
  page: number;
  pageSize: number;
  search?: string;
  inviteStatus?: readonly InviteStatus[];
  deviceStatus?: readonly DeviceStatusBadge[];
  locationId?: string;
  departmentId?: string;
  teamId?: string;
  policyId?: string;
  sort: EmployeeSortKey;
}

export function toEmployeeApiQuery(params: EmployeeListParams): EmployeeApiQuery {
  const query: EmployeeApiQuery = {
    page: params.page,
    pageSize: params.pageSize,
    sort: params.sort,
  };
  const search = params.search.trim();
  if (search) query.search = search;
  if (params.filter) {
    const meta = QUICK_FILTER_META[params.filter];
    if (meta.inviteStatus) query.inviteStatus = meta.inviteStatus;
    if (meta.deviceStatus) query.deviceStatus = meta.deviceStatus;
  }
  if (params.locationId) query.locationId = params.locationId;
  if (params.departmentId) query.departmentId = params.departmentId;
  if (params.teamId) query.teamId = params.teamId;
  if (params.policyId) query.policyId = params.policyId;
  return query;
}

/** Table column id ⇄ API sort field. Only these columns are sortable server-side. */
export const SORTABLE_COLUMNS: Readonly<Record<string, EmployeeSortField>> = {
  name: "lastName",
  inviteStatus: "inviteStatus",
  lastSyncAt: "lastSyncAt",
};

export function sortKeyToColumnSorting(sort: EmployeeSortKey): { id: string; desc: boolean }[] {
  const desc = sort.startsWith("-");
  const field = (desc ? sort.slice(1) : sort) as EmployeeSortField;
  const column = Object.entries(SORTABLE_COLUMNS).find(([, f]) => f === field)?.[0];
  return column ? [{ id: column, desc }] : [];
}

export function columnSortingToSortKey(
  sorting: readonly { id: string; desc: boolean }[],
): EmployeeSortKey {
  const first = sorting[0];
  if (!first) return DEFAULT_EMPLOYEE_LIST_PARAMS.sort;
  const field = SORTABLE_COLUMNS[first.id];
  if (!field) return DEFAULT_EMPLOYEE_LIST_PARAMS.sort;
  return first.desc ? `-${field}` : field;
}
