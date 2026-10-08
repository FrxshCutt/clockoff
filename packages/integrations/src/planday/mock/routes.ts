/**
 * Mock Planday's REST API (`https://openapi.planday.com`): exactly the GET endpoints ClockOff calls (notes §9,
 * plan §12.2), with the documented paths, scopes, query parameters, `limit` ranges and response shapes. Paths
 * are matched case-sensitively, so the getting-started `/hr/v1/Departments` spelling is an unknown path.
 */
import { addLocalDays } from "@clockoff/shared/time/zone";
import { isValidLocalDate } from "@clockoff/shared/time/parse";
import {
  encodeDateTime,
  localDateOfMs,
  localToMs,
  parseQueryDateTime,
  usableZone,
} from "./datetime";
import type {
  MockDeletedShiftFixture,
  MockEmployeeFixture,
  MockPunchClockBreakFixture,
  MockPunchClockFixture,
  MockShiftFixture,
} from "./fixture";
import type {
  PlandayJsonDeactivatedEmployee,
  PlandayJsonEmployee,
  PlandayJsonEmployeeDetails,
  PlandayJsonPagedResponse,
  PlandayJsonPunchClockBreak,
  PlandayJsonPunchClockShift,
  PlandayJsonScheduleDay,
  PlandayJsonShift,
  PlandayJsonDeletedShift,
} from "./raw";
import { jsonResponse, problemResponse } from "./respond";
import type { MockPlandayState, MockPortalState } from "./state";

export interface ApiRequestContext {
  readonly state: MockPlandayState;
  readonly portal: MockPortalState;
  readonly query: URLSearchParams;
  /** Path parameters by template name (`employeeId`, `shiftId`, `punchClockShiftId`). */
  readonly params: Readonly<Record<string, string>>;
}

interface PagingRule {
  /** Limit when the request has none (Punch Clock's documented default is 0, notes §7). */
  readonly defaultLimit: number;
  /** Smallest accepted limit. */
  readonly minLimit: number;
  readonly maxLimit: number;
  /** `reject`: 400 outside the spec's declared range; `clamp`: the server lowers the limit (notes §7). */
  readonly overMax: "reject" | "clamp";
}

export interface ApiRoute {
  /** Path template as the notes write it (`/hr/v1.0/employees/{employeeId}`). */
  readonly template: string;
  readonly pattern: RegExp;
  readonly paramNames: readonly string[];
  /** Scope the app needs (notes §5.2); null for `GET /portal/v1.0/info`, whose scope is undocumented. */
  readonly scope: string | null;
  /** Documented query parameters ClockOff may send. */
  readonly params: readonly string[];
  /** Documented query parameters ClockOff never sends (plan §4.2, §16.1 Q31): recorded as unexpected. */
  readonly forbidden: readonly string[];
  readonly paging: PagingRule | null;
  handle(ctx: ApiRequestContext): Response;
}

/** HR lists: default and documented maximum 50 (notes §7); the spec declares no range, so more is lowered. */
const HR_PAGING: PagingRule = { defaultLimit: 50, minLimit: 1, maxLimit: 50, overMax: "clamp" };
/** Declared `minimum` / `maximum` in the Scheduling spec: a value outside answers 400. */
const SHIFTS_PAGING: PagingRule = {
  defaultLimit: 50,
  minLimit: 1,
  maxLimit: 5000,
  overMax: "reject",
};
const DELETED_SHIFTS_PAGING: PagingRule = {
  defaultLimit: 50,
  minLimit: 1,
  maxLimit: 1000,
  overMax: "reject",
};
const SCHEDULE_DAY_PAGING: PagingRule = {
  defaultLimit: 50,
  minLimit: 1,
  maxLimit: 50,
  overMax: "reject",
};
/** Punch Clock: default 0 and no documented maximum (notes §7); the mock lowers anything above 50. */
const PUNCH_CLOCK_PAGING: PagingRule = {
  defaultLimit: 0,
  minLimit: 0,
  maxLimit: 50,
  overMax: "clamp",
};
const CREATED_MODIFIED = ["createdFrom", "createdTo", "modifiedFrom", "modifiedTo"] as const;
const SHIFT_ARRAY_FILTERS = [
  "departmentId",
  "employeeGroupId",
  "shiftTypeId",
  "positionId",
  "employeeId",
  "shiftStatus",
] as const;

// ---------------------------------------------------------------------------------------------------------
// Rendering (stored records → raw Planday JSON)
// ---------------------------------------------------------------------------------------------------------

function renderEmployee(e: MockEmployeeFixture): PlandayJsonEmployee {
  return structuredClone(e.raw);
}

function renderDeactivatedEmployee(e: MockEmployeeFixture): PlandayJsonDeactivatedEmployee {
  const {
    securityGroups: _s,
    supervisorId: _v,
    primaryDepartmentId: _p,
    ...rest
  } = structuredClone(e.raw);
  return rest;
}

function renderEmployeeDetails(e: MockEmployeeFixture): PlandayJsonEmployeeDetails {
  const {
    hiredDate: _h,
    dateTimeDeleted: _d,
    cellPhoneWithoutCountryPrefix: _c,
    phoneWithoutCountryPrefix: _p,
    ...core
  } = structuredClone(e.raw);
  const { customFields, ...extra } = structuredClone(e.details);
  return {
    ...core,
    ...extra,
    isDeactivated: e.status === "DEACTIVATED",
    ...(customFields as Record<`custom_${number}`, PlandayJsonEmployeeDetails[`custom_${number}`]>),
  };
}

function encodeShiftTimes(
  shift: MockShiftFixture,
  ctx: ApiRequestContext,
): { startDateTime: string; endDateTime: string } {
  const fallback = ctx.portal.info.timeZone;
  const format = ctx.state.settings.dateTimeFormat;
  return {
    startDateTime: encodeDateTime(shift.start, shift.timeZone, fallback, format),
    endDateTime: encodeDateTime(shift.end, shift.timeZone, fallback, format),
  };
}

export function renderShift(shift: MockShiftFixture, ctx: ApiRequestContext): PlandayJsonShift {
  const times = encodeShiftTimes(shift, ctx);
  return {
    id: shift.id,
    departmentId: shift.departmentId,
    employeeId: shift.employeeId,
    employeeGroupId: shift.employeeGroupId,
    positionId: shift.positionId,
    shiftTypeId: shift.shiftTypeId,
    date: shift.start.slice(0, 10),
    comment: shift.comment,
    timeZone: shift.timeZone,
    punchClockShiftId: shift.punchClockShiftId,
    startDateTime: times.startDateTime,
    endDateTime: times.endDateTime,
    status: shift.status,
    dateTimeCreated: shift.dateTimeCreated,
    dateTimeModified: shift.dateTimeModified,
    skillIds: [...shift.skillIds],
  };
}

function renderDeletedShift(
  shift: MockDeletedShiftFixture,
  ctx: ApiRequestContext,
): PlandayJsonDeletedShift {
  const times = encodeShiftTimes(shift, ctx);
  return {
    id: shift.id,
    departmentId: shift.departmentId,
    employeeId: shift.employeeId,
    employeeGroupId: shift.employeeGroupId,
    positionId: shift.positionId,
    shiftTypeId: shift.shiftTypeId,
    date: shift.start.slice(0, 10),
    comment: shift.comment,
    timeZone: shift.timeZone,
    startDateTime: times.startDateTime,
    endDateTime: times.endDateTime,
    status: shift.status,
    dateTimeCreated: shift.dateTimeCreated,
    dateTimeModified: shift.dateTimeModified,
    dateTimeDeleted: shift.dateTimeDeleted,
    deletedBy: shift.deletedBy,
  };
}

/** Punch Clock date-times: the documented example has no seconds and no zone (`2025-01-01T00:00`, notes §10.3). */
function encodePunchTime(local: string, ctx: ApiRequestContext): string {
  const zone = ctx.portal.info.timeZone;
  return encodeDateTime(local, zone, zone, ctx.state.settings.dateTimeFormat, { seconds: false });
}

function renderPunchClockShift(
  p: MockPunchClockFixture,
  ctx: ApiRequestContext,
): PlandayJsonPunchClockShift {
  const shift = p.shiftId === null ? undefined : ctx.portal.shifts.get(p.shiftId);
  const fallback = ctx.portal.info.timeZone;
  const format = ctx.state.settings.dateTimeFormat;
  return {
    id: p.id,
    shiftId: p.shiftId,
    departmentId: p.departmentId,
    employeeId: p.employeeId,
    startDateTime: encodePunchTime(p.start, ctx),
    endDateTime: p.end === null ? null : encodePunchTime(p.end, ctx),
    shiftStartDateTime: shift
      ? encodeDateTime(shift.start, shift.timeZone, fallback, format, { seconds: false })
      : null,
    shiftEndDateTime: shift
      ? encodeDateTime(shift.end, shift.timeZone, fallback, format, { seconds: false })
      : null,
    description: p.description,
    isApproved: p.isApproved,
  };
}

function renderBreak(
  b: MockPunchClockBreakFixture,
  ctx: ApiRequestContext,
): PlandayJsonPunchClockBreak {
  let duration: string | null = null;
  if (b.end !== null) {
    const zone = ctx.portal.info.timeZone;
    const seconds = Math.round((localToMs(b.end, zone) - localToMs(b.start, zone)) / 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    duration = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
  }
  return {
    id: b.id,
    punchClocksShiftId: b.punchClockShiftId,
    startDateTime: encodePunchTime(b.start, ctx),
    endDateTime: b.end === null ? null : encodePunchTime(b.end, ctx),
    duration,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------------------------------------

class BadRequest extends Error {}

function intParam(query: URLSearchParams, name: string): number | null {
  const raw = query.get(name);
  if (raw === null) return null;
  if (!/^-?\d+$/.test(raw)) throw new BadRequest(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new BadRequest(`${name} is out of range`);
  return value;
}

function dateParam(query: URLSearchParams, name: string, required = false): string | null {
  const raw = query.get(name);
  if (raw === null) {
    if (required) throw new BadRequest(`${name} is required`);
    return null;
  }
  if (!isValidLocalDate(raw)) throw new BadRequest(`${name} must be a date (yyyy-mm-dd)`);
  return raw;
}

function dateTimeParam(ctx: ApiRequestContext, name: string, required = false): number | null {
  const raw = ctx.query.get(name);
  if (raw === null) {
    if (required) throw new BadRequest(`${name} is required`);
    return null;
  }
  const ms = parseQueryDateTime(raw, ctx.portal.info.timeZone);
  if (ms === null) throw new BadRequest(`${name} must be a date-time`);
  return ms;
}

/** Inclusive `[from, to]` instant filter of one record field (`modifiedFrom` / `modifiedTo` and the like). */
function instantFilter(
  ctx: ApiRequestContext,
  fromName: string,
  toName: string,
): (iso: string | null) => boolean {
  const from = dateTimeParam(ctx, fromName);
  const to = dateTimeParam(ctx, toName);
  return (iso) => {
    if (from === null && to === null) return true;
    if (iso === null) return false;
    const ms = Date.parse(iso);
    return (from === null || ms >= from) && (to === null || ms <= to);
  };
}

function dateRangeFilter(ctx: ApiRequestContext): (date: string) => boolean {
  const from = dateParam(ctx.query, "from");
  const to = dateParam(ctx.query, "to");
  if (from && to && from > to) throw new BadRequest("from must not be after to");
  const max = ctx.state.settings.maxShiftRangeDays;
  if (max !== null && from && to && addLocalDays(from, max - 1) < to) {
    throw new BadRequest(`The period between from and to may not exceed ${max} days`);
  }
  return (date) => (from === null || date >= from) && (to === null || date <= to);
}

function readPaging(ctx: ApiRequestContext, rule: PagingRule): { limit: number; offset: number } {
  let limit = intParam(ctx.query, "limit") ?? rule.defaultLimit;
  const offset = intParam(ctx.query, "offset") ?? 0;
  if (offset < 0) throw new BadRequest("offset must be 0 or more");
  if (limit < rule.minLimit) throw new BadRequest(`limit must be at least ${rule.minLimit}`);
  if (limit > rule.maxLimit) {
    if (rule.overMax === "reject") throw new BadRequest(`limit must be at most ${rule.maxLimit}`);
    limit = rule.maxLimit;
  }
  const cap = ctx.state.settings.pageSizeCap;
  return { limit: cap === null ? limit : Math.min(limit, cap), offset };
}

function paged<T, R>(
  ctx: ApiRequestContext,
  rule: PagingRule,
  items: readonly T[],
  render: (item: T) => R,
): Response {
  const { limit, offset } = readPaging(ctx, rule);
  const body: PlandayJsonPagedResponse<R> = {
    paging: ctx.state.settings.pagingNull ? null : { offset, limit, total: items.length },
    data: items.slice(offset, offset + limit).map(render),
  };
  return jsonResponse(200, body);
}

const byId = <T extends { id: number }>(a: T, b: T) => a.id - b.id;

// ---------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------

function route(definition: Omit<ApiRoute, "pattern" | "paramNames">): ApiRoute {
  const paramNames: string[] = [];
  const source = definition.template
    .replace(/[.]/g, "\\.")
    .replace(/\{(\w+)\}/g, (_m, name: string) => {
      paramNames.push(name);
      return "(\\d+)";
    });
  return { ...definition, pattern: new RegExp(`^${source}$`), paramNames };
}

export const API_ROUTES: readonly ApiRoute[] = [
  route({
    template: "/portal/v1.0/info",
    scope: null,
    params: [],
    forbidden: [],
    paging: null,
    handle: (ctx) => jsonResponse(200, { data: structuredClone(ctx.portal.info) }),
  }),
  route({
    template: "/hr/v1.0/departments",
    scope: "department:read",
    params: ["limit", "offset"],
    forbidden: ["managedEmployeesOnly"],
    paging: HR_PAGING,
    handle: (ctx) =>
      paged(ctx, HR_PAGING, [...ctx.portal.departments].sort(byId), (d) => ({ ...d })),
  }),
  route({
    template: "/hr/v1.0/employeegroups",
    scope: "employeegroup:read",
    params: ["limit", "offset"],
    forbidden: [],
    paging: HR_PAGING,
    handle: (ctx) =>
      paged(ctx, HR_PAGING, [...ctx.portal.employeeGroups].sort(byId), (g) => ({ ...g })),
  }),
  route({
    template: "/hr/v1.0/employees",
    scope: "employee:read",
    params: ["limit", "offset", ...CREATED_MODIFIED],
    forbidden: ["special", "includeSecurityGroups", "searchQuery"],
    paging: HR_PAGING,
    handle: (ctx) => {
      const created = instantFilter(ctx, "createdFrom", "createdTo");
      const modified = instantFilter(ctx, "modifiedFrom", "modifiedTo");
      const today = localDateOfMs(ctx.state.now(), ctx.portal.info.timeZone);
      const active = [...ctx.portal.employees.values()].filter(
        (e) =>
          e.status === "ACTIVE" ||
          // A future dismissal kept on the active list until its date (plan §6.5, the worst case).
          (e.status === "DEACTIVATED" &&
            e.stayOnActiveList &&
            (e.raw.deactivationDate ?? "") > today),
      );
      const list = active
        .filter((e) => created(e.raw.dateTimeCreated) && modified(e.raw.dateTimeModified))
        .sort((a, b) => a.raw.id - b.raw.id);
      return paged(ctx, HR_PAGING, list, renderEmployee);
    },
  }),
  route({
    template: "/hr/v1.0/employees/deactivated",
    scope: "employee:read",
    params: ["limit", "offset", ...CREATED_MODIFIED, "deactivatedFrom", "deactivatedTo"],
    forbidden: ["special", "searchQuery"],
    paging: HR_PAGING,
    handle: (ctx) => {
      const created = instantFilter(ctx, "createdFrom", "createdTo");
      const modified = instantFilter(ctx, "modifiedFrom", "modifiedTo");
      // `deactivatedFrom` / `deactivatedTo` filter on `dateTimeDeleted`, "when last deactivated" (notes §9.2).
      const deactivated = instantFilter(ctx, "deactivatedFrom", "deactivatedTo");
      const list = [...ctx.portal.employees.values()]
        .filter(
          (e) =>
            e.status === "DEACTIVATED" &&
            created(e.raw.dateTimeCreated) &&
            modified(e.raw.dateTimeModified) &&
            deactivated(e.raw.dateTimeDeleted),
        )
        .sort((a, b) => a.raw.id - b.raw.id);
      return paged(ctx, HR_PAGING, list, renderDeactivatedEmployee);
    },
  }),
  route({
    template: "/hr/v1.0/employees/{employeeId}",
    scope: "employee:read",
    params: [],
    forbidden: ["special"],
    paging: null,
    handle: (ctx) => {
      const employee = ctx.portal.employees.get(Number(ctx.params.employeeId));
      // Notes §8: 400 "invalid employee id: it does not exist or the user is no longer active". The mock answers
      // it for unknown and removed people; a deactivated person answers a body with `isDeactivated: true`.
      if (!employee || employee.status === "REMOVED") {
        return problemResponse(400, "Invalid employee id");
      }
      return jsonResponse(200, { data: renderEmployeeDetails(employee) });
    },
  }),
  route({
    template: "/scheduling/v1.0/shifts",
    scope: "shift:read",
    params: ["limit", "offset", "from", "to", ...CREATED_MODIFIED],
    forbidden: SHIFT_ARRAY_FILTERS,
    paging: SHIFTS_PAGING,
    handle: (ctx) => {
      const inRange = dateRangeFilter(ctx);
      const created = instantFilter(ctx, "createdFrom", "createdTo");
      const modified = instantFilter(ctx, "modifiedFrom", "modifiedTo");
      const list = [...ctx.portal.shifts.values()]
        .filter(
          (s) =>
            inRange(s.start.slice(0, 10)) &&
            created(s.dateTimeCreated) &&
            modified(s.dateTimeModified),
        )
        .sort(byId);
      return paged(ctx, SHIFTS_PAGING, list, (s) => renderShift(s, ctx));
    },
  }),
  route({
    template: "/scheduling/v1.0/shifts/deleted",
    scope: "shift:read",
    params: ["limit", "offset", "deletedFrom", "deletedTo", "from", "to", ...CREATED_MODIFIED],
    forbidden: SHIFT_ARRAY_FILTERS,
    paging: DELETED_SHIFTS_PAGING,
    handle: (ctx) => {
      const inRange = dateRangeFilter(ctx);
      const created = instantFilter(ctx, "createdFrom", "createdTo");
      const modified = instantFilter(ctx, "modifiedFrom", "modifiedTo");
      const deleted = instantFilter(ctx, "deletedFrom", "deletedTo");
      const list = [...ctx.portal.deletedShifts.values()]
        .filter(
          (s) =>
            inRange(s.start.slice(0, 10)) &&
            created(s.dateTimeCreated) &&
            modified(s.dateTimeModified) &&
            deleted(s.dateTimeDeleted),
        )
        .sort(byId);
      return paged(ctx, DELETED_SHIFTS_PAGING, list, (s) => renderDeletedShift(s, ctx));
    },
  }),
  route({
    template: "/scheduling/v1.0/shifts/{shiftId}",
    scope: "shift:read",
    params: [],
    forbidden: [],
    paging: null,
    handle: (ctx) => {
      const shift = ctx.portal.shifts.get(Number(ctx.params.shiftId));
      if (!shift) return problemResponse(404, "Shift not found");
      return jsonResponse(200, { data: renderShift(shift, ctx) });
    },
  }),
  route({
    template: "/scheduling/v1.0/scheduleDay",
    scope: "shift:read",
    params: ["departmentId", "from", "to", "limit", "offset"],
    forbidden: [],
    paging: SCHEDULE_DAY_PAGING,
    handle: (ctx) => {
      const departmentId = intParam(ctx.query, "departmentId");
      if (departmentId === null) throw new BadRequest("departmentId is required");
      if (!ctx.portal.departments.some((d) => d.id === departmentId)) {
        throw new BadRequest(`Department ${departmentId} does not exist`);
      }
      const from = dateParam(ctx.query, "from", true)!;
      const to = dateParam(ctx.query, "to", true)!;
      if (from > to) throw new BadRequest("from must not be after to");
      if (addLocalDays(from, 366) < to) throw new BadRequest("The period is too long");
      const days: PlandayJsonScheduleDay[] = [];
      for (let date = from; date <= to; date = addLocalDays(date, 1)) {
        const hidden = ctx.portal.hiddenDays.has(`${departmentId}|${date}`);
        days.push({
          date,
          title: null,
          // Manager-only notes: free text Planday may hold about the day (notes §9.3 strip column).
          description: hidden ? `SENTINEL-PII-DAYNOTE-${departmentId}-${date}` : null,
          isVisible: !hidden,
          holiday: [],
          lockState: "Unlocked",
          departmentId,
          id: hidden ? Number(`${departmentId}${date.replaceAll("-", "")}`) : null,
        });
      }
      return paged(ctx, SCHEDULE_DAY_PAGING, days, (d) => d);
    },
  }),
  route({
    template: "/punchclock/v1.0/punchclockshifts",
    scope: "punchclockshift:read",
    params: ["from", "to", "limit", "offset", "employeeId", "shiftId"],
    forbidden: [],
    paging: PUNCH_CLOCK_PAGING,
    handle: (ctx) => {
      const from = dateTimeParam(ctx, "from", true)!;
      const to = dateTimeParam(ctx, "to", true)!;
      const employeeId = intParam(ctx.query, "employeeId");
      const shiftId = intParam(ctx.query, "shiftId");
      const zone = ctx.portal.info.timeZone;
      // Which timestamp the window filters on is undocumented (notes §12 Q44): the mock uses overlap.
      const list = [...ctx.portal.punchClockShifts.values()]
        .filter((p) => {
          const start = localToMs(p.start, zone);
          const end = p.end === null ? Number.POSITIVE_INFINITY : localToMs(p.end, zone);
          return (
            start <= to &&
            end >= from &&
            (employeeId === null || p.employeeId === employeeId) &&
            (shiftId === null || p.shiftId === shiftId)
          );
        })
        .sort(byId);
      return paged(ctx, PUNCH_CLOCK_PAGING, list, (p) => renderPunchClockShift(p, ctx));
    },
  }),
  route({
    template: "/punchclock/v1.0/punchclockshifts/{punchClockShiftId}/breaks",
    scope: "punchclockshift:read",
    params: [],
    forbidden: [],
    paging: null,
    handle: (ctx) => {
      const id = Number(ctx.params.punchClockShiftId);
      if (!ctx.portal.punchClockShifts.has(id)) {
        return problemResponse(404, "Punch clock shift not found");
      }
      const breaks = ctx.portal.punchClockBreaks
        .filter((b) => b.punchClockShiftId === id)
        .sort(byId)
        .map((b) => renderBreak(b, ctx));
      return jsonResponse(200, {
        data: breaks,
        paging: ctx.state.settings.pagingNull ? null : { total: breaks.length },
      });
    },
  }),
];

/** The route and its path parameters, or null for a path the mock (and ClockOff) does not know. */
export function matchApiRoute(
  pathname: string,
): { route: ApiRoute; params: Record<string, string> } | null {
  for (const candidate of API_ROUTES) {
    const m = candidate.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    candidate.paramNames.forEach((name, index) => {
      params[name] = m[index + 1]!;
    });
    return { route: candidate, params };
  }
  return null;
}

/** Runs a matched route; a malformed query answers 400 `ProblemDetails`. */
export function runApiRoute(routeToRun: ApiRoute, ctx: ApiRequestContext): Response {
  try {
    return routeToRun.handle(ctx);
  } catch (error) {
    if (error instanceof BadRequest) return problemResponse(400, error.message);
    throw error;
  }
}

/** Instants of a stored shift (for controls that need them). */
export function shiftInstants(
  shift: MockShiftFixture,
  portalZone: string,
): { startMs: number; endMs: number } {
  const zone = usableZone(shift.timeZone, portalZone);
  return { startMs: localToMs(shift.start, zone), endMs: localToMs(shift.end, zone) };
}
