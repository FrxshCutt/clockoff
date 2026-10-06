import { randomUUID } from "node:crypto";
import { prisma, type Device } from "@workmode/db";
import {
  deviceEventsResponseSchema,
  deviceStateResponseSchema,
  mobileMeResponseSchema,
  mobileScheduleResponseSchema,
  mobileSyncResponseSchema,
} from "@workmode/validation/mobile";
import { describe, expect, it } from "vitest";
import { POST as startBreakRoute } from "@/app/api/mobile/v1/breaks/start/route";
import { POST as pushTokenRoute } from "@/app/api/mobile/v1/device/push-token/route";
import { POST as deviceStateRoute } from "@/app/api/mobile/v1/device/state/route";
import { POST as eventsRoute } from "@/app/api/mobile/v1/events/route";
import { GET as meRoute } from "@/app/api/mobile/v1/me/route";
import { GET as scheduleRoute } from "@/app/api/mobile/v1/schedule/route";
import { GET as syncRoute } from "@/app/api/mobile/v1/sync/route";
import { issueMobileTokens } from "@/server/mobileAuth";
import { decryptPushToken } from "@/server/realtime/pushBridge";
import { callRoute, createTestDevice, createTestOrg, type ErrorBody } from "../helpers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function bearer(device: Device): Promise<Record<string, string>> {
  const { accessToken } = await issueMobileTokens(device);
  return { authorization: `Bearer ${accessToken}` };
}

async function createShift(
  organisationId: string,
  employeeId: string,
  startsAt: Date,
  endsAt: Date,
) {
  return prisma.shift.create({
    data: { organisationId, employeeId, startsAt, endsAt, timezone: "Europe/London" },
  });
}

const restrictionConfig = {
  categories: ["SOCIAL_MEDIA", "GAMES"],
  requireEmployeeAppSelection: true,
  alwaysAllowedNote: [],
  activationMode: "SCHEDULED",
  preShiftWarningMinutes: 10,
};

/** A published policy set as the organisation default; returns the current version id. */
async function publishDefaultPolicy(
  organisationId: string,
): Promise<{ policyId: string; versionId: string }> {
  const policy = await prisma.policy.create({
    data: {
      organisationId,
      name: "Floor policy",
      status: "ACTIVE",
      versions: { create: { versionNumber: 1, restrictionConfig, publishedAt: new Date() } },
    },
    include: { versions: true },
  });
  const versionId = policy.versions[0]!.id;
  await prisma.policy.update({ where: { id: policy.id }, data: { currentVersionId: versionId } });
  await prisma.organisation.update({
    where: { id: organisationId },
    data: { defaultPolicyId: policy.id },
  });
  return { policyId: policy.id, versionId };
}

async function setDefaultBreakPolicy(organisationId: string) {
  const policy = await prisma.breakPolicy.create({
    data: { organisationId, name: "Standard breaks" },
  });
  await prisma.organisation.update({
    where: { id: organisationId },
    data: { defaultBreakPolicyId: policy.id },
  });
  return policy;
}

function deviceReport(overrides: Record<string, unknown> = {}) {
  return {
    permissionState: "APPROVED",
    selectionState: "CONFIGURED",
    selectionCounts: { categories: 2, applications: 5, webDomains: 0 },
    restrictionEngineState: "OFF_SHIFT",
    appVersion: "1.0.0",
    osVersion: "17.5",
    localTime: new Date().toISOString(),
    timezone: "Europe/London",
    ...overrides,
  };
}

describe("GET /api/mobile/v1/me", () => {
  it("returns the employee, organisation and resolved policies, and rejects unknown query params", async () => {
    const org = await createTestOrg();
    const { device, employee } = await createTestDevice(org.organisation.id);
    const headers = await bearer(device);

    const before = await callRoute(meRoute, { path: "/api/mobile/v1/me", headers });
    expect(before.status).toBe(200);
    const parsed = mobileMeResponseSchema.parse(before.body);
    expect(parsed.employee.id).toBe(employee.id);
    expect(parsed.deviceId).toBe(device.id);
    expect(parsed.organisation.id).toBe(org.organisation.id);
    expect(parsed.resolvedPolicy).toBeNull();
    expect(parsed.policyVersion).toBeNull();
    expect(parsed.scheduleVersion).toBe(0);

    const { policyId, versionId } = await publishDefaultPolicy(org.organisation.id);
    const breakPolicy = await setDefaultBreakPolicy(org.organisation.id);
    const after = mobileMeResponseSchema.parse(
      (await callRoute(meRoute, { path: "/api/mobile/v1/me", headers })).body,
    );
    expect(after.resolvedPolicy?.policy.id).toBe(policyId);
    expect(after.resolvedPolicy?.version.id).toBe(versionId);
    expect(after.resolvedPolicy?.restrictionConfig.categories).toEqual(["SOCIAL_MEDIA", "GAMES"]);
    expect(after.policyVersion).toBe(versionId);
    expect(after.resolvedBreakPolicy?.id).toBe(breakPolicy.id);

    const strict = await callRoute<ErrorBody>(meRoute, {
      path: "/api/mobile/v1/me",
      query: { foo: "1" },
      headers,
    });
    expect(strict.status).toBe(400);
    expect(strict.body.error.code).toBe("VALIDATION_ERROR");

    const anonymous = await callRoute<ErrorBody>(meRoute, { path: "/api/mobile/v1/me" });
    expect(anonymous.status).toBe(401);
  });
});

describe("GET /api/mobile/v1/schedule", () => {
  it("lists this employee's SCHEDULED shifts in the window with a deterministic schedule version", async () => {
    const org = await createTestOrg();
    const { device, employee } = await createTestDevice(org.organisation.id);
    const other = await createTestDevice(org.organisation.id);
    const now = Date.now();
    const mine = await createShift(
      org.organisation.id,
      employee.id,
      new Date(now + DAY),
      new Date(now + DAY + 6 * HOUR),
    );
    await createShift(
      org.organisation.id,
      other.employee.id,
      new Date(now + DAY),
      new Date(now + DAY + 6 * HOUR),
    );
    await createShift(
      org.organisation.id,
      employee.id,
      new Date(now + 30 * DAY),
      new Date(now + 30 * DAY + HOUR),
    );
    const headers = await bearer(device);

    const res = await callRoute(scheduleRoute, { path: "/api/mobile/v1/schedule", headers });
    expect(res.status).toBe(200);
    const parsed = mobileScheduleResponseSchema.parse(res.body);
    expect(parsed.shifts.map((s) => s.id)).toEqual([mine.id]);
    expect(parsed.scheduleVersion).toBeGreaterThan(0);

    const again = mobileScheduleResponseSchema.parse(
      (await callRoute(scheduleRoute, { path: "/api/mobile/v1/schedule", headers })).body,
    );
    expect(again.scheduleVersion).toBe(parsed.scheduleVersion);

    const tooWide = await callRoute<ErrorBody>(scheduleRoute, {
      path: "/api/mobile/v1/schedule",
      query: { from: new Date(now).toISOString(), to: new Date(now + 90 * DAY).toISOString() },
      headers,
    });
    expect(tooWide.status).toBe(400);
  });
});

describe("GET /api/mobile/v1/sync", () => {
  it("returns the offline bundle, stamps the device and records SYNCED events only when versions change", async () => {
    const org = await createTestOrg();
    const { device, employee } = await createTestDevice(org.organisation.id);
    const { versionId } = await publishDefaultPolicy(org.organisation.id);
    const breakPolicy = await setDefaultBreakPolicy(org.organisation.id);
    const now = Date.now();
    const shift = await createShift(
      org.organisation.id,
      employee.id,
      new Date(now - HOUR),
      new Date(now + 5 * HOUR),
    );
    await prisma.device.update({
      where: { id: device.id },
      data: { permissionState: "APPROVED", selectionState: "CONFIGURED" },
    });
    const fresh = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    const headers = await bearer(fresh);

    const first = await callRoute(syncRoute, { path: "/api/mobile/v1/sync", headers });
    expect(first.status).toBe(200);
    const bundle = mobileSyncResponseSchema.parse(first.body);
    expect(bundle.policy?.version.id).toBe(versionId);
    expect(bundle.policyVersion).toBe(versionId);
    expect(bundle.breakPolicy?.id).toBe(breakPolicy.id);
    expect(bundle.breakPolicy?.rules.maxBreaksPerShift).toBe(2);
    expect(bundle.shifts.map((s) => s.id)).toEqual([shift.id]);
    expect(bundle.scheduleVersion).toBeGreaterThan(0);
    expect(bundle.expectedState.state).toBe("WORKING");
    expect(bundle.expectedState.activeShift?.id).toBe(shift.id);
    expect(bundle.activeOverrides).toEqual([]);
    expect(bundle.activeBreakSession).toBeNull();
    expect(bundle.breakAllowance?.breaksRemaining).toBe(2);

    const stamped = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(stamped.policyVersionId).toBe(versionId);
    expect(stamped.scheduleVersion).toBe(bundle.scheduleVersion);
    expect(stamped.lastPolicySyncAt).not.toBeNull();
    expect(stamped.lastScheduleSyncAt).not.toBeNull();

    const workState = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(workState.expectedState).toBe("WORKING");
    expect(workState.activeShiftId).toBe(shift.id);
    expect(workState.source).toBe("SERVER_COMPUTED");

    const countEvents = (type: "POLICY_SYNCED" | "SCHEDULE_SYNCED") =>
      prisma.activityEvent.count({
        where: { organisationId: org.organisation.id, employeeId: employee.id, type },
      });
    expect(await countEvents("POLICY_SYNCED")).toBe(1);
    expect(await countEvents("SCHEDULE_SYNCED")).toBe(1);

    // Same versions → no event spam.
    await callRoute(syncRoute, { path: "/api/mobile/v1/sync", headers: await bearer(stamped) });
    expect(await countEvents("POLICY_SYNCED")).toBe(1);
    expect(await countEvents("SCHEDULE_SYNCED")).toBe(1);

    // A schedule change → one more SCHEDULE_SYNCED, policy untouched.
    await createShift(
      org.organisation.id,
      employee.id,
      new Date(now + 2 * DAY),
      new Date(now + 2 * DAY + HOUR),
    );
    const third = mobileSyncResponseSchema.parse(
      (await callRoute(syncRoute, { path: "/api/mobile/v1/sync", headers: await bearer(stamped) }))
        .body,
    );
    expect(third.shifts).toHaveLength(2);
    expect(third.scheduleVersion).not.toBe(bundle.scheduleVersion);
    expect(await countEvents("SCHEDULE_SYNCED")).toBe(2);
    expect(await countEvents("POLICY_SYNCED")).toBe(1);
  });

  it("includes active overrides for this employee and organisation-wide ones only", async () => {
    const org = await createTestOrg();
    const { device, employee } = await createTestDevice(org.organisation.id);
    const other = await createTestDevice(org.organisation.id);
    const now = Date.now();
    const base = {
      organisationId: org.organisation.id,
      reason: "test override",
      startsAt: new Date(now - HOUR),
    };
    const mine = await prisma.managerOverride.create({
      data: {
        ...base,
        employeeId: employee.id,
        type: "EXEMPT_TEMPORARILY",
        expiresAt: new Date(now + HOUR),
      },
    });
    const orgWide = await prisma.managerOverride.create({
      data: {
        ...base,
        type: "EMERGENCY_POLICY_OVERRIDE",
        expiresAt: new Date(now + HOUR),
        payload: {},
      },
    });
    await prisma.managerOverride.create({
      data: {
        ...base,
        employeeId: other.employee.id,
        type: "EXEMPT_TEMPORARILY",
        expiresAt: new Date(now + HOUR),
      },
    });
    await prisma.managerOverride.create({
      data: {
        ...base,
        employeeId: employee.id,
        type: "EXEMPT_TEMPORARILY",
        expiresAt: new Date(now - 1000),
      },
    });
    await prisma.managerOverride.create({
      data: {
        ...base,
        employeeId: employee.id,
        type: "TEMPORARY_EXCEPTION",
        expiresAt: new Date(now + HOUR),
        revokedAt: new Date(now - 1000),
      },
    });

    const bundle = mobileSyncResponseSchema.parse(
      (await callRoute(syncRoute, { path: "/api/mobile/v1/sync", headers: await bearer(device) }))
        .body,
    );
    expect(bundle.activeOverrides.map((o) => o.id).sort()).toEqual([mine.id, orgWide.id].sort());
    expect(bundle.activeOverrides.every((o) => o.breakBehaviour === null)).toBe(true);
  });
});

describe("POST /api/mobile/v1/device/state", () => {
  it("stores the report, records permission/selection events on transitions only and flags clock skew", async () => {
    const org = await createTestOrg();
    const { device, employee } = await createTestDevice(org.organisation.id);
    const headers = await bearer(device);
    const events = (type: string) =>
      prisma.activityEvent.count({
        where: {
          organisationId: org.organisation.id,
          employeeId: employee.id,
          type: type as never,
        },
      });

    const first = await callRoute(deviceStateRoute, {
      method: "POST",
      path: "/api/mobile/v1/device/state",
      headers,
      body: deviceReport(),
    });
    expect(first.status).toBe(200);
    const parsed = deviceStateResponseSchema.parse(first.body);
    expect(parsed.ok).toBe(true);
    expect(Math.abs(parsed.clockSkewSeconds)).toBeLessThan(5);
    expect(parsed.clockSkewExceeded).toBe(false);
    expect(parsed.expectedState.state).toBe("OFF_SHIFT");
    expect(await events("PERMISSION_GRANTED")).toBe(1);
    expect(await events("SELECTION_CONFIGURED")).toBe(1);

    const stored = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(stored.permissionState).toBe("APPROVED");
    expect(stored.selectionState).toBe("CONFIGURED");
    expect(stored.selectionAppCount).toBe(5);
    expect(stored.appVersion).toBe("1.0.0");
    expect(stored.lastDeviceSyncAt).not.toBeNull();
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } })).inviteStatus,
    ).toBe("CONNECTED");
    const workState = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(workState.reportedState).toBe("OFF_SHIFT");
    expect(workState.source).toBe("DEVICE_REPORT");

    // Same state again: no new transition events (the bearer carries the updated device row).
    await callRoute(deviceStateRoute, {
      method: "POST",
      path: "/api/mobile/v1/device/state",
      headers: await bearer(stored),
      body: deviceReport(),
    });
    expect(await events("PERMISSION_GRANTED")).toBe(1);
    expect(await events("SELECTION_CONFIGURED")).toBe(1);

    // Permission lost + a 10 minute clock skew.
    const skewed = await callRoute(deviceStateRoute, {
      method: "POST",
      path: "/api/mobile/v1/device/state",
      headers: await bearer(stored),
      body: deviceReport({
        permissionState: "DENIED",
        localTime: new Date(Date.now() + 600_000).toISOString(),
      }),
    });
    const skewedBody = deviceStateResponseSchema.parse(skewed.body);
    expect(skewedBody.clockSkewSeconds).toBeGreaterThanOrEqual(598);
    expect(skewedBody.clockSkewExceeded).toBe(true);
    expect(await events("PERMISSION_NEEDS_ATTENTION")).toBe(1);
    const afterSkew = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(afterSkew.lastClockSkewSeconds).toBeGreaterThanOrEqual(598);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } })).inviteStatus,
    ).toBe("SETUP_INCOMPLETE");

    const unknownField = await callRoute<ErrorBody>(deviceStateRoute, {
      method: "POST",
      path: "/api/mobile/v1/device/state",
      headers: await bearer(afterSkew),
      body: deviceReport({ installedApps: ["x"] }),
    });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/mobile/v1/events", () => {
  it("accepts a batch idempotently, rejects skewed timestamps and foreign shift ids, and updates the reported state", async () => {
    const org = await createTestOrg();
    const { device, employee } = await createTestDevice(org.organisation.id);
    const other = await createTestDevice(org.organisation.id);
    const headers = await bearer(device);
    const now = Date.now();
    const shift = await createShift(
      org.organisation.id,
      employee.id,
      new Date(now - HOUR),
      new Date(now + 5 * HOUR),
    );
    const foreign = await createShift(
      org.organisation.id,
      other.employee.id,
      new Date(now - HOUR),
      new Date(now + HOUR),
    );

    const started = randomUUID();
    const ended = randomUUID();
    const batch = {
      events: [
        {
          clientEventId: started,
          type: "WORK_MODE_STARTED",
          occurredAt: new Date(now - 30 * 60_000).toISOString(),
          metadata: { shiftId: shift.id, policyVersion: randomUUID() },
        },
        {
          clientEventId: ended,
          type: "SETUP_COMPLETED",
          occurredAt: new Date(now - 40 * 60_000).toISOString(),
        },
      ],
    };
    const first = await callRoute(eventsRoute, {
      method: "POST",
      path: "/api/mobile/v1/events",
      headers,
      body: batch,
    });
    expect(first.status).toBe(200);
    expect(deviceEventsResponseSchema.parse(first.body)).toEqual({
      accepted: 2,
      duplicates: 0,
      rejected: [],
    });

    const replay = await callRoute(eventsRoute, {
      method: "POST",
      path: "/api/mobile/v1/events",
      headers,
      body: batch,
    });
    expect(deviceEventsResponseSchema.parse(replay.body)).toEqual({
      accepted: 0,
      duplicates: 2,
      rejected: [],
    });
    expect(
      await prisma.activityEvent.count({
        where: { deviceId: device.id, clientEventId: { in: [started, ended] } },
      }),
    ).toBe(2);

    const workState = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(workState.reportedState).toBe("WORKING");
    expect(workState.reportedAt?.toISOString()).toBe(new Date(now - 30 * 60_000).toISOString());

    const tooOld = randomUUID();
    const future = randomUUID();
    const foreignShift = randomUUID();
    const mixed = await callRoute(eventsRoute, {
      method: "POST",
      path: "/api/mobile/v1/events",
      headers,
      body: {
        events: [
          {
            clientEventId: tooOld,
            type: "SCHEDULE_SYNCED",
            occurredAt: new Date(now - 40 * DAY).toISOString(),
          },
          {
            clientEventId: future,
            type: "SCHEDULE_SYNCED",
            occurredAt: new Date(now + HOUR).toISOString(),
          },
          {
            clientEventId: foreignShift,
            type: "WORK_MODE_ENDED",
            occurredAt: new Date(now).toISOString(),
            metadata: { shiftId: foreign.id },
          },
        ],
      },
    });
    const mixedBody = deviceEventsResponseSchema.parse(mixed.body);
    expect(mixedBody.accepted).toBe(0);
    expect(mixedBody.rejected).toEqual(
      expect.arrayContaining([
        { clientEventId: tooOld, code: "CLOCK_SKEW" },
        { clientEventId: future, code: "CLOCK_SKEW" },
        { clientEventId: foreignShift, code: "NOT_FOUND" },
      ]),
    );

    const unknownType = await callRoute<ErrorBody>(eventsRoute, {
      method: "POST",
      path: "/api/mobile/v1/events",
      headers,
      body: {
        events: [
          {
            clientEventId: randomUUID(),
            type: "APP_OPENED",
            occurredAt: new Date(now).toISOString(),
          },
        ],
      },
    });
    expect(unknownType.status).toBe(400);
    expect(unknownType.body.error.code).toBe("VALIDATION_ERROR");

    // The same clientEventId from ANOTHER device is a different event.
    const otherDevice = await callRoute(eventsRoute, {
      method: "POST",
      path: "/api/mobile/v1/events",
      headers: await bearer(other.device),
      body: {
        events: [
          {
            clientEventId: ended,
            type: "SETUP_COMPLETED",
            occurredAt: new Date(now).toISOString(),
          },
        ],
      },
    });
    expect(deviceEventsResponseSchema.parse(otherDevice.body).accepted).toBe(1);
  });
});

describe("POST /api/mobile/v1/events (break events the server already holds)", () => {
  it("counts a device BREAK_STARTED for a server-recorded session as a duplicate but still applies its reported state", async () => {
    const org = await createTestOrg();
    const { device, employee } = await createTestDevice(org.organisation.id);
    await setDefaultBreakPolicy(org.organisation.id);
    const now = Date.now();
    const shift = await createShift(
      org.organisation.id,
      employee.id,
      new Date(now - 2 * HOUR),
      new Date(now + 4 * HOUR),
    );
    const headers = await bearer(device);

    const started = await callRoute<{ breakSession: { id: string } }>(startBreakRoute, {
      method: "POST",
      path: "/api/mobile/v1/breaks/start",
      headers,
      body: {
        clientBreakId: randomUUID(),
        shiftId: shift.id,
        requestedAt: new Date(now).toISOString(),
      },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const sessionId = started.body.breakSession.id;
    const breakStartedEvents = () =>
      prisma.activityEvent.count({ where: { employeeId: employee.id, type: "BREAK_STARTED" } });
    expect(await breakStartedEvents()).toBe(1);

    // The phone's own outbox reports the same break: no second feed entry, but the engine state is new information.
    const res = await callRoute(eventsRoute, {
      method: "POST",
      path: "/api/mobile/v1/events",
      headers,
      body: {
        events: [
          {
            clientEventId: randomUUID(),
            type: "BREAK_STARTED",
            occurredAt: new Date(now + 1000).toISOString(),
            metadata: { shiftId: shift.id, breakSessionId: sessionId },
          },
        ],
      },
    });
    expect(deviceEventsResponseSchema.parse(res.body)).toEqual({
      accepted: 0,
      duplicates: 1,
      rejected: [],
    });
    expect(await breakStartedEvents()).toBe(1);
    const workState = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(workState.reportedState).toBe("ON_BREAK");
    expect(workState.source).toBe("DEVICE_REPORT");
    expect(workState.state).toBe("ON_BREAK");
  });
});

describe("POST /api/mobile/v1/device/push-token", () => {
  it("stores the token encrypted (never in clear) and rejects non-hex tokens", async () => {
    const org = await createTestOrg();
    const { device } = await createTestDevice(org.organisation.id);
    const headers = await bearer(device);
    const token = "A".repeat(64);
    const res = await callRoute(pushTokenRoute, {
      method: "POST",
      path: "/api/mobile/v1/device/push-token",
      headers,
      body: { token, environment: "sandbox" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const stored = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(stored.pushTokenEncrypted).not.toBeNull();
    expect(Buffer.from(stored.pushTokenEncrypted!).toString("utf8")).not.toContain(
      token.toLowerCase(),
    );
    expect(decryptPushToken(stored.pushTokenEncrypted)).toBe(token.toLowerCase());

    const bad = await callRoute<ErrorBody>(pushTokenRoute, {
      method: "POST",
      path: "/api/mobile/v1/device/push-token",
      headers,
      body: { token: "not-hex-at-all-not-hex-at-all-not-hex", environment: "sandbox" },
    });
    expect(bad.status).toBe(400);
  });
});
