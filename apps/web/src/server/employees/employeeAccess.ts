import type { ActivityEvent, Prisma } from "@workmode/db";
import type { ActorType, BreakEndReason } from "@workmode/shared/enums";
import { recordActivity } from "@/server/activity/recordActivity";

/**
 * Cut an employee's phones off, in one transaction, for deactivation, archiving and "leave workplace":
 * deactivate devices (and forget their push tokens), revoke every refresh token, unlink the mobile
 * identity, optionally revoke live invites, and end any break still running (so the Break Rules and the
 * dashboard never see a break outliving the person). Shifts are deliberately KEPT: inactive employees are
 * excluded from state computation (`deriveDeviceStatus` returns null for them), and a reactivated
 * employee's schedule should still be there.
 *
 * Returns the BREAK_ENDED activity rows written with `publish: false`; the caller publishes them after
 * the transaction commits (`publishActivity`).
 */
export interface RevokeEmployeeAccessInput {
  organisationId: string;
  employeeId: string;
  /** Only these devices (leave-workplace: the calling phone). Default: every device of the employee. */
  deviceIds?: readonly string[];
  /** Revoke PENDING / SENT invites too (manager deactivation / archive). */
  revokeInvites: boolean;
  /** Who is ending running breaks, for the BREAK_ENDED activity. */
  actor: { type: ActorType; userId?: string | null; deviceId?: string | null };
  breakEndReason: Extract<BreakEndReason, "MANAGER_ENDED" | "EMPLOYEE_ENDED">;
  now?: Date;
}

export interface RevokeEmployeeAccessResult {
  deactivatedDevices: number;
  revokedTokens: number;
  unlinked: boolean;
  revokedInvites: number;
  endedBreakEvents: ActivityEvent[];
}

export async function revokeEmployeeAccess(
  tx: Prisma.TransactionClient,
  input: RevokeEmployeeAccessInput,
): Promise<RevokeEmployeeAccessResult> {
  const now = input.now ?? new Date();
  const { organisationId, employeeId } = input;
  const deviceWhere: Prisma.DeviceWhereInput = {
    organisationId,
    employeeId,
    ...(input.deviceIds ? { id: { in: [...input.deviceIds] } } : {}),
  };

  const devices = await tx.device.updateMany({
    where: { ...deviceWhere, isActive: true },
    data: { isActive: false, deactivatedAt: now, pushTokenEncrypted: null },
  });
  const tokens = await tx.refreshToken.updateMany({
    where: { device: deviceWhere, revokedAt: null },
    data: { revokedAt: now },
  });
  const links = await tx.employeeUserLink.updateMany({
    where: { employeeId, unlinkedAt: null },
    data: { unlinkedAt: now },
  });
  const invites = input.revokeInvites
    ? await tx.employeeInvite.updateMany({
        where: { organisationId, employeeId, status: { in: ["PENDING", "SENT"] } },
        data: { status: "REVOKED", revokedAt: now },
      })
    : { count: 0 };

  const runningBreaks = await tx.breakSession.findMany({
    where: { organisationId, employeeId, status: "ACTIVE" },
    select: { id: true, shiftId: true, startedAt: true, plannedEndsAt: true },
  });
  const endedBreakEvents: ActivityEvent[] = [];
  for (const session of runningBreaks) {
    const endedAt = new Date(
      Math.max(
        session.startedAt.getTime(),
        Math.min(now.getTime(), session.plannedEndsAt.getTime()),
      ),
    );
    await tx.breakSession.update({
      where: { id: session.id },
      data: { status: "ENDED", endedAt, endReason: input.breakEndReason },
    });
    const { event } = await recordActivity(
      {
        organisationId,
        employeeId,
        deviceId: input.actor.deviceId ?? null,
        actorType: input.actor.type,
        actorUserId: input.actor.userId ?? null,
        type: "BREAK_ENDED",
        occurredAt: endedAt,
        metadata: {
          breakSessionId: session.id,
          shiftId: session.shiftId,
          reason: input.breakEndReason,
        },
      },
      { db: tx, publish: false },
    );
    endedBreakEvents.push(event);
  }

  return {
    deactivatedDevices: devices.count,
    revokedTokens: tokens.count,
    unlinked: links.count > 0,
    revokedInvites: invites.count,
    endedBreakEvents,
  };
}
