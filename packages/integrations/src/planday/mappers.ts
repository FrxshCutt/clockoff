import type {
  ExternalClockEvent,
  ExternalEmployee,
  ExternalLocation,
  ExternalPortal,
  ExternalShift,
  ExternalTeam,
  ShiftRemovalReason,
} from "@clockoff/shared/providers/syncSink";
import { canonicalTimeZone } from "@clockoff/shared/time/zone";
import { plandayClockEventExternalId } from "./constants";
import type {
  RawDeactivatedEmployee,
  RawDeletedShift,
  RawDepartment,
  RawEmployee,
  RawEmployeeDetails,
  RawEmployeeGroup,
  RawPortalInfo,
  RawPunchClockBreak,
  RawPunchClockShift,
  RawScheduleDay,
  RawShift,
} from "./schemas";
import {
  assertShiftDateMatchesStart,
  parsePlandayDateTime,
  parsePlandayEffectiveDate,
  PlandayTimeError,
  toShiftInstants,
  type ShiftInstantsResult,
} from "./time";

/**
 * Allow-list mappers (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.7, spec §8): parsed Planday records →
 * ClockOff's vocabulary, built field by field (never by copying and deleting), so a record can only ever carry the
 * fields listed here. Ids stay the bare Planday ids as decimal strings (`ExternalEntityMap.externalId`); the
 * portal-qualified forms written to employees, shifts and clock events come from `constants.ts` (§2.6, D-050).
 */

/** The portal a connection reads. `reportedTimezone` is Planday's raw value, shown when it is not IANA (§6.7). */
export interface PlandayPortal extends ExternalPortal {
  readonly reportedTimezone: string | null;
}

export function mapPortal(raw: RawPortalInfo): PlandayPortal {
  const reported = raw.timeZone?.trim() ? raw.timeZone.trim() : null;
  return {
    externalId: raw.id,
    name: raw.name,
    timezone: reported ? canonicalTimeZone(reported) : null,
    reportedTimezone: reported,
    childPortalCount: raw.portals?.length ?? 0,
  };
}

/** A department (→ location). `number` is kept for the wizard's catalogue only. */
export interface PlandayDepartment extends ExternalLocation {
  readonly number: string | null;
}

export function mapDepartment(raw: RawDepartment): PlandayDepartment {
  const number = raw.number?.trim();
  return { externalId: raw.id, name: raw.name.trim(), number: number ? number : null };
}

/** An employee group (→ team). */
export type PlandayEmployeeGroup = ExternalTeam;

export function mapEmployeeGroup(raw: RawEmployeeGroup): PlandayEmployeeGroup {
  return { externalId: raw.id, name: raw.name.trim() };
}

/**
 * A person on the active list (`GET /hr/v1.0/employees`): the spec §8 fields only. `active` is true because the
 * list holds active employees only; `deactivationDate` carries a future dismissal, which the decision table acts on
 * once it has passed (§6.5, Q23). No phone, job title, user name, address or any other field exists here.
 */
export interface PlandayEmployee extends ExternalEmployee {
  readonly email: string | null;
  readonly externalLocationIds: readonly string[];
  readonly externalTeamIds: readonly string[];
  readonly primaryExternalLocationId: string | null;
  readonly deactivationDate: Date | null;
}

function cleanEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function uniqueIds(ids: readonly string[] | null | undefined): string[] {
  return [...new Set(ids ?? [])];
}

/** `zone` resolves bare `deactivationDate` values (the portal zone; UTC when unknown). */
export function mapEmployee(raw: RawEmployee, zone: string | null): PlandayEmployee {
  return {
    externalId: raw.id,
    firstName: raw.firstName.trim(),
    lastName: raw.lastName.trim(),
    email: cleanEmail(raw.email),
    externalLocationIds: uniqueIds(raw.departments),
    externalTeamIds: uniqueIds(raw.employeeGroups),
    primaryExternalLocationId: raw.primaryDepartmentId ?? null,
    active: true,
    deactivationDate: parsePlandayEffectiveDate(raw.deactivationDate, zone ?? "UTC"),
  };
}

/** A person on `GET /hr/v1.0/employees/deactivated`: the id and when the dismissal takes effect. */
export interface PlandayDeactivatedEmployee {
  readonly externalId: string;
  readonly deactivationDate: Date | null;
}

export function mapDeactivatedEmployee(
  raw: RawDeactivatedEmployee,
  zone: string | null,
): PlandayDeactivatedEmployee {
  return {
    externalId: raw.id,
    deactivationDate: parsePlandayEffectiveDate(raw.deactivationDate, zone ?? "UTC"),
  };
}

/**
 * The deactivation evidence of a by-id read (§6.5, D-045): only `isDeactivated: true` counts as positive
 * evidence; a missing or null flag is not.
 */
export interface PlandayEmployeeStatus {
  readonly externalId: string;
  readonly isDeactivated: boolean;
  readonly deactivationDate: Date | null;
}

export function mapEmployeeStatus(
  externalId: string,
  raw: RawEmployeeDetails,
  zone: string | null,
): PlandayEmployeeStatus {
  return {
    externalId,
    isDeactivated: raw.isDeactivated === true,
    deactivationDate: parsePlandayEffectiveDate(raw.deactivationDate, zone ?? "UTC"),
  };
}

/**
 * A shift with its times resolved (§4.8). `status` stays Planday's string; the sync classifies it (§6.6). When
 * `times.ok` is false the record is skipped with INVALID_TIME by the caller.
 */
export interface PlandayShift {
  readonly externalId: string;
  /** Null for an open (unassigned) shift. */
  readonly externalEmployeeId: string | null;
  /** Null when the shift is in no department (§6.3 "none"). */
  readonly externalDepartmentId: string | null;
  readonly externalGroupId: string | null;
  readonly status: string;
  /** The local start date Planday reported, if any. */
  readonly date: string | null;
  readonly times: ShiftInstantsResult;
}

/**
 * Maps one shift. Throws PLANDAY_INVALID_RESPONSE `TIME_ENCODING_MISMATCH` when its `date` disagrees with the
 * local date of its parsed start, which fails the whole page before anything of it is written.
 */
export function mapShift(
  raw: RawShift,
  portalZone: string | null,
  pathTemplate?: string,
): PlandayShift {
  const times = toShiftInstants(raw, portalZone);
  const date = raw.date ?? null;
  assertShiftDateMatchesStart(date, times, pathTemplate);
  return {
    externalId: raw.id,
    externalEmployeeId: raw.employeeId,
    externalDepartmentId: raw.departmentId,
    externalGroupId: raw.employeeGroupId ?? null,
    status: raw.status,
    date,
    times,
  };
}

/** A shift with readable times. */
export type TimedPlandayShift = PlandayShift & {
  readonly times: Extract<ShiftInstantsResult, { ok: true }>;
};

export function hasValidTimes(shift: PlandayShift): shift is TimedPlandayShift {
  return shift.times.ok;
}

/**
 * The sink record for a shift (spec §8: start, end, employee, department, time zone). `externalLocationId` is the
 * Planday department id; the sink resolves it through the mapping. Notes are never set (`Shift.notes` stays null
 * for synced shifts) and Planday's `comment` was never parsed.
 */
export function toExternalShift(
  shift: TimedPlandayShift,
  removal: { readonly cancelled: boolean; readonly removalReason?: ShiftRemovalReason | null } = {
    cancelled: false,
  },
): ExternalShift {
  return {
    externalId: shift.externalId,
    externalEmployeeId: shift.externalEmployeeId,
    externalLocationId: shift.externalDepartmentId,
    startsAt: shift.times.startsAt,
    endsAt: shift.times.endsAt,
    timezone: shift.times.timezone,
    cancelled: removal.cancelled,
    removalReason: removal.cancelled ? (removal.removalReason ?? null) : null,
    timeWarning: shift.times.timeWarning,
  };
}

/** An entry of `GET /scheduling/v1.0/shifts/deleted`: the id and, when readable, when it was deleted. */
export interface PlandayDeletedShift {
  readonly externalId: string;
  readonly deletedAt: Date | null;
}

export function mapDeletedShift(raw: RawDeletedShift): PlandayDeletedShift {
  let deletedAt: Date | null = null;
  if (raw.dateTimeDeleted) {
    try {
      // Zone undocumented (Q30); the one-day overlap of `deletedFrom` covers it, so UTC is enough here.
      deletedAt = parsePlandayDateTime(raw.dateTimeDeleted, "UTC").instant;
    } catch (err) {
      if (!(err instanceof PlandayTimeError)) throw err;
    }
  }
  return { externalId: raw.id, deletedAt };
}

/** Day visibility per department (`scheduleDay`); an unknown `isVisible` counts as visible (never cancel on doubt). */
export interface PlandayScheduleDay {
  readonly externalDepartmentId: string;
  readonly date: string;
  readonly isVisible: boolean;
}

export function mapScheduleDay(raw: RawScheduleDay): PlandayScheduleDay {
  return {
    externalDepartmentId: raw.departmentId,
    date: raw.date,
    isVisible: raw.isVisible !== false,
  };
}

/**
 * A punch clock record (Beta). Times stay as Planday's strings: without an offset they are wall-clock in the
 * matched shift's zone, which only the sync knows (notes §10.3 rule 2, Q43); `toPunchClockEvents` resolves them.
 */
export interface PlandayPunchClockShift {
  readonly externalId: string;
  readonly externalShiftId: string | null;
  readonly externalDepartmentId: string;
  readonly externalEmployeeId: string | null;
  readonly startDateTime: string | null;
  readonly endDateTime: string | null;
  readonly isApproved: boolean | null;
}

export function mapPunchClockShift(raw: RawPunchClockShift): PlandayPunchClockShift {
  return {
    externalId: raw.id,
    externalShiftId: raw.shiftId ?? null,
    externalDepartmentId: raw.departmentId,
    externalEmployeeId: raw.employeeId ?? null,
    startDateTime: raw.startDateTime ?? null,
    endDateTime: raw.endDateTime ?? null,
    isApproved: raw.isApproved ?? null,
  };
}

export interface PlandayPunchClockBreak {
  readonly externalId: string;
  readonly startDateTime: string;
  readonly endDateTime: string | null;
}

export function mapPunchClockBreak(raw: RawPunchClockBreak): PlandayPunchClockBreak {
  return {
    externalId: raw.id,
    startDateTime: raw.startDateTime,
    endDateTime: raw.endDateTime ?? null,
  };
}

function resolveInstant(value: string | null, zone: string): Date | null {
  if (!value) return null;
  try {
    return parsePlandayDateTime(value, zone).instant;
  } catch (err) {
    if (err instanceof PlandayTimeError) return null;
    throw err;
  }
}

/**
 * `ClockEvent`s for a punch record (§6.8): `CLOCK_IN` at the punch-in and, once punched out, `CLOCK_OUT`, with the
 * portal-qualified ids `<portalId>:<punchClockShiftId>:in|out`. A record without an employee yields nothing.
 */
export function toPunchClockEvents(
  punch: PlandayPunchClockShift,
  options: { readonly portalId: string; readonly zone: string },
): ExternalClockEvent[] {
  if (!punch.externalEmployeeId) return [];
  const events: ExternalClockEvent[] = [];
  const punchIn = resolveInstant(punch.startDateTime, options.zone);
  if (punchIn) {
    events.push({
      externalId: plandayClockEventExternalId(options.portalId, punch.externalId, "in"),
      externalEmployeeId: punch.externalEmployeeId,
      type: "CLOCK_IN",
      occurredAt: punchIn,
    });
  }
  const punchOut = resolveInstant(punch.endDateTime, options.zone);
  if (punchOut) {
    events.push({
      externalId: plandayClockEventExternalId(options.portalId, punch.externalId, "out"),
      externalEmployeeId: punch.externalEmployeeId,
      type: "CLOCK_OUT",
      occurredAt: punchOut,
    });
  }
  return events;
}

/** `BREAK_START` / `BREAK_END` reference events for a punch break: `<portalId>:<breakId>:start|end`. */
export function toBreakClockEvents(
  brk: PlandayPunchClockBreak,
  options: {
    readonly portalId: string;
    readonly externalEmployeeId: string;
    readonly zone: string;
  },
): ExternalClockEvent[] {
  const events: ExternalClockEvent[] = [];
  const start = resolveInstant(brk.startDateTime, options.zone);
  if (start) {
    events.push({
      externalId: plandayClockEventExternalId(options.portalId, brk.externalId, "start"),
      externalEmployeeId: options.externalEmployeeId,
      type: "BREAK_START",
      occurredAt: start,
    });
  }
  const end = resolveInstant(brk.endDateTime, options.zone);
  if (end) {
    events.push({
      externalId: plandayClockEventExternalId(options.portalId, brk.externalId, "end"),
      externalEmployeeId: options.externalEmployeeId,
      type: "BREAK_END",
      occurredAt: end,
    });
  }
  return events;
}
