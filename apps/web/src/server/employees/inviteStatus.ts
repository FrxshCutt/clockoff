import { prisma } from "@workmode/db";
import type { InviteStatus } from "@workmode/shared/enums";
import { deriveInviteStatus } from "@workmode/shared/status/deriveInviteStatus";
import { publishEvent } from "@/server/events";
import type { Db } from "./employees.repository";

/**
 * Re-derive and persist `Employee.inviteStatus` (§9 lifecycle) from the facts that decide it: employment
 * status, an active EmployeeUserLink, the most recently registered device, and a live (PENDING / SENT,
 * unexpired) invite. Call after anything that changes one of them — invite created / revoked, join,
 * leave, device deactivation, a device-state report (the sync engineer's hook). Safe inside a transaction
 * (`db`); publishes a `device.status.changed` realtime hint when the value changed and `publish` is not
 * false.
 */
export interface RecomputeInviteStatusOptions {
  db?: Db;
  now?: Date;
  publish?: boolean;
}

export interface RecomputedInviteStatus {
  inviteStatus: InviteStatus;
  previous: InviteStatus;
  changed: boolean;
}

export async function recomputeEmployeeInviteStatusDetailed(
  employeeId: string,
  options: RecomputeInviteStatusOptions = {},
): Promise<RecomputedInviteStatus> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const employee = await db.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: {
      id: true,
      organisationId: true,
      employmentStatus: true,
      inviteStatus: true,
      userLink: { select: { unlinkedAt: true } },
      devices: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { permissionState: true, selectionState: true, isActive: true },
      },
    },
  });
  const liveInvites = await db.employeeInvite.count({
    where: {
      employeeId,
      status: { in: ["PENDING", "SENT"] },
      expiresAt: { gt: now },
    },
  });
  const hasLink = employee.userLink !== null && employee.userLink.unlinkedAt === null;
  const inviteStatus = deriveInviteStatus({
    hasLink,
    // Only a device registered while the current link was made says anything about setup progress.
    device: hasLink ? (employee.devices[0] ?? null) : null,
    employmentStatus: employee.employmentStatus,
    hasPendingInvite: liveInvites > 0,
  });
  const previous = employee.inviteStatus;
  if (inviteStatus === previous) return { inviteStatus, previous, changed: false };

  await db.employee.update({ where: { id: employeeId }, data: { inviteStatus } });
  if (options.publish ?? true) {
    publishEvent({
      type: "device.status.changed",
      organisationId: employee.organisationId,
      employeeId,
      payload: { employeeId, inviteStatus, previousInviteStatus: previous },
    });
  }
  return { inviteStatus, previous, changed: true };
}

/** The new (or unchanged) `inviteStatus`. See {@link recomputeEmployeeInviteStatusDetailed}. */
export async function recomputeEmployeeInviteStatus(
  employeeId: string,
  options: RecomputeInviteStatusOptions = {},
): Promise<InviteStatus> {
  return (await recomputeEmployeeInviteStatusDetailed(employeeId, options)).inviteStatus;
}
