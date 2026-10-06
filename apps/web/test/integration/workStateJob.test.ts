import { randomUUID } from "node:crypto";
import { prisma } from "@workmode/db";
import { afterEach, describe, expect, it } from "vitest";
import { POST as tickRoute } from "@/app/api/jobs/tick/route";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getEventBus, publishEvent, type RealtimeEvent } from "@/server/events";
import type { AlertPushPayload, PushProvider, PushReport, SilentPushPayload } from "@/server/push";
import { setPushProviderForTesting } from "@/server/push";
import {
  ensureOrganisationBridged,
  flushPushBridge,
  resetPushBridgeForTesting,
} from "@/server/realtime/pushBridge";
import { SYNC_DELAYED_MARKER } from "@/server/workState/workState.service";
import { runWorkModeTick, scheduledBreakClientId } from "@/server/workState/workStateJob";
import { DIGEST_NOTIFICATION_TYPE } from "@/server/digest/digest.service";
import { callRoute, createTestDevice, createTestOrg, createTestUser, addMember, testEmails, type ErrorBody } from "../helpers";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Test-only push double: records what would have been sent. */
class MockPushProvider implements PushProvider {
  readonly name = "noop" as const;
  readonly silent: Array<{ tokens: string[]; payload: SilentPushPayload }> = [];
  async sendSilent(deviceTokens: string[], payload: SilentPushPayload): Promise<PushReport> {
    this.silent.push({ tokens: deviceTokens, payload });
    return { provider: "noop", requested: deviceTokens.length, sent: deviceTokens.length, failed: 0, invalidTokens: [], failures: [] };
  }
  async sendAlert(deviceTokens: string[], _payload: AlertPushPayload): Promise<PushReport> {
    return { provider: "noop", requested: deviceTokens.length, sent: 0, failed: 0, invalidTokens: [], failures: [] };
  }
}

afterEach(() => {
  resetPushBridgeForTesting();
  setPushProviderForTesting(undefined);
});

async function connectedFixture(now: Date) {
  const org = await createTestOrg();
  const { device, employee } = await createTestDevice(org.organisation.id);
  await prisma.employee.update({ where: { id: employee.id }, data: { inviteStatus: "CONNECTED" } });
  const connected = await prisma.device.update({
    where: { id: device.id },
    data: { permissionState: "APPROVED", selectionState: "CONFIGURED", lastDeviceSyncAt: now, lastSeenAt: now },
  });
  const policy = await prisma.breakPolicy.create({ data: { organisationId: org.organisation.id, name: "Breaks" } });
  await prisma.organisation.update({
    where: { id: org.organisation.id },
    data: { defaultBreakPolicyId: policy.id },
  });
  const shift = await prisma.shift.create({
    data: {
      organisationId: org.organisation.id,
      employeeId: employee.id,
      startsAt: new Date(now.getTime() - 2 * HOUR),
      endsAt: new Date(now.getTime() + 4 * HOUR),
      timezone: "Europe/London",
    },
  });
  return { org, device: connected, employee, policy, shift };
}

const countEvents = (employeeId: string | null, organisationId: string, type: string) =>
  prisma.activityEvent.count({
    where: { organisationId, ...(employeeId ? { employeeId } : {}), type: type as never },
  });

describe("runWorkModeTick", () => {
  it("evaluates candidates, persists the expected state and publishes work-state changes", async () => {
    const now = new Date();
    const { org, employee, shift } = await connectedFixture(now);
    const seen: RealtimeEvent[] = [];
    const unsubscribe = getEventBus().subscribe(org.organisation.id, (e) => seen.push(e));

    const report = await runWorkModeTick(now, { sendDigest: false });
    expect(report.errors).toEqual([]);
    expect(report.employeesEvaluated).toBeGreaterThanOrEqual(1);
    const row = await prisma.employeeWorkState.findUniqueOrThrow({ where: { employeeId: employee.id } });
    expect(row.expectedState).toBe("WORKING");
    expect(row.expectedRestriction).toBe("WORK");
    expect(row.state).toBe("WORKING");
    expect(row.source).toBe("SERVER_COMPUTED");
    expect(row.activeShiftId).toBe(shift.id);
    expect(row.nextTransitionAt?.getTime()).toBe(shift.endsAt.getTime() - 5 * MINUTE);
    expect(row.attentionReason).toBeNull();
    expect(seen.some((e) => e.type === "employee.work_state.changed" && e.employeeId === employee.id)).toBe(true);

    // A second tick a minute later changes nothing and publishes nothing new.
    seen.length = 0;
    await runWorkModeTick(new Date(now.getTime() + MINUTE), { sendDigest: false });
    expect(seen.filter((e) => e.type === "employee.work_state.changed")).toHaveLength(0);
    unsubscribe();
  });

  it("auto-ends an expired break exactly once with BREAK_EXPIRED and ends breaks of ended shifts", async () => {
    const now = new Date();
    const { org, employee, shift } = await connectedFixture(now);
    const expired = await prisma.breakSession.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        shiftId: shift.id,
        startedAt: new Date(now.getTime() - 30 * MINUTE),
        plannedEndsAt: new Date(now.getTime() - 15 * MINUTE),
        clientBreakId: randomUUID(),
      },
    });
    const cancelledShift = await prisma.shift.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        startsAt: new Date(now.getTime() - 26 * HOUR),
        endsAt: new Date(now.getTime() - 20 * HOUR),
        timezone: "Europe/London",
        status: "CANCELLED",
      },
    });
    const orphan = await prisma.breakSession.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        shiftId: cancelledShift.id,
        startedAt: new Date(now.getTime() - 25 * HOUR),
        plannedEndsAt: new Date(now.getTime() - 24 * HOUR),
        clientBreakId: randomUUID(),
      },
    });

    const first = await runWorkModeTick(now, { sendDigest: false });
    expect(first.breaksExpired).toBe(1);
    const closed = await prisma.breakSession.findUniqueOrThrow({ where: { id: expired.id } });
    expect(closed.status).toBe("ENDED");
    expect(closed.endReason).toBe("EXPIRED");
    expect(closed.endedAt?.getTime()).toBe(expired.plannedEndsAt.getTime());
    const orphanRow = await prisma.breakSession.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(orphanRow.status).toBe("ENDED");
    expect(orphanRow.endReason).toBe("SHIFT_ENDED");
    expect(await countEvents(employee.id, org.organisation.id, "BREAK_EXPIRED")).toBe(1);
    expect(await countEvents(employee.id, org.organisation.id, "BREAK_ENDED")).toBe(1);
    const row = await prisma.employeeWorkState.findUniqueOrThrow({ where: { employeeId: employee.id } });
    expect(row.activeBreakSessionId).toBeNull();
    expect(row.breaksTakenCount).toBe(1);
    expect(row.breakMinutesUsed).toBe(15);

    const second = await runWorkModeTick(new Date(now.getTime() + MINUTE), { sendDigest: false });
    expect(second.breaksExpired).toBe(0);
    expect(await countEvents(employee.id, org.organisation.id, "BREAK_EXPIRED")).toBe(1);
  });

  it("emits OVERRIDE_EXPIRED exactly once per expired override and never for revoked ones", async () => {
    const now = new Date();
    const { org, employee } = await connectedFixture(now);
    const base = { organisationId: org.organisation.id, reason: "cover", startsAt: new Date(now.getTime() - 2 * HOUR) };
    const expired = await prisma.managerOverride.create({
      data: { ...base, employeeId: employee.id, type: "EXEMPT_TEMPORARILY", expiresAt: new Date(now.getTime() - MINUTE) },
    });
    await prisma.managerOverride.create({
      data: {
        ...base,
        employeeId: employee.id,
        type: "EXEMPT_TEMPORARILY",
        expiresAt: new Date(now.getTime() - MINUTE),
        revokedAt: new Date(now.getTime() - HOUR),
      },
    });
    const orgWide = await prisma.managerOverride.create({
      data: { ...base, type: "EMERGENCY_POLICY_OVERRIDE", expiresAt: new Date(now.getTime() - 5 * MINUTE) },
    });
    const seen: RealtimeEvent[] = [];
    const unsubscribe = getEventBus().subscribe(org.organisation.id, (e) => seen.push(e));

    const first = await runWorkModeTick(now, { sendDigest: false });
    expect(first.overridesExpired).toBe(2);
    expect(await countEvents(employee.id, org.organisation.id, "OVERRIDE_EXPIRED")).toBe(1);
    expect(await countEvents(null, org.organisation.id, "OVERRIDE_EXPIRED")).toBe(2);
    expect((await prisma.managerOverride.findUniqueOrThrow({ where: { id: expired.id } })).expiredEventEmittedAt).not.toBeNull();
    expect((await prisma.managerOverride.findUniqueOrThrow({ where: { id: orgWide.id } })).expiredEventEmittedAt).not.toBeNull();
    expect(seen.filter((e) => e.type === "OVERRIDE_EXPIRED")).toHaveLength(2);
    expect(seen.filter((e) => e.type === "override.changed")).toHaveLength(2);

    const second = await runWorkModeTick(new Date(now.getTime() + MINUTE), { sendDigest: false });
    expect(second.overridesExpired).toBe(0);
    expect(await countEvents(null, org.organisation.id, "OVERRIDE_EXPIRED")).toBe(2);
    unsubscribe();
  });

  it("records DEVICE_SYNC_DELAYED once per episode", async () => {
    const now = new Date();
    const { org, employee, device } = await connectedFixture(now);
    await prisma.device.update({
      where: { id: device.id },
      data: { lastDeviceSyncAt: new Date(now.getTime() - 3 * HOUR) },
    });

    await runWorkModeTick(now, { sendDigest: false });
    const row = await prisma.employeeWorkState.findUniqueOrThrow({ where: { employeeId: employee.id } });
    expect(row.attentionReason).toContain(SYNC_DELAYED_MARKER);
    expect(await countEvents(employee.id, org.organisation.id, "DEVICE_SYNC_DELAYED")).toBe(1);

    await runWorkModeTick(new Date(now.getTime() + MINUTE), { sendDigest: false });
    await runWorkModeTick(new Date(now.getTime() + 2 * MINUTE), { sendDigest: false });
    expect(await countEvents(employee.id, org.organisation.id, "DEVICE_SYNC_DELAYED")).toBe(1);

    // The device syncs again: the episode ends…
    await prisma.device.update({ where: { id: device.id }, data: { lastDeviceSyncAt: new Date(now.getTime() + 3 * MINUTE) } });
    await runWorkModeTick(new Date(now.getTime() + 3 * MINUTE), { sendDigest: false });
    expect((await prisma.employeeWorkState.findUniqueOrThrow({ where: { employeeId: employee.id } })).attentionReason).toBeNull();

    // …and a new silence starts a new episode.
    await prisma.device.update({ where: { id: device.id }, data: { lastDeviceSyncAt: new Date(now.getTime() - 3 * HOUR) } });
    await runWorkModeTick(new Date(now.getTime() + 4 * MINUTE), { sendDigest: false });
    expect(await countEvents(employee.id, org.organisation.id, "DEVICE_SYNC_DELAYED")).toBe(2);
  });

  it("starts scheduled breaks server-side when their window opens, once", async () => {
    const now = new Date();
    const { org, employee, shift } = await connectedFixture(now);
    const scheduled = await prisma.scheduledBreak.create({
      data: { shiftId: shift.id, offsetMinutesFromStart: 119, durationMinutes: 15 },
    });
    await prisma.scheduledBreak.create({ data: { shiftId: shift.id, offsetMinutesFromStart: 200, durationMinutes: 15 } });

    const report = await runWorkModeTick(now, { sendDigest: false });
    expect(report.scheduledBreaksStarted).toBe(1);
    const session = await prisma.breakSession.findFirstOrThrow({
      where: { clientBreakId: scheduledBreakClientId(scheduled.id) },
    });
    expect(session.status).toBe("ACTIVE");
    expect(session.startedAt.getTime()).toBe(shift.startsAt.getTime() + 119 * MINUTE);
    expect(session.plannedEndsAt.getTime()).toBe(session.startedAt.getTime() + 15 * MINUTE);
    const started = await prisma.activityEvent.findFirstOrThrow({ where: { employeeId: employee.id, type: "BREAK_STARTED" } });
    expect(started.actorType).toBe("SYSTEM");
    expect((started.metadata as { trigger: string }).trigger).toBe("SCHEDULED");
    const row = await prisma.employeeWorkState.findUniqueOrThrow({ where: { employeeId: employee.id } });
    expect(row.expectedState).toBe("ON_BREAK");
    expect(row.activeBreakSessionId).toBe(session.id);

    const again = await runWorkModeTick(new Date(now.getTime() + MINUTE), { sendDigest: false });
    expect(again.scheduledBreaksStarted).toBe(0);
    expect(await prisma.breakSession.count({ where: { shiftId: shift.id } })).toBe(1);
    expect(await countEvents(employee.id, org.organisation.id, "BREAK_STARTED")).toBe(1);
  });

  it("sends the manager digest at most once an hour, in-app to OWNER/ADMIN and by email unless opted out", async () => {
    const now = new Date();
    const { org, employee, device } = await connectedFixture(now);
    // Permission lost during the shift → PERMISSIONS_MISSING while on shift → digest-worthy.
    await prisma.device.update({ where: { id: device.id }, data: { permissionState: "DENIED" } });
    const admin = await createTestUser({ name: "Quiet Admin" });
    await addMember(org.organisation.id, admin.user, "ADMIN");
    await prisma.organisationMembership.update({
      where: { userId_organisationId: { userId: admin.user.id, organisationId: org.organisation.id } },
      data: { notificationPreferences: { digestEmail: false } },
    });
    const manager = await createTestUser({ name: "Plain Manager" });
    await addMember(org.organisation.id, manager.user, "MANAGER");

    const report = await runWorkModeTick(now);
    expect(report.digestsSent).toBe(1);
    const notifications = await prisma.notification.findMany({
      where: { organisationId: org.organisation.id, type: DIGEST_NOTIFICATION_TYPE },
    });
    expect(notifications.map((n) => n.recipientId).sort()).toEqual([org.owner.id, admin.user.id].sort());
    expect(notifications[0]!.title).toContain("needs attention");
    expect((notifications[0]!.metadata as { employeeIds: string[] }).employeeIds).toEqual([employee.id]);
    const emails = testEmails().sent.filter((m) => m.subject.includes("attention"));
    expect(emails.map((m) => m.to.toLowerCase())).toEqual([org.owner.email.toLowerCase()]);
    expect(emails[0]!.text).toContain("Permissions missing");

    const again = await runWorkModeTick(new Date(now.getTime() + 10 * MINUTE));
    expect(again.digestsSent).toBe(0);
    expect(await prisma.notification.count({ where: { organisationId: org.organisation.id, type: DIGEST_NOTIFICATION_TYPE } })).toBe(2);

    const later = await runWorkModeTick(new Date(now.getTime() + 61 * MINUTE));
    expect(later.digestsSent).toBe(1);
  });

  it("records POLICY_RESOLUTION_WARNING for ambiguous team assignments once per day", async () => {
    const now = new Date();
    const { org, employee } = await connectedFixture(now);
    const [teamA, teamB] = await Promise.all([
      prisma.team.create({ data: { organisationId: org.organisation.id, name: "Bar" } }),
      prisma.team.create({ data: { organisationId: org.organisation.id, name: "Floor" } }),
    ]);
    await prisma.employeeTeam.createMany({
      data: [
        { employeeId: employee.id, teamId: teamA.id },
        { employeeId: employee.id, teamId: teamB.id },
      ],
    });
    const [policyA, policyB] = await Promise.all([
      prisma.breakPolicy.create({ data: { organisationId: org.organisation.id, name: "Bar breaks" } }),
      prisma.breakPolicy.create({ data: { organisationId: org.organisation.id, name: "Floor breaks" } }),
    ]);
    await prisma.breakPolicyAssignment.create({
      data: { organisationId: org.organisation.id, breakPolicyId: policyA.id, scopeType: "TEAM", scopeId: teamA.id },
    });
    await prisma.breakPolicyAssignment.create({
      data: { organisationId: org.organisation.id, breakPolicyId: policyB.id, scopeType: "TEAM", scopeId: teamB.id },
    });

    const first = await runWorkModeTick(now, { sendDigest: false });
    expect(first.resolutionWarnings).toBe(1);
    const warning = await prisma.activityEvent.findFirstOrThrow({
      where: { employeeId: employee.id, type: "POLICY_RESOLUTION_WARNING" },
    });
    expect((warning.metadata as { code: string; kind: string }).code).toBe("AMBIGUOUS_TEAM_ASSIGNMENT");
    expect((warning.metadata as { kind: string }).kind).toBe("break");

    const second = await runWorkModeTick(new Date(now.getTime() + MINUTE), { sendDigest: false });
    expect(second.resolutionWarnings).toBe(0);
    expect(await countEvents(employee.id, org.organisation.id, "POLICY_RESOLUTION_WARNING")).toBe(1);
  });
});

describe("push bridge", () => {
  it("sends one debounced silent push per affected device with the decrypted token", async () => {
    const now = new Date();
    const provider = new MockPushProvider();
    setPushProviderForTesting(provider);
    const { org, employee, device } = await connectedFixture(now);
    const other = await createTestDevice(org.organisation.id);
    const token = "ab".repeat(32);
    await prisma.device.update({
      where: { id: device.id },
      data: { pushTokenEncrypted: new Uint8Array(encrypt(JSON.stringify({ token, environment: "sandbox" }))) },
    });
    await prisma.device.update({
      where: { id: other.device.id },
      data: { pushTokenEncrypted: new Uint8Array(encrypt(JSON.stringify({ token: "cd".repeat(32), environment: "sandbox" }))) },
    });
    ensureOrganisationBridged(org.organisation.id);

    publishEvent({
      type: "POLICY_CHANGED",
      organisationId: org.organisation.id,
      payload: { policyId: randomUUID(), reason: "PUBLISHED", affectedEmployeeIds: [employee.id] },
    });
    publishEvent({
      type: "SCHEDULE_CHANGED",
      organisationId: org.organisation.id,
      employeeId: employee.id,
      payload: { employeeId: employee.id, shiftIds: [randomUUID()], reason: "UPDATED" },
    });
    await flushPushBridge();
    expect(provider.silent).toHaveLength(1);
    expect(provider.silent[0]!.tokens).toEqual([token]);
    expect(provider.silent[0]!.payload.reason).toBe("policy_changed,schedule_changed");

    // Organisation-wide override → every device with a token.
    publishEvent({
      type: "OVERRIDE_CREATED",
      organisationId: org.organisation.id,
      payload: { overrideId: randomUUID(), type: "EMERGENCY_POLICY_OVERRIDE", employeeId: null },
    });
    await flushPushBridge();
    expect(provider.silent).toHaveLength(3);
    const tokens = provider.silent.slice(1).flatMap((s) => s.tokens).sort();
    expect(tokens).toEqual([token, "cd".repeat(32)].sort());

    // Unrelated event kinds are ignored.
    publishEvent({ type: "activity.recorded", organisationId: org.organisation.id, payload: {} });
    await flushPushBridge();
    expect(provider.silent).toHaveLength(3);
  });
});

describe("POST /api/jobs/tick", () => {
  it("requires the scheduler secret and returns the tick report", async () => {
    const anonymous = await callRoute<ErrorBody>(tickRoute, { method: "POST", path: "/api/jobs/tick" });
    expect(anonymous.status).toBe(401);
    const wrong = await callRoute<ErrorBody>(tickRoute, {
      method: "POST",
      path: "/api/jobs/tick",
      headers: { authorization: "Bearer not-the-secret" },
    });
    expect(wrong.status).toBe(401);

    const res = await callRoute<{ ok: boolean; report: { now: string; errors: string[] } }>(tickRoute, {
      method: "POST",
      path: "/api/jobs/tick",
      headers: { authorization: `Bearer ${env().CRON_SECRET}` },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.report.errors).toEqual([]);
    expect(Date.parse(res.body.report.now)).not.toBeNaN();
  });
});
