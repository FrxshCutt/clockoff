import type { ActivityEventType } from "@clockoff/shared/enums";
import { COMPLIANCE_FILTERS, type ComplianceFilter } from "@clockoff/validation/compliance";
import { DateTime } from "luxon";
import type { ComplianceListParams } from "@/components/overview/compliance-keys";
import { ROUTES, isResourceId } from "@/config/navigation";
import { toDate, type DateInput } from "@/lib/format";
import { isActivityEventType } from "./activity-meta";

/**
 * `/activity` page state ⇄ URL search params ⇄ API queries. Pure so the mapping is unit tested: a link from
 * the overview (`/activity?tab=compliance&filter=NEEDS_ATTENTION`) must land on the same rows the metric
 * counted, and reloading the page must restore every filter.
 */

export const ACTIVITY_TABS = ["activity", "compliance"] as const;
export type ActivityTab = (typeof ACTIVITY_TABS)[number];

export const DATE_RANGE_PRESETS = ["24h", "7d", "30d", "all", "custom"] as const;
export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export const DATE_RANGE_PRESET_LABELS: Record<DateRangePreset, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
  custom: "Custom range",
};

const PRESET_HOURS: Partial<Record<DateRangePreset, number>> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

export interface ActivityFeedParams {
  readonly employeeId: string | null;
  readonly types: readonly ActivityEventType[];
  readonly range: DateRangePreset;
  /** `YYYY-MM-DD` in the organisation's zone; only used with `range: "custom"`. */
  readonly from: string | null;
  readonly to: string | null;
  readonly locationId: string | null;
}

export interface ActivityPageState {
  readonly tab: ActivityTab;
  readonly feed: ActivityFeedParams;
  readonly compliance: ComplianceListParams;
}

export const COMPLIANCE_PAGE_SIZES = [10, 25, 50, 100] as const;

export const DEFAULT_FEED_PARAMS: ActivityFeedParams = {
  employeeId: null,
  types: [],
  range: "7d",
  from: null,
  to: null,
  locationId: null,
};

export const DEFAULT_COMPLIANCE_PARAMS: ComplianceListParams = {
  filter: "ALL",
  search: "",
  page: 1,
  pageSize: 25,
  locationId: null,
  teamId: null,
};

export const DEFAULT_ACTIVITY_PAGE_STATE: ActivityPageState = {
  tab: "activity",
  feed: DEFAULT_FEED_PARAMS,
  compliance: DEFAULT_COMPLIANCE_PARAMS,
};

/** URL parameter names (short and stable: other pages link here). */
export const ACTIVITY_URL_PARAMS = {
  tab: "tab",
  employeeId: "employee",
  types: "type",
  range: "range",
  from: "from",
  to: "to",
  locationId: "location",
  filter: "filter",
  search: "q",
  page: "page",
  pageSize: "pageSize",
  teamId: "team",
} as const;

export type SearchParamsLike =
  URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

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

function readId(value: string | null): string | null {
  return isResourceId(value) ? value : null;
}

function readPositiveInt(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: unknown): value is string {
  return typeof value === "string" && LOCAL_DATE.test(value) && DateTime.fromISO(value).isValid;
}

export function isActivityTab(value: unknown): value is ActivityTab {
  return typeof value === "string" && (ACTIVITY_TABS as readonly string[]).includes(value);
}

export function isDateRangePreset(value: unknown): value is DateRangePreset {
  return typeof value === "string" && (DATE_RANGE_PRESETS as readonly string[]).includes(value);
}

export function isComplianceFilter(value: unknown): value is ComplianceFilter {
  return typeof value === "string" && (COMPLIANCE_FILTERS as readonly string[]).includes(value);
}

/** `?type=A,B&type=C` → unique known types in the order given. */
export function parseTypeList(values: readonly string[]): ActivityEventType[] {
  const out: ActivityEventType[] = [];
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const value = part.trim();
      if (isActivityEventType(value) && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

/** Parses the URL; anything invalid falls back to its default rather than erroring. */
export function parseActivityPageState(params: SearchParamsLike): ActivityPageState {
  const tab = readParam(params, ACTIVITY_URL_PARAMS.tab);
  const range = readParam(params, ACTIVITY_URL_PARAMS.range);
  const from = readParam(params, ACTIVITY_URL_PARAMS.from);
  const to = readParam(params, ACTIVITY_URL_PARAMS.to);
  const filter = readParam(params, ACTIVITY_URL_PARAMS.filter);
  const pageSizeRaw = readPositiveInt(
    readParam(params, ACTIVITY_URL_PARAMS.pageSize),
    DEFAULT_COMPLIANCE_PARAMS.pageSize,
    200,
  );
  const pageSize = (COMPLIANCE_PAGE_SIZES as readonly number[]).includes(pageSizeRaw)
    ? pageSizeRaw
    : DEFAULT_COMPLIANCE_PARAMS.pageSize;
  const resolvedRange: DateRangePreset = isDateRangePreset(range)
    ? range
    : DEFAULT_FEED_PARAMS.range;
  const customFrom = resolvedRange === "custom" && isLocalDate(from) ? from : null;
  const customTo = resolvedRange === "custom" && isLocalDate(to) ? to : null;
  return {
    tab: isActivityTab(tab) ? tab : DEFAULT_ACTIVITY_PAGE_STATE.tab,
    feed: {
      employeeId: readId(readParam(params, ACTIVITY_URL_PARAMS.employeeId)),
      types: parseTypeList(readAll(params, ACTIVITY_URL_PARAMS.types)),
      range: resolvedRange,
      from: customFrom,
      to: customTo,
      locationId: readId(readParam(params, ACTIVITY_URL_PARAMS.locationId)),
    },
    compliance: {
      filter: isComplianceFilter(filter) ? filter : DEFAULT_COMPLIANCE_PARAMS.filter,
      search: (readParam(params, ACTIVITY_URL_PARAMS.search) ?? "").trim().slice(0, 100),
      page: readPositiveInt(readParam(params, ACTIVITY_URL_PARAMS.page), 1, 100_000),
      pageSize,
      locationId: readId(readParam(params, ACTIVITY_URL_PARAMS.locationId)),
      teamId: readId(readParam(params, ACTIVITY_URL_PARAMS.teamId)),
    },
  };
}

/** Query string (without `?`); defaults are omitted so plain `/activity` stays clean. */
export function serializeActivityPageState(state: ActivityPageState): string {
  const out = new URLSearchParams();
  if (state.tab !== DEFAULT_ACTIVITY_PAGE_STATE.tab) out.set(ACTIVITY_URL_PARAMS.tab, state.tab);
  if (state.tab === "activity") {
    const feed = state.feed;
    if (feed.employeeId) out.set(ACTIVITY_URL_PARAMS.employeeId, feed.employeeId);
    if (feed.types.length > 0) out.set(ACTIVITY_URL_PARAMS.types, feed.types.join(","));
    if (feed.range !== DEFAULT_FEED_PARAMS.range) out.set(ACTIVITY_URL_PARAMS.range, feed.range);
    if (feed.range === "custom") {
      if (feed.from) out.set(ACTIVITY_URL_PARAMS.from, feed.from);
      if (feed.to) out.set(ACTIVITY_URL_PARAMS.to, feed.to);
    }
    if (feed.locationId) out.set(ACTIVITY_URL_PARAMS.locationId, feed.locationId);
  } else {
    const list = state.compliance;
    if (list.filter !== DEFAULT_COMPLIANCE_PARAMS.filter)
      out.set(ACTIVITY_URL_PARAMS.filter, list.filter);
    if (list.search.trim()) out.set(ACTIVITY_URL_PARAMS.search, list.search.trim());
    if (list.page > 1) out.set(ACTIVITY_URL_PARAMS.page, String(list.page));
    if (list.pageSize !== DEFAULT_COMPLIANCE_PARAMS.pageSize)
      out.set(ACTIVITY_URL_PARAMS.pageSize, String(list.pageSize));
    if (list.locationId) out.set(ACTIVITY_URL_PARAMS.locationId, list.locationId);
    if (list.teamId) out.set(ACTIVITY_URL_PARAMS.teamId, list.teamId);
  }
  return out.toString();
}

/** `/activity?tab=compliance&filter=NEEDS_ATTENTION` (the filter is omitted for ALL). */
export function complianceListHref(filter: ComplianceFilter = "ALL"): string {
  const qs = serializeActivityPageState({
    ...DEFAULT_ACTIVITY_PAGE_STATE,
    tab: "compliance",
    compliance: { ...DEFAULT_COMPLIANCE_PARAMS, filter },
  });
  return `${ROUTES.activity}?${qs}`;
}

/** `/activity?employee=<id>` — the organisation feed narrowed to one employee. */
export function employeeActivityHref(employeeId: string): string {
  const qs = serializeActivityPageState({
    ...DEFAULT_ACTIVITY_PAGE_STATE,
    feed: { ...DEFAULT_FEED_PARAMS, employeeId, range: "all" },
  });
  return `${ROUTES.activity}?${qs}`;
}

export interface ResolvedDateRange {
  readonly from?: string;
  readonly to?: string;
}

/**
 * Instants for the feed query. Presets are rolling windows ending now; a custom range covers whole local
 * days in the organisation's zone (`from` 00:00 → `to` 23:59:59.999). Invalid custom bounds are dropped.
 */
export function resolveDateRange(
  feed: Pick<ActivityFeedParams, "range" | "from" | "to">,
  now: DateInput,
  timeZone: string,
): ResolvedDateRange {
  const reference = toDate(now) ?? new Date();
  if (feed.range === "all") return {};
  if (feed.range === "custom") {
    const out: { from?: string; to?: string } = {};
    const zone = DateTime.local().setZone(timeZone).isValid ? timeZone : "UTC";
    if (feed.from && isLocalDate(feed.from)) {
      const start = DateTime.fromISO(feed.from, { zone }).startOf("day");
      if (start.isValid) out.from = start.toUTC().toISO() ?? undefined;
    }
    if (feed.to && isLocalDate(feed.to)) {
      const end = DateTime.fromISO(feed.to, { zone }).endOf("day");
      if (end.isValid) out.to = end.toUTC().toISO() ?? undefined;
    }
    if (out.from && out.to && Date.parse(out.to) <= Date.parse(out.from)) delete out.to;
    return out;
  }
  const hours = PRESET_HOURS[feed.range] ?? 24;
  return { from: new Date(reference.getTime() - hours * 3_600_000).toISOString() };
}

export interface ActivityApiQuery {
  employeeId?: string;
  type?: readonly ActivityEventType[];
  from?: string;
  to?: string;
  locationId?: string;
  limit: number;
}

export function toActivityApiQuery(
  feed: ActivityFeedParams,
  now: DateInput,
  timeZone: string,
  limit = 25,
): ActivityApiQuery {
  const query: ActivityApiQuery = { limit };
  if (feed.employeeId) query.employeeId = feed.employeeId;
  if (feed.types.length > 0) query.type = feed.types;
  const range = resolveDateRange(feed, now, timeZone);
  if (range.from) query.from = range.from;
  if (range.to) query.to = range.to;
  if (feed.locationId) query.locationId = feed.locationId;
  return query;
}

export interface ComplianceApiQuery {
  filter: ComplianceFilter;
  page: number;
  pageSize: number;
  search?: string;
  locationId?: string;
  teamId?: string;
}

export function toComplianceApiQuery(params: ComplianceListParams): ComplianceApiQuery {
  const query: ComplianceApiQuery = {
    filter: params.filter,
    page: params.page,
    pageSize: params.pageSize,
  };
  const search = params.search.trim();
  if (search) query.search = search;
  if (params.locationId) query.locationId = params.locationId;
  if (params.teamId) query.teamId = params.teamId;
  return query;
}

/** True when anything other than the default rolling window narrows the feed. */
export function hasActiveFeedFilters(feed: ActivityFeedParams): boolean {
  return (
    feed.employeeId !== null ||
    feed.types.length > 0 ||
    feed.range !== DEFAULT_FEED_PARAMS.range ||
    feed.locationId !== null
  );
}

export function hasActiveComplianceFilters(params: ComplianceListParams): boolean {
  return (
    params.filter !== "ALL" ||
    params.search.trim() !== "" ||
    params.locationId !== null ||
    params.teamId !== null
  );
}
