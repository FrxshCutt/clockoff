import { prisma, type Prisma } from "@workmode/db";

type Db = Prisma.TransactionClient | typeof prisma;

export interface ScheduleVersionShift {
  id: string;
  version: number;
  status: string;
}

/**
 * Deterministic per-employee schedule version (`Device.scheduleVersion`, `MobileSyncResponse.scheduleVersion`).
 *
 * It is a 32-bit FNV-1a hash over the sorted `id:version:status` signatures of EVERY non-deleted shift of the
 * employee, mapped into [1, 2_000_000_000] (0 = no shifts). It therefore changes exactly when a shift is
 * created, edited (version bump), cancelled, completed or soft-deleted — and never with the passage of time,
 * so a device that holds the same number already has the same schedule and the server records
 * SCHEDULE_SYNCED only when the number differs.
 */
export function computeScheduleVersion(shifts: readonly ScheduleVersionShift[]): number {
  if (shifts.length === 0) return 0;
  const signature = shifts
    .map((s) => `${s.id}:${s.version}:${s.status}`)
    .sort()
    .join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < signature.length; i++) {
    hash ^= signature.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 2_000_000_000) + 1;
}

export async function loadScheduleVersion(
  organisationId: string,
  employeeId: string,
  db: Db = prisma,
): Promise<number> {
  const shifts = await db.shift.findMany({
    where: { organisationId, employeeId, deletedAt: null },
    select: { id: true, version: true, status: true },
  });
  return computeScheduleVersion(shifts);
}
