/**
 * Fault simulation and data changes of Mock Planday (plan §12.4), plus the few extra controls the stage 3 to 8
 * suites need (`addShift`, `editEmployee`, department and group changes, punch records, latency, a route-range
 * limit and generic queued errors). Every control acts on the mock's live state; data changes stamp
 * `dateTimeModified` with the mock clock. `runControlAction` exposes the same controls to the HTTP server's
 * `POST /__control` (and through it to the web app's dev control route).
 */
import { z } from "zod";
import { isValidLocalDate } from "@clockoff/shared/time/parse";
import {
  isoZ,
  localDateOfMs,
  MOCK_DATE_TIME_FORMATS,
  toStoredLocal,
  usableZone,
  type MockDateTimeFormat,
} from "./datetime";
import {
  MOCK_DELETED_BY_USER_ID,
  SENTINEL_PII_PREFIX,
  sentinel,
  sentinelEmployeeDetails,
  sentinelRawEmployee,
  type MockEmployeeFixture,
  type MockPunchClockFixture,
  type MockShiftFixture,
} from "./fixture";
import { issueAuthorizationCode, type AuthorizationRequestInput } from "./oauth";
import type { PlandayJsonDepartment, PlandayJsonEmployee, PlandayJsonEmployeeGroup } from "./raw";
import {
  MockControlError,
  type MockGrant,
  type MockMalformedMode,
  type MockPlandayState,
  type MockPortalState,
} from "./state";

/** Names the portal a data control acts on (default: the mock's default portal, 4100001). */
export interface MockPortalOption {
  portalId?: number;
}

/** Date-times are a `Date`, an instant string (`Z` / offset) or wall-clock in the shift's zone. */
export interface MockShiftPatch {
  startDateTime?: string | Date;
  endDateTime?: string | Date;
  departmentId?: number | null;
  employeeId?: number | null;
  employeeGroupId?: number | null;
  /** Any string, so a test can serve an undocumented status. */
  status?: string;
  timeZone?: string;
  comment?: string | null;
  punchClockShiftId?: number | null;
}

export interface MockNewShift extends MockShiftPatch {
  /** Default: one above the portal's highest shift id. */
  id?: number;
  startDateTime: string | Date;
  endDateTime: string | Date;
}

export interface MockNewPunchClockShift {
  id: number;
  shiftId?: number | null;
  departmentId: number;
  employeeId?: number | null;
  /** Punch in: a `Date`, an instant string or wall-clock in the portal zone. */
  start: string | Date;
  /** Punch out, or null while punched in. */
  end?: string | Date | null;
  isApproved?: boolean | null;
}

export interface MockRevokeOptions {
  /** Revoke but keep the grant's live access tokens working (notes §12 Q5 variant). */
  keepAccessTokens?: boolean;
}

export interface MockPlandayControls {
  /** The next `count` matching requests answer 429 with `Retry-After`, `x-ratelimit-reset`, both or neither. */
  queueRateLimit(options: {
    /** A path (`/hr/v1.0/employees`, `/connect/token`) or path template; default: every API request. */
    path?: string;
    count?: number;
    retryAfterSeconds?: number;
    resetSeconds?: number;
  }): void;
  /** Every access token issued so far is expired. */
  expireAccessTokens(): void;
  /** On: each refresh returns a new refresh token and invalidates the old one. */
  setRotateRefreshTokens(enabled: boolean): void;
  /**
   * The token endpoint answers 400 `{"error":"invalid_grant"}` for the revoked token(s); the API answers 401 for
   * their access tokens unless `keepAccessTokens`. Accepts `(token | "all", options)` or `({ token?, keepAccessTokens? })`.
   * Returns the number of grants revoked.
   */
  revokeRefreshToken(
    target?: string | (MockRevokeOptions & { token?: string }),
    options?: MockRevokeOptions,
  ): number;
  /** Whether `POST /connect/revocation` also ends the grant's access tokens (default true). */
  setRevocationKillsAccessTokens(enabled: boolean): void;
  /** A new refresh token for the app, as after the admin authorises it again in Planday. */
  reauthorize(
    appId: string,
    options?: MockPortalOption,
  ): { refreshToken: string; portalId: number };
  /** Method B: the admin added this App ID with "Connect App" and authorised it; returns the Token column value. */
  issueTokenForApp(
    appId: string,
    options?: MockPortalOption,
  ): { refreshToken: string; portalId: number };
  /** Method A consent approved: a single-use code for the request (the dev authorize route uses it). */
  issueAuthorizationCode(input: AuthorizationRequestInput): { code: string; portalId: number };
  /** The next `count` matching 2xx answers are malformed (default: a required field dropped). */
  queueMalformed(options: {
    path?: string;
    count?: number;
    mode?: MockMalformedMode;
    /** Field to drop with `missing-field` (default `id` of the first record; `access_token` on `/connect/token`). */
    field?: string;
  }): void;
  /** The next `count` matching requests answer a 5xx `ProblemDetails` (default 500). */
  queue5xx(options: { path?: string; count?: number; status?: number }): void;
  /** The next `count` matching requests answer `status` with `body` (for example a transient token-endpoint 400). */
  queueError(options: { path?: string; count?: number; status: number; body?: unknown }): void;
  setDateTimeFormat(format: MockDateTimeFormat): void;
  /** Server-lowered page size (null removes the cap). */
  capPageSize(size: number | null): void;
  /** Serve `paging: null` on list answers. */
  setPagingNull(enabled: boolean): void;
  /** `/shifts` and `/shifts/deleted` answer 400 for a `from`–`to` range longer than `days` (null: no limit). */
  setMaxShiftRangeDays(days: number | null): void;
  /** Override `x-ratelimit-remaining` / `x-ratelimit-reset` on ordinary API answers (null: computed values). */
  setRateLimitHeaders(value: { remaining: number; resetSeconds: number } | null): void;
  /** Delay answers by `ms` (abortable by the request's signal); 0 removes it. `path` limits it to one path. */
  setLatency(ms: number, options?: { path?: string }): void;
  editShift(id: number, patch: MockShiftPatch, options?: MockPortalOption): MockShiftFixture;
  addShift(shift: MockNewShift, options?: MockPortalOption): MockShiftFixture;
  /** Moves the shift to `/shifts/deleted` with `dateTimeDeleted` = now; by-id answers 404 afterwards. */
  deleteShift(id: number, options?: MockPortalOption): void;
  setShiftStatus(id: number, status: string, options?: MockPortalOption): void;
  /** `null` makes it an open shift (`status` `Open`), as Planday does (notes §10.2). */
  reassignShift(id: number, employeeId: number | null, options?: MockPortalOption): void;
  setScheduleDayVisible(
    departmentId: number,
    date: string,
    visible: boolean,
    options?: MockPortalOption,
  ): void;
  /** A new active employee; strip-set fields not given are filled with sentinels. */
  addEmployee(
    raw: Pick<PlandayJsonEmployee, "id" | "firstName" | "lastName"> & Partial<PlandayJsonEmployee>,
    options?: MockPortalOption,
  ): MockEmployeeFixture;
  /** Changes list fields of an employee (name, email, departments, groups…). */
  editEmployee(
    id: number,
    patch: Partial<Omit<PlandayJsonEmployee, "id">>,
    options?: MockPortalOption,
  ): MockEmployeeFixture;
  /**
   * Deactivates in Planday: on `/employees/deactivated` with `deactivationDate` = `effectiveDate` (default
   * today). With a future date and `stayOnActiveList` the person is on both lists until the date (plan §6.5).
   */
  deactivateEmployee(
    id: number,
    options?: MockPortalOption & { effectiveDate?: string; stayOnActiveList?: boolean },
  ): void;
  reactivateEmployee(id: number, options?: MockPortalOption): void;
  /** Gone from both lists; the by-id read answers 400. */
  removeEmployee(id: number, options?: MockPortalOption): void;
  /** Adds or renames a department. */
  upsertDepartment(department: PlandayJsonDepartment, options?: MockPortalOption): void;
  removeDepartment(id: number, options?: MockPortalOption): void;
  /** Adds or renames an employee group. */
  upsertEmployeeGroup(group: PlandayJsonEmployeeGroup, options?: MockPortalOption): void;
  removeEmployeeGroup(id: number, options?: MockPortalOption): void;
  /** Adds or replaces a punch record (Beta clock mode). */
  upsertPunchClockShift(record: MockNewPunchClockShift, options?: MockPortalOption): void;
  /** Adds a break to a punch record. */
  addPunchClockBreak(
    breakRecord: {
      id: number;
      punchClockShiftId: number;
      start: string | Date;
      end?: string | Date | null;
    },
    options?: MockPortalOption,
  ): void;
  /** The scopes the app was created with; checked on every request (403 without the endpoint's scope). */
  setScopes(appId: string, scopes: readonly string[]): void;
  advanceClock(ms: number): void;
  /** Back to the fixture: data, apps, grants, tokens, faults, settings, clock offset and both logs. */
  reset(): void;
}

function positiveCount(count: number | undefined): number {
  const value = count ?? 1;
  if (!Number.isInteger(value) || value < 1)
    throw new MockControlError("count must be a positive integer");
  return value;
}

export function createMockPlandayControls(
  state: MockPlandayState,
  hooks: { onReset(): void },
): MockPlandayControls {
  const portalOf = (options?: MockPortalOption): MockPortalState =>
    state.portal(options?.portalId ?? state.defaultPortalId);
  const nowIso = () => isoZ(state.now());
  const shiftOf = (portal: MockPortalState, id: number): MockShiftFixture => {
    const shift = portal.shifts.get(id);
    if (!shift) throw new MockControlError(`portal ${portal.info.id} has no shift ${id}`);
    return shift;
  };
  const employeeOf = (portal: MockPortalState, id: number): MockEmployeeFixture => {
    const employee = portal.employees.get(id);
    if (!employee || employee.status === "REMOVED") {
      throw new MockControlError(`portal ${portal.info.id} has no employee ${id}`);
    }
    return employee;
  };
  const storedLocal = (value: string | Date, zone: string, portal: MockPortalState): string => {
    try {
      return toStoredLocal(value, usableZone(zone, portal.info.timeZone));
    } catch (error) {
      throw new MockControlError(error instanceof Error ? error.message : String(error));
    }
  };
  const applyShiftPatch = (
    portal: MockPortalState,
    shift: MockShiftFixture,
    patch: MockShiftPatch,
  ) => {
    if (patch.timeZone !== undefined) shift.timeZone = patch.timeZone;
    if (patch.startDateTime !== undefined) {
      shift.start = storedLocal(patch.startDateTime, shift.timeZone, portal);
    }
    if (patch.endDateTime !== undefined) {
      shift.end = storedLocal(patch.endDateTime, shift.timeZone, portal);
    }
    if (patch.departmentId !== undefined) shift.departmentId = patch.departmentId;
    if (patch.employeeId !== undefined) shift.employeeId = patch.employeeId;
    if (patch.employeeGroupId !== undefined) shift.employeeGroupId = patch.employeeGroupId;
    if (patch.status !== undefined) shift.status = patch.status;
    if (patch.comment !== undefined) shift.comment = patch.comment;
    if (patch.punchClockShiftId !== undefined) shift.punchClockShiftId = patch.punchClockShiftId;
    shift.dateTimeModified = nowIso();
  };
  const newGrant = (appId: string, options?: MockPortalOption) => {
    const app = state.app(appId);
    let portalId = options?.portalId;
    if (portalId === undefined) {
      const latest = [...state.grants.values()].filter((g) => g.appId === appId).at(-1);
      portalId = app.portalId ?? latest?.portalId ?? state.defaultPortalId;
    }
    if (app.kind === "CUSTOMER" && app.portalId !== null && app.portalId !== portalId) {
      throw new MockControlError(`app ${appId} belongs to portal ${app.portalId}`);
    }
    const grant = state.createGrant(appId, portalId);
    return { refreshToken: grant.refreshToken, portalId };
  };

  return {
    queueRateLimit(options) {
      state.faults.push({
        kind: "RATE_LIMIT",
        path: options.path ?? null,
        remaining: positiveCount(options.count),
        retryAfterSeconds: options.retryAfterSeconds ?? null,
        resetSeconds: options.resetSeconds ?? null,
      });
    },
    expireAccessTokens() {
      const past = state.now() - 1;
      for (const token of state.accessTokens.values()) token.expiresAtMs = past;
    },
    setRotateRefreshTokens(enabled) {
      state.settings.rotateRefreshTokens = enabled;
    },
    revokeRefreshToken(target, options) {
      let token: string = "all";
      let keepAccessTokens = false;
      if (typeof target === "string") token = target;
      else if (target) {
        token = target.token ?? "all";
        keepAccessTokens = target.keepAccessTokens ?? false;
      }
      if (options?.keepAccessTokens !== undefined) keepAccessTokens = options.keepAccessTokens;
      let grants: MockGrant[];
      if (token === "all") {
        grants = [...state.grants.values()].filter((g) => !g.revoked);
      } else {
        const found = state.grantByRefreshToken(token);
        if (!found) throw new MockControlError("unknown refresh token");
        grants = [found.grant];
      }
      for (const grant of grants) {
        grant.revoked = true;
        grant.keepAccessTokens = keepAccessTokens;
        if (!keepAccessTokens) state.revokeAccessTokensOf(grant.id);
      }
      return grants.length;
    },
    setRevocationKillsAccessTokens(enabled) {
      state.settings.revocationKillsAccessTokens = enabled;
    },
    reauthorize: newGrant,
    issueTokenForApp: newGrant,
    issueAuthorizationCode(input) {
      return issueAuthorizationCode(state, input);
    },
    queueMalformed(options) {
      state.faults.push({
        kind: "MALFORMED",
        path: options.path ?? null,
        remaining: positiveCount(options.count),
        mode: options.mode ?? "missing-field",
        field: options.field ?? null,
      });
    },
    queue5xx(options) {
      const status = options.status ?? 500;
      if (status < 500 || status > 599) throw new MockControlError("queue5xx status must be 5xx");
      state.faults.push({
        kind: "ERROR",
        path: options.path ?? null,
        remaining: positiveCount(options.count),
        status,
        body: null,
      });
    },
    queueError(options) {
      if (!Number.isInteger(options.status) || options.status < 400 || options.status > 599) {
        throw new MockControlError("queueError status must be 4xx or 5xx");
      }
      state.faults.push({
        kind: "ERROR",
        path: options.path ?? null,
        remaining: positiveCount(options.count),
        status: options.status,
        body: options.body ?? null,
      });
    },
    setDateTimeFormat(format) {
      if (!(MOCK_DATE_TIME_FORMATS as readonly string[]).includes(format)) {
        throw new MockControlError(`unknown date-time format ${format}`);
      }
      state.settings.dateTimeFormat = format;
    },
    capPageSize(size) {
      if (size !== null && (!Number.isInteger(size) || size < 1)) {
        throw new MockControlError("capPageSize needs a positive integer or null");
      }
      state.settings.pageSizeCap = size;
    },
    setPagingNull(enabled) {
      state.settings.pagingNull = enabled;
    },
    setMaxShiftRangeDays(days) {
      if (days !== null && (!Number.isInteger(days) || days < 1)) {
        throw new MockControlError("setMaxShiftRangeDays needs a positive integer or null");
      }
      state.settings.maxShiftRangeDays = days;
    },
    setRateLimitHeaders(value) {
      state.settings.rateLimitHeaders = value ? { ...value } : null;
    },
    setLatency(ms, options) {
      if (!Number.isFinite(ms) || ms < 0) throw new MockControlError("latency must be 0 or more");
      state.settings.latency = ms === 0 ? null : { ms, path: options?.path ?? null };
    },
    editShift(id, patch, options) {
      const portal = portalOf(options);
      const shift = shiftOf(portal, id);
      applyShiftPatch(portal, shift, patch);
      return structuredClone(shift);
    },
    addShift(input, options) {
      const portal = portalOf(options);
      const id =
        input.id ?? Math.max(0, ...portal.shifts.keys(), ...portal.deletedShifts.keys()) + 1;
      if (portal.shifts.has(id)) throw new MockControlError(`shift ${id} exists`);
      const timeZone = input.timeZone ?? portal.info.timeZone;
      const employeeId = input.employeeId ?? null;
      const shift: MockShiftFixture = {
        id,
        departmentId: input.departmentId ?? null,
        employeeId,
        employeeGroupId: input.employeeGroupId ?? null,
        positionId: null,
        shiftTypeId: 1,
        timeZone,
        start: storedLocal(input.startDateTime, timeZone, portal),
        end: storedLocal(input.endDateTime, timeZone, portal),
        status: input.status ?? (employeeId === null ? "Open" : "Assigned"),
        comment:
          input.comment === undefined ? `${SENTINEL_PII_PREFIX}-COMMENT-${id}` : input.comment,
        punchClockShiftId: input.punchClockShiftId ?? null,
        skillIds: [],
        dateTimeCreated: nowIso(),
        dateTimeModified: nowIso(),
      };
      portal.deletedShifts.delete(id);
      portal.shifts.set(id, shift);
      return structuredClone(shift);
    },
    deleteShift(id, options) {
      const portal = portalOf(options);
      const shift = shiftOf(portal, id);
      portal.shifts.delete(id);
      portal.deletedShifts.set(id, {
        ...shift,
        dateTimeModified: nowIso(),
        dateTimeDeleted: nowIso(),
        deletedBy: MOCK_DELETED_BY_USER_ID,
      });
    },
    setShiftStatus(id, status, options) {
      const portal = portalOf(options);
      applyShiftPatch(portal, shiftOf(portal, id), { status });
    },
    reassignShift(id, employeeId, options) {
      const portal = portalOf(options);
      const shift = shiftOf(portal, id);
      const status =
        employeeId === null ? "Open" : shift.status === "Open" ? "Assigned" : shift.status;
      applyShiftPatch(portal, shift, { employeeId, status });
    },
    setScheduleDayVisible(departmentId, date, visible, options) {
      const portal = portalOf(options);
      if (!isValidLocalDate(date)) throw new MockControlError(`invalid date ${date}`);
      if (!portal.departments.some((d) => d.id === departmentId)) {
        throw new MockControlError(`portal ${portal.info.id} has no department ${departmentId}`);
      }
      const key = `${departmentId}|${date}`;
      if (visible) portal.hiddenDays.delete(key);
      else portal.hiddenDays.add(key);
    },
    addEmployee(raw, options) {
      const portal = portalOf(options);
      const existing = portal.employees.get(raw.id);
      if (existing && existing.status !== "REMOVED") {
        throw new MockControlError(`employee ${raw.id} exists`);
      }
      const departments = raw.departments ?? [];
      const employee: MockEmployeeFixture = {
        raw: sentinelRawEmployee(
          {
            ...raw,
            departments,
            primaryDepartmentId: raw.primaryDepartmentId ?? departments[0] ?? null,
          },
          nowIso(),
        ),
        details: sentinelEmployeeDetails(raw.id),
        status: "ACTIVE",
        stayOnActiveList: false,
      };
      portal.employees.set(raw.id, employee);
      return structuredClone(employee);
    },
    editEmployee(id, patch, options) {
      const portal = portalOf(options);
      const employee = employeeOf(portal, id);
      const { id: _ignored, ...rest } = patch as Partial<PlandayJsonEmployee>;
      employee.raw = { ...employee.raw, ...rest, dateTimeModified: nowIso() };
      return structuredClone(employee);
    },
    deactivateEmployee(id, options) {
      const portal = portalOf(options);
      const employee = employeeOf(portal, id);
      const effectiveDate =
        options?.effectiveDate ?? localDateOfMs(state.now(), portal.info.timeZone);
      if (!isValidLocalDate(effectiveDate)) {
        throw new MockControlError(`invalid effectiveDate ${effectiveDate}`);
      }
      employee.status = "DEACTIVATED";
      employee.stayOnActiveList = options?.stayOnActiveList ?? false;
      employee.raw = {
        ...employee.raw,
        deactivationDate: effectiveDate,
        dateTimeDeleted: nowIso(),
        dateTimeModified: nowIso(),
        terminationTypeId: 2,
        terminationTypeName: sentinel("terminationTypeName", id),
        deactivationReason: `${SENTINEL_PII_PREFIX}-REASON-${id}`,
      };
    },
    reactivateEmployee(id, options) {
      const portal = portalOf(options);
      const employee = employeeOf(portal, id);
      employee.status = "ACTIVE";
      employee.stayOnActiveList = false;
      employee.raw = {
        ...employee.raw,
        deactivationDate: null,
        dateTimeDeleted: null,
        dateTimeModified: nowIso(),
        terminationTypeId: null,
        terminationTypeName: null,
        deactivationReason: null,
      };
    },
    removeEmployee(id, options) {
      const portal = portalOf(options);
      const employee = employeeOf(portal, id);
      employee.status = "REMOVED";
      employee.stayOnActiveList = false;
    },
    upsertDepartment(department, options) {
      const portal = portalOf(options);
      const index = portal.departments.findIndex((d) => d.id === department.id);
      if (index >= 0) portal.departments[index] = { ...department };
      else portal.departments.push({ ...department });
    },
    removeDepartment(id, options) {
      const portal = portalOf(options);
      portal.departments = portal.departments.filter((d) => d.id !== id);
    },
    upsertEmployeeGroup(group, options) {
      const portal = portalOf(options);
      const index = portal.employeeGroups.findIndex((g) => g.id === group.id);
      if (index >= 0) portal.employeeGroups[index] = { ...group };
      else portal.employeeGroups.push({ ...group });
    },
    removeEmployeeGroup(id, options) {
      const portal = portalOf(options);
      portal.employeeGroups = portal.employeeGroups.filter((g) => g.id !== id);
    },
    upsertPunchClockShift(record, options) {
      const portal = portalOf(options);
      const zone = portal.info.timeZone;
      const stored: MockPunchClockFixture = {
        id: record.id,
        shiftId: record.shiftId ?? null,
        departmentId: record.departmentId,
        employeeId: record.employeeId ?? null,
        start: storedLocal(record.start, zone, portal),
        end: record.end == null ? null : storedLocal(record.end, zone, portal),
        description: `${SENTINEL_PII_PREFIX}-PUNCHNOTE-${record.id}`,
        isApproved: record.isApproved ?? false,
      };
      portal.punchClockShifts.set(record.id, stored);
    },
    addPunchClockBreak(breakRecord, options) {
      const portal = portalOf(options);
      if (!portal.punchClockShifts.has(breakRecord.punchClockShiftId)) {
        throw new MockControlError(`no punch clock shift ${breakRecord.punchClockShiftId}`);
      }
      const zone = portal.info.timeZone;
      portal.punchClockBreaks = portal.punchClockBreaks.filter((b) => b.id !== breakRecord.id);
      portal.punchClockBreaks.push({
        id: breakRecord.id,
        punchClockShiftId: breakRecord.punchClockShiftId,
        start: storedLocal(breakRecord.start, zone, portal),
        end: breakRecord.end == null ? null : storedLocal(breakRecord.end, zone, portal),
      });
    },
    setScopes(appId, scopes) {
      state.app(appId).scopes = [...scopes];
    },
    advanceClock(ms) {
      if (!Number.isFinite(ms)) throw new MockControlError("advanceClock needs a number of ms");
      state.clockOffsetMs += ms;
    },
    reset() {
      state.reset();
      hooks.onReset();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// JSON dispatch for the HTTP server's POST /__control
// ---------------------------------------------------------------------------------------------------------

const id = z.number().int();
const portalOption = { portalId: id.optional() };
const dateTime = z.string().min(1);
const path = z.string().min(1).optional();
const count = z.number().int().positive().optional();

/** Every action `POST /__control` accepts: `{ action, ...arguments }` (arguments by name). */
const controlActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("queueRateLimit"),
    path,
    count,
    retryAfterSeconds: z.number().nonnegative().optional(),
    resetSeconds: z.number().nonnegative().optional(),
  }),
  z.object({ action: z.literal("expireAccessTokens") }),
  z.object({ action: z.literal("setRotateRefreshTokens"), enabled: z.boolean() }),
  z.object({
    action: z.literal("revokeRefreshToken"),
    token: z.string().min(1).optional(),
    keepAccessTokens: z.boolean().optional(),
  }),
  z.object({ action: z.literal("setRevocationKillsAccessTokens"), enabled: z.boolean() }),
  z.object({ action: z.literal("reauthorize"), appId: z.string().min(1), ...portalOption }),
  z.object({ action: z.literal("issueTokenForApp"), appId: z.string().min(1), ...portalOption }),
  z.object({
    action: z.literal("issueAuthorizationCode"),
    clientId: z.string().min(1),
    redirectUri: z.string().min(1),
    scope: z.string(),
    responseType: z.string().optional(),
    codeChallenge: z.string().nullable().optional(),
    codeChallengeMethod: z.string().nullable().optional(),
    ...portalOption,
  }),
  z.object({
    action: z.literal("queueMalformed"),
    path,
    count,
    mode: z.enum(["missing-field", "unsafe-id", "not-json"]).optional(),
    field: z.string().min(1).optional(),
  }),
  z.object({ action: z.literal("queue5xx"), path, count, status: z.number().int().optional() }),
  z.object({
    action: z.literal("queueError"),
    path,
    count,
    status: z.number().int(),
    body: z.unknown().optional(),
  }),
  z.object({ action: z.literal("setDateTimeFormat"), format: z.enum(MOCK_DATE_TIME_FORMATS) }),
  z.object({ action: z.literal("capPageSize"), size: z.number().int().positive().nullable() }),
  z.object({ action: z.literal("setPagingNull"), enabled: z.boolean() }),
  z.object({
    action: z.literal("setMaxShiftRangeDays"),
    days: z.number().int().positive().nullable(),
  }),
  z.object({
    action: z.literal("setRateLimitHeaders"),
    value: z
      .object({ remaining: z.number().int().nonnegative(), resetSeconds: z.number().nonnegative() })
      .nullable(),
  }),
  z.object({ action: z.literal("setLatency"), ms: z.number().nonnegative(), path }),
  z.object({
    action: z.literal("editShift"),
    id,
    patch: z.object({
      startDateTime: dateTime.optional(),
      endDateTime: dateTime.optional(),
      departmentId: id.nullable().optional(),
      employeeId: id.nullable().optional(),
      employeeGroupId: id.nullable().optional(),
      status: z.string().min(1).optional(),
      timeZone: z.string().min(1).optional(),
      comment: z.string().nullable().optional(),
      punchClockShiftId: id.nullable().optional(),
    }),
    ...portalOption,
  }),
  z.object({
    action: z.literal("addShift"),
    shift: z.object({
      id: id.optional(),
      startDateTime: dateTime,
      endDateTime: dateTime,
      departmentId: id.nullable().optional(),
      employeeId: id.nullable().optional(),
      employeeGroupId: id.nullable().optional(),
      status: z.string().min(1).optional(),
      timeZone: z.string().min(1).optional(),
    }),
    ...portalOption,
  }),
  z.object({ action: z.literal("deleteShift"), id, ...portalOption }),
  z.object({ action: z.literal("setShiftStatus"), id, status: z.string().min(1), ...portalOption }),
  z.object({ action: z.literal("reassignShift"), id, employeeId: id.nullable(), ...portalOption }),
  z.object({
    action: z.literal("setScheduleDayVisible"),
    departmentId: id,
    date: z.string(),
    visible: z.boolean(),
    ...portalOption,
  }),
  z.object({
    action: z.literal("addEmployee"),
    raw: z.looseObject({ id, firstName: z.string(), lastName: z.string() }),
    ...portalOption,
  }),
  z.object({
    action: z.literal("editEmployee"),
    id,
    patch: z.record(z.string(), z.unknown()),
    ...portalOption,
  }),
  z.object({
    action: z.literal("deactivateEmployee"),
    id,
    effectiveDate: z.string().optional(),
    stayOnActiveList: z.boolean().optional(),
    ...portalOption,
  }),
  z.object({ action: z.literal("reactivateEmployee"), id, ...portalOption }),
  z.object({ action: z.literal("removeEmployee"), id, ...portalOption }),
  z.object({
    action: z.literal("upsertDepartment"),
    department: z.object({ id, name: z.string(), number: z.string() }),
    ...portalOption,
  }),
  z.object({ action: z.literal("removeDepartment"), id, ...portalOption }),
  z.object({
    action: z.literal("upsertEmployeeGroup"),
    group: z.object({ id, name: z.string() }),
    ...portalOption,
  }),
  z.object({ action: z.literal("removeEmployeeGroup"), id, ...portalOption }),
  z.object({
    action: z.literal("upsertPunchClockShift"),
    record: z.object({
      id,
      shiftId: id.nullable().optional(),
      departmentId: id,
      employeeId: id.nullable().optional(),
      start: dateTime,
      end: dateTime.nullable().optional(),
      isApproved: z.boolean().nullable().optional(),
    }),
    ...portalOption,
  }),
  z.object({
    action: z.literal("addPunchClockBreak"),
    breakRecord: z.object({
      id,
      punchClockShiftId: id,
      start: dateTime,
      end: dateTime.nullable().optional(),
    }),
    ...portalOption,
  }),
  z.object({
    action: z.literal("setScopes"),
    appId: z.string().min(1),
    scopes: z.array(z.string()),
  }),
  z.object({ action: z.literal("advanceClock"), ms: z.number() }),
  z.object({ action: z.literal("reset") }),
]);

export type MockControlAction = z.infer<typeof controlActionSchema>;
/** Names of the actions `POST /__control` accepts. */
export const MOCK_CONTROL_ACTIONS: readonly MockControlAction["action"][] =
  controlActionSchema.options.map((option) => option.shape.action.value);

/**
 * Validates `{ action, ...arguments }` and runs the control; returns its result (or null). Throws
 * `MockControlError` for an unknown action, invalid arguments or a control that cannot be honoured.
 */
export function runControlAction(controls: MockPlandayControls, payload: unknown): unknown {
  const parsed = controlActionSchema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
      .join("; ");
    throw new MockControlError(`invalid control request: ${issues}`);
  }
  const a = parsed.data;
  const portal = "portalId" in a && a.portalId !== undefined ? { portalId: a.portalId } : undefined;
  const done = (run: () => void): null => {
    run();
    return null;
  };
  switch (a.action) {
    case "queueRateLimit":
      return done(() => controls.queueRateLimit(a));
    case "expireAccessTokens":
      return done(() => controls.expireAccessTokens());
    case "setRotateRefreshTokens":
      return done(() => controls.setRotateRefreshTokens(a.enabled));
    case "revokeRefreshToken":
      return {
        revoked: controls.revokeRefreshToken({
          token: a.token,
          keepAccessTokens: a.keepAccessTokens,
        }),
      };
    case "setRevocationKillsAccessTokens":
      return done(() => controls.setRevocationKillsAccessTokens(a.enabled));
    case "reauthorize":
      return controls.reauthorize(a.appId, portal);
    case "issueTokenForApp":
      return controls.issueTokenForApp(a.appId, portal);
    case "issueAuthorizationCode": {
      const { action: _action, ...input } = a;
      return controls.issueAuthorizationCode(input);
    }
    case "queueMalformed":
      return done(() => controls.queueMalformed(a));
    case "queue5xx":
      return done(() => controls.queue5xx(a));
    case "queueError":
      return done(() => controls.queueError(a));
    case "setDateTimeFormat":
      return done(() => controls.setDateTimeFormat(a.format));
    case "capPageSize":
      return done(() => controls.capPageSize(a.size));
    case "setPagingNull":
      return done(() => controls.setPagingNull(a.enabled));
    case "setMaxShiftRangeDays":
      return done(() => controls.setMaxShiftRangeDays(a.days));
    case "setRateLimitHeaders":
      return done(() => controls.setRateLimitHeaders(a.value));
    case "setLatency":
      return done(() =>
        controls.setLatency(a.ms, a.path === undefined ? undefined : { path: a.path }),
      );
    case "editShift":
      return controls.editShift(a.id, a.patch, portal);
    case "addShift":
      return controls.addShift(a.shift, portal);
    case "deleteShift":
      return done(() => controls.deleteShift(a.id, portal));
    case "setShiftStatus":
      return done(() => controls.setShiftStatus(a.id, a.status, portal));
    case "reassignShift":
      return done(() => controls.reassignShift(a.id, a.employeeId, portal));
    case "setScheduleDayVisible":
      return done(() => controls.setScheduleDayVisible(a.departmentId, a.date, a.visible, portal));
    case "addEmployee":
      return controls.addEmployee(
        a.raw as Parameters<MockPlandayControls["addEmployee"]>[0],
        portal,
      );
    case "editEmployee":
      return controls.editEmployee(
        a.id,
        a.patch as Partial<Omit<PlandayJsonEmployee, "id">>,
        portal,
      );
    case "deactivateEmployee":
      return done(() =>
        controls.deactivateEmployee(a.id, {
          ...portal,
          effectiveDate: a.effectiveDate,
          stayOnActiveList: a.stayOnActiveList,
        }),
      );
    case "reactivateEmployee":
      return done(() => controls.reactivateEmployee(a.id, portal));
    case "removeEmployee":
      return done(() => controls.removeEmployee(a.id, portal));
    case "upsertDepartment":
      return done(() => controls.upsertDepartment(a.department, portal));
    case "removeDepartment":
      return done(() => controls.removeDepartment(a.id, portal));
    case "upsertEmployeeGroup":
      return done(() => controls.upsertEmployeeGroup(a.group, portal));
    case "removeEmployeeGroup":
      return done(() => controls.removeEmployeeGroup(a.id, portal));
    case "upsertPunchClockShift":
      return done(() => controls.upsertPunchClockShift(a.record, portal));
    case "addPunchClockBreak":
      return done(() => controls.addPunchClockBreak(a.breakRecord, portal));
    case "setScopes":
      return done(() => controls.setScopes(a.appId, a.scopes));
    case "advanceClock":
      return done(() => controls.advanceClock(a.ms));
    case "reset":
      return done(() => controls.reset());
  }
}
