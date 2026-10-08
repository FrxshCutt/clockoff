import { randomUUID } from "node:crypto";
import { prisma } from "@clockoff/db";
import { describe, expect, it } from "vitest";
import { GET as syncRoute } from "@/app/api/mobile/v1/sync/route";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { issueMobileTokens } from "@/server/mobileAuth";
import { SYNC_DELAYED_MARKER } from "@/server/workState/workState.service";
import {
  runScheduleUpkeep,
  runWorkModeTick,
  scheduledBreakClientId,
  sweepExpiredOverrides,
} from "@/server/workState/workStateJob";
import { DIGEST_NOTIFICATION_TYPE } from "@/server/digest/digest.service";
import {
  callRoute,
  createTestDevice,
  createTestOrg,
  createTestUser,
  addMember,
  testEmails,
} from "../helpers";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function connectedFixture(now: Date) {
  const org = await createTestOrg();
  const { device, employee } = await createTestDevice(org.organisation.id);
  await prisma.employee.update({ where: { id: employee.id }, data: { inviteStatus: "CONNECTED" } });
  const connected = await prisma.device.update({
    where: { id: device.id },
    data: {
      permissionState: "APPROVED",
      selectionState: "CONFIGURED",
      lastDeviceSyncAt: now,
      lastSeenAt: now,
    },
  });
  const policy = await prisma.breakPolicy.create({
    data: { organisationId: org.organisation.id, name: "Breaks" },
  });
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
    const row = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(row.expectedState).toBe("WORKING");
    expect(row.expectedRestriction).toBe("WORK");
    expect(row.state).toBe("WORKING");
    expect(row.source).toBe("SERVER_COMPUTED");
    expect(row.activeShiftId).toBe(shift.id);
    expect(row.nextTransitionAt?.getTime()).toBe(shift.endsAt.getTime() - 5 * MINUTE);
    expect(row.attentionReason).toBeNull();
    expect(
      seen.some((e) => e.type === "employee.work_state.changed" && e.employeeId === employee.id),
    ).toBe(true);

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
    const row = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
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
    const base = {
      organisationId: org.organisation.id,
      reason: "cover",
      startsAt: new Date(now.getTime() - 2 * HOUR),
    };
    const expired = await prisma.managerOverride.create({
      data: {
        ...base,
        employeeId: employee.id,
        type: "EXEMPT_TEMPORARILY",
        expiresAt: new Date(now.getTime() - MINUTE),
      },
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
      data: {
        ...base,
        type: "EMERGENCY_POLICY_OVERRIDE",
        expiresAt: new Date(now.getTime() - 5 * MINUTE),
      },
    });
    const seen: RealtimeEvent[] = [];
    const unsubscribe = getEventBus().subscribe(org.organisation.id, (e) => seen.push(e));

    const first = await runWorkModeTick(now, { sendDigest: false });
    expect(first.overridesExpired).toBe(2);
    expect(await countEvents(employee.id, org.organisation.id, "OVERRIDE_EXPIRED")).toBe(1);
    expect(await countEvents(null, org.organisation.id, "OVERRIDE_EXPIRED")).toBe(2);
    expect(
      (await prisma.managerOverride.findUniqueOrThrow({ where: { id: expired.id } }))
        .expiredEventEmittedAt,
    ).not.toBeNull();
    expect(
      (await prisma.managerOverride.findUniqueOrThrow({ where: { id: orgWide.id } }))
        .expiredEventEmittedAt,
    ).not.toBeNull();
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
    const row = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(row.attentionReason).toContain(SYNC_DELAYED_MARKER);
    expect(await countEvents(employee.id, org.organisation.id, "DEVICE_SYNC_DELAYED")).toBe(1);

    await runWorkModeTick(new Date(now.getTime() + MINUTE), { sendDigest: false });
    await runWorkModeTick(new Date(now.getTime() + 2 * MINUTE), { sendDigest: false });
    expect(await countEvents(employee.id, org.organisation.id, "DEVICE_SYNC_DELAYED")).toBe(1);

    // The device syncs again: the episode ends…
    await prisma.device.update({
      where: { id: device.id },
      data: { lastDeviceSyncAt: new Date(now.getTime() + 3 * MINUTE) },
    });
    await runWorkModeTick(new Date(now.getTime() + 3 * MINUTE), { sendDigest: false });
    expect(
      (await prisma.employeeWorkState.findUniqueOrThrow({ where: { employeeId: employee.id } }))
        .attentionReason,
    ).toBeNull();

    // …and a new silence starts a new episode.
    await prisma.device.update({
      where: { id: device.id },
      data: { lastDeviceSyncAt: new Date(now.getTime() - 3 * HOUR) },
    });
    await runWorkModeTick(new Date(now.getTime() + 4 * MINUTE), { sendDigest: false });
    expect(await countEvents(employee.id, org.organisation.id, "DEVICE_SYNC_DELAYED")).toBe(2);
  });

  it("records DEVICE_SYNC_DELAYED once when an on-demand evaluation (GET /sync) is the first to see the episode", async () => {
    const now = new Date();
    const { org, employee, device } = await connectedFixture(now);
    const silent = await prisma.device.update({
      where: { id: device.id },
      data: { lastDeviceSyncAt: new Date(now.getTime() - 3 * HOUR) },
    });
    const { accessToken } = await issueMobileTokens(silent);

    // The phone fetches its bundle without having posted /device/state for 3 h on shift: the sync evaluation
    // claims the episode and must emit the event — otherwise the job, seeing the marker, never would.
    const res = await callRoute(syncRoute, {
      path: "/api/mobile/v1/sync",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const row = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(row.attentionReason).toContain(SYNC_DELAYED_MARKER);
    expect(await countEvents(employee.id, org.organisation.id, "DEVICE_SYNC_DELAYED")).toBe(1);

    const tick = await runWorkModeTick(new Date(now.getTime() + MINUTE), { sendDigest: false });
    expect(tick.syncDelayedEpisodes).toBe(0);
    expect(await countEvents(employee.id, org.organisation.id, "DEVICE_SYNC_DELAYED")).toBe(1);
  });

  it("starts scheduled breaks server-side when their window opens, once", async () => {
    const now = new Date();
    const { org, employee, shift } = await connectedFixture(now);
    const scheduled = await prisma.scheduledBreak.create({
      data: { shiftId: shift.id, offsetMinutesFromStart: 119, durationMinutes: 15 },
    });
    await prisma.scheduledBreak.create({
      data: { shiftId: shift.id, offsetMinutesFromStart: 200, durationMinutes: 15 },
    });

    const report = await runWorkModeTick(now, { sendDigest: false });
    expect(report.scheduledBreaksStarted).toBe(1);
    const session = await prisma.breakSession.findFirstOrThrow({
      where: { clientBreakId: scheduledBreakClientId(scheduled.id) },
    });
    expect(session.status).toBe("ACTIVE");
    expect(session.startedAt.getTime()).toBe(shift.startsAt.getTime() + 119 * MINUTE);
    expect(session.plannedEndsAt.getTime()).toBe(session.startedAt.getTime() + 15 * MINUTE);
    const started = await prisma.activityEvent.findFirstOrThrow({
      where: { employeeId: employee.id, type: "BREAK_STARTED" },
    });
    expect(started.actorType).toBe("SYSTEM");
    expect((started.metadata as { trigger: string }).trigger).toBe("SCHEDULED");
    const row = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
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
      where: {
        userId_organisationId: { userId: admin.user.id, organisationId: org.organisation.id },
      },
      data: { notificationPreferences: { digestEmail: false } },
    });
    const manager = await createTestUser({ name: "Plain Manager" });
    await addMember(org.organisation.id, manager.user, "MANAGER");

    // The tick covers every organisation in the shared test database (other files leave flagged employees
    // with shifts today behind), so the report counts are lower bounds; this organisation's rows are exact.
    const digestRows = () =>
      prisma.notification.count({
        where: { organisationId: org.organisation.id, type: DIGEST_NOTIFICATION_TYPE },
      });
    const report = await runWorkModeTick(now);
    expect(report.digestsSent).toBeGreaterThanOrEqual(1);
    const notifications = await prisma.notification.findMany({
      where: { organisationId: org.organisation.id, type: DIGEST_NOTIFICATION_TYPE },
    });
    expect(notifications.map((n) => n.recipientId).sort()).toEqual(
      [org.owner.id, admin.user.id].sort(),
    );
    expect(notifications[0]!.title).toContain("needs attention");
    expect((notifications[0]!.metadata as { employeeIds: string[] }).employeeIds).toEqual([
      employee.id,
    ]);
    const members = [org.owner.email, admin.user.email, manager.user.email].map((e) =>
      e.toLowerCase(),
    );
    const emails = testEmails().sent.filter(
      (m) => m.subject.includes("attention") && members.includes(m.to.toLowerCase()),
    );
    expect(emails.map((m) => m.to.toLowerCase())).toEqual([org.owner.email.toLowerCase()]);
    expect(emails[0]!.text).toContain("Permissions missing");

    await runWorkModeTick(new Date(now.getTime() + 10 * MINUTE));
    expect(await digestRows()).toBe(2);

    const later = await runWorkModeTick(new Date(now.getTime() + 61 * MINUTE));
    expect(later.digestsSent).toBeGreaterThanOrEqual(1);
    expect(await digestRows()).toBe(4);
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
      prisma.breakPolicy.create({
        data: { organisationId: org.organisation.id, name: "Bar breaks" },
      }),
      prisma.breakPolicy.create({
        data: { organisationId: org.organisation.id, name: "Floor breaks" },
      }),
    ]);
    await prisma.breakPolicyAssignment.create({
      data: {
        organisationId: org.organisation.id,
        breakPolicyId: policyA.id,
        scopeType: "TEAM",
        scopeId: teamA.id,
      },
    });
    await prisma.breakPolicyAssignment.create({
      data: {
        organisationId: org.organisation.id,
        breakPolicyId: policyB.id,
        scopeType: "TEAM",
        scopeId: teamB.id,
      },
    });

    const first = await runWorkModeTick(now, { sendDigest: false });
    expect(first.resolutionWarnings).toBe(1);
    const warning = await prisma.activityEvent.findFirstOrThrow({
      where: { employeeId: employee.id, type: "POLICY_RESOLUTION_WARNING" },
    });
    expect((warning.metadata as { code: string; kind: string }).code).toBe(
      "AMBIGUOUS_TEAM_ASSIGNMENT",
    );
    expect((warning.metadata as { kind: string }).kind).toBe("break");

    const second = await runWorkModeTick(new Date(now.getTime() + MINUTE), { sendDigest: false });
    expect(second.resolutionWarnings).toBe(0);
    expect(await countEvents(employee.id, org.organisation.id, "POLICY_RESOLUTION_WARNING")).toBe(
      1,
    );
  });
});

describe("runWorkModeTick options (the worker's job split)", () => {
  it("sweepOverrides: false leaves expired overrides to the override-expiry job, which emits once", async () => {
    const now = new Date();
    const { org, employee } = await connectedFixture(now);
    const expired = await prisma.managerOverride.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        type: "EXEMPT_TEMPORARILY",
        reason: "cover",
        startsAt: new Date(now.getTime() - 2 * HOUR),
        expiresAt: new Date(now.getTime() - MINUTE),
      },
    });

    const tick = await runWorkModeTick(now, {
      sendDigest: false,
      sweepOverrides: false,
      scheduleUpkeep: false,
    });
    expect(tick.overridesExpired).toBe(0);
    expect(
      (await prisma.managerOverride.findUniqueOrThrow({ where: { id: expired.id } }))
        .expiredEventEmittedAt,
    ).toBeNull();
    expect(await countEvents(employee.id, org.organisation.id, "OVERRIDE_EXPIRED")).toBe(0);

    // The override-expiry job (the test database is shared, so the sweep count is a lower bound).
    expect(await sweepExpiredOverrides(now)).toBeGreaterThanOrEqual(1);
    await sweepExpiredOverrides(new Date(now.getTime() + MINUTE));
    expect(await countEvents(employee.id, org.organisation.id, "OVERRIDE_EXPIRED")).toBe(1);
    expect(
      (await prisma.managerOverride.findUniqueOrThrow({ where: { id: expired.id } }))
        .expiredEventEmittedAt,
    ).not.toBeNull();
  });

  it("scheduleUpkeep: false leaves ended shifts to the schedule-upkeep job", async () => {
    const now = new Date();
    const { org, employee } = await connectedFixture(now);
    const ended = await prisma.shift.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        startsAt: new Date(now.getTime() - 7 * HOUR),
        endsAt: new Date(now.getTime() - 3 * HOUR),
        timezone: "Europe/London",
      },
    });

    const tick = await runWorkModeTick(now, {
      sendDigest: false,
      sweepOverrides: false,
      scheduleUpkeep: false,
    });
    expect(tick.shiftsCompleted).toBe(0);
    expect(tick.recurrencesCreated).toBe(0);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: ended.id } })).status).toBe(
      "SCHEDULED",
    );

    const upkeep = await runScheduleUpkeep(now);
    expect(upkeep.errors).toEqual([]);
    expect(upkeep.shiftsCompleted).toBeGreaterThanOrEqual(1);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: ended.id } })).status).toBe(
      "COMPLETED",
    );
  });

  it("runs every step by default (override sweep and schedule upkeep included)", async () => {
    const now = new Date();
    const { org, employee } = await connectedFixture(now);
    await prisma.managerOverride.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        type: "EXEMPT_TEMPORARILY",
        reason: "cover",
        startsAt: new Date(now.getTime() - 2 * HOUR),
        expiresAt: new Date(now.getTime() - MINUTE),
      },
    });
    const ended = await prisma.shift.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        startsAt: new Date(now.getTime() - 7 * HOUR),
        endsAt: new Date(now.getTime() - 3 * HOUR),
        timezone: "Europe/London",
      },
    });

    const tick = await runWorkModeTick(now, { sendDigest: false });
    expect(tick.overridesExpired).toBeGreaterThanOrEqual(1);
    expect(tick.shiftsCompleted).toBeGreaterThanOrEqual(1);
    expect(await countEvents(employee.id, org.organisation.id, "OVERRIDE_EXPIRED")).toBe(1);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: ended.id } })).status).toBe(
      "COMPLETED",
    );
  });
});
