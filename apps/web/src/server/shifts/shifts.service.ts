import { prisma, type ActivityEvent } from "@clockoff/db";
import type { ApiErrorCode } from "@clockoff/shared/errors";
import { AppError } from "@clockoff/shared/errors";
import {
  addLocalDays,
  buildShiftInstants,
  expandRecurrence,
  expandShiftSeries,
  floatingMsToWallClock,
  instantToLocal,
  instantToWallClock,
  localDateOf,
  localDateRange,
  minutesBetween,
  recurrenceUntilFromLocalDate,
  resolveWallClock,
  wallClockMinutesBetween,
  wallClockToFloatingMs,
  weekStart,
  type RecurrenceOccurrence,
  type ShiftTimeWarning,
} from "@clockoff/shared/time/time";
import {
  SHIFT_LIMITS,
  isInstantShiftInput,
  type BulkShiftActionInput,
  type BulkShiftActionResponse,
  type CancelShiftInput,
  type CreateShiftInput,
  type CreateShiftResponse,
  type DuplicateShiftInput,
  type EmployeeShiftsQuery,
  type ListShiftsResponse,
  type ScheduledBreakInput,
  type Shift,
  type ShiftQuery,
  type ShiftResponse,
  type ShiftWarning,
  type SkippedOccurrence,
  type UpdateShiftInput,
} from "@clockoff/validation/shifts";
import { publishActivity } from "@/server/activity/recordActivity";
import { audit } from "@/server/audit/audit";
import { readOrganisationSettings } from "@/server/organisations/mappers";
import type { ManagerContext } from "@/server/tenancy/context";
import { encodeSeriesRule, parseSeriesRule, withCount } from "./recurrence";
import { publishScheduleChanged, publishScheduleChangedForShifts } from "./shifts.events";
import { integrationManagedError } from "./shifts.integration";
import {
  auditSnapshot,
  breakInputs,
  endActiveBreakOutside,
  instantsOf,
  recordShiftActivity,
  updateShiftRow,
  type ShiftActor,
} from "./shifts.internal";
import { shiftInclude, toShiftDto, type ShiftRow } from "./shifts.mappers";
import {
  completeEndedShifts,
  findEmployee,
  findLocation,
  findShift,
  findShifts,
  listFutureSeriesMembers,
  listScheduledIntervals,
  listSeriesRows,
  listShifts as listShiftRows,
  loadBreakPolicyFor,
  type Db,
  type EmployeeForShift,
} from "./shifts.repository";
import {
  MS_PER_DAY,
  MS_PER_MINUTE,
  RECURRENCE_HORIZON_DAYS,
  assertNoOverlap,
  assertShiftDuration,
  breaksFitting,
  conflictingShiftIds,
  daysBetweenLocalDates,
  dstWarnings,
  normaliseScheduledBreaks,
  scheduledBreakWarnings,
  shiftOverlapError,
} from "./shifts.rules";

/**
 * Shift scheduling (§5 schedule, §6.4 time). Rules:
 * - The employee must exist in the organisation and be ACTIVE; the location (when given) must be the
 *   organisation's. Timezone: request → location → organisation.
 * - 15 min ≤ length ≤ 24 h. New or moved times may not overlap another SCHEDULED shift of the same
 *   employee (half-open intervals, adjacent is fine) unless `allowOverlap` is set.
 * - Recurring series: the first shift is the anchor and carries the rule (with the end encoded as COUNT);
 *   occurrences up to 8 weeks ahead are created immediately, the rest by `materialiseRecurrences`.
 * - Every mutation bumps `version`, writes an audit entry, records an activity event and publishes
 *   `SCHEDULE_CHANGED` for the employee so their device re-syncs.
 * - Writes are optimistic-locked on `version` (`updateShiftRow`): a change that lands between reading and
 *   writing a shift answers CONFLICT, with or without `expectedVersion`.
 * - Only SCHEDULED shifts can be rescheduled; a cancelled or completed shift keeps its times (duplicate it
 *   instead). Notes, location and scheduled breaks stay editable on any status.
 * - A shift an integration manages (`managedByIntegrationId`, plan §6.6 "Read-only") cannot be updated,
 *   cancelled or deleted here (INTEGRATION_MANAGED; per item in bulk actions): it is edited in the provider and
 *   synced. Duplicating or repeating it creates an ordinary MANUAL shift and stays allowed.
 */

const TRANSACTION_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;

// ── helpers ─────────────────────────────────────────────────────────────────

async function requireActiveEmployee(
  organisationId: string,
  employeeId: string,
  db: Db = prisma,
): Promise<EmployeeForShift> {
  const employee = await findEmployee(organisationId, employeeId, db);
  if (!employee) throw new AppError("EMPLOYEE_NOT_FOUND", "Employee not found");
  if (employee.employmentStatus !== "ACTIVE") {
    throw new AppError("EMPLOYEE_INACTIVE", "Shifts can only be scheduled for active employees");
  }
  return employee;
}

async function requireLocation(organisationId: string, locationId: string, db: Db = prisma) {
  const location = await findLocation(organisationId, locationId, db);
  if (!location) throw new AppError("NOT_FOUND", "Location not found");
  return location;
}

async function requireShift(
  organisationId: string,
  shiftId: string,
  db: Db = prisma,
): Promise<ShiftRow> {
  const shift = await findShift(organisationId, shiftId, db);
  if (!shift) throw new AppError("NOT_FOUND", "Shift not found");
  return shift;
}

/** The manager behind a request, as the shared write helpers (`shifts.internal.ts`) take it. */
function shiftActor(ctx: ManagerContext): ShiftActor {
  return { organisationId: ctx.organisation.id, actorType: "MANAGER", actorUserId: ctx.user.id };
}

/** Managed shifts are read-only for managers (INTEGRATION_MANAGED): they change in the provider. */
function assertNotManaged(row: Pick<ShiftRow, "managedByIntegrationId">): void {
  if (row.managedByIntegrationId)
    throw integrationManagedError("Shift", row.managedByIntegrationId);
}

// ── reads ───────────────────────────────────────────────────────────────────

function weekStartsOnFor(ctx: ManagerContext): 1 | 7 {
  return readOrganisationSettings(ctx.organisation.settings).weekStartsOn === "SUNDAY" ? 7 : 1;
}

/** `from`/`to` default to the current week in the organisation's timezone; one given → 7 days from it. */
export function resolveShiftWindow(
  query: Pick<ShiftQuery, "from" | "to">,
  ctx: ManagerContext,
  now: Date = new Date(),
): { from: Date; to: Date } {
  if (query.from !== undefined && query.to !== undefined) {
    return { from: new Date(query.from), to: new Date(query.to) };
  }
  if (query.from !== undefined) {
    const from = new Date(query.from);
    return { from, to: new Date(from.getTime() + 7 * MS_PER_DAY) };
  }
  if (query.to !== undefined) {
    const to = new Date(query.to);
    return { from: new Date(to.getTime() - 7 * MS_PER_DAY), to };
  }
  const tz = ctx.organisation.timezone;
  const start = weekStart(now, tz, weekStartsOnFor(ctx));
  const firstDay = localDateOf(start, tz);
  const [from, to] = localDateRange(firstDay, addLocalDays(firstDay, 6), tz);
  return { from, to };
}

/** `GET /api/shifts` */
export async function listShifts(
  ctx: ManagerContext,
  query: ShiftQuery,
): Promise<ListShiftsResponse> {
  const { from, to } = resolveShiftWindow(query, ctx);
  const rows = await listShiftRows(ctx.organisation.id, {
    from,
    to,
    employeeId: query.employeeId,
    locationId: query.locationId,
    teamId: query.teamId,
    statuses: query.status,
  });
  return { shifts: rows.map(toShiftDto) };
}

/** `GET /api/employees/:id/shifts` — for the employees domain to call (the employee must already be checked). */
export async function listShiftsForEmployee(
  organisationId: string,
  employeeId: string,
  query: EmployeeShiftsQuery,
  now: Date = new Date(),
): Promise<ListShiftsResponse> {
  const maxRangeMs = SHIFT_LIMITS.maxQueryRangeDays * MS_PER_DAY;
  const from = query.from ? new Date(query.from) : new Date(now.getTime() - 7 * MS_PER_DAY);
  const requestedTo = query.to
    ? new Date(query.to)
    : new Date(Math.max(from.getTime(), now.getTime()) + maxRangeMs);
  // The employee query has no range refinement of its own, so the window is clamped to the same cap as
  // GET /shifts and `limit` is applied by the database rather than in memory.
  const to = new Date(Math.min(requestedTo.getTime(), from.getTime() + maxRangeMs));
  if (to.getTime() <= from.getTime()) return { shifts: [] };
  const rows = await listShiftRows(organisationId, {
    from,
    to,
    employeeId,
    statuses: query.status,
    limit: query.limit,
  });
  return { shifts: rows.map(toShiftDto) };
}

/** `GET /api/shifts/:id` */
export async function getShift(ctx: ManagerContext, shiftId: string): Promise<ShiftResponse> {
  return { shift: toShiftDto(await requireShift(ctx.organisation.id, shiftId)) };
}

// ── create ──────────────────────────────────────────────────────────────────

interface SeriesPlan {
  /** Anchor first. */
  occurrences: RecurrenceOccurrence[];
  /** Canonical rule with COUNT, or null for a single shift. */
  storedRule: string | null;
}

function planSeries(input: CreateShiftInput, timezone: string): SeriesPlan {
  const max = SHIFT_LIMITS.maxRecurrenceOccurrences;
  let occurrences: RecurrenceOccurrence[];
  if (isInstantShiftInput(input)) {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (!input.recurrence) {
      return {
        occurrences: [
          {
            startsAt,
            endsAt,
            localDate: localDateOf(startsAt, timezone),
            isAnchor: true,
            warnings: [],
          },
        ],
        storedRule: null,
      };
    }
    const wallClock = wallClockMinutesBetween(startsAt, endsAt, timezone);
    occurrences = expandRecurrence({
      rule: input.recurrence.rule,
      firstStartsAt: startsAt,
      durationMinutes: wallClock > 0 ? wallClock : minutesBetween(startsAt, endsAt),
      timezone,
      until: recurrenceUntilFromLocalDate(input.recurrence.until, timezone),
      max: max + 1,
    });
    // Honour the exact instants the manager sent for the anchor itself.
    if (occurrences[0]) occurrences[0] = { ...occurrences[0], startsAt, endsAt, warnings: [] };
  } else if (!input.recurrence) {
    const built = buildShiftInstants({
      date: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      timezone,
    });
    return {
      occurrences: [
        {
          startsAt: built.startsAt,
          endsAt: built.endsAt,
          localDate: input.date,
          isAnchor: true,
          warnings: built.warnings,
        },
      ],
      storedRule: null,
    };
  } else {
    occurrences = expandShiftSeries({
      date: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      timezone,
      rule: input.recurrence.rule,
      untilDate: input.recurrence.until,
      max: max + 1,
    });
  }
  if (occurrences.length === 0) {
    throw new AppError(
      "INVALID_RECURRENCE",
      "The series end date must be on or after the first shift",
      {
        details: { field: "recurrence.until" },
      },
    );
  }
  if (occurrences.length > max) {
    throw new AppError(
      "INVALID_RECURRENCE",
      `A series may create at most ${max} shifts; choose an earlier end date or a less frequent rule`,
      { details: { field: "recurrence.until", maxOccurrences: max } },
    );
  }
  return { occurrences, storedRule: encodeSeriesRule(input.recurrence!.rule, occurrences.length) };
}

/** `POST /api/shifts` */
export async function createShift(
  ctx: ManagerContext,
  input: CreateShiftInput,
): Promise<CreateShiftResponse> {
  const organisationId = ctx.organisation.id;
  const now = new Date();
  const employee = await requireActiveEmployee(organisationId, input.employeeId);
  const location = input.locationId
    ? await requireLocation(organisationId, input.locationId)
    : null;
  const timezone = input.timezone ?? location?.timezone ?? ctx.organisation.timezone;

  const series = planSeries(input, timezone);
  const anchor = series.occurrences[0]!;
  const durationMinutes = assertShiftDuration(anchor.startsAt, anchor.endsAt);
  const breaks = normaliseScheduledBreaks(input.scheduledBreaks, durationMinutes);

  const warnings: ShiftWarning[] = dstWarnings(anchor.warnings);
  const horizon = new Date(now.getTime() + RECURRENCE_HORIZON_DAYS * MS_PER_DAY);
  const children = series.occurrences
    .slice(1)
    .filter((o) => o.startsAt.getTime() < horizon.getTime());
  for (const child of children)
    warnings.push(...dstWarnings(child.warnings, { date: child.localDate }));

  const windowEnd = [anchor, ...children].reduce(
    (max, o) => (o.endsAt.getTime() > max.getTime() ? o.endsAt : max),
    anchor.endsAt,
  );
  const existing = await listScheduledIntervals(
    organisationId,
    [employee.id],
    anchor.startsAt,
    windowEnd,
  );
  assertNoOverlap(anchor.startsAt, anchor.endsAt, existing, { allowOverlap: input.allowOverlap });

  const taken = [...existing, { id: "anchor", startsAt: anchor.startsAt, endsAt: anchor.endsAt }];
  const skippedOccurrences: SkippedOccurrence[] = [];
  const planned: RecurrenceOccurrence[] = [];
  for (const child of children) {
    const conflicts = input.allowOverlap
      ? []
      : conflictingShiftIds(child.startsAt, child.endsAt, taken);
    if (conflicts.length > 0) {
      skippedOccurrences.push({ ...instantsOf(child), conflictingShiftIds: conflicts });
      continue;
    }
    planned.push(child);
    taken.push({ id: `planned-${planned.length}`, startsAt: child.startsAt, endsAt: child.endsAt });
  }

  if (breaks.length > 0) {
    const policy = await loadBreakPolicyFor(
      organisationId,
      employee,
      ctx.organisation.defaultBreakPolicyId,
      now,
    );
    warnings.push(...scheduledBreakWarnings(breaks, policy));
  }

  const { rows, events } = await prisma.$transaction(async (tx) => {
    const base = {
      organisationId,
      employeeId: employee.id,
      locationId: location?.id ?? null,
      timezone,
      status: "SCHEDULED" as const,
      source: "MANUAL" as const,
      notes: input.notes ?? null,
    };
    const anchorRow = await tx.shift.create({
      data: {
        ...base,
        startsAt: anchor.startsAt,
        endsAt: anchor.endsAt,
        recurrenceRule: series.storedRule,
        scheduledBreaks: { create: breaks },
      },
      include: shiftInclude,
    });
    const rows: ShiftRow[] = [anchorRow];
    for (const child of planned) {
      rows.push(
        await tx.shift.create({
          data: {
            ...base,
            startsAt: child.startsAt,
            endsAt: child.endsAt,
            parentRecurrenceId: anchorRow.id,
            scheduledBreaks: {
              create: breaksFitting(breaks, minutesBetween(child.startsAt, child.endsAt)),
            },
          },
          include: shiftInclude,
        }),
      );
    }
    const events: ActivityEvent[] = [];
    for (const row of rows)
      events.push(await recordShiftActivity(tx, shiftActor(ctx), "SHIFT_CREATED", row));
    await audit(
      ctx,
      {
        action: "shift.created",
        entityType: "Shift",
        entityId: anchorRow.id,
        after: {
          ...auditSnapshot(anchorRow),
          occurrenceIds: rows.slice(1).map((r) => r.id),
          skippedOccurrences: skippedOccurrences.length,
          allowOverlap: input.allowOverlap ?? false,
        },
      },
      tx,
    );
    return { rows, events };
  }, TRANSACTION_OPTIONS);

  for (const event of events) publishActivity(event);
  publishScheduleChanged(organisationId, {
    employeeId: employee.id,
    shiftIds: rows.map((r) => r.id),
    reason: "CREATED",
  });
  return { shifts: rows.map(toShiftDto), warnings, skippedOccurrences };
}

// ── update ──────────────────────────────────────────────────────────────────

interface NewTimes {
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  warnings: ShiftTimeWarning[];
  timesChanged: boolean;
}

/** Applies a PATCH body's time fields to the current row (local fields fall back to the current local values). */
function computeNewTimes(current: ShiftRow, input: UpdateShiftInput): NewTimes {
  const timezone = input.timezone ?? current.timezone;
  const hasLocal =
    input.date !== undefined || input.startTime !== undefined || input.endTime !== undefined;
  const hasInstant = input.startsAt !== undefined || input.endsAt !== undefined;
  if (hasLocal) {
    const start = instantToLocal(current.startsAt, current.timezone);
    const end = instantToLocal(current.endsAt, current.timezone);
    const built = buildShiftInstants({
      date: input.date ?? start.date,
      startTime: input.startTime ?? start.time,
      endTime: input.endTime ?? end.time,
      timezone,
    });
    return {
      startsAt: built.startsAt,
      endsAt: built.endsAt,
      timezone,
      warnings: built.warnings,
      timesChanged:
        built.startsAt.getTime() !== current.startsAt.getTime() ||
        built.endsAt.getTime() !== current.endsAt.getTime(),
    };
  }
  if (hasInstant) {
    const startsAt = input.startsAt !== undefined ? new Date(input.startsAt) : current.startsAt;
    const endsAt = input.endsAt !== undefined ? new Date(input.endsAt) : current.endsAt;
    return {
      startsAt,
      endsAt,
      timezone,
      warnings: [],
      timesChanged:
        startsAt.getTime() !== current.startsAt.getTime() ||
        endsAt.getTime() !== current.endsAt.getTime(),
    };
  }
  return {
    startsAt: current.startsAt,
    endsAt: current.endsAt,
    timezone,
    warnings: [],
    timesChanged: false,
  };
}

/** True when the body carries any of the time fields (a reschedule, as opposed to a metadata edit). */
function reschedules(input: UpdateShiftInput): boolean {
  return (
    input.date !== undefined ||
    input.startTime !== undefined ||
    input.endTime !== undefined ||
    input.startsAt !== undefined ||
    input.endsAt !== undefined
  );
}

function changedFields(input: UpdateShiftInput): string[] {
  return Object.entries(input)
    .filter(
      ([key, value]) =>
        value !== undefined && !["expectedVersion", "applyTo", "allowOverlap"].includes(key),
    )
    .map(([key]) => key);
}

/** `PATCH /api/shifts/:id` */
export async function updateShift(
  ctx: ManagerContext,
  shiftId: string,
  input: UpdateShiftInput,
): Promise<ShiftResponse> {
  const organisationId = ctx.organisation.id;
  const now = new Date();
  const current = await requireShift(organisationId, shiftId);
  assertNotManaged(current);
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
    throw new AppError("CONFLICT", "The shift was changed by someone else; reload and try again", {
      details: { currentVersion: current.version },
    });
  }
  if (reschedules(input) && current.status !== "SCHEDULED") {
    throw new AppError(
      "CONFLICT",
      "Only scheduled shifts can be rescheduled; duplicate the shift to put it back on the rota",
      { details: { status: current.status } },
    );
  }
  const inSeries = current.recurrenceRule !== null || current.parentRecurrenceId !== null;
  if ((input.applyTo ?? "THIS") === "THIS_AND_FUTURE" && inSeries) {
    return updateSeriesFrom(ctx, current, input, now);
  }
  return updateSingleShift(ctx, current, input, now);
}

async function resolveLocationPatch(organisationId: string, locationId: string | null | undefined) {
  if (locationId === undefined) return undefined;
  if (locationId === null) return null;
  return (await requireLocation(organisationId, locationId)).id;
}

async function updateSingleShift(
  ctx: ManagerContext,
  current: ShiftRow,
  input: UpdateShiftInput,
  now: Date,
): Promise<ShiftResponse> {
  const organisationId = ctx.organisation.id;
  const locationId = await resolveLocationPatch(organisationId, input.locationId);
  const times = computeNewTimes(current, input);
  const durationMinutes = assertShiftDuration(times.startsAt, times.endsAt);
  const breaks = normaliseScheduledBreaks(
    input.scheduledBreaks !== undefined ? input.scheduledBreaks : breakInputs(current),
    durationMinutes,
  );
  if (times.timesChanged && current.status === "SCHEDULED") {
    const others = await listScheduledIntervals(
      organisationId,
      [current.employeeId],
      times.startsAt,
      times.endsAt,
    );
    assertNoOverlap(times.startsAt, times.endsAt, others, {
      allowOverlap: input.allowOverlap,
      excludeIds: new Set([current.id]),
    });
  }
  const warnings: ShiftWarning[] = dstWarnings(times.warnings);
  if (breaks.length > 0 && (input.scheduledBreaks !== undefined || times.timesChanged)) {
    const employee = await findEmployee(organisationId, current.employeeId);
    if (employee) {
      const policy = await loadBreakPolicyFor(
        organisationId,
        employee,
        ctx.organisation.defaultBreakPolicyId,
        now,
      );
      warnings.push(...scheduledBreakWarnings(breaks, policy));
    }
  }

  const { row, events } = await prisma.$transaction(async (tx) => {
    const row = await updateShiftRow(
      tx,
      organisationId,
      current,
      {
        startsAt: times.startsAt,
        endsAt: times.endsAt,
        timezone: times.timezone,
        ...(locationId !== undefined ? { locationId } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      input.scheduledBreaks !== undefined ? breaks : undefined,
    );
    const events: ActivityEvent[] = [];
    if (times.timesChanged) {
      const breakEvent = await endActiveBreakOutside(tx, shiftActor(ctx), row, times, now);
      if (breakEvent) events.push(breakEvent);
    }
    events.push(
      await recordShiftActivity(tx, shiftActor(ctx), "SHIFT_UPDATED", row, {
        changedFields: changedFields(input),
      }),
    );
    await audit(
      ctx,
      {
        action: "shift.updated",
        entityType: "Shift",
        entityId: row.id,
        before: auditSnapshot(current),
        after: auditSnapshot(row),
      },
      tx,
    );
    return { row, events };
  }, TRANSACTION_OPTIONS);

  for (const event of events) publishActivity(event);
  publishScheduleChanged(organisationId, {
    employeeId: row.employeeId,
    shiftIds: [row.id],
    reason: "UPDATED",
  });
  return { shift: toShiftDto(row), ...(warnings.length > 0 ? { warnings } : {}) };
}

interface MemberPlan {
  row: ShiftRow;
  startsAt: Date;
  endsAt: Date;
  warnings: ShiftTimeWarning[];
  breaks: ScheduledBreakInput[];
}

/**
 * THIS_AND_FUTURE: applies the change to the edited shift and every later SCHEDULED occurrence of its
 * series. Times are applied as wall-clock values on each occurrence's own date (shifted by the same number
 * of days when the date changed). Editing an occurrence splits the series: it becomes the anchor of a new
 * series carrying the remaining COUNT and the old anchor's COUNT is cut off before it, so the recurrence
 * job keeps both halves consistent.
 */
async function updateSeriesFrom(
  ctx: ManagerContext,
  current: ShiftRow,
  input: UpdateShiftInput,
  now: Date,
): Promise<ShiftResponse> {
  const organisationId = ctx.organisation.id;
  const anchorId = current.parentRecurrenceId ?? current.id;
  const locationId = await resolveLocationPatch(organisationId, input.locationId);
  const times = computeNewTimes(current, input);
  const timezone = times.timezone;
  const futureMembers = (
    await listFutureSeriesMembers(organisationId, anchorId, current.startsAt)
  ).filter((m) => m.id !== current.id);
  const members: ShiftRow[] = [current, ...futureMembers];

  const newStart = instantToLocal(times.startsAt, timezone);
  const newEnd = instantToLocal(times.endsAt, timezone);
  const dateDelta = daysBetweenLocalDates(
    localDateOf(current.startsAt, current.timezone),
    newStart.date,
  );
  const retime = times.timesChanged || input.timezone !== undefined;

  const plans: MemberPlan[] = members.map((row) => {
    let startsAt = row.startsAt;
    let endsAt = row.endsAt;
    let warnings: ShiftTimeWarning[] = [];
    if (row.id === current.id) {
      startsAt = times.startsAt;
      endsAt = times.endsAt;
      warnings = times.warnings;
    } else if (retime) {
      const built = buildShiftInstants({
        date: addLocalDays(localDateOf(row.startsAt, row.timezone), dateDelta),
        startTime: newStart.time,
        endTime: newEnd.time,
        timezone,
      });
      startsAt = built.startsAt;
      endsAt = built.endsAt;
      warnings = built.warnings;
    }
    const durationMinutes = assertShiftDuration(startsAt, endsAt);
    const breaks =
      row.id === current.id
        ? normaliseScheduledBreaks(
            input.scheduledBreaks !== undefined ? input.scheduledBreaks : breakInputs(row),
            durationMinutes,
          )
        : breaksFitting(
            input.scheduledBreaks !== undefined ? input.scheduledBreaks : breakInputs(row),
            durationMinutes,
          );
    return { row, startsAt, endsAt, warnings, breaks };
  });

  if (retime) {
    const memberIds = new Set(members.map((m) => m.id));
    const windowStart = plans.reduce(
      (min, p) => (p.startsAt < min ? p.startsAt : min),
      plans[0]!.startsAt,
    );
    const windowEnd = plans.reduce((max, p) => (p.endsAt > max ? p.endsAt : max), plans[0]!.endsAt);
    const others = await listScheduledIntervals(
      organisationId,
      [current.employeeId],
      windowStart,
      windowEnd,
    );
    const planned = plans.map((p) => ({ id: p.row.id, startsAt: p.startsAt, endsAt: p.endsAt }));
    const conflicts = new Set<string>();
    for (const plan of plans) {
      for (const id of conflictingShiftIds(plan.startsAt, plan.endsAt, others, memberIds))
        conflicts.add(id);
      for (const id of conflictingShiftIds(
        plan.startsAt,
        plan.endsAt,
        planned,
        new Set([plan.row.id]),
      )) {
        conflicts.add(id);
      }
    }
    if (conflicts.size > 0 && !input.allowOverlap) throw shiftOverlapError([...conflicts]);
  }

  const warnings: ShiftWarning[] = [];
  for (const plan of plans) {
    warnings.push(
      ...dstWarnings(
        plan.warnings,
        plan.row.id === current.id ? undefined : { date: localDateOf(plan.startsAt, timezone) },
      ),
    );
  }
  const currentPlan = plans[0]!;
  if (
    currentPlan.breaks.length > 0 &&
    (input.scheduledBreaks !== undefined || times.timesChanged)
  ) {
    const employee = await findEmployee(organisationId, current.employeeId);
    if (employee) {
      const policy = await loadBreakPolicyFor(
        organisationId,
        employee,
        ctx.organisation.defaultBreakPolicyId,
        now,
      );
      warnings.push(...scheduledBreakWarnings(currentPlan.breaks, policy));
    }
  }

  const { rows, events } = await prisma.$transaction(async (tx) => {
    const events: ActivityEvent[] = [];
    const split = current.parentRecurrenceId !== null;
    let newAnchorRule: string | null = null;
    if (split) {
      const anchor = await tx.shift.findFirst({
        where: { id: anchorId, organisationId },
        select: { id: true, recurrenceRule: true },
      });
      const parsed = anchor?.recurrenceRule ? parseSeriesRule(anchor.recurrenceRule) : null;
      const seriesRows = await listSeriesRows(anchorId, tx);
      const before = seriesRows.filter(
        (r) => r.startsAt.getTime() < current.startsAt.getTime(),
      ).length;
      if (anchor && parsed) {
        await tx.shift.update({
          where: { id: anchor.id },
          data: { recurrenceRule: withCount(parsed, Math.max(1, before)) },
        });
        newAnchorRule = withCount(
          parsed,
          parsed.count === null ? null : Math.max(1, parsed.count - before),
        );
      } else {
        newAnchorRule = anchor?.recurrenceRule ?? null;
      }
      // Every later occurrence (whatever its status) now belongs to the new series.
      await tx.shift.updateMany({
        where: {
          organisationId,
          parentRecurrenceId: anchorId,
          startsAt: { gte: current.startsAt },
          id: { not: current.id },
        },
        data: { parentRecurrenceId: current.id },
      });
    }

    const rows: ShiftRow[] = [];
    for (const plan of plans) {
      const isCurrent = plan.row.id === current.id;
      const replaceBreaks = input.scheduledBreaks !== undefined || (retime && !isCurrent);
      const row = await updateShiftRow(
        tx,
        organisationId,
        plan.row,
        {
          startsAt: plan.startsAt,
          endsAt: plan.endsAt,
          timezone,
          ...(locationId !== undefined ? { locationId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(isCurrent && split
            ? { parentRecurrenceId: null, recurrenceRule: newAnchorRule }
            : {}),
        },
        replaceBreaks ? plan.breaks : undefined,
      );
      rows.push(row);
      if (retime) {
        const breakEvent = await endActiveBreakOutside(tx, shiftActor(ctx), row, plan, now);
        if (breakEvent) events.push(breakEvent);
      }
      events.push(
        await recordShiftActivity(tx, shiftActor(ctx), "SHIFT_UPDATED", row, {
          changedFields: changedFields(input),
          applyTo: "THIS_AND_FUTURE",
        }),
      );
    }
    await audit(
      ctx,
      {
        action: "shift.series_updated",
        entityType: "Shift",
        entityId: current.id,
        before: auditSnapshot(current),
        after: {
          ...auditSnapshot(rows[0]!),
          applyTo: "THIS_AND_FUTURE",
          affectedShiftIds: rows.map((r) => r.id),
          splitFromAnchorId: split ? anchorId : null,
        },
      },
      tx,
    );
    return { rows, events };
  }, TRANSACTION_OPTIONS);

  for (const event of events) publishActivity(event);
  publishScheduleChanged(organisationId, {
    employeeId: current.employeeId,
    shiftIds: rows.map((r) => r.id),
    reason: "UPDATED",
  });
  return { shift: toShiftDto(rows[0]!), ...(warnings.length > 0 ? { warnings } : {}) };
}

// ── delete / cancel ─────────────────────────────────────────────────────────

/** `DELETE /api/shifts/:id` — soft delete; the shift disappears from every list. */
export async function deleteShift(ctx: ManagerContext, shiftId: string): Promise<void> {
  const organisationId = ctx.organisation.id;
  const now = new Date();
  const current = await requireShift(organisationId, shiftId);
  assertNotManaged(current);
  const events = await prisma.$transaction(async (tx) => {
    const row = await updateShiftRow(tx, organisationId, current, { deletedAt: now });
    const events: ActivityEvent[] = [];
    const breakEvent = await endActiveBreakOutside(tx, shiftActor(ctx), row, null, now);
    if (breakEvent) events.push(breakEvent);
    events.push(
      await recordShiftActivity(tx, shiftActor(ctx), "SHIFT_CANCELLED", row, { removed: true }),
    );
    await audit(
      ctx,
      {
        action: "shift.deleted",
        entityType: "Shift",
        entityId: row.id,
        before: auditSnapshot(current),
      },
      tx,
    );
    return events;
  });
  for (const event of events) publishActivity(event);
  publishScheduleChanged(organisationId, {
    employeeId: current.employeeId,
    shiftIds: [current.id],
    reason: "DELETED",
  });
}

function assertCancellable(row: Pick<ShiftRow, "status">): void {
  if (row.status === "CANCELLED") throw new AppError("CONFLICT", "The shift is already cancelled");
  if (row.status === "COMPLETED")
    throw new AppError("CONFLICT", "A completed shift cannot be cancelled");
}

/** `POST /api/shifts/:id/cancel` — status CANCELLED; ends Work Mode (and any break) if in progress. */
export async function cancelShift(
  ctx: ManagerContext,
  shiftId: string,
  input: CancelShiftInput,
): Promise<ShiftResponse> {
  const organisationId = ctx.organisation.id;
  const now = new Date();
  const current = await requireShift(organisationId, shiftId);
  assertNotManaged(current);
  assertCancellable(current);
  const { row, events } = await prisma.$transaction(async (tx) => {
    const row = await updateShiftRow(tx, organisationId, current, { status: "CANCELLED" });
    const events: ActivityEvent[] = [];
    const breakEvent = await endActiveBreakOutside(tx, shiftActor(ctx), row, null, now);
    if (breakEvent) events.push(breakEvent);
    events.push(await recordShiftActivity(tx, shiftActor(ctx), "SHIFT_CANCELLED", row));
    await audit(
      ctx,
      {
        action: "shift.cancelled",
        entityType: "Shift",
        entityId: row.id,
        before: auditSnapshot(current),
        after: { ...auditSnapshot(row), reason: input.reason ?? null },
      },
      tx,
    );
    return { row, events };
  });
  for (const event of events) publishActivity(event);
  publishScheduleChanged(organisationId, {
    employeeId: row.employeeId,
    shiftIds: [row.id],
    reason: "CANCELLED",
  });
  return { shift: toShiftDto(row) };
}

// ── duplicate ───────────────────────────────────────────────────────────────

/** `POST /api/shifts/:id/duplicate` `{ date }` — same local times, location, notes and breaks on another date. */
export async function duplicateShift(
  ctx: ManagerContext,
  shiftId: string,
  input: DuplicateShiftInput,
): Promise<ShiftResponse> {
  const organisationId = ctx.organisation.id;
  const source = await requireShift(organisationId, shiftId);
  await requireActiveEmployee(organisationId, source.employeeId);
  const start = instantToLocal(source.startsAt, source.timezone);
  const end = instantToLocal(source.endsAt, source.timezone);
  const built = buildShiftInstants({
    date: input.date,
    startTime: start.time,
    endTime: end.time,
    timezone: source.timezone,
  });
  const durationMinutes = assertShiftDuration(built.startsAt, built.endsAt);
  const breaks = breaksFitting(breakInputs(source), durationMinutes);
  const others = await listScheduledIntervals(
    organisationId,
    [source.employeeId],
    built.startsAt,
    built.endsAt,
  );
  assertNoOverlap(built.startsAt, built.endsAt, others);

  const { row, event } = await prisma.$transaction(async (tx) => {
    const row = await tx.shift.create({
      data: {
        organisationId,
        employeeId: source.employeeId,
        locationId: source.locationId,
        startsAt: built.startsAt,
        endsAt: built.endsAt,
        timezone: source.timezone,
        status: "SCHEDULED",
        source: "MANUAL",
        notes: source.notes,
        scheduledBreaks: { create: breaks },
      },
      include: shiftInclude,
    });
    const event = await recordShiftActivity(tx, shiftActor(ctx), "SHIFT_CREATED", row, {
      duplicatedFromShiftId: source.id,
    });
    await audit(
      ctx,
      {
        action: "shift.duplicated",
        entityType: "Shift",
        entityId: row.id,
        after: { ...auditSnapshot(row), duplicatedFromShiftId: source.id },
      },
      tx,
    );
    return { row, event };
  });
  publishActivity(event);
  publishScheduleChanged(organisationId, {
    employeeId: row.employeeId,
    shiftIds: [row.id],
    reason: "CREATED",
  });
  const warnings = dstWarnings(built.warnings);
  return { shift: toShiftDto(row), ...(warnings.length > 0 ? { warnings } : {}) };
}

// ── bulk ────────────────────────────────────────────────────────────────────

interface BulkFailure {
  shiftId: string;
  code: ApiErrorCode;
  message: string;
}

function notFoundFailures(
  requested: readonly string[],
  found: ReadonlyMap<string, ShiftRow>,
): BulkFailure[] {
  return requested
    .filter((id) => !found.has(id))
    .map((shiftId) => ({ shiftId, code: "NOT_FOUND" as const, message: "Shift not found" }));
}

/** Shifts the same wall-clock start/end by whole days and minutes in the shift's timezone. */
function shiftWallClock(
  row: ShiftRow,
  deltaDays: number,
  deltaMinutes: number,
): { startsAt: Date; endsAt: Date } {
  const deltaMs = deltaDays * MS_PER_DAY + deltaMinutes * MS_PER_MINUTE;
  const startFloating =
    wallClockToFloatingMs(instantToWallClock(row.startsAt, row.timezone)) + deltaMs;
  const endFloating = wallClockToFloatingMs(instantToWallClock(row.endsAt, row.timezone)) + deltaMs;
  const start = resolveWallClock(floatingMsToWallClock(startFloating), row.timezone).instant;
  let end = resolveWallClock(floatingMsToWallClock(endFloating), row.timezone).instant;
  if (end.getTime() <= start.getTime())
    end = new Date(start.getTime() + (row.endsAt.getTime() - row.startsAt.getTime()));
  return { startsAt: start, endsAt: end };
}

/** `POST /api/shifts/bulk` — per-item results; one item failing never blocks the others. */
export async function bulkShiftAction(
  ctx: ManagerContext,
  input: BulkShiftActionInput,
): Promise<BulkShiftActionResponse> {
  const organisationId = ctx.organisation.id;
  const now = new Date();
  const rows = await findShifts(organisationId, input.shiftIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const failed: BulkFailure[] = notFoundFailures(input.shiftIds, byId);
  const ordered = input.shiftIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  // Managed shifts are read-only: CANCEL, DELETE and MOVE fail per item; REPEAT only copies them into
  // ordinary MANUAL shifts, like duplicateShift, and stays allowed.
  const editable =
    input.action === "REPEAT"
      ? ordered
      : ordered.filter((row) => {
          if (!row.managedByIntegrationId) return true;
          const err = integrationManagedError("Shift", row.managedByIntegrationId);
          failed.push({ shiftId: row.id, code: err.code, message: err.message });
          return false;
        });

  switch (input.action) {
    case "CANCEL": {
      const targets: ShiftRow[] = [];
      for (const row of editable) {
        try {
          assertCancellable(row);
          targets.push(row);
        } catch (err) {
          if (err instanceof AppError)
            failed.push({ shiftId: row.id, code: err.code, message: err.message });
          else throw err;
        }
      }
      const { updated, events } = await prisma.$transaction(async (tx) => {
        const updated: ShiftRow[] = [];
        const events: ActivityEvent[] = [];
        for (const row of targets) {
          const u = await tx.shift.update({
            where: { id: row.id },
            data: { status: "CANCELLED", version: { increment: 1 } },
            include: shiftInclude,
          });
          updated.push(u);
          const breakEvent = await endActiveBreakOutside(tx, shiftActor(ctx), u, null, now);
          if (breakEvent) events.push(breakEvent);
          events.push(
            await recordShiftActivity(tx, shiftActor(ctx), "SHIFT_CANCELLED", u, { bulk: true }),
          );
        }
        await audit(
          ctx,
          {
            action: "shift.bulk_cancelled",
            entityType: "Shift",
            after: {
              shiftIds: updated.map((u) => u.id),
              reason: input.payload?.reason ?? null,
              failed,
            },
          },
          tx,
        );
        return { updated, events };
      }, TRANSACTION_OPTIONS);
      for (const event of events) publishActivity(event);
      publishScheduleChangedForShifts(organisationId, updated, "CANCELLED");
      return {
        action: "CANCEL",
        processed: rows.length,
        succeeded: updated.length,
        failed,
        shifts: updated.map(toShiftDto),
      };
    }

    case "DELETE": {
      const events = await prisma.$transaction(async (tx) => {
        const events: ActivityEvent[] = [];
        for (const row of editable) {
          const u = await tx.shift.update({
            where: { id: row.id },
            data: { deletedAt: now, version: { increment: 1 } },
          });
          const breakEvent = await endActiveBreakOutside(tx, shiftActor(ctx), u, null, now);
          if (breakEvent) events.push(breakEvent);
          events.push(
            await recordShiftActivity(tx, shiftActor(ctx), "SHIFT_CANCELLED", u, {
              removed: true,
              bulk: true,
            }),
          );
        }
        await audit(
          ctx,
          {
            action: "shift.bulk_deleted",
            entityType: "Shift",
            after: { shiftIds: editable.map((r) => r.id), failed },
          },
          tx,
        );
        return events;
      }, TRANSACTION_OPTIONS);
      for (const event of events) publishActivity(event);
      publishScheduleChangedForShifts(organisationId, editable, "DELETED");
      return {
        action: "DELETE",
        processed: rows.length,
        succeeded: editable.length,
        failed,
        shifts: [],
      };
    }

    case "MOVE": {
      const plans: Array<{ row: ShiftRow; startsAt: Date; endsAt: Date }> = [];
      for (const row of editable) {
        if (row.status !== "SCHEDULED") {
          failed.push({
            shiftId: row.id,
            code: "CONFLICT",
            message: "Only scheduled shifts can be moved",
          });
          continue;
        }
        const moved = shiftWallClock(row, input.payload.deltaDays, input.payload.deltaMinutes);
        try {
          assertShiftDuration(moved.startsAt, moved.endsAt);
        } catch (err) {
          if (err instanceof AppError) {
            failed.push({ shiftId: row.id, code: err.code, message: err.message });
            continue;
          }
          throw err;
        }
        plans.push({ row, ...moved });
      }
      const accepted = await filterConflicting(organisationId, plans, failed);
      const { updated, events } = await prisma.$transaction(async (tx) => {
        const updated: ShiftRow[] = [];
        const events: ActivityEvent[] = [];
        for (const plan of accepted) {
          const u = await tx.shift.update({
            where: { id: plan.row.id },
            data: { startsAt: plan.startsAt, endsAt: plan.endsAt, version: { increment: 1 } },
            include: shiftInclude,
          });
          updated.push(u);
          const breakEvent = await endActiveBreakOutside(tx, shiftActor(ctx), u, plan, now);
          if (breakEvent) events.push(breakEvent);
          events.push(
            await recordShiftActivity(tx, shiftActor(ctx), "SHIFT_UPDATED", u, {
              changedFields: ["startsAt", "endsAt"],
              bulk: true,
              deltaDays: input.payload.deltaDays,
              deltaMinutes: input.payload.deltaMinutes,
            }),
          );
        }
        await audit(
          ctx,
          {
            action: "shift.bulk_moved",
            entityType: "Shift",
            after: {
              shiftIds: updated.map((u) => u.id),
              deltaDays: input.payload.deltaDays,
              deltaMinutes: input.payload.deltaMinutes,
              failed,
            },
          },
          tx,
        );
        return { updated, events };
      }, TRANSACTION_OPTIONS);
      for (const event of events) publishActivity(event);
      publishScheduleChangedForShifts(organisationId, updated, "UPDATED");
      return {
        action: "MOVE",
        processed: rows.length,
        succeeded: updated.length,
        failed,
        shifts: updated.map(toShiftDto),
      };
    }

    case "REPEAT": {
      const plans: Array<{
        row: ShiftRow;
        startsAt: Date;
        endsAt: Date;
        breaks: ScheduledBreakInput[];
      }> = [];
      const inactive = new Set<string>();
      for (const row of ordered) {
        if (row.employee && !inactive.has(row.employeeId)) {
          const employee = await findEmployee(organisationId, row.employeeId);
          if (!employee || employee.employmentStatus !== "ACTIVE") inactive.add(row.employeeId);
        }
        if (inactive.has(row.employeeId)) {
          failed.push({
            shiftId: row.id,
            code: "EMPLOYEE_INACTIVE",
            message: "The employee is no longer active",
          });
          continue;
        }
        const start = instantToLocal(row.startsAt, row.timezone);
        const end = instantToLocal(row.endsAt, row.timezone);
        for (let week = 1; week <= input.payload.weeks; week++) {
          const built = buildShiftInstants({
            date: addLocalDays(start.date, 7 * week),
            startTime: start.time,
            endTime: end.time,
            timezone: row.timezone,
          });
          plans.push({
            row,
            startsAt: built.startsAt,
            endsAt: built.endsAt,
            breaks: breaksFitting(breakInputs(row), minutesBetween(built.startsAt, built.endsAt)),
          });
        }
      }
      const accepted = await filterConflicting(organisationId, plans, failed, { copies: true });
      const { created, events } = await prisma.$transaction(async (tx) => {
        const created: ShiftRow[] = [];
        const events: ActivityEvent[] = [];
        for (const plan of accepted) {
          const c = await tx.shift.create({
            data: {
              organisationId,
              employeeId: plan.row.employeeId,
              locationId: plan.row.locationId,
              startsAt: plan.startsAt,
              endsAt: plan.endsAt,
              timezone: plan.row.timezone,
              status: "SCHEDULED",
              source: "MANUAL",
              notes: plan.row.notes,
              scheduledBreaks: { create: plan.breaks },
            },
            include: shiftInclude,
          });
          created.push(c);
          events.push(
            await recordShiftActivity(tx, shiftActor(ctx), "SHIFT_CREATED", c, {
              duplicatedFromShiftId: plan.row.id,
              bulk: true,
            }),
          );
        }
        await audit(
          ctx,
          {
            action: "shift.bulk_repeated",
            entityType: "Shift",
            after: {
              sourceShiftIds: ordered.map((r) => r.id),
              createdShiftIds: created.map((c) => c.id),
              weeks: input.payload.weeks,
              failed,
            },
          },
          tx,
        );
        return { created, events };
      }, TRANSACTION_OPTIONS);
      for (const event of events) publishActivity(event);
      publishScheduleChangedForShifts(organisationId, created, "CREATED");
      const failedSources = new Set(failed.map((f) => f.shiftId));
      const succeeded = ordered.filter((r) => !failedSources.has(r.id)).length;
      return {
        action: "REPEAT",
        processed: rows.length,
        succeeded,
        failed,
        shifts: created.map(toShiftDto),
      };
    }

    default: {
      const exhaustive: never = input;
      throw new Error(`Unknown bulk action ${String(exhaustive)}`);
    }
  }
}

/**
 * Drops planned intervals that overlap the employee's other SCHEDULED shifts or another accepted plan,
 * appending SHIFT_OVERLAP failures. For moves the plans' own rows are excluded from the comparison.
 */
async function filterConflicting<T extends { row: ShiftRow; startsAt: Date; endsAt: Date }>(
  organisationId: string,
  plans: readonly T[],
  failed: BulkFailure[],
  options: { copies?: boolean } = {},
): Promise<T[]> {
  if (plans.length === 0) return [];
  const employeeIds = [...new Set(plans.map((p) => p.row.employeeId))];
  const windowStart = plans.reduce(
    (min, p) => (p.startsAt < min ? p.startsAt : min),
    plans[0]!.startsAt,
  );
  const windowEnd = plans.reduce((max, p) => (p.endsAt > max ? p.endsAt : max), plans[0]!.endsAt);
  const existing = await listScheduledIntervals(
    organisationId,
    employeeIds,
    windowStart,
    windowEnd,
  );
  const excluded = options.copies ? new Set<string>() : new Set(plans.map((p) => p.row.id));
  const takenByEmployee = new Map<string, Array<{ id: string; startsAt: Date; endsAt: Date }>>();
  for (const e of existing) {
    if (excluded.has(e.id)) continue;
    const list = takenByEmployee.get(e.employeeId) ?? [];
    list.push(e);
    takenByEmployee.set(e.employeeId, list);
  }
  const accepted: T[] = [];
  plans.forEach((plan, index) => {
    const taken = takenByEmployee.get(plan.row.employeeId) ?? [];
    const conflicts = conflictingShiftIds(plan.startsAt, plan.endsAt, taken);
    if (conflicts.length > 0) {
      failed.push({
        shiftId: plan.row.id,
        code: "SHIFT_OVERLAP",
        message: `${options.copies ? "The copy starting" : "Moving the shift to"} ${plan.startsAt.toISOString()} overlaps ${conflicts.length === 1 ? "an existing shift" : `${conflicts.length} existing shifts`} (${conflicts.join(", ")})`,
      });
      return;
    }
    accepted.push(plan);
    taken.push({ id: `planned-${index}`, startsAt: plan.startsAt, endsAt: plan.endsAt });
    takenByEmployee.set(plan.row.employeeId, taken);
  });
  return accepted;
}

// ── jobs ────────────────────────────────────────────────────────────────────

/** Job entry point: SCHEDULED shifts that ended at or before `now` become COMPLETED. Returns the count. */
export async function markCompletedShifts(
  now: Date = new Date(),
  db: Db = prisma,
): Promise<number> {
  return completeEndedShifts(now, db);
}

/** Re-exported so the job seam (`workState/externalServices.ts`) can take both job entry points from here. */
export { materialiseRecurrences } from "./recurrence";
export type { MaterialiseRecurrencesReport } from "./recurrence";

export type { Shift };
