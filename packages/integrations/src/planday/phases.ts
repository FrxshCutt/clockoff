import { z } from "zod";
import type { IntegrationSyncRunKind } from "@clockoff/shared/enums";
import { AppError } from "@clockoff/shared/errors";
import type {
  PhaseInputs,
  PhaseOptions,
  PhaseStepResult,
  SyncBatch,
  SyncPhase,
} from "@clockoff/shared/providers/resumable";
import { isDatabaseOnlyPhase } from "@clockoff/shared/providers/resumable";
import type {
  ExternalClockEvent,
  ExternalEmployee,
  ExternalShift,
  ShiftRemovalReason,
} from "@clockoff/shared/providers/syncSink";
import type {
  ProviderContext,
  SyncError,
  SyncErrorCode,
  SyncRange,
} from "@clockoff/shared/providers/workforceProvider";
import { addLocalDays, canonicalTimeZone, localDateOf } from "@clockoff/shared/time/zone";
import { ABSENT_EMPLOYEE_RECHECK_LIMIT } from "../core/employeeDecisions";
import { departmentKeysOf, NO_DEPARTMENT_ID } from "../core/locationDecisions";
import {
  ABSENT_SHIFT_RECHECK_LIMIT,
  classifyPlandayShift,
  removalReasonForClass,
  type ShiftClass,
} from "../core/shiftDecisions";
import { overlapsWindow, splitDateRange, syncWindow } from "../core/window";
import type { PlandayClient } from "./client";
import { MAX_PAGES_PER_LIST, SHIFT_RANGE_SLICE_DAYS } from "./constants";
import { isPlandayNotFound, PlandayError } from "./errors";
import { pathTemplate } from "./logging";
import {
  hasValidTimes,
  toBreakClockEvents,
  toExternalShift,
  toPunchClockEvents,
  type PlandayEmployee,
  type PlandayShift,
} from "./mappers";
import type { PlandayPage } from "./pagination";
import { parsePlandayDateTime, PlandayTimeError } from "./time";

/**
 * Planday's resumable phases (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.1, §7.2). One step reads at most
 * one Planday page (or a handful of by-id reads), classifies and maps it, and returns it as a `SyncBatch` with a
 * small JSON cursor; it never touches the database and never holds anything between steps but that cursor. The
 * run executor (apps/web, the worker) writes the batch and the cursor in one fenced transaction, so a crash, a
 * shutdown or a lost lease resumes at the next page and replaying a step is idempotent.
 *
 * What a step needs beyond `PhaseInputs` arrives in `ProviderContext.settings` (`PlandayPhaseSettings`, built by the
 * executor from the connection and the mapping config). Errors are thrown as they are: `PlandayError` (with
 * `PlandayRateLimitedError` for a park), `PlandayPortalMismatchError`, an AbortError on shutdown, and the credential
 * store's `LeaseLostError` / `CredentialsWipedError` / `CredentialPersistError`.
 *
 * Cursors: every phase keeps only its own small keys (offsets, page counters, ids of departments or groups seen) and
 * passes through keys it does not know, so an executor may keep its own state beside them.
 */

// ---------------------------------------------------------------------------------------------------------
// Phase lists (§7.2)
// ---------------------------------------------------------------------------------------------------------

/** `provider.phasesFor(kind, options)`: the §7.2 table. Database-only phases are run by the executor's sink. */
export function plandayPhasesFor(
  kind: IntegrationSyncRunKind,
  options: PhaseOptions,
): readonly SyncPhase[] {
  switch (kind) {
    case "STRUCTURE":
      return ["PORTAL_CHECK", "DEPARTMENTS", "EMPLOYEE_GROUPS", "EMPLOYEE_COUNTS", "FINALISE"];
    case "DIRECTORY":
      return [
        "PORTAL_CHECK",
        "EMPLOYEES",
        "MATCH_EMPLOYEES",
        ...(options.hiddenDays ? (["SCHEDULE_DAYS"] as const) : []),
        "PREVIEW_SHIFTS",
        "FINALISE",
      ];
    case "IMPORT_EMPLOYEES":
      return ["APPLY_EMPLOYEES", "FINALISE"];
    case "SYNC":
      return [
        "PORTAL_CHECK",
        "DEPARTMENTS",
        "EMPLOYEE_GROUPS",
        "EMPLOYEES",
        "DEACTIVATED_EMPLOYEES",
        "ABSENT_EMPLOYEES",
        "REACTIVATIONS",
        ...(options.hiddenDays ? (["SCHEDULE_DAYS"] as const) : []),
        "SHIFTS",
        "DELETED_SHIFTS",
        "ABSENT_SHIFTS",
        ...(options.clockEvents ? (["CLOCK_EVENTS"] as const) : []),
        "FINALISE",
      ];
    case "CLOCK":
      return ["CLOCK_EVENTS", "FINALISE"];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Settings the executor passes in ProviderContext.settings
// ---------------------------------------------------------------------------------------------------------

/** The preview's window (§7.2 DIRECTORY: "next 14 days"). */
export const PREVIEW_WINDOW_DAYS = 14;
/** The default `syncWindowDays` (IntegrationMappingConfig default). */
export const DEFAULT_SYNC_WINDOW_DAYS = 28;
/** CLOCK_EVENTS reads punches from `now − 3 h` to `now + 1 h` (overlapping windows, notes §9.4 rule). */
export const CLOCK_EVENTS_LOOKBACK_MS = 3 * 3_600_000;
export const CLOCK_EVENTS_LOOKAHEAD_MS = 3_600_000;
/**
 * A punch record's breaks are read once it has a punch-out later than this long ago (default when the executor
 * passes no `punchBreaksSince`): a few CLOCK runs see each finished record, the external ids keep it idempotent.
 */
export const PUNCH_BREAKS_LOOKBACK_MS = 10 * 60_000;
/** By-id reads per ABSENT_EMPLOYEES step (each step is one apply transaction). */
export const ABSENT_EMPLOYEES_PER_STEP = 5;

const DAY_MS = 86_400_000;

const instantSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
]);

const settingsSchema = z.object({
  portalId: z.string().regex(/^[0-9]{1,16}$/),
  portalTimezone: z.string().nullable(),
  runKind: z.enum(["STRUCTURE", "DIRECTORY", "IMPORT_EMPLOYEES", "SYNC", "CLOCK"]).optional(),
  retryAuth: z.boolean().optional(),
  includedDepartmentIds: z.array(z.string()).optional(),
  syncWindowDays: z.number().int().min(1).max(366).optional(),
  deletedShiftsSince: instantSchema.optional(),
  clockEventsFrom: instantSchema.optional(),
  punchBreaksSince: instantSchema.optional(),
  runId: z.string().optional(),
});

/**
 * `ProviderContext.settings` for Planday phases (the executor builds it from the connection, the mapping config
 * and the run). A type alias, so a value of it is a valid `ProviderContext.settings`.
 */
export type PlandayPhaseSettings = {
  /** The connection's `externalPortalId`: PORTAL_CHECK fails with INTEGRATION_PORTAL_MISMATCH when Planday disagrees. */
  readonly portalId: string;
  /** The portal's IANA zone (`externalPortalTimezone`); null: wall-clock values need the shift's own zone, windows use UTC. */
  readonly portalTimezone: string | null;
  /** SYNC runs (and `retryAuth`) force the refresh grant at PORTAL_CHECK (§4.3). */
  readonly runKind?: IntegrationSyncRunKind;
  readonly retryAuth?: boolean;
  /**
   * `includedDepartmentIds`. When given: shifts of other departments become OUT_OF_SCOPE removals (never imported,
   * and a mapped one is cancelled), SCHEDULE_DAYS reads these departments, and CLOCK_EVENTS drops punches of other
   * departments before anything is mapped. CLOCK_EVENTS without it keeps nothing.
   */
  readonly includedDepartmentIds?: readonly string[];
  /** `syncWindowDays`, for SHIFTS when `PhaseInputs.window` is not given. */
  readonly syncWindowDays?: number;
  /**
   * DELETED_SHIFTS watermark: `deletedShiftsCheckedAt`, on the first run `connectedAt`. The phase reads from one
   * day before it (Q30). Without it the window's start is used.
   */
  readonly deletedShiftsSince?: Date | string;
  /** CLOCK_EVENTS window start (default `now − 3 h`). */
  readonly clockEventsFrom?: Date | string;
  /** Read a punch record's breaks only when it was punched out after this (default `now − 10 min`). */
  readonly punchBreaksSince?: Date | string;
  /** Log field. */
  readonly runId?: string;
};

export interface ParsedPlandayPhaseSettings {
  readonly portalId: string;
  readonly portalTimezone: string | null;
  readonly runKind?: IntegrationSyncRunKind;
  readonly retryAuth: boolean;
  readonly includedDepartmentIds?: readonly string[];
  readonly syncWindowDays?: number;
  readonly deletedShiftsSince?: Date;
  readonly clockEventsFrom?: Date;
  readonly punchBreaksSince?: Date;
  readonly runId?: string;
}

/** Validates `ProviderContext.settings`; a malformed value is a programming error (TypeError). */
export function parsePlandayPhaseSettings(
  settings: Readonly<Record<string, unknown>>,
): ParsedPlandayPhaseSettings {
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success) {
    throw new TypeError(
      `Planday phase settings are invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.code}`)
        .join(", ")}`,
    );
  }
  const value = parsed.data;
  const zone = value.portalTimezone === null ? null : canonicalTimeZone(value.portalTimezone);
  return {
    portalId: value.portalId,
    portalTimezone: zone,
    retryAuth: value.retryAuth === true,
    ...(value.runKind !== undefined ? { runKind: value.runKind } : {}),
    ...(value.includedDepartmentIds !== undefined
      ? { includedDepartmentIds: [...new Set(value.includedDepartmentIds)] }
      : {}),
    ...(value.syncWindowDays !== undefined ? { syncWindowDays: value.syncWindowDays } : {}),
    ...(value.deletedShiftsSince !== undefined
      ? { deletedShiftsSince: value.deletedShiftsSince }
      : {}),
    ...(value.clockEventsFrom !== undefined ? { clockEventsFrom: value.clockEventsFrom } : {}),
    ...(value.punchBreaksSince !== undefined ? { punchBreaksSince: value.punchBreaksSince } : {}),
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Errors and warnings
// ---------------------------------------------------------------------------------------------------------

/**
 * PORTAL_CHECK read a different portal than the connection's (notes §2): the run fails and the connection goes to
 * AUTH_ERROR (§7.2, §7.6). An `AppError` with code INTEGRATION_PORTAL_MISMATCH (409).
 */
export class PlandayPortalMismatchError extends AppError {
  constructor() {
    super(
      "INTEGRATION_PORTAL_MISMATCH",
      "The Planday credentials now open a different portal than the one this connection uses.",
    );
    this.name = "PlandayPortalMismatchError";
  }
}

export function isPlandayPortalMismatchError(err: unknown): err is PlandayPortalMismatchError {
  return err instanceof PlandayPortalMismatchError;
}

/** The run-warning code behind a phase warning (`IntegrationSyncRun.warnings[].code`). */
export type PlandayWarningReason = "UNKNOWN_STATUS" | "INVALID_TIME" | "HIDDEN_DAYS_UNAVAILABLE";

/**
 * A phase warning: a `SyncError` (its `code` is the generic `SyncErrorCode`) carrying the specific reason the run
 * stores. Messages hold a status name, a reason or a path template, never personal data.
 */
export interface PlandayWarning extends SyncError {
  readonly reason: PlandayWarningReason;
}

/** The code to store for a phase warning: the Planday-specific reason when there is one, else the generic code. */
export function plandayWarningCode(warning: SyncError): string {
  const reason = (warning as Partial<PlandayWarning>).reason;
  return typeof reason === "string" ? reason : warning.code;
}

function warning(
  reason: PlandayWarningReason,
  code: SyncErrorCode,
  message: string,
  externalId?: string,
): PlandayWarning {
  return { reason, code, message, ...(externalId !== undefined ? { externalId } : {}) };
}

// ---------------------------------------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------------------------------------

type Cursor = Readonly<Record<string, unknown>>;

function cursorInt(cursor: Cursor, key: string): number {
  const value = cursor[key];
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Planday phase cursor: ${key} must be a non-negative integer`);
  }
  return value;
}

function cursorIds(cursor: Cursor, key: string): string[] {
  const value = cursor[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`Planday phase cursor: ${key} must be a list of ids`);
  }
  return value as string[];
}

function cursorCounts(cursor: Cursor, key: string): Record<string, number> {
  const value = cursor[key];
  if (value === undefined || value === null) return {};
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.values(value).every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
  ) {
    throw new TypeError(`Planday phase cursor: ${key} must map ids to counts`);
  }
  return { ...(value as Record<string, number>) };
}

/** One more page for a paged phase; a list that never ends fails like the pagination helper (`PAGINATION_RUNAWAY`). */
function nextPageCount(cursor: Cursor, path: string): number {
  const pages = cursorInt(cursor, "pages");
  if (pages >= MAX_PAGES_PER_LIST) {
    throw new PlandayError("PLANDAY_INVALID_RESPONSE", {
      reason: "PAGINATION_RUNAWAY",
      pathTemplate: pathTemplate(path),
    });
  }
  return pages + 1;
}

function uniqueBy<T>(records: readonly T[], key: (record: T) => string, seen?: Set<string>): T[] {
  const ids = seen ?? new Set<string>();
  return records.filter((record) => {
    const id = key(record);
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------------------

interface ShiftWindow {
  readonly range: SyncRange;
  /** Planday's inclusive `from` / `to` dates: one day wider on each side (notes §10.3 rule 5). */
  readonly queryFrom: string;
  readonly queryTo: string;
}

function windowZone(settings: ParsedPlandayPhaseSettings): string {
  return settings.portalTimezone ?? "UTC";
}

/** `PhaseInputs.window` when given, else `syncWindow(now, portal zone, days)`. */
function resolveShiftWindow(
  ctx: ProviderContext,
  settings: ParsedPlandayPhaseSettings,
  inputs: PhaseInputs,
  defaultDays: number,
): ShiftWindow {
  const zone = windowZone(settings);
  if (inputs.window) {
    const { from, to } = inputs.window;
    if (!(to.getTime() > from.getTime())) throw new RangeError("the sync window must not be empty");
    return {
      range: { from, to },
      queryFrom: addLocalDays(localDateOf(from, zone), -1),
      queryTo: addLocalDays(localDateOf(new Date(to.getTime() - 1), zone), 1),
    };
  }
  const window = syncWindow(ctx.now, zone, defaultDays);
  return {
    range: { from: window.from, to: window.to },
    queryFrom: window.queryFrom,
    queryTo: window.queryTo,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Shift classification for a page (provider side of §6.6)
// ---------------------------------------------------------------------------------------------------------

const REMOVAL_CLASSES: ReadonlySet<ShiftClass> = new Set(["DRAFT", "UNASSIGNED", "OUT_OF_SCOPE"]);

/**
 * What the provider can decide about one Planday shift: DRAFT / UNASSIGNED / OUT_OF_SCOPE (department, when the
 * scope is known) become `cancelled: true` records carrying the removal reason and no employee id (a mapped shift is
 * then cancelled, an unmapped one counted); UNKNOWN_STATUS / INVALID_TIME become warnings (never create, never
 * cancel); PUBLISHED records go to the sink, which adds the employee mapping and hidden days. A removal class whose
 * times cannot be read has no record to carry (`ExternalShift` needs instants): it comes back as `removal` only,
 * which a by-id read (ABSENT_SHIFTS) turns into a SHIFT_REMOVALS entry, since cancelling needs no times.
 */
function classifyForBatch(
  shift: PlandayShift,
  settings: ParsedPlandayPhaseSettings,
): {
  readonly record?: ExternalShift;
  readonly warning?: PlandayWarning;
  readonly removal?: ShiftRemovalReason;
} {
  const shiftClass = classifyPlandayShift(
    shift,
    settings.includedDepartmentIds ? { includedDepartmentIds: settings.includedDepartmentIds } : {},
  );
  if (shiftClass === "UNKNOWN_STATUS") {
    return {
      warning: warning(
        "UNKNOWN_STATUS",
        "MAPPING_FAILED",
        `Planday shift status "${shift.status.slice(0, 60)}" is not one ClockOff knows; the shift was skipped`,
        shift.externalId,
      ),
    };
  }
  if (!hasValidTimes(shift)) {
    if (REMOVAL_CLASSES.has(shiftClass)) {
      return { removal: removalReasonForClass(shiftClass) as ShiftRemovalReason };
    }
    if (shiftClass !== "INVALID_TIME") return {};
    const reason = shift.times.ok ? "" : shift.times.reason;
    return {
      warning: warning(
        "INVALID_TIME",
        "INVALID_TIME",
        `Planday shift times could not be read (${reason}); the shift was skipped`,
        shift.externalId,
      ),
    };
  }
  if (REMOVAL_CLASSES.has(shiftClass)) {
    const removalReason = removalReasonForClass(shiftClass) as ShiftRemovalReason;
    return {
      record: {
        ...toExternalShift(shift, { cancelled: true, removalReason }),
        externalEmployeeId: null,
      },
    };
  }
  return { record: toExternalShift(shift) };
}

// ---------------------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------------------

interface StepContext {
  readonly client: PlandayClient;
  readonly ctx: ProviderContext;
  readonly settings: ParsedPlandayPhaseSettings;
  readonly cursor: Cursor;
  readonly inputs: PhaseInputs;
}

function result(
  step: StepContext,
  done: boolean,
  cursor: Record<string, unknown>,
  batch?: SyncBatch,
  warnings?: readonly SyncError[],
): PhaseStepResult {
  // Unknown keys pass through (an executor's own state); the phase's keys replace theirs.
  return {
    done,
    cursor: { ...step.cursor, ...cursor },
    ...(batch ? { batch } : {}),
    requests: step.client.requestCount(),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

async function portalCheck(step: StepContext): Promise<PhaseStepResult> {
  const { client, settings } = step;
  if (settings.runKind === "SYNC" || settings.retryAuth) {
    // Whether a revocation also ends issued access tokens is undocumented (Q5): every SYNC proves the refresh token.
    await client.accessToken({ force: true });
  }
  const portal = await client.getPortalInfo();
  if (portal.externalId !== settings.portalId) throw new PlandayPortalMismatchError();
  return result(step, true, {}, { kind: "PORTAL", portal });
}

async function departmentsOrGroups(
  step: StepContext,
  kind: "LOCATIONS" | "TEAMS",
): Promise<PhaseStepResult> {
  const { client, cursor } = step;
  const offset = cursorInt(cursor, "offset");
  const pages = nextPageCount(
    cursor,
    kind === "LOCATIONS" ? "/hr/v1.0/departments" : "/hr/v1.0/employeegroups",
  );
  const seen = new Set(cursorIds(cursor, "seenIds"));
  const page =
    kind === "LOCATIONS"
      ? await client.listDepartments({ offset })
      : await client.listEmployeeGroups({ offset });
  const records = uniqueBy(page.records, (record) => record.externalId, seen);
  // `seenIds` on the last step lists every id read in the phase (for "missing from a complete list").
  const next = { offset: page.nextOffset, pages, seenIds: [...seen] };
  const batch: SyncBatch =
    kind === "LOCATIONS"
      ? { kind: "LOCATIONS", records, complete: page.done }
      : { kind: "TEAMS", records, complete: page.done };
  return result(step, page.done, next, batch);
}

/** A person from the active list as the sink sees it: `active` is false once their dismissal date has passed (Q23). */
function toSinkEmployee(employee: PlandayEmployee, now: Date): ExternalEmployee {
  return {
    externalId: employee.externalId,
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.email,
    externalLocationIds: employee.externalLocationIds,
    externalTeamIds: employee.externalTeamIds,
    primaryExternalLocationId: employee.primaryExternalLocationId,
    active:
      employee.deactivationDate === null || employee.deactivationDate.getTime() > now.getTime(),
  };
}

async function listEmployeesPage(step: StepContext): Promise<{
  readonly page: PlandayPage<PlandayEmployee>;
  readonly pages: number;
}> {
  const pages = nextPageCount(step.cursor, "/hr/v1.0/employees");
  const page = await step.client.listEmployees({
    offset: cursorInt(step.cursor, "offset"),
    portalZone: step.settings.portalTimezone,
  });
  return { page, pages };
}

async function employeeCounts(step: StepContext): Promise<PhaseStepResult> {
  const { page, pages } = await listEmployeesPage(step);
  const byDepartment = cursorCounts(step.cursor, "byDepartment");
  const byGroup = cursorCounts(step.cursor, "byGroup");
  for (const employee of uniqueBy(page.records, (e) => e.externalId)) {
    for (const key of departmentKeysOf(employee.externalLocationIds)) {
      byDepartment[key] = (byDepartment[key] ?? 0) + 1;
    }
    for (const group of new Set(employee.externalTeamIds)) {
      byGroup[group] = (byGroup[group] ?? 0) + 1;
    }
  }
  const next = { offset: page.nextOffset, pages, byDepartment, byGroup };
  // Counts only, in memory: the batch carries totals once the list is complete (never a person).
  return result(
    step,
    page.done,
    next,
    page.done ? { kind: "EMPLOYEE_COUNTS", byDepartment, byGroup } : undefined,
  );
}

async function employees(step: StepContext): Promise<PhaseStepResult> {
  const { page, pages } = await listEmployeesPage(step);
  const records = uniqueBy(page.records, (e) => e.externalId).map((e) =>
    toSinkEmployee(e, step.ctx.now),
  );
  return result(
    step,
    page.done,
    { offset: page.nextOffset, pages },
    { kind: "EMPLOYEES", records },
  );
}

async function deactivatedEmployees(step: StepContext): Promise<PhaseStepResult> {
  const { client, cursor, ctx, inputs, settings } = step;
  const pages = nextPageCount(cursor, "/hr/v1.0/employees/deactivated");
  const since = inputs.deactivatedSince;
  const page = await client.listDeactivatedEmployees({
    offset: cursorInt(cursor, "offset"),
    portalZone: settings.portalTimezone,
    ...(since ? { deactivatedFrom: new Date(since.getTime() - DAY_MS) } : {}),
  });
  const now = ctx.now.getTime();
  const records = uniqueBy(page.records, (r) => r.externalId).map((r) => ({
    externalId: r.externalId,
    // A future dismissal is reported ACTIVE: nothing happens until its date has passed (Q23).
    status:
      r.deactivationDate === null || r.deactivationDate.getTime() <= now
        ? ("DEACTIVATED" as const)
        : ("ACTIVE" as const),
  }));
  return result(
    step,
    page.done,
    { offset: page.nextOffset, pages },
    { kind: "EMPLOYEE_STATUS", records },
  );
}

async function absentEmployees(step: StepContext): Promise<PhaseStepResult> {
  const { client, cursor, ctx, inputs, settings } = step;
  const ids = [...new Set(inputs.recheckExternalIds ?? [])].slice(0, ABSENT_EMPLOYEE_RECHECK_LIMIT);
  const index = cursorInt(cursor, "index");
  const chunk = ids.slice(index, index + ABSENT_EMPLOYEES_PER_STEP);
  const now = ctx.now.getTime();
  const records: Array<{ externalId: string; status: "DEACTIVATED" | "REMOVED" | "ACTIVE" }> = [];
  for (const externalId of chunk) {
    try {
      const status = await client.getEmployeeStatus(externalId, {
        portalZone: settings.portalTimezone,
      });
      // Positive evidence only (D-045): deactivated and the date has passed.
      const deactivated =
        status.isDeactivated &&
        (status.deactivationDate === null || status.deactivationDate.getTime() <= now);
      records.push({ externalId, status: deactivated ? "DEACTIVATED" : "ACTIVE" });
    } catch (err) {
      // 400 or 404 on the by-id read is a record-level skip (notes §8, Q24), never a deactivation.
      if (!isPlandayNotFound(err)) throw err;
      records.push({ externalId, status: "REMOVED" });
    }
  }
  const nextIndex = index + chunk.length;
  return result(
    step,
    nextIndex >= ids.length,
    { index: nextIndex },
    records.length > 0 ? { kind: "EMPLOYEE_STATUS", records } : undefined,
  );
}

async function scheduleDays(step: StepContext): Promise<PhaseStepResult> {
  const { client, cursor, ctx, inputs, settings } = step;
  const departments = (settings.includedDepartmentIds ?? [])
    .filter((id) => id !== NO_DEPARTMENT_ID)
    .sort();
  const departmentIndex = cursorInt(cursor, "departmentIndex");
  const department = departments[departmentIndex];
  if (department === undefined) return result(step, true, { departmentIndex, offset: 0 });
  // The days the next SHIFTS or PREVIEW_SHIFTS phase reads.
  const windowDays =
    settings.runKind === "DIRECTORY"
      ? PREVIEW_WINDOW_DAYS
      : (settings.syncWindowDays ?? DEFAULT_SYNC_WINDOW_DAYS);
  const window = resolveShiftWindow(ctx, settings, inputs, windowDays);
  const offset = cursorInt(cursor, "offset");
  const pages = nextPageCount(cursor, "/scheduling/v1.0/scheduleDay");
  const advance = { departmentIndex: departmentIndex + 1, offset: 0, pages: 0 };
  const lastDepartment = departmentIndex + 1 >= departments.length;
  let page;
  try {
    page = await client.listScheduleDays({
      departmentId: department,
      from: window.queryFrom,
      to: window.queryTo,
      offset,
    });
  } catch (err) {
    // Q35: a 400 or 404 for a department skips the filter for it in this run; 429 / 5xx follow the normal rules.
    if (
      err instanceof PlandayError &&
      err.code === "PLANDAY_INVALID_RESPONSE" &&
      err.reason === "BAD_REQUEST" &&
      (err.status === 400 || err.status === 404)
    ) {
      return result(step, lastDepartment, advance, undefined, [
        warning(
          "HIDDEN_DAYS_UNAVAILABLE",
          "PROVIDER_ERROR",
          "Planday's hidden days could not be read for a department; its shifts were treated as visible",
          department,
        ),
      ]);
    }
    throw err;
  }
  const days = page.records
    .filter((day) => !day.isVisible)
    .map((day) => ({ externalDepartmentId: day.externalDepartmentId, date: day.date }));
  const batch: SyncBatch = { kind: "HIDDEN_DAYS", days };
  if (!page.done) {
    return result(step, false, { departmentIndex, offset: page.nextOffset, pages }, batch);
  }
  return result(step, lastDepartment, advance, batch);
}

function isRangeRefused(err: unknown): boolean {
  return (
    err instanceof PlandayError &&
    err.code === "PLANDAY_INVALID_RESPONSE" &&
    err.reason === "BAD_REQUEST" &&
    err.status === 400
  );
}

function cursorSlices(cursor: Cursor): Array<{ from: string; to: string }> | null {
  const value = cursor.slices;
  if (value === undefined || value === null) return null;
  const parsed = z
    .array(z.object({ from: z.iso.date(), to: z.iso.date() }))
    .min(1)
    .safeParse(value);
  if (!parsed.success) throw new TypeError("Planday phase cursor: slices must be date ranges");
  return parsed.data;
}

/** SHIFTS (the sync window) and PREVIEW_SHIFTS (the next 14 days): one page per step, records inside the window. */
async function shifts(step: StepContext, previewDays?: number): Promise<PhaseStepResult> {
  const { client, cursor, ctx, inputs, settings } = step;
  const window = resolveShiftWindow(
    ctx,
    settings,
    inputs,
    previewDays ?? settings.syncWindowDays ?? DEFAULT_SYNC_WINDOW_DAYS,
  );
  let slices = cursorSlices(cursor);
  let sliceIndex = cursorInt(cursor, "sliceIndex");
  const offset = cursorInt(cursor, "offset");
  const pages = nextPageCount(cursor, "/scheduling/v1.0/shifts");
  const read = (range: { from: string; to: string }, at: number) =>
    client.listShifts({
      from: range.from,
      to: range.to,
      offset: at,
      portalZone: settings.portalTimezone,
    });
  let page: PlandayPage<PlandayShift>;
  if (slices) {
    const slice = slices[sliceIndex];
    if (!slice) throw new TypeError("Planday phase cursor: sliceIndex is out of range");
    page = await read(slice, offset);
  } else {
    try {
      page = await read({ from: window.queryFrom, to: window.queryTo }, offset);
    } catch (err) {
      // Q37: the maximum range is undocumented; a 400 switches the phase to 14-day slices from the start.
      if (!isRangeRefused(err)) throw err;
      slices = splitDateRange(window.queryFrom, window.queryTo, SHIFT_RANGE_SLICE_DAYS);
      sliceIndex = 0;
      page = await read(slices[0] as { from: string; to: string }, 0);
    }
  }

  const records: ExternalShift[] = [];
  const warnings: PlandayWarning[] = [];
  for (const shift of uniqueBy(page.records, (s) => s.externalId)) {
    if (shift.times.ok && !overlapsWindow(shift.times, window.range)) continue;
    // A removal without readable times (`classified.removal`) has no record here: its mapped shift is not seen, so
    // ABSENT_SHIFTS re-reads it by id and cancels it.
    const classified = classifyForBatch(shift, settings);
    if (classified.record) records.push(classified.record);
    if (classified.warning) warnings.push(classified.warning);
  }

  let done = false;
  let next: Record<string, unknown>;
  if (!page.done) {
    next = { offset: page.nextOffset, pages, ...(slices ? { slices, sliceIndex } : {}) };
  } else if (slices && sliceIndex + 1 < slices.length) {
    next = { offset: 0, pages, slices, sliceIndex: sliceIndex + 1 };
  } else {
    done = true;
    next = { offset: page.nextOffset, pages, ...(slices ? { slices, sliceIndex } : {}) };
  }
  return result(step, done, next, { kind: "SHIFTS", records, window: window.range }, warnings);
}

async function deletedShifts(step: StepContext): Promise<PhaseStepResult> {
  const { client, cursor, ctx, inputs, settings } = step;
  const pages = nextPageCount(cursor, "/scheduling/v1.0/shifts/deleted");
  const since =
    settings.deletedShiftsSince ??
    resolveShiftWindow(ctx, settings, inputs, settings.syncWindowDays ?? DEFAULT_SYNC_WINDOW_DAYS)
      .range.from;
  // One day of overlap: the zone of `dateTimeDeleted` is undocumented (Q30); re-reading a deletion is idempotent.
  const page = await client.listDeletedShifts({
    offset: cursorInt(cursor, "offset"),
    deletedFrom: new Date(since.getTime() - DAY_MS),
  });
  const records = uniqueBy(page.records, (r) => r.externalId).map((r) => ({
    externalId: r.externalId,
    reason: "DELETED" as const,
  }));
  return result(
    step,
    page.done,
    { offset: page.nextOffset, pages },
    { kind: "SHIFT_REMOVALS", records },
  );
}

/** One by-id read per step: a 404 is NOT_FOUND; a body is classified and decided like a page record. */
async function absentShifts(step: StepContext): Promise<PhaseStepResult> {
  const { client, cursor, ctx, inputs, settings } = step;
  const ids = [...new Set(inputs.recheckExternalIds ?? [])].slice(0, ABSENT_SHIFT_RECHECK_LIMIT);
  const index = cursorInt(cursor, "index");
  const externalId = ids[index];
  if (externalId === undefined) return result(step, true, { index });
  const next = { index: index + 1 };
  const done = index + 1 >= ids.length;
  let shift: PlandayShift;
  try {
    shift = await client.getShift(externalId, { portalZone: settings.portalTimezone });
  } catch (err) {
    if (!isPlandayNotFound(err)) throw err;
    return result(step, done, next, {
      kind: "SHIFT_REMOVALS",
      records: [{ externalId, reason: "NOT_FOUND" }],
    });
  }
  const classified = classifyForBatch(shift, settings);
  const warnings = classified.warning ? [classified.warning] : [];
  if (classified.removal) {
    // A draft, open or out-of-scope shift whose times cannot be read: still a removal (cancelling needs no times).
    return result(step, done, next, {
      kind: "SHIFT_REMOVALS",
      records: [{ externalId, reason: classified.removal }],
    });
  }
  const record = classified.record;
  if (!record) return result(step, done, next, undefined, warnings);
  if (record.cancelled) {
    return result(
      step,
      done,
      next,
      {
        kind: "SHIFT_REMOVALS",
        records: [{ externalId, reason: record.removalReason ?? "DELETED" }],
      },
      warnings,
    );
  }
  // Unfiltered: the shift may have moved out of the window; the sink computes membership (§6.6).
  const window = resolveShiftWindow(
    ctx,
    settings,
    inputs,
    settings.syncWindowDays ?? DEFAULT_SYNC_WINDOW_DAYS,
  );
  return result(
    step,
    done,
    next,
    { kind: "SHIFTS", records: [record], window: window.range },
    warnings,
  );
}

function resolvePunchOut(value: string | null, zone: string): Date | null {
  if (!value) return null;
  try {
    return parsePlandayDateTime(value, zone).instant;
  } catch (err) {
    if (err instanceof PlandayTimeError) return null;
    throw err;
  }
}

/**
 * CLOCK_EVENTS (Beta, §6.8): punches from `now − 3 h` to `now + 1 h`. Records of departments that are not included
 * are dropped before anything is mapped (the list has no department filter); the sink drops punches of employees
 * that are not mapped to an in-scope ClockOff employee. Wall-clock punch times are read in the portal zone (Q43).
 */
async function clockEvents(step: StepContext): Promise<PhaseStepResult> {
  const { client, cursor, ctx, settings } = step;
  const pages = nextPageCount(cursor, "/punchclock/v1.0/punchclockshifts");
  const zone = windowZone(settings);
  const now = ctx.now.getTime();
  const from = settings.clockEventsFrom ?? new Date(now - CLOCK_EVENTS_LOOKBACK_MS);
  const to = new Date(now + CLOCK_EVENTS_LOOKAHEAD_MS);
  const breaksSince = (
    settings.punchBreaksSince ?? new Date(now - PUNCH_BREAKS_LOOKBACK_MS)
  ).getTime();
  const page = await client.listPunchClockShifts({
    from,
    to,
    portalZone: zone,
    offset: cursorInt(cursor, "offset"),
  });
  const included = new Set(settings.includedDepartmentIds ?? []);
  const records: ExternalClockEvent[] = [];
  for (const punch of uniqueBy(page.records, (p) => p.externalId)) {
    if (!included.has(punch.externalDepartmentId) || !punch.externalEmployeeId) continue;
    records.push(...toPunchClockEvents(punch, { portalId: settings.portalId, zone }));
    const punchedOut = resolvePunchOut(punch.endDateTime, zone);
    if (punchedOut && punchedOut.getTime() > breaksSince) {
      for (const brk of await client.listPunchClockBreaks(punch.externalId)) {
        records.push(
          ...toBreakClockEvents(brk, {
            portalId: settings.portalId,
            externalEmployeeId: punch.externalEmployeeId,
            zone,
          }),
        );
      }
    }
  }
  return result(
    step,
    page.done,
    { offset: page.nextOffset, pages },
    { kind: "CLOCK_EVENTS", records },
  );
}

/**
 * Runs one step of `phase` (`provider.runPhaseStep`). The database-only phases (MATCH_EMPLOYEES, REACTIVATIONS,
 * APPLY_EMPLOYEES) belong to the executor's sink and throw here; FINALISE is the executor's and is a no-op.
 */
export async function runPlandayPhaseStep(
  client: PlandayClient,
  ctx: ProviderContext,
  settings: ParsedPlandayPhaseSettings,
  phase: SyncPhase,
  cursor: Readonly<Record<string, unknown>>,
  inputs: PhaseInputs,
): Promise<PhaseStepResult> {
  if (isDatabaseOnlyPhase(phase)) {
    throw new TypeError(`${phase} is a database-only phase: the executor runs it against the sink`);
  }
  const step: StepContext = { client, ctx, settings, cursor, inputs };
  switch (phase) {
    case "PORTAL_CHECK":
      return portalCheck(step);
    case "DEPARTMENTS":
      return departmentsOrGroups(step, "LOCATIONS");
    case "EMPLOYEE_GROUPS":
      return departmentsOrGroups(step, "TEAMS");
    case "EMPLOYEE_COUNTS":
      return employeeCounts(step);
    case "EMPLOYEES":
      return employees(step);
    case "DEACTIVATED_EMPLOYEES":
      return deactivatedEmployees(step);
    case "ABSENT_EMPLOYEES":
      return absentEmployees(step);
    case "SCHEDULE_DAYS":
      return scheduleDays(step);
    case "PREVIEW_SHIFTS":
      return shifts(step, PREVIEW_WINDOW_DAYS);
    case "SHIFTS":
      return shifts(step);
    case "DELETED_SHIFTS":
      return deletedShifts(step);
    case "ABSENT_SHIFTS":
      return absentShifts(step);
    case "CLOCK_EVENTS":
      return clockEvents(step);
    case "FINALISE":
      return { done: true, cursor: {}, requests: 0 };
    default:
      throw new TypeError(`Unknown phase ${String(phase)}`);
  }
}
