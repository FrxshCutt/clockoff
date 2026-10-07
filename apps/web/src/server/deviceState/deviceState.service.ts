import { prisma, type Prisma } from "@clockoff/db";
import {
  clockSkewNeedsAttention,
  computeClockSkewSeconds,
} from "@clockoff/shared/breaks/breakRules";
import type { PermissionState, SelectionState, WorkModeState } from "@clockoff/shared/enums";
import type { DeviceStateReportInput, DeviceStateResponse } from "@clockoff/validation/mobile";
import { recordActivity } from "@/server/activity/recordActivity";
import { publishEvent } from "@/server/events";
import { ensureOrganisationBridged } from "@/server/realtime/pushBridge";
import { policyVersionExistsInOrganisation, updateDevice } from "@/server/sync/sync.repository";
import type { DeviceContext } from "@/server/tenancy/context";
import { recomputeEmployeeInviteStatus } from "@/server/workState/externalServices";
import { toExpectedStateDto } from "@/server/sync/mobileMappers";
import { recomputeEmployeeWorkState } from "@/server/workState/workState.service";

/**
 * `POST /api/mobile/v1/device/state` — the periodic compliance check-in (§5, §12). Stores operational
 * signals only, records PERMISSION_GRANTED / PERMISSION_NEEDS_ATTENTION / SELECTION_CONFIGURED on
 * transitions only, and answers with the server's expected state so the device can self-correct.
 */

type Db = Prisma.TransactionClient | typeof prisma;

const ATTENTION_PERMISSIONS: ReadonlySet<PermissionState> = new Set(["DENIED", "REVOKED"]);

function isPermissionGranted(prev: PermissionState, next: PermissionState): boolean {
  return prev !== "APPROVED" && next === "APPROVED";
}

function isPermissionLost(prev: PermissionState, next: PermissionState): boolean {
  return !ATTENTION_PERMISSIONS.has(prev) && ATTENTION_PERMISSIONS.has(next);
}

function isSelectionConfigured(prev: SelectionState, next: SelectionState): boolean {
  return prev !== "CONFIGURED" && next === "CONFIGURED";
}

/**
 * The app also queues PERMISSION_GRANTED / PERMISSION_NEEDS_ATTENTION / SELECTION_CONFIGURED in its outbox, and
 * a sync flushes the outbox BEFORE checking in. The previous report still showed the old state, so an event of
 * this type that the device itself sent (clientEventId set) for an instant after that report (device clock,
 * corrected by the known skew) is the transition this report reveals: the feed already has it.
 */
async function deviceAlreadyReportedTransition(
  device: DeviceContext["device"],
  type: "PERMISSION_GRANTED" | "PERMISSION_NEEDS_ATTENTION" | "SELECTION_CONFIGURED",
  db: Db = prisma,
): Promise<boolean> {
  const previousReportAt = device.lastDeviceSyncAt;
  const skewMs = (device.lastClockSkewSeconds ?? 0) * 1_000;
  const existing = await db.activityEvent.findFirst({
    where: {
      organisationId: device.organisationId,
      deviceId: device.id,
      type,
      clientEventId: { not: null },
      ...(previousReportAt
        ? { occurredAt: { gt: new Date(previousReportAt.getTime() + skewMs) } }
        : {}),
    },
    select: { id: true },
  });
  return existing !== null;
}

/**
 * Store a device report on the work-state row: the report wins the displayed `state` (source DEVICE_REPORT)
 * until the server detects the next expected transition. Only reports newer than the stored one are applied.
 */
export async function applyReportedState(
  employeeId: string,
  reportedState: WorkModeState,
  reportedAt: Date,
  db: Db = prisma,
): Promise<boolean> {
  const existing = await db.employeeWorkState.findUnique({ where: { employeeId } });
  if (existing?.reportedAt && existing.reportedAt.getTime() > reportedAt.getTime()) return false;
  const stateSince =
    existing && existing.state === reportedState ? existing.stateSince : reportedAt;
  const data = {
    reportedState,
    reportedAt,
    state: reportedState,
    source: "DEVICE_REPORT" as const,
    stateSince,
    lastUpdatedAt: reportedAt,
  };
  await db.employeeWorkState.upsert({
    where: { employeeId },
    update: data,
    create: { employeeId, ...data },
  });
  return true;
}

export async function reportDeviceState(
  ctx: DeviceContext,
  input: DeviceStateReportInput,
  now: Date = new Date(),
): Promise<DeviceStateResponse> {
  const organisationId = ctx.organisation.id;
  const employeeId = ctx.employee.id;
  const previous = ctx.device;
  ensureOrganisationBridged(organisationId);

  const clockSkewSeconds = computeClockSkewSeconds(new Date(input.localTime), now);
  const policyVersionId =
    input.policyVersionApplied !== undefined &&
    (await policyVersionExistsInOrganisation(organisationId, input.policyVersionApplied))
      ? input.policyVersionApplied
      : previous.policyVersionId;

  await updateDevice(previous.id, {
    permissionState: input.permissionState,
    selectionState: input.selectionState,
    ...(input.selectionCounts
      ? {
          selectionCategoryCount: input.selectionCounts.categories,
          selectionAppCount: input.selectionCounts.applications,
          selectionDomainCount: input.selectionCounts.webDomains,
        }
      : {}),
    restrictionEngineState: input.restrictionEngineState,
    appVersion: input.appVersion,
    osVersion: input.osVersion,
    timezone: input.timezone,
    policyVersionId,
    ...(input.scheduleVersionApplied !== undefined
      ? { scheduleVersion: input.scheduleVersionApplied }
      : {}),
    lastDeviceSyncAt: now,
    lastSeenAt: now,
    lastClockSkewSeconds: clockSkewSeconds,
  });

  // Transitions only — the periodic check-in must not flood the feed — and only once: not when the device's own
  // event for the same transition was flushed first (`deviceAlreadyReportedTransition`).
  const base = {
    organisationId,
    employeeId,
    deviceId: previous.id,
    actorType: "EMPLOYEE_DEVICE" as const,
    occurredAt: now,
  };
  if (isPermissionGranted(previous.permissionState, input.permissionState)) {
    if (!(await deviceAlreadyReportedTransition(previous, "PERMISSION_GRANTED"))) {
      await recordActivity({
        ...base,
        type: "PERMISSION_GRANTED",
        metadata: { permissionState: input.permissionState },
      });
    }
  } else if (isPermissionLost(previous.permissionState, input.permissionState)) {
    if (!(await deviceAlreadyReportedTransition(previous, "PERMISSION_NEEDS_ATTENTION"))) {
      await recordActivity({
        ...base,
        type: "PERMISSION_NEEDS_ATTENTION",
        metadata: {
          permissionState: input.permissionState,
          previousPermissionState: previous.permissionState,
        },
      });
    }
  }
  if (
    isSelectionConfigured(previous.selectionState, input.selectionState) &&
    !(await deviceAlreadyReportedTransition(previous, "SELECTION_CONFIGURED"))
  ) {
    await recordActivity({
      ...base,
      type: "SELECTION_CONFIGURED",
      metadata: {
        selectionState: input.selectionState,
        ...(input.selectionCounts ? { selectionCounts: input.selectionCounts } : {}),
      },
    });
  }

  await recomputeEmployeeInviteStatus(employeeId);
  await applyReportedState(employeeId, input.restrictionEngineState, now);
  const recomputed = await recomputeEmployeeWorkState({ organisationId, employeeId, now });
  if (!recomputed) throw new Error("device/state: employee missing from its own organisation");

  publishEvent({
    type: "device.status.changed",
    organisationId,
    employeeId,
    payload: {
      deviceId: previous.id,
      employeeId,
      permissionState: input.permissionState,
      selectionState: input.selectionState,
      restrictionEngineState: input.restrictionEngineState,
      badge: recomputed.evaluation.badge?.badge ?? null,
      clockSkewExceeded: clockSkewNeedsAttention(clockSkewSeconds),
      lastDeviceSyncAt: now.toISOString(),
    },
  });

  return {
    ok: true,
    serverTime: now.toISOString(),
    clockSkewSeconds,
    expectedState: toExpectedStateDto(recomputed.evaluation.expected),
    clockSkewExceeded: clockSkewNeedsAttention(clockSkewSeconds),
  };
}
