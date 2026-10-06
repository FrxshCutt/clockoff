import { prisma, type Device, type ManagerOverride, type Prisma } from "@workmode/db";
import type { ShiftWithScheduledBreaks } from "./mobileMappers";

/** Organisation/employee-scoped queries for the mobile read endpoints. */

type Db = Prisma.TransactionClient | typeof prisma;

export async function loadEmployeeShifts(
  params: { organisationId: string; employeeId: string; from: Date; to: Date },
  db: Db = prisma,
): Promise<ShiftWithScheduledBreaks[]> {
  return db.shift.findMany({
    where: {
      organisationId: params.organisationId,
      employeeId: params.employeeId,
      status: "SCHEDULED",
      deletedAt: null,
      startsAt: { lt: params.to },
      endsAt: { gt: params.from },
    },
    include: { scheduledBreaks: true, location: { select: { id: true, name: true } } },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
}

/** Overrides in force at `now` for this employee: not revoked, started, not expired, employee-specific or org-wide. */
export async function loadActiveOverridesForEmployee(
  params: { organisationId: string; employeeId: string; now: Date },
  db: Db = prisma,
): Promise<ManagerOverride[]> {
  return db.managerOverride.findMany({
    where: {
      organisationId: params.organisationId,
      revokedAt: null,
      startsAt: { lte: params.now },
      expiresAt: { gt: params.now },
      OR: [{ employeeId: null }, { employeeId: params.employeeId }],
    },
    orderBy: [{ startsAt: "asc" }],
  });
}

export async function loadEmployeePrimaryLocation(
  organisationId: string,
  locationId: string | null,
  db: Db = prisma,
): Promise<{ id: string; name: string; timezone: string | null } | null> {
  if (!locationId) return null;
  return db.location.findFirst({
    where: { id: locationId, organisationId, deletedAt: null },
    select: { id: true, name: true, timezone: true },
  });
}

export async function updateDevice(
  deviceId: string,
  data: Prisma.DeviceUncheckedUpdateInput,
  db: Db = prisma,
): Promise<Device> {
  return db.device.update({ where: { id: deviceId }, data });
}

/** A PolicyVersion id is only "known" when its policy belongs to this organisation. */
export async function policyVersionExistsInOrganisation(
  organisationId: string,
  versionId: string,
  db: Db = prisma,
): Promise<boolean> {
  const row = await db.policyVersion.findFirst({
    where: { id: versionId, policy: { organisationId } },
    select: { id: true },
  });
  return row !== null;
}
