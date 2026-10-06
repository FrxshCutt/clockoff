import { prisma } from "@workmode/db";
import { AppError } from "@workmode/shared/errors";
import {
  expandRecurrence,
  formatRecurrenceRule,
  minutesBetween,
  validateRecurrenceRule,
  wallClockMinutesBetween,
  type ParsedRecurrenceRule,
  type RecurrenceOccurrence,
} from "@workmode/shared/time/time";
import { SHIFT_LIMITS } from "@workmode/validation/shifts";
import { errorSummary, logger, stackFrames } from "@/lib/logger";
import { publishActivity, recordActivity } from "@/server/activity/recordActivity";
import { publishScheduleChanged } from "./shifts.events";
import { shiftInclude } from "./shifts.mappers";
import { listRecurrenceAnchors, listScheduledIntervals, listSeriesRows } from "./shifts.repository";
import {
  MS_PER_DAY,
  RECURRENCE_HORIZON_DAYS,
  breaksFitting,
  conflictingShiftIds,
  type IntervalLike,
} from "./shifts.rules";

/**
 * Recurring series storage and materialisation.
 *
 * A series is its anchor shift (`parentRecurrenceId = null`, `recurrenceRule` set) plus child rows that
 * point at it. The manager's inclusive `until` date is stored as an RFC 5545 `COUNT` on the rule
 * (`FREQ=WEEKLY;BYDAY=MO;COUNT=12`): the rule stays valid RRULE text, `validateRecurrenceRule` accepts it,
 * and the job can expand the series from the anchor without a separate column.
 *
 * Materialisation is append-only: the job expands the series from the anchor's instants and creates the
 * occurrences that start AFTER the series' latest existing row (any status, including cancelled and
 * soft-deleted ones) and before `now + horizonDays`. Keying on `(parent, startsAt)` on top of that rule
 * means a run can never duplicate an occurrence, and an occurrence a manager moved or removed is never
 * re-created in its old slot.
 */

export function parseSeriesRule(rule: string): ParsedRecurrenceRule | null {
  const validation = validateRecurrenceRule(rule);
  return validation.ok ? validation.parsed : null;
}

/** Canonical rule text with `COUNT` set to the series' total number of occurrences (anchor included). */
export function encodeSeriesRule(rule: string, occurrenceCount: number): string {
  const validation = validateRecurrenceRule(rule);
  if (!validation.ok) {
    throw new AppError("INVALID_RECURRENCE", validation.error, { details: { rule } });
  }
  return formatRecurrenceRule({ ...validation.parsed, count: Math.max(1, occurrenceCount) });
}

export function withCount(parsed: ParsedRecurrenceRule, count: number | null): string {
  return formatRecurrenceRule({ ...parsed, count: count === null ? null : Math.max(1, count) });
}

export interface SeriesAnchorLike {
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  recurrenceRule: string;
}

/**
 * Occurrences of a stored series (anchor first) with `startsAt < until`. Uses the anchor's wall-clock
 * length so DST nights keep the typed times (22:00–06:00 stays 22:00–06:00).
 */
export function expandSeriesFromAnchor(
  anchor: SeriesAnchorLike,
  until: Date,
  max: number = SHIFT_LIMITS.maxRecurrenceOccurrences + 1,
): RecurrenceOccurrence[] {
  if (until.getTime() <= anchor.startsAt.getTime()) return [];
  const wallClock = wallClockMinutesBetween(anchor.startsAt, anchor.endsAt, anchor.timezone);
  const durationMinutes = wallClock > 0 ? wallClock : minutesBetween(anchor.startsAt, anchor.endsAt);
  return expandRecurrence({
    rule: anchor.recurrenceRule,
    firstStartsAt: anchor.startsAt,
    durationMinutes,
    timezone: anchor.timezone,
    until,
    max,
  });
}

export interface MaterialiseRecurrencesReport {
  seriesProcessed: number;
  created: number;
  /** Occurrences not created because they overlapped a scheduled shift (retried on later runs if freed). */
  skipped: number;
  /** Series whose expansion failed (logged); the others are unaffected. */
  failed: number;
}

/**
 * Job entry point (run every tick, idempotent): tops every recurring series up to `now + horizonDays`.
 * Scoped to one organisation when `organisationId` is given.
 */
export async function materialiseRecurrences(
  organisationId?: string,
  horizonDays?: number,
  now?: Date,
): Promise<MaterialiseRecurrencesReport>;
/** Job-seam form (`workState/externalServices.ts`): `materialiseRecurrences(now)` over every organisation. */
export async function materialiseRecurrences(now: Date): Promise<MaterialiseRecurrencesReport>;
export async function materialiseRecurrences(
  first?: string | Date,
  horizonDays: number = RECURRENCE_HORIZON_DAYS,
  nowArg: Date = new Date(),
): Promise<MaterialiseRecurrencesReport> {
  const organisationId = typeof first === "string" ? first : undefined;
  const now = first instanceof Date ? first : nowArg;
  const report: MaterialiseRecurrencesReport = {
    seriesProcessed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
  };
  const horizon = new Date(now.getTime() + horizonDays * MS_PER_DAY);
  const anchors = await listRecurrenceAnchors(organisationId);

  for (const anchor of anchors) {
    if (!anchor.recurrenceRule) continue;
    report.seriesProcessed += 1;
    // Inactive or removed employees get no new shifts; the series resumes if they are reactivated.
    if (anchor.employee.employmentStatus !== "ACTIVE" || anchor.employee.deletedAt) continue;
    try {
      const rows = await listSeriesRows(anchor.id);
      const frontier = rows.reduce(
        (max, row) => Math.max(max, row.startsAt.getTime()),
        anchor.startsAt.getTime(),
      );
      const occurrences = expandSeriesFromAnchor(
        {
          startsAt: anchor.startsAt,
          endsAt: anchor.endsAt,
          timezone: anchor.timezone,
          recurrenceRule: anchor.recurrenceRule,
        },
        horizon,
      );
      const candidates = occurrences.filter(
        (o) => !o.isAnchor && o.startsAt.getTime() > frontier && o.startsAt.getTime() < horizon.getTime(),
      );
      if (candidates.length === 0) continue;

      const windowStart = candidates[0]!.startsAt;
      const windowEnd = candidates.reduce(
        (max, o) => (o.endsAt.getTime() > max.getTime() ? o.endsAt : max),
        candidates[0]!.endsAt,
      );
      const taken: IntervalLike[] = await listScheduledIntervals(
        anchor.organisationId,
        [anchor.employeeId],
        windowStart,
        windowEnd,
      );
      const planned: RecurrenceOccurrence[] = [];
      for (const occurrence of candidates) {
        if (conflictingShiftIds(occurrence.startsAt, occurrence.endsAt, taken).length > 0) {
          report.skipped += 1;
          continue;
        }
        planned.push(occurrence);
        taken.push({ id: `planned-${planned.length}`, startsAt: occurrence.startsAt, endsAt: occurrence.endsAt });
      }
      if (planned.length === 0) continue;

      const { created, events } = await prisma.$transaction(async (tx) => {
        const created: Array<{ id: string }> = [];
        const events = [];
        for (const occurrence of planned) {
          const durationMinutes = minutesBetween(occurrence.startsAt, occurrence.endsAt);
          const row = await tx.shift.create({
            data: {
              organisationId: anchor.organisationId,
              employeeId: anchor.employeeId,
              locationId: anchor.locationId,
              startsAt: occurrence.startsAt,
              endsAt: occurrence.endsAt,
              timezone: anchor.timezone,
              status: "SCHEDULED",
              source: anchor.source,
              notes: anchor.notes,
              parentRecurrenceId: anchor.id,
              scheduledBreaks: {
                create: breaksFitting(anchor.scheduledBreaks, durationMinutes),
              },
            },
            include: shiftInclude,
          });
          created.push({ id: row.id });
          const { event } = await recordActivity(
            {
              organisationId: anchor.organisationId,
              employeeId: anchor.employeeId,
              actorType: "SYSTEM",
              type: "SHIFT_CREATED",
              metadata: {
                shiftId: row.id,
                startsAt: row.startsAt.toISOString(),
                endsAt: row.endsAt.toISOString(),
                timezone: row.timezone,
                parentRecurrenceId: anchor.id,
                source: row.source,
                materialised: true,
              },
            },
            { db: tx, publish: false },
          );
          events.push(event);
        }
        return { created, events };
      });
      for (const event of events) publishActivity(event);
      publishScheduleChanged(anchor.organisationId, {
        employeeId: anchor.employeeId,
        shiftIds: created.map((c) => c.id),
        reason: "MATERIALISED",
      });
      report.created += created.length;
    } catch (err) {
      report.failed += 1;
      logger.error(
        { error: errorSummary(err), stack: stackFrames(err), shiftId: anchor.id },
        "recurrence materialisation failed for a series",
      );
    }
  }
  return report;
}
