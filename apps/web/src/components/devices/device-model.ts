import { PERMISSION_STATES, type PermissionState } from "@workmode/shared/enums";
import type { DeviceSummary, SelectionCounts } from "@workmode/validation/devices";
import type { EmployeeSummary } from "@workmode/validation/refs";
import { isResourceId } from "@/config/navigation";
import { formatCount } from "@/lib/format";

/**
 * Pure view-model helpers for the devices pages (unit tested in node). Only the §12 operational fields of
 * `DeviceSummary` are ever described here — no identifiers, app lists or content exist to describe.
 */

export const DEVICE_ACTIVE_FILTERS = ["active", "inactive", "all"] as const;
export type DeviceActiveFilter = (typeof DEVICE_ACTIVE_FILTERS)[number];

export const DEVICE_ACTIVE_FILTER_LABELS: Record<DeviceActiveFilter, string> = {
  active: "Active devices",
  inactive: "Deactivated devices",
  all: "All devices",
};

export const DEVICE_PAGE_SIZES = [10, 25, 50, 100] as const;

export interface DeviceListParams {
  readonly active: DeviceActiveFilter;
  readonly permission: readonly PermissionState[];
  readonly employeeId: string | null;
  readonly locationId: string | null;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_DEVICE_LIST_PARAMS: DeviceListParams = {
  active: "active",
  permission: [],
  employeeId: null,
  locationId: null,
  page: 1,
  pageSize: 25,
};

export const DEVICE_URL_PARAMS = {
  active: "active",
  permission: "permission",
  employeeId: "employee",
  locationId: "location",
  page: "page",
  pageSize: "pageSize",
} as const;

type SearchParamsLike = URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

function readParam(params: SearchParamsLike, name: string): string | null {
  if (params instanceof URLSearchParams) return params.get(name);
  const value = params[name];
  if (Array.isArray(value)) return (value[0] as string | undefined) ?? null;
  return typeof value === "string" ? value : null;
}

function readAll(params: SearchParamsLike, name: string): string[] {
  if (params instanceof URLSearchParams) return params.getAll(name);
  const value = params[name];
  if (Array.isArray(value)) return [...(value as readonly string[])];
  return typeof value === "string" ? [value] : [];
}

function readPositiveInt(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function isDeviceActiveFilter(value: unknown): value is DeviceActiveFilter {
  return typeof value === "string" && (DEVICE_ACTIVE_FILTERS as readonly string[]).includes(value);
}

export function isPermissionState(value: unknown): value is PermissionState {
  return typeof value === "string" && (PERMISSION_STATES as readonly string[]).includes(value);
}

export function parsePermissionList(values: readonly string[]): PermissionState[] {
  const out: PermissionState[] = [];
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const value = part.trim();
      if (isPermissionState(value) && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

export function parseDeviceListParams(params: SearchParamsLike): DeviceListParams {
  const active = readParam(params, DEVICE_URL_PARAMS.active);
  const pageSizeRaw = readPositiveInt(readParam(params, DEVICE_URL_PARAMS.pageSize), DEFAULT_DEVICE_LIST_PARAMS.pageSize, 200);
  const employeeId = readParam(params, DEVICE_URL_PARAMS.employeeId);
  const locationId = readParam(params, DEVICE_URL_PARAMS.locationId);
  return {
    active: isDeviceActiveFilter(active) ? active : DEFAULT_DEVICE_LIST_PARAMS.active,
    permission: parsePermissionList(readAll(params, DEVICE_URL_PARAMS.permission)),
    employeeId: isResourceId(employeeId) ? employeeId : null,
    locationId: isResourceId(locationId) ? locationId : null,
    page: readPositiveInt(readParam(params, DEVICE_URL_PARAMS.page), 1, 100_000),
    pageSize: (DEVICE_PAGE_SIZES as readonly number[]).includes(pageSizeRaw) ? pageSizeRaw : DEFAULT_DEVICE_LIST_PARAMS.pageSize,
  };
}

export function serializeDeviceListParams(params: DeviceListParams): string {
  const out = new URLSearchParams();
  if (params.active !== DEFAULT_DEVICE_LIST_PARAMS.active) out.set(DEVICE_URL_PARAMS.active, params.active);
  if (params.permission.length > 0) out.set(DEVICE_URL_PARAMS.permission, params.permission.join(","));
  if (params.employeeId) out.set(DEVICE_URL_PARAMS.employeeId, params.employeeId);
  if (params.locationId) out.set(DEVICE_URL_PARAMS.locationId, params.locationId);
  if (params.page > 1) out.set(DEVICE_URL_PARAMS.page, String(params.page));
  if (params.pageSize !== DEFAULT_DEVICE_LIST_PARAMS.pageSize) out.set(DEVICE_URL_PARAMS.pageSize, String(params.pageSize));
  return out.toString();
}

export interface DeviceApiQuery {
  page: number;
  pageSize: number;
  isActive?: boolean;
  permissionState?: readonly PermissionState[];
  employeeId?: string;
  locationId?: string;
}

/** Query object for `GET /api/devices` (arrays repeat the key, which `queryListSchema` accepts). */
export function toDeviceApiQuery(params: DeviceListParams): DeviceApiQuery {
  const query: DeviceApiQuery = { page: params.page, pageSize: params.pageSize };
  if (params.active !== "all") query.isActive = params.active === "active";
  if (params.permission.length > 0) query.permissionState = params.permission;
  if (params.employeeId) query.employeeId = params.employeeId;
  if (params.locationId) query.locationId = params.locationId;
  return query;
}

export function hasActiveDeviceFilters(params: DeviceListParams): boolean {
  return (
    params.active !== DEFAULT_DEVICE_LIST_PARAMS.active ||
    params.permission.length > 0 ||
    params.employeeId !== null ||
    params.locationId !== null
  );
}

// ── Descriptions ────────────────────────────────────────────────────────────

/** "3 categories · 12 apps · 2 websites" (zero groups omitted); "Nothing selected" when all are zero. */
export function describeSelectionCounts(counts: SelectionCounts): string {
  const parts: string[] = [];
  if (counts.categories > 0) parts.push(formatCount(counts.categories, "category", "categories"));
  if (counts.applications > 0) parts.push(formatCount(counts.applications, "app"));
  if (counts.webDomains > 0) parts.push(formatCount(counts.webDomains, "website"));
  return parts.length > 0 ? parts.join(" · ") : "Nothing selected";
}

/** "iOS 18.1" / "—". */
export function describeOs(device: Pick<DeviceSummary, "platform" | "osVersion">): string {
  if (!device.osVersion) return "—";
  return device.platform === "IOS" ? `iOS ${device.osVersion}` : device.osVersion;
}

/** "Work Mode 1.4.2" / "—". */
export function describeAppVersion(device: Pick<DeviceSummary, "appVersion">): string {
  return device.appVersion ? `v${device.appVersion}` : "—";
}

/** "Jane Smith's iPhone 15" — the page title for a device. */
export function deviceDisplayName(
  device: Pick<DeviceSummary, "deviceModel">,
  employee: Pick<EmployeeSummary, "firstName" | "lastName">,
): string {
  const name = `${employee.firstName} ${employee.lastName}`.trim();
  const model = device.deviceModel?.trim() || "iPhone";
  if (!name) return model;
  return `${name.endsWith("s") ? `${name}'` : `${name}'s`} ${model}`;
}

/** "In sync" within a minute, else "3 min ahead" / "7 min behind"; null when never reported. */
export function describeClockSkew(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  if (Math.abs(seconds) < 60) return "In sync";
  const minutes = Math.round(Math.abs(seconds) / 60);
  return `${minutes} min ${seconds > 0 ? "ahead" : "behind"}`;
}

/** Policy version label from the summary's version number / id. */
export function describePolicyVersion(device: Pick<DeviceSummary, "policyVersionId" | "policyVersionNumber">): string {
  if (device.policyVersionNumber !== null) return `Version ${device.policyVersionNumber}`;
  return device.policyVersionId ? "Synced" : "Not synced yet";
}
