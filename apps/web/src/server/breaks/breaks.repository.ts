import {
  prisma,
  type BreakSession,
  type Prisma,
  type ScheduledBreak,
  type Shift,
} from "@workmode/db";
import type { BreakSessionClosure } from "@workmode/shared/breaks/breakRules";

/** Organisation-scoped break-session queries. `organisationId` always comes from a verified context. */

type Db = Prisma.TransactionClient | typeof prisma;

export type ShiftForBreaks = Shift & { scheduledBreaks: ScheduledBreak[] };

/**
 * `SELECT … FOR UPDATE` on the employee's shift row so concurrent break starts for one shift serialise
 * (the partial unique index `break_sessions_one_active_per_shift` is the backstop). Returns null when the
 * shift does not exist for this employee in this organisation (NOT_FOUND to the caller — never 403).
 */
export async function lockShiftForEmployee(
  tx: Prisma.TransactionClient,
  params: { organisationId: string; employeeId: string; shiftId: string },
): Promise<ShiftForBreaks | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM shifts
    WHERE id = ${params.shiftId}::uuid
      AND organisation_id = ${params.organisationId}::uuid
      AND employee_id = ${params.employeeId}::uuid
      AND deleted_at IS NULL
    FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.shift.findUnique({ where: { id: params.shiftId }, include: { scheduledBreaks: true } });
}

export async function findSessionByClientBreakId(
  organisationId: string,
  clientBreakId: string,
  db: Db = prisma,
): Promise<BreakSession | null> {
  return db.breakSession.findFirst({ where: { organisationId, clientBreakId } });
}

export async function listSessionsForShift(
  organisationId: string,
  shiftId: string,
  db: Db = prisma,
): Promise<BreakSession[]> {
  return db.breakSession.findMany({
    where: { organisationId, shiftId },
    orderBy: [{ startedAt: "asc" }],
  });
}

export async function findEmployeeSession(
  organisationId: string,
  employeeId: string,
  sessionId: string,
  db: Db = prisma,
): Promise<(BreakSession & { shift: Shift }) | null> {
  return db.breakSession.findFirst({
    where: { id: sessionId, organisationId, employeeId },
    include: { shift: true },
  });
}

/**
 * Persist closures from `expiredBreakSessionClosures`. Each update is guarded on `status = ACTIVE`, so a
 * closure applied concurrently by another tick/request is skipped; only the closures THIS call applied are
 * returned (the caller records their activity events exactly once).
 */
export async function applyBreakClosures(
  organisationId: string,
  closures: readonly BreakSessionClosure[],
  db: Db = prisma,
): Promise<BreakSessionClosure[]> {
  const applied: BreakSessionClosure[] = [];
  for (const closure of closures) {
    const result = await db.breakSession.updateMany({
      where: { id: closure.sessionId, organisationId, status: "ACTIVE" },
      data: { status: "ENDED", endedAt: closure.endedAt, endReason: closure.endReason },
    });
    if (result.count === 1) applied.push(closure);
  }
  return applied;
}

/** Guarded end: only an ACTIVE row is updated. Returns the row (updated or already ended) and whether this call ended it. */
export async function endSessionIfActive(
  organisationId: string,
  sessionId: string,
  data: { endedAt: Date; endReason: BreakSession["endReason"] },
  db: Db = prisma,
): Promise<{ session: BreakSession; ended: boolean }> {
  const result = await db.breakSession.updateMany({
    where: { id: sessionId, organisationId, status: "ACTIVE" },
    data: { status: "ENDED", endedAt: data.endedAt, endReason: data.endReason },
  });
  const session = await db.breakSession.findUniqueOrThrow({ where: { id: sessionId } });
  return { session, ended: result.count === 1 };
}

/** ACTIVE session whose planned end is still ahead at `now` (what the device should be relaxing right now). */
export async function findActiveSessionForEmployee(
  organisationId: string,
  employeeId: string,
  now: Date,
  db: Db = prisma,
): Promise<BreakSession | null> {
  return db.breakSession.findFirst({
    where: { organisationId, employeeId, status: "ACTIVE", plannedEndsAt: { gt: now } },
    orderBy: [{ startedAt: "desc" }],
  });
}
