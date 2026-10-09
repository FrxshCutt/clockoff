import type { ActivityEvent, Prisma } from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import type { ScheduledBreakInput } from "@clockoff/validation/shifts";
import { recordActivity } from "@/server/activity/recordActivity";
import { shiftInclude, type ShiftRow } from "./shifts.mappers";
import { findActiveBreakSession } from "./shifts.repository";

/**
 * Write helpers shared by the manager-facing shift service (`shifts.service.ts`) and the integration writers
 * (`shifts.integration.ts`). They take a {@link ShiftActor} instead of a `ManagerContext`, so the same
 * optimistic lock, break handling and activity rows serve a manager's edit and a provider sync alike.
 */

/** Who changes a shift: a manager (`actorUserId` set) or the system (an integration sync, a job). */
export interface ShiftActor {
  organisationId: string;
  actorType: "MANAGER" | "SYSTEM";
  actorUserId: string | null;
}

/** The fields a shift activity / audit snapshot reads. */
export interface ShiftActivityRow {
  id: string;
  employeeId: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  version: number;
  status: string;
  parentRecurrenceId: string | null;
  source: string;
}

export type ShiftActivityType = "SHIFT_CREATED" | "SHIFT_UPDATED" | "SHIFT_CANCELLED";

export function instantsOf(row: { startsAt: Date; endsAt: Date }) {
  return { startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() };
}

export function breakInputs(row: ShiftRow): ScheduledBreakInput[] {
  return row.scheduledBreaks.map((b) => ({
    offsetMinutesFromStart: b.offsetMinutesFromStart,
    durationMinutes: b.durationMinutes,
  }));
}

/** Snapshot for audit `before` / `after` (operational fields only). */
export function auditSnapshot(row: ShiftRow) {
  return {
    employeeId: row.employeeId,
    locationId: row.locationId,
    ...instantsOf(row),
    timezone: row.timezone,
    status: row.status,
    notes: row.notes,
    version: row.version,
    recurrenceRule: row.recurrenceRule,
    parentRecurrenceId: row.parentRecurrenceId,
    scheduledBreaks: breakInputs(row),
  };
}

/** Metadata of a SHIFT_* activity row (the shift's identity, instants, version and status). */
export function shiftActivityMetadata(
  row: ShiftActivityRow,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    shiftId: row.id,
    ...instantsOf(row),
    timezone: row.timezone,
    version: row.version,
    status: row.status,
    source: row.source,
    ...(row.parentRecurrenceId ? { parentRecurrenceId: row.parentRecurrenceId } : {}),
    ...extra,
  };
}

/** One SHIFT_* activity row for a batched `activityEvent.createManyAndReturn` (same shape as below). */
export function shiftActivityData(
  actor: ShiftActor,
  type: ShiftActivityType,
  row: ShiftActivityRow,
  extra: Record<string, unknown> = {},
  occurredAt: Date = new Date(),
): Prisma.ActivityEventCreateManyInput {
  return {
    organisationId: actor.organisationId,
    employeeId: row.employeeId,
    deviceId: null,
    actorType: actor.actorType,
    actorUserId: actor.actorUserId,
    type,
    occurredAt,
    metadata: shiftActivityMetadata(row, extra) as Prisma.InputJsonValue,
    clientEventId: null,
  };
}

/**
 * Ends the shift's ACTIVE break session (reason SHIFT_ENDED) when `now` is no longer inside the shift's
 * window (`null` window = the shift is gone). Returns the activity event to publish after commit.
 */
export async function endActiveBreakOutside(
  tx: Prisma.TransactionClient,
  actor: ShiftActor,
  shift: { id: string; employeeId: string },
  window: { startsAt: Date; endsAt: Date } | null,
  now: Date,
): Promise<ActivityEvent | null> {
  const session = await findActiveBreakSession(shift.id, tx);
  if (!session) return null;
  return endBreakSessionOutside(tx, actor, shift, session, window, now);
}

/**
 * {@link endActiveBreakOutside} for a session already loaded (batched writers read the sessions of a whole
 * page in one query).
 */
export async function endBreakSessionOutside(
  tx: Prisma.TransactionClient,
  actor: ShiftActor,
  shift: { id: string; employeeId: string },
  session: { id: string; startedAt: Date; deviceId: string | null },
  window: { startsAt: Date; endsAt: Date } | null,
  now: Date,
): Promise<ActivityEvent | null> {
  if (window && now >= window.startsAt && now < window.endsAt) return null;
  const limit = window ? Math.min(now.getTime(), window.endsAt.getTime()) : now.getTime();
  const endedAt = new Date(Math.max(session.startedAt.getTime(), limit));
  await tx.breakSession.update({
    where: { id: session.id },
    data: { status: "ENDED", endedAt, endReason: "SHIFT_ENDED" },
  });
  const { event } = await recordActivity(
    {
      organisationId: actor.organisationId,
      employeeId: shift.employeeId,
      deviceId: session.deviceId,
      actorType: actor.actorType,
      actorUserId: actor.actorUserId,
      type: "BREAK_ENDED",
      occurredAt: endedAt,
      metadata: { breakSessionId: session.id, shiftId: shift.id, endReason: "SHIFT_ENDED" },
    },
    { db: tx, publish: false },
  );
  return event;
}

export async function recordShiftActivity(
  tx: Prisma.TransactionClient,
  actor: ShiftActor,
  type: ShiftActivityType,
  row: ShiftActivityRow,
  extra: Record<string, unknown> = {},
): Promise<ActivityEvent> {
  const { event } = await recordActivity(
    {
      organisationId: actor.organisationId,
      employeeId: row.employeeId,
      actorType: actor.actorType,
      actorUserId: actor.actorUserId,
      type,
      metadata: shiftActivityMetadata(row, extra),
    },
    { db: tx, publish: false },
  );
  return event;
}

/** Extra conditions an optimistic write must also meet (the integration writers pin the managing integration). */
export interface ShiftWriteGuard {
  /** The row must still be managed by exactly this integration (`null`: by none). */
  managedByIntegrationId?: string | null;
}

/**
 * Writes `data` to a shift only while its `version` is still the one the caller read (optimistic lock) and
 * bumps the version. A change that landed in between — another manager's edit, a cancel, a delete —
 * answers CONFLICT with the current version (NOT_FOUND once the row is gone) instead of overwriting it.
 * `breaks`, when given, replace the scheduled breaks. `guard` adds conditions to the same `WHERE` (a row
 * that no longer meets them answers CONFLICT with `details.reason = "MANAGED_BY_CHANGED"`). Returns the
 * fresh row.
 */
export async function updateShiftRow(
  tx: Prisma.TransactionClient,
  organisationId: string,
  current: Pick<ShiftRow, "id" | "version">,
  data: Omit<Prisma.ShiftUncheckedUpdateManyInput, "id" | "organisationId" | "version">,
  breaks?: readonly ScheduledBreakInput[],
  guard: ShiftWriteGuard = {},
): Promise<ShiftRow> {
  const result = await tx.shift.updateMany({
    where: {
      id: current.id,
      organisationId,
      version: current.version,
      deletedAt: null,
      ...(guard.managedByIntegrationId !== undefined
        ? { managedByIntegrationId: guard.managedByIntegrationId }
        : {}),
    },
    data: { ...data, version: { increment: 1 } },
  });
  if (result.count === 0) {
    const latest = await tx.shift.findFirst({
      where: { id: current.id, organisationId },
      select: { version: true, deletedAt: true, managedByIntegrationId: true },
    });
    if (!latest || latest.deletedAt) throw new AppError("NOT_FOUND", "Shift not found");
    if (
      guard.managedByIntegrationId !== undefined &&
      latest.version === current.version &&
      latest.managedByIntegrationId !== guard.managedByIntegrationId
    ) {
      throw new AppError("CONFLICT", "The shift is no longer managed by this integration", {
        details: { currentVersion: latest.version, reason: "MANAGED_BY_CHANGED" },
      });
    }
    throw new AppError("CONFLICT", "The shift was changed by someone else; reload and try again", {
      details: { currentVersion: latest.version },
    });
  }
  if (breaks !== undefined) {
    await tx.scheduledBreak.deleteMany({ where: { shiftId: current.id } });
    if (breaks.length > 0) {
      await tx.scheduledBreak.createMany({
        data: breaks.map((b) => ({
          shiftId: current.id,
          offsetMinutesFromStart: b.offsetMinutesFromStart,
          durationMinutes: b.durationMinutes,
        })),
      });
    }
  }
  return tx.shift.findUniqueOrThrow({ where: { id: current.id }, include: shiftInclude });
}
