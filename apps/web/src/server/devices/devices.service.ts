import { prisma } from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import type {
  DeactivateDeviceInput,
  DeviceQuery,
  DeviceResponse,
  DeviceWithEmployee,
  ListDevicesResponse,
} from "@clockoff/validation/devices";
import type { DeviceStatus } from "@clockoff/validation/refs";
import { audit } from "@/server/audit/audit";
import {
  computeEmployeeStatus,
  getEmployeeStatusContext,
  recomputeEmployeeInviteStatus,
  toDeviceSummary,
  toEmployeeSummary,
  type EmployeeStatusContext,
} from "@/server/employees";
import { publishEvent } from "@/server/events";
import { revokeDeviceTokens } from "@/server/mobileAuth";
import type { ManagerContext } from "@/server/tenancy/context";
import {
  deactivateDeviceRow,
  findDeviceInOrganisation,
  findDevicesPage,
  type DeviceWithEmployeeRow,
} from "./devices.repository";

/**
 * Devices (§5 devices, §12): what a manager may know about a phone is the operational summary
 * (`toDeviceSummary` — no identifiers, push tokens, app lists or content), its employee and the derived
 * §9 badge. The badge comes from the same state-machine evaluation the employee list uses
 * (`getEmployeeStatusContext` + `computeEmployeeStatus`), evaluated for the specific device requested.
 * Deactivating a device revokes its refresh tokens, forgets its push token and re-derives the employee's
 * invite status; the phone must join again. Audited; no activity event (nothing happened on the device).
 */

function toDeviceStatusDto(
  computation: ReturnType<typeof computeEmployeeStatus> | null,
): DeviceStatus | null {
  if (!computation || !computation.status) return null;
  return {
    badge: computation.status.badge,
    reason: computation.status.reason ?? null,
    severity: computation.status.severity,
    since: computation.since?.toISOString() ?? null,
  };
}

/** Evaluate the badge for each row's own device (not merely the employee's current device). */
async function withStatuses(
  organisationId: string,
  organisationTimezone: string,
  rows: readonly DeviceWithEmployeeRow[],
  now: Date,
): Promise<DeviceWithEmployee[]> {
  if (rows.length === 0) return [];
  const employees = [...new Map(rows.map((row) => [row.employee.id, row.employee])).values()];
  const contexts = await getEmployeeStatusContext(
    organisationId,
    employees.map((e) => e.id),
    { now, employees, organisationTimezone },
  );
  return rows.map((row) => {
    const context: EmployeeStatusContext | undefined = contexts.get(row.employeeId);
    const computation = context ? computeEmployeeStatus({ ...context, device: row }, now) : null;
    return {
      device: toDeviceSummary(row),
      employee: toEmployeeSummary(row.employee),
      status: toDeviceStatusDto(computation),
    };
  });
}

/** `GET /api/devices?page&pageSize&employeeId&locationId&isActive&permissionState` */
export async function listDevices(
  ctx: ManagerContext,
  query: DeviceQuery,
): Promise<ListDevicesResponse> {
  const { rows, total } = await findDevicesPage(
    ctx.organisation.id,
    {
      employeeId: query.employeeId,
      locationId: query.locationId,
      isActive: query.isActive,
      permissionState: query.permissionState,
    },
    { skip: (query.page - 1) * query.pageSize, take: query.pageSize },
  );
  const items = await withStatuses(
    ctx.organisation.id,
    ctx.organisation.timezone,
    rows,
    new Date(),
  );
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

async function loadDeviceOrThrow(
  organisationId: string,
  id: string,
): Promise<DeviceWithEmployeeRow> {
  const row = await findDeviceInOrganisation(organisationId, id);
  if (!row) throw new AppError("NOT_FOUND", "Device not found");
  return row;
}

/** `GET /api/devices/:id` */
export async function getDevice(ctx: ManagerContext, id: string): Promise<DeviceResponse> {
  const row = await loadDeviceOrThrow(ctx.organisation.id, id);
  const [item] = await withStatuses(
    ctx.organisation.id,
    ctx.organisation.timezone,
    [row],
    new Date(),
  );
  return item!;
}

/**
 * `POST /api/devices/:id/deactivate` (employees:write). Idempotent: an already inactive device is
 * returned unchanged and nothing is written.
 */
export async function deactivateDevice(
  ctx: ManagerContext,
  id: string,
  input: DeactivateDeviceInput,
): Promise<DeviceResponse> {
  const organisationId = ctx.organisation.id;
  const existing = await loadDeviceOrThrow(organisationId, id);
  if (!existing.isActive) return getDevice(ctx, id);

  const now = new Date();
  const changed = await prisma.$transaction(async (tx) => {
    const flipped = await deactivateDeviceRow(tx, organisationId, id, now);
    if (flipped === 0) return false; // another request deactivated it meanwhile
    const revokedTokens = await revokeDeviceTokens(id, tx);
    const inviteStatus = await recomputeEmployeeInviteStatus(existing.employeeId, {
      db: tx,
      now,
      publish: false,
    });
    await audit(
      ctx,
      {
        action: "device.deactivated",
        entityType: "Device",
        entityId: id,
        before: { employeeId: existing.employeeId, isActive: true },
        after: {
          employeeId: existing.employeeId,
          isActive: false,
          deactivatedAt: now,
          revokedTokens,
          pushTokenRemoved: existing.pushTokenEncrypted !== null,
          inviteStatus,
          reason: input.reason?.trim() ? input.reason.trim() : null,
        },
        occurredAt: now,
      },
      tx,
    );
    return true;
  });
  if (changed) {
    publishEvent({
      type: "device.status.changed",
      organisationId,
      employeeId: existing.employeeId,
      payload: { deviceId: id, employeeId: existing.employeeId, isActive: false },
    });
  }
  return getDevice(ctx, id);
}
