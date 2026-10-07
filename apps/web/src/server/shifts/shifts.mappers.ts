import type { Prisma } from "@clockoff/db";
import {
  formatShiftRange,
  instantToLocal,
  localDateOf,
  minutesBetween,
} from "@clockoff/shared/time/time";
import type { Shift } from "@clockoff/validation/shifts";

/** Relations every shift response carries. */
export const shiftInclude = {
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      inviteStatus: true,
      primaryLocation: { select: { id: true, name: true } },
    },
  },
  location: { select: { id: true, name: true } },
  scheduledBreaks: {
    select: { id: true, offsetMinutesFromStart: true, durationMinutes: true },
    orderBy: { offsetMinutesFromStart: "asc" },
  },
} satisfies Prisma.ShiftInclude;

export type ShiftRow = Prisma.ShiftGetPayload<{ include: typeof shiftInclude }>;

/** Row → API DTO. Local fields are rendered in the shift's own timezone. */
export function toShiftDto(row: ShiftRow): Shift {
  const start = instantToLocal(row.startsAt, row.timezone);
  const end = instantToLocal(row.endsAt, row.timezone);
  return {
    id: row.id,
    employee: {
      id: row.employee.id,
      firstName: row.employee.firstName,
      lastName: row.employee.lastName,
      jobTitle: row.employee.jobTitle,
      primaryLocation: row.employee.primaryLocation
        ? { id: row.employee.primaryLocation.id, name: row.employee.primaryLocation.name }
        : null,
      inviteStatus: row.employee.inviteStatus,
    },
    location: row.location ? { id: row.location.id, name: row.location.name } : null,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    timezone: row.timezone,
    durationMinutes: minutesBetween(row.startsAt, row.endsAt),
    status: row.status,
    source: row.source,
    externalShiftId: row.externalShiftId,
    notes: row.notes,
    recurrenceRule: row.recurrenceRule,
    parentRecurrenceId: row.parentRecurrenceId,
    version: row.version,
    scheduledBreaks: row.scheduledBreaks.map((b) => ({
      id: b.id,
      offsetMinutesFromStart: b.offsetMinutesFromStart,
      durationMinutes: b.durationMinutes,
    })),
    isOvernight: localDateOf(row.endsAt, row.timezone) > localDateOf(row.startsAt, row.timezone),
    localDate: start.date,
    localStartTime: start.time,
    localEndTime: end.time,
    displayRange: formatShiftRange(row.startsAt, row.endsAt, row.timezone),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
