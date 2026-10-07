import { prisma } from "@clockoff/db";
import { breakPolicyFromRecord, computeBreakAllowance } from "@clockoff/shared/breaks/breakRules";
import type {
  MobileMeResponse,
  MobileScheduleQuery,
  MobileScheduleResponse,
  MobileSyncResponse,
  PushTokenInput,
} from "@clockoff/validation/mobile";
import { MOBILE_LIMITS } from "@clockoff/validation/mobile";
import type { OkResponse } from "@clockoff/validation/primitives";
import { encrypt } from "@/lib/crypto";
import { recordActivity } from "@/server/activity/recordActivity";
import { ensureOrganisationBridged } from "@/server/realtime/pushBridge";
import type { DeviceContext } from "@/server/tenancy/context";
import {
  computePolicyVersionString,
  resolveEmployeePolicies,
} from "@/server/workState/externalServices";
import { DAY_MS } from "@/server/workState/workState.repository";
import {
  evaluateOrganisation,
  persistEvaluation,
  publishWorkStateChanged,
  recordSyncDelayedEpisode,
} from "@/server/workState/workState.service";
import {
  toBreakAllowanceDto,
  toBreakSessionDto,
  toExpectedStateDto,
  toMobileActiveOverride,
  toMobileBreakPolicy,
  toMobileResolvedPolicy,
  toMobileShift,
} from "./mobileMappers";
import { policyVersionToken } from "./policyResolution";
import { loadScheduleVersion } from "./scheduleVersion";
import {
  loadActiveOverridesForEmployee,
  loadEmployeePrimaryLocation,
  loadEmployeeShifts,
  updateDevice,
} from "./sync.repository";

/**
 * Mobile read surface (§5 /api/mobile/v1): `/me`, `/schedule`, `/sync`, `/device/push-token`. Everything
 * is scoped to `ctx.employee` / `ctx.device` from the verified bearer token. Responses carry operational
 * data only (§12).
 */

function scheduleWindow(now: Date, query?: MobileScheduleQuery): { from: Date; to: Date } {
  const from = query?.from
    ? new Date(query.from)
    : new Date(now.getTime() - MOBILE_LIMITS.defaultScheduleDaysBack * DAY_MS);
  const to = query?.to
    ? new Date(query.to)
    : new Date(
        (query?.from ? from.getTime() : now.getTime()) +
          MOBILE_LIMITS.defaultScheduleDaysAhead * DAY_MS,
      );
  return { from, to };
}

async function mobileEmployee(ctx: DeviceContext): Promise<MobileMeResponse["employee"]> {
  const location = await loadEmployeePrimaryLocation(
    ctx.organisation.id,
    ctx.employee.primaryLocationId,
  );
  return {
    id: ctx.employee.id,
    firstName: ctx.employee.firstName,
    lastName: ctx.employee.lastName,
    jobTitle: ctx.employee.jobTitle,
    primaryLocation: location,
  };
}

export async function getMe(ctx: DeviceContext, now: Date = new Date()): Promise<MobileMeResponse> {
  const [employee, resolution, scheduleVersion] = await Promise.all([
    mobileEmployee(ctx),
    resolveEmployeePolicies(ctx.organisation.id, ctx.employee.id, now),
    loadScheduleVersion(ctx.organisation.id, ctx.employee.id),
    updateDevice(ctx.device.id, { lastSeenAt: now }),
  ]);
  return {
    employee,
    organisation: {
      id: ctx.organisation.id,
      name: ctx.organisation.name,
      timezone: ctx.organisation.timezone,
    },
    deviceId: ctx.device.id,
    resolvedPolicy: toMobileResolvedPolicy(resolution),
    resolvedBreakPolicy: toMobileBreakPolicy(resolution.breakPolicy),
    policyVersion: policyVersionToken(resolution),
    scheduleVersion,
  };
}

export async function getSchedule(
  ctx: DeviceContext,
  query: MobileScheduleQuery,
  now: Date = new Date(),
): Promise<MobileScheduleResponse> {
  const { from, to } = scheduleWindow(now, query);
  const [shifts, scheduleVersion] = await Promise.all([
    loadEmployeeShifts({
      organisationId: ctx.organisation.id,
      employeeId: ctx.employee.id,
      from,
      to,
    }),
    loadScheduleVersion(ctx.organisation.id, ctx.employee.id),
    updateDevice(ctx.device.id, { lastSeenAt: now }),
  ]);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    shifts: shifts.map(toMobileShift),
    scheduleVersion,
    serverTime: now.toISOString(),
  };
}

/**
 * The offline bundle. Side effects: the device's sync timestamps and last-known versions are updated, the
 * employee's work state is re-evaluated, and SCHEDULE_SYNCED / POLICY_SYNCED are recorded ONLY when the
 * version differs from what this device last had (no event spam on the periodic sync).
 */
export async function getSyncBundle(
  ctx: DeviceContext,
  now: Date = new Date(),
): Promise<MobileSyncResponse> {
  const organisationId = ctx.organisation.id;
  const employeeId = ctx.employee.id;
  ensureOrganisationBridged(organisationId);
  const { from, to } = scheduleWindow(now);

  const [evaluated, shifts, overrides, scheduleVersion] = await Promise.all([
    evaluateOrganisation({
      organisationId,
      employeeIds: [employeeId],
      now,
      shiftWindow: { from, to },
    }),
    loadEmployeeShifts({ organisationId, employeeId, from, to }),
    loadActiveOverridesForEmployee({ organisationId, employeeId, now }),
    loadScheduleVersion(organisationId, employeeId),
  ]);
  const evaluation = evaluated.evaluations[0];
  if (!evaluation) throw new Error("sync: employee missing from its own organisation");
  const { row, startedSyncDelayedEpisode } = await persistEvaluation(evaluation);
  // This evaluation may be the first to notice a silent device (the badge reads lastDeviceSyncAt, which only
  // /device/state moves): it owns the episode's event exactly like a job tick would.
  if (startedSyncDelayedEpisode) await recordSyncDelayedEpisode(evaluation, now);
  if (evaluation.changed) publishWorkStateChanged(evaluation, row);

  const resolution = evaluation.policy;
  const policyVersion = policyVersionToken(resolution);
  const breakPolicyRow = resolution?.breakPolicy ?? null;

  // Versions the device last had, before this sync.
  const previousPolicyVersion = ctx.device.policyVersionId;
  const previousScheduleVersion = ctx.device.scheduleVersion;
  if (previousPolicyVersion !== policyVersion) {
    await recordActivity({
      organisationId,
      employeeId,
      deviceId: ctx.device.id,
      actorType: "EMPLOYEE_DEVICE",
      type: "POLICY_SYNCED",
      occurredAt: now,
      metadata: {
        policyVersion,
        previousPolicyVersion,
        policyVersionString: resolution ? computePolicyVersionString(resolution) : null,
      },
    });
  }
  if (previousScheduleVersion !== scheduleVersion) {
    await recordActivity({
      organisationId,
      employeeId,
      deviceId: ctx.device.id,
      actorType: "EMPLOYEE_DEVICE",
      type: "SCHEDULE_SYNCED",
      occurredAt: now,
      metadata: { scheduleVersion, previousScheduleVersion, shiftCount: shifts.length },
    });
  }
  await updateDevice(ctx.device.id, {
    lastPolicySyncAt: now,
    lastScheduleSyncAt: now,
    lastSeenAt: now,
    scheduleVersion,
    policyVersionId: policyVersion,
  });

  const expected = evaluation.expected;
  const activeBreakId = expected.activeBreak?.id ?? null;
  const activeBreakSession = activeBreakId
    ? await prisma.breakSession.findFirst({
        where: { id: activeBreakId, organisationId, employeeId },
      })
    : null;

  const allowanceShift = expected.activeShift ?? expected.upcomingShift;
  let breakAllowance: MobileSyncResponse["breakAllowance"] = null;
  if (allowanceShift && breakPolicyRow) {
    const sessions = evaluated.inputs.sessionsByShift.get(allowanceShift.id) ?? [];
    breakAllowance = toBreakAllowanceDto(
      computeBreakAllowance(breakPolicyFromRecord(breakPolicyRow), allowanceShift, sessions, now),
    );
  }

  return {
    policy: toMobileResolvedPolicy(resolution),
    breakPolicy: toMobileBreakPolicy(breakPolicyRow),
    shifts: shifts.map(toMobileShift),
    policyVersion,
    scheduleVersion,
    serverTime: now.toISOString(),
    activeOverrides: overrides.map(toMobileActiveOverride),
    expectedState: toExpectedStateDto(expected),
    activeBreakSession: activeBreakSession ? toBreakSessionDto(activeBreakSession) : null,
    breakAllowance,
  };
}

/** Encrypts the APNs token at rest (AES-256-GCM); the plaintext is never logged or returned. */
export async function registerPushToken(
  ctx: DeviceContext,
  input: PushTokenInput,
  now: Date = new Date(),
): Promise<OkResponse> {
  const payload = JSON.stringify({
    token: input.token.toLowerCase(),
    environment: input.environment,
  });
  await updateDevice(ctx.device.id, {
    pushTokenEncrypted: new Uint8Array(encrypt(payload)),
    lastSeenAt: now,
  });
  return { ok: true };
}
