import { prisma, type Prisma } from "@clockoff/db";
import type { PermissionState } from "@clockoff/shared/enums";
import { employeeInclude } from "@/server/employees/employees.repository";

/**
 * Device rows with their employee (the employee row shape the status helpers in `@/server/employees`
 * expect). Devices of archived employees are never listed. Scoped by the verified organisation id.
 */

export type Db = Prisma.TransactionClient | typeof prisma;

export const deviceWithEmployeeInclude = {
  policyVersion: { select: { id: true, versionNumber: true } },
  employee: { include: employeeInclude },
} satisfies Prisma.DeviceInclude;
export type DeviceWithEmployeeRow = Prisma.DeviceGetPayload<{
  include: typeof deviceWithEmployeeInclude;
}>;

export interface DeviceFilters {
  employeeId?: string;
  /** Employees whose primary or additional location is this one. */
  locationId?: string;
  isActive?: boolean;
  permissionState?: readonly PermissionState[];
}

function deviceWhere(organisationId: string, filters: DeviceFilters): Prisma.DeviceWhereInput {
  return {
    organisationId,
    employee: {
      deletedAt: null,
      ...(filters.locationId
        ? {
            OR: [
              { primaryLocationId: filters.locationId },
              { locations: { some: { locationId: filters.locationId } } },
            ],
          }
        : {}),
    },
    ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
    ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
    ...(filters.permissionState && filters.permissionState.length > 0
      ? { permissionState: { in: [...filters.permissionState] } }
      : {}),
  };
}

export async function findDevicesPage(
  organisationId: string,
  filters: DeviceFilters,
  page: { skip: number; take: number },
  db: Db = prisma,
): Promise<{ rows: DeviceWithEmployeeRow[]; total: number }> {
  const where = deviceWhere(organisationId, filters);
  const [rows, total] = await Promise.all([
    db.device.findMany({
      where,
      include: deviceWithEmployeeInclude,
      orderBy: [
        { isActive: "desc" },
        { lastDeviceSyncAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      skip: page.skip,
      take: page.take,
    }),
    db.device.count({ where }),
  ]);
  return { rows, total };
}

export async function findDeviceInOrganisation(
  organisationId: string,
  deviceId: string,
  db: Db = prisma,
): Promise<DeviceWithEmployeeRow | null> {
  return db.device.findFirst({
    where: { id: deviceId, organisationId, employee: { deletedAt: null } },
    include: deviceWithEmployeeInclude,
  });
}

/** Flip an active device to inactive (and forget its push token). Returns 1 when this call did it. */
export async function deactivateDeviceRow(
  tx: Prisma.TransactionClient,
  organisationId: string,
  deviceId: string,
  now: Date,
): Promise<number> {
  const result = await tx.device.updateMany({
    where: { id: deviceId, organisationId, isActive: true },
    data: { isActive: false, deactivatedAt: now, pushTokenEncrypted: null },
  });
  return result.count;
}
