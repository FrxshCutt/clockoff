import { prisma } from "@clockoff/db";
import { mobileSyncResponseSchema } from "@clockoff/validation/mobile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as syncRoute } from "@/app/api/mobile/v1/sync/route";
import { resetEnvCache } from "@/lib/env";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { loadScheduleVersion } from "@/server/sync/scheduleVersion";
import { callRoute } from "../../helpers";
import {
  completeOnboarding,
  connectionOf,
  connectViaMethod,
  createPlandayOrg,
  DAY_MS,
  deviceFor,
  employeeFor,
  finishOnboarding,
  installPlanday,
  recordTransactionOperations,
  runKind,
  runSync,
  shiftFor,
  uninstallPlanday,
  type PlandayOrg,
  type PlandayTestContext,
} from "./plandayHarness";

/**
 * Shifts end to end (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.6, §6.7, §6.9, §13.2 `syncShifts.test.ts`):
 * Mock Planday → provider phases → the apply sink → the integration writers, through `runSyncSlice` exactly as the
 * worker runs it. Fixture times are Europe/London wall-clock; FROZEN_NOW is 2026-10-21 10:30Z (11:30 BST).
 */

let t: PlandayTestContext;
let org: PlandayOrg;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(async () => {
  t = installPlanday();
  org = await createPlandayOrg();
  await connectViaMethod(org);
});

afterEach(() => {
  expect(t.mock.unexpectedRequests).toEqual([]);
  uninstallPlanday();
});

const specials = () => t.mock.fixture.specials;

async function shift(id: number) {
  const row = await shiftFor(org, id);
  if (!row) throw new Error(`Planday shift ${id} is not mapped`);
  return row;
}

describe("the INITIAL SYNC's filter (§6.6)", () => {
  it("imports published shifts only: drafts excluded, open ignored, history before connecting skipped", async () => {
    const onboarding = await completeOnboarding(org);
    const run = onboarding.initialSync!.run;
    expect(run.status).toBe("SUCCEEDED");

    expect(await shiftFor(org, specials().draftShiftId)).toBeNull();
    expect(await shiftFor(org, specials().openShiftId)).toBeNull();
    expect(await shiftFor(org, specials().excludedDepartmentShiftId)).toBeNull();
    // 500004 ended (Tue 20 Oct) before the first sync: never imported.
    expect(await shiftFor(org, 500004)).toBeNull();
    const counts = run.counts as {
      excluded: Record<string, number>;
      shifts: Record<string, number>;
    };
    expect(counts.excluded.drafts).toBe(1);
    expect(counts.excluded.open).toBe(1);
    expect(counts.excluded.outOfScope).toBeGreaterThanOrEqual(1);

    // Other published statuses are imported.
    for (const id of [specials().forSaleShiftId, specials().inProgressShiftId, 500018]) {
      const row = await shift(id);
      expect(row.status).toBe("SCHEDULED");
      expect(row.source).toBe("INTEGRATION");
      expect(row.managedByIntegrationId).toBe(org.integrationId);
      expect(row.externalShiftId).toBe(`PLANDAY:${org.portalId}:${id}`);
      expect(row.notes).toBeNull();
      expect(row.timezone).toBe("Europe/London");
    }
    const aisha = await employeeFor(org, 1001);
    expect((await shift(500018)).employeeId).toBe(aisha!.id);
  });

  it("imports an Open shift that has an employee, and ignores one without", async () => {
    await completeOnboarding(org);
    t.mock.controls.addShift({
      id: 590001,
      employeeId: 1001,
      departmentId: 101,
      status: "Open",
      timeZone: "Europe/London",
      startDateTime: "2026-10-27T06:00:00",
      endDateTime: "2026-10-27T09:00:00",
    });
    t.mock.controls.addShift({
      id: 590002,
      employeeId: null,
      departmentId: 101,
      status: "Assigned",
      timeZone: "Europe/London",
      startDateTime: "2026-10-27T06:00:00",
      endDateTime: "2026-10-27T09:00:00",
    });
    await runSync(org);
    expect((await shift(590001)).status).toBe("SCHEDULED");
    expect(await shiftFor(org, 590002)).toBeNull();
  });

  it("resolves overnight shifts and the late-October DST change in the shift's zone", async () => {
    await completeOnboarding(org);
    const overnight = await shift(500012);
    expect(overnight.startsAt.toISOString()).toBe("2026-10-23T19:00:00.000Z");
    expect(overnight.endsAt.toISOString()).toBe("2026-10-24T01:00:00.000Z");
    const dst = await shift(specials().dstShiftId!);
    expect(dst.startsAt.toISOString()).toBe("2026-10-24T21:00:00.000Z");
    expect(dst.endsAt.toISOString()).toBe("2026-10-25T06:00:00.000Z");
    expect(dst.endsAt.getTime() - dst.startsAt.getTime()).toBe(9 * HOUR);
  });
});

describe("future shifts (rows 6, 7, 8, 15)", () => {
  beforeEach(async () => {
    await completeOnboarding(org);
  });

  it("moves an edited shift, bumping its version, publishing SCHEDULE_CHANGED and recording activity", async () => {
    const before = await shift(500018);
    const events: RealtimeEvent[] = [];
    const unsubscribe = getEventBus().subscribeAll((event) => events.push(event));
    t.mock.controls.editShift(500018, {
      startDateTime: "2026-10-26T11:00:00",
      endDateTime: "2026-10-26T19:00:00",
    });
    const { run } = await runSync(org);
    unsubscribe();
    expect(run.status).toBe("SUCCEEDED");
    const after = await shift(500018);
    expect(after.id).toBe(before.id);
    expect(after.startsAt.toISOString()).toBe("2026-10-26T11:00:00.000Z");
    expect(after.endsAt.toISOString()).toBe("2026-10-26T19:00:00.000Z");
    expect(after.version).toBe(before.version + 1);
    expect(
      events.some((e) => e.type === "SCHEDULE_CHANGED" && e.employeeId === before.employeeId),
    ).toBe(true);
    const activity = await prisma.activityEvent.findFirst({
      where: {
        organisationId: org.organisationId,
        type: "SHIFT_UPDATED",
        employeeId: before.employeeId,
      },
      orderBy: { occurredAt: "desc" },
    });
    expect(activity?.actorType).toBe("SYSTEM");
    expect(activity?.metadata).toMatchObject({ source: "PLANDAY" });
    const synced = await prisma.activityEvent.count({
      where: { organisationId: org.organisationId, type: "INTEGRATION_SYNCED" },
    });
    expect(synced).toBeGreaterThanOrEqual(2);
  });

  it("an edit reaches GET /api/mobile/v1/sync as a new scheduleVersion", async () => {
    const aisha = await employeeFor(org, 1001);
    const { headers } = await deviceFor(org.organisationId, aisha!.id);
    const first = await callRoute(syncRoute, { path: "/api/mobile/v1/sync", headers });
    expect(first.status).toBe(200);
    const v1 = mobileSyncResponseSchema.parse(first.body).scheduleVersion;
    t.mock.controls.editShift(500018, { endDateTime: "2026-10-26T20:00:00" });
    await runSync(org);
    const second = await callRoute(syncRoute, { path: "/api/mobile/v1/sync", headers });
    const v2 = mobileSyncResponseSchema.parse(second.body).scheduleVersion;
    expect(v2).not.toBe(v1);
  });

  it("reassigns a future shift in place and tells both employees", async () => {
    const aisha = (await employeeFor(org, 1001))!;
    const ben = (await employeeFor(org, 1002))!;
    const before = await shift(500018);
    const aishaV = await loadScheduleVersion(org.organisationId, aisha.id);
    const benV = await loadScheduleVersion(org.organisationId, ben.id);
    t.mock.controls.reassignShift(500018, 1002);
    await runSync(org);
    const after = await shift(500018);
    expect(after.id).toBe(before.id);
    expect(after.employeeId).toBe(ben.id);
    expect(after.version).toBe(before.version + 1);
    expect(await loadScheduleVersion(org.organisationId, aisha.id)).not.toBe(aishaV);
    expect(await loadScheduleVersion(org.organisationId, ben.id)).not.toBe(benV);
  });

  it("cancels a shift Planday deleted (deleted list), never deleting it", async () => {
    t.mock.controls.deleteShift(500024);
    await runSync(org);
    const row = await shift(500024);
    expect(row.status).toBe("CANCELLED");
    expect(row.deletedAt).toBeNull();
    const map = await prisma.externalEntityMap.findFirst({
      where: { integrationId: org.integrationId, entityType: "SHIFT", externalId: "500024" },
    });
    expect(map?.upstreamRemovedAt).not.toBeNull();
  });

  it("cancels a shift that is gone by id (404) when the deleted list no longer names it", async () => {
    // The deletion falls before the deleted list's watermark: only the absent check can find it.
    await prisma.integrationConnection.update({
      where: { integrationId: org.integrationId },
      data: { deletedShiftsCheckedAt: new Date(t.now().getTime() + 3 * 86_400_000) },
    });
    t.mock.controls.deleteShift(500034);
    const { run } = await runSync(org);
    expect(run.status).toBe("SUCCEEDED");
    expect((await shift(500034)).status).toBe("CANCELLED");
    expect(t.mock.requestLog.some((e) => e.path === "/scheduling/v1.0/shifts/500034")).toBe(true);
  });

  it("cancels a shift moved to an excluded department", async () => {
    t.mock.controls.editShift(500036, { departmentId: 103 });
    await runSync(org);
    expect((await shift(500036)).status).toBe("CANCELLED");
  });

  it("X → unmapped Y → mapped C ends with C's shift (full-target REINSTATE)", async () => {
    const aisha = (await employeeFor(org, 1001))!;
    const ben = (await employeeFor(org, 1002))!;
    const original = await shift(500034);
    const aishaV = await loadScheduleVersion(org.organisationId, aisha.id);
    t.mock.controls.reassignShift(500034, 1010); // Omar: Head Office only, never imported
    await runSync(org);
    const cancelled = await shift(500034);
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.employeeId).toBe(aisha.id);

    t.mock.controls.reassignShift(500034, 1002);
    await runSync(org);
    const reinstated = await shift(500034);
    expect(reinstated.id).toBe(original.id);
    expect(reinstated.status).toBe("SCHEDULED");
    expect(reinstated.employeeId).toBe(ben.id);
    expect(reinstated.version).toBeGreaterThan(cancelled.version);
    expect(await loadScheduleVersion(org.organisationId, aisha.id)).not.toBe(aishaV);
  });

  it("a shift cancelled by the sync comes back after its old times passed (row 15, created afresh)", async () => {
    const aisha = (await employeeFor(org, 1001))!;
    const moved = await shift(500018); // 2026-10-26 10:00–18:00 GMT
    const drafted = await shift(500024); // 2026-10-28 10:00–18:00 GMT
    // Moved beyond the window's end (2026-11-18): ABSENT_SHIFTS reads it by id and cancels it (row 16), and the
    // other one becomes a draft (row 8). Both ClockOff copies keep their old times.
    t.mock.controls.editShift(500018, {
      startDateTime: "2026-12-01T10:00:00",
      endDateTime: "2026-12-01T18:00:00",
    });
    t.mock.controls.setShiftStatus(500024, "Draft");
    await runSync(org);
    for (const original of [moved, drafted]) {
      const cancelled = await prisma.shift.findUniqueOrThrow({ where: { id: original.id } });
      expect(cancelled.status).toBe("CANCELLED");
      expect(cancelled.startsAt).toEqual(original.startsAt);
    }

    // The old times pass; then Planday publishes both again inside the window.
    t.advance(8 * DAY_MS);
    t.mock.controls.editShift(500018, {
      startDateTime: "2026-11-10T10:00:00",
      endDateTime: "2026-11-10T18:00:00",
    });
    t.mock.controls.setShiftStatus(500024, "Assigned");
    t.mock.controls.editShift(500024, {
      startDateTime: "2026-11-12T10:00:00",
      endDateTime: "2026-11-12T18:00:00",
    });
    const { run } = await runSync(org);
    expect(run.status).toBe("SUCCEEDED");
    for (const [id, original, start] of [
      [500018, moved, "2026-11-10T10:00:00.000Z"],
      [500024, drafted, "2026-11-12T10:00:00.000Z"],
    ] as const) {
      const back = await shift(id);
      expect(back.id).not.toBe(original.id);
      expect(back.status).toBe("SCHEDULED");
      expect(back.employeeId).toBe(aisha.id);
      expect(back.startsAt.toISOString()).toBe(start);
      expect(back.managedByIntegrationId).toBe(org.integrationId);
      // The ended copy is never modified: still cancelled, same times; only its external id moved aside.
      const old = await prisma.shift.findUniqueOrThrow({ where: { id: original.id } });
      expect(old.status).toBe("CANCELLED");
      expect(old.startsAt).toEqual(original.startsAt);
      expect(old.externalShiftId).toBe(`PLANDAY:${org.portalId}:${id}:superseded:${original.id}`);
      const map = await prisma.externalEntityMap.findFirstOrThrow({
        where: { integrationId: org.integrationId, entityType: "SHIFT", externalId: String(id) },
      });
      expect(map.upstreamRemovedAt).toBeNull();
    }
    // Settled: the next SYNC changes nothing.
    const versions = [(await shift(500018)).version, (await shift(500024)).version];
    const again = await runSync(org);
    expect(again.run.counts).toMatchObject({ shifts: { created: 0, updated: 0, cancelled: 0 } });
    expect([(await shift(500018)).version, (await shift(500024)).version]).toEqual(versions);
  });

  it("keeps updating the shifts of a mapped employee a manager deactivated", async () => {
    const chloe = (await employeeFor(org, 1003))!;
    await prisma.employee.update({
      where: { id: chloe.id },
      data: { employmentStatus: "INACTIVE" },
    });
    t.mock.controls.editShift(500026, { endDateTime: "2026-10-29T17:00:00" });
    await runSync(org);
    const row = await shift(500026);
    expect(row.status).toBe("SCHEDULED");
    expect(row.endsAt.toISOString()).toBe("2026-10-29T17:00:00.000Z");
  });

  it("never acts on an undocumented status: the shift stays, the run warns", async () => {
    const before = await shift(500038);
    t.mock.controls.setShiftStatus(500038, "Mystery");
    const { run } = await runSync(org);
    expect(run.status).toBe("PARTIAL");
    const warnings = run.warnings as Array<{ code: string; externalId: string | null }>;
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_STATUS", externalId: "500038" }),
    );
    const after = await shift(500038);
    expect(after.status).toBe("SCHEDULED");
    expect(after.version).toBe(before.version);
    expect((run.counts as { excluded: { unknownStatus: number } }).excluded.unknownStatus).toBe(1);
  });

  it("fails the run with TIME_ENCODING_MISMATCH and writes nothing of the page", async () => {
    // Starts 00:30 BST, inside the UTC offset of midnight: the kind of shift the `date` cross-check catches (§4.8).
    t.mock.controls.addShift({
      id: 590010,
      employeeId: 1001,
      departmentId: 101,
      timeZone: "Europe/London",
      startDateTime: "2026-10-22T00:30:00",
      endDateTime: "2026-10-22T06:00:00",
    });
    await runSync(org);
    const before = await prisma.shift.findMany({
      where: { organisationId: org.organisationId },
      select: { id: true, version: true, startsAt: true },
    });
    t.mock.controls.setDateTimeFormat("utc-without-z");
    const { run } = await runSync(org);
    expect(run.status).toBe("FAILED");
    expect(run.errorCode).toBe("TIME_ENCODING_MISMATCH");
    expect(run.errorMessage).toContain("could not be read reliably");
    const after = await prisma.shift.findMany({
      where: { organisationId: org.organisationId },
      select: { id: true, version: true, startsAt: true },
    });
    expect(after).toEqual(before);
    t.mock.controls.setDateTimeFormat("local");
  });
});

describe("in-progress shifts (rows 9 to 14)", () => {
  beforeEach(async () => {
    await completeOnboarding(org);
  });

  it("extends and shortens an in-progress shift", async () => {
    const id = specials().inProgressShiftId; // 1001, 09:00–17:00 BST
    const before = await shift(id);
    t.mock.controls.editShift(id, { endDateTime: "2026-10-21T18:00:00" });
    await runSync(org);
    const extended = await shift(id);
    expect(extended.endsAt.toISOString()).toBe("2026-10-21T17:00:00.000Z");
    expect(extended.startsAt).toEqual(before.startsAt);
    expect(extended.version).toBe(before.version + 1);

    t.mock.controls.editShift(id, { endDateTime: "2026-10-21T13:00:00" });
    await runSync(org);
    const shortened = await shift(id);
    expect(shortened.endsAt.toISOString()).toBe("2026-10-21T12:00:00.000Z");
    expect(shortened.status).toBe("SCHEDULED");
  });

  it("ends a shift now when Planday's new end has passed (no 15-minute minimum)", async () => {
    const id = specials().inProgressShiftId;
    t.mock.controls.editShift(id, { endDateTime: "2026-10-21T11:00:00" }); // 10:00Z, before now (10:30Z)
    await runSync(org);
    const row = await shift(id);
    const now = t.now().getTime();
    expect(row.endsAt.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-10-21T10:30:00Z"));
    expect(row.endsAt.getTime()).toBeLessThanOrEqual(now + MINUTE);
    expect(row.status).toBe("SCHEDULED");
  });

  it("cancels an in-progress shift Planday removed", async () => {
    t.mock.controls.deleteShift(500007); // 1009, in progress
    await runSync(org);
    expect((await shift(500007)).status).toBe("CANCELLED");
  });

  it("an in-progress shift reassigned in Planday is cancelled and created afresh for the new employee", async () => {
    const id = specials().inProgressShiftId;
    const old = await shift(id);
    const grace = (await employeeFor(org, 1009))!;
    t.mock.controls.reassignShift(id, 1009);
    await runSync(org);
    const cancelled = await prisma.shift.findUniqueOrThrow({ where: { id: old.id } });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.externalShiftId).toBe(`PLANDAY:${org.portalId}:${id}:superseded:${old.id}`);
    const replacement = await shift(id);
    expect(replacement.id).not.toBe(old.id);
    expect(replacement.employeeId).toBe(grace.id);
    expect(replacement.status).toBe("SCHEDULED");
  });

  it("leaves past shifts untouched", async () => {
    const before = await shift(500005); // Kitchen 08:00–16:00 BST today (ends 15:00Z)
    t.advance(5 * HOUR); // 15:30Z: it has ended
    t.mock.controls.editShift(500005, { endDateTime: "2026-10-21T18:00:00" });
    await runSync(org);
    const after = await shift(500005);
    expect(after.endsAt).toEqual(before.endsAt);
    expect(after.version).toBe(before.version);
  });
});

describe("hidden days (§6.6, D-040)", () => {
  it("with respectHiddenDays on: skipped, cancelled when hidden later, reinstated on unhide; in progress untouched", async () => {
    await completeOnboarding(org, { respectHiddenDays: true });
    const hidden = specials().hiddenDay;
    for (const id of hidden.shiftIds) expect(await shiftFor(org, id)).toBeNull();

    t.mock.controls.setScheduleDayVisible(hidden.departmentId, hidden.date, true);
    await runSync(org);
    for (const id of hidden.shiftIds) expect((await shift(id)).status).toBe("SCHEDULED");

    t.mock.controls.setScheduleDayVisible(hidden.departmentId, hidden.date, false);
    await runSync(org);
    for (const id of hidden.shiftIds) expect((await shift(id)).status).toBe("CANCELLED");

    t.mock.controls.setScheduleDayVisible(hidden.departmentId, hidden.date, true);
    await runSync(org);
    for (const id of hidden.shiftIds) expect((await shift(id)).status).toBe("SCHEDULED");

    // Today's Kitchen day hidden while 500005 (1006, Kitchen) is in progress: never ended mid-shift.
    t.mock.controls.setScheduleDayVisible(102, "2026-10-21", false);
    const { run } = await runSync(org);
    expect((await shift(500005)).status).toBe("SCHEDULED");
    expect(run.warnings).toContainEqual(
      expect.objectContaining({ code: "HIDDEN_DAY_IN_PROGRESS", externalId: "500005" }),
    );
  });

  it("with respectHiddenDays off (the default), hidden days are ignored", async () => {
    await completeOnboarding(org);
    for (const id of specials().hiddenDay.shiftIds) {
      expect((await shift(id)).status).toBe("SCHEDULED");
    }
    expect(t.mock.requestLog.some((e) => e.path === "/scheduling/v1.0/scheduleDay")).toBe(false);
  });
});

describe("conflict replacement at the INITIAL SYNC (§6.6 Overlaps, D-034)", () => {
  it("cancels ticked conflicts with their replacement; keeps in-progress, unticked and unreplaced ones", async () => {
    await completeOnboarding(org, { stopBeforeFinish: true });
    const aisha = (await employeeFor(org, 1001))!;
    const manual = (startsAt: string, endsAt: string) =>
      prisma.shift.create({
        data: {
          organisationId: org.organisationId,
          employeeId: aisha.id,
          startsAt: new Date(startsAt),
          endsAt: new Date(endsAt),
          timezone: "Europe/London",
        },
      });
    const ticked = await manual("2026-10-26T09:00:00Z", "2026-10-26T12:00:00Z"); // overlaps 500018
    const unticked = await manual("2026-10-28T09:00:00Z", "2026-10-28T12:00:00Z"); // overlaps 500024
    const inProgress = await manual("2026-10-21T09:00:00Z", "2026-10-21T12:00:00Z"); // overlaps 500006, started
    const unreplaced = await manual("2026-10-27T01:00:00Z", "2026-10-27T02:00:00Z"); // no Planday shift
    const { run } = await finishOnboarding(org, {
      replaceShiftIds: [ticked.id, inProgress.id, unreplaced.id],
    });
    expect(run.status).toBe("PARTIAL");
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: ticked.id } })).status).toBe(
      "CANCELLED",
    );
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: unticked.id } })).status).toBe(
      "SCHEDULED",
    );
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: inProgress.id } })).status).toBe(
      "SCHEDULED",
    );
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: unreplaced.id } })).status).toBe(
      "SCHEDULED",
    );
    const audit = await prisma.auditLog.findFirst({
      where: {
        organisationId: org.organisationId,
        action: "integration.conflicting_shift_replaced",
      },
    });
    expect(audit?.entityId).toBe(ticked.id);
    expect(audit?.actorUserId).toBe(org.owner.id);
    const warnings = run.warnings as Array<{ code: string; message: string }>;
    expect(warnings.some((w) => w.code === "CONFLICT" && w.message.includes(unticked.id))).toBe(
      true,
    );
    expect(
      warnings.some((w) => w.code === "UNRESOLVED_CONFLICT" && w.message.includes(unreplaced.id)),
    ).toBe(true);
    // The first SYNC records one summary instead of a SHIFT_CREATED row per shift.
    expect(
      await prisma.activityEvent.count({
        where: {
          organisationId: org.organisationId,
          type: "SHIFT_CREATED",
          metadata: { path: ["source"], equals: "PLANDAY" },
        },
      }),
    ).toBe(0);
  });
});

describe("large pages (§6.1)", () => {
  it("applies 500 changed shifts in pages of 100, each step a fixed handful of statements within the transaction timeout", async () => {
    await completeOnboarding(org);
    const employees = [1001, 1002, 1003, 1005, 1008, 1009, 1012];
    const ids: number[] = [];
    for (let i = 0; i < 500; i++) {
      const day = 1 + (i % 14);
      const hour = i % 20;
      const id = 600000 + i;
      ids.push(id);
      t.mock.controls.addShift({
        id,
        employeeId: employees[i % employees.length]!,
        departmentId: [1003, 1008, 1012].includes(employees[i % employees.length]!) ? 102 : 101,
        status: "Assigned",
        timeZone: "Europe/London",
        startDateTime: `2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00`,
        endDateTime: `2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:30:00`,
      });
    }
    const created = await runSync(org);
    expect(created.run.status).toBe("SUCCEEDED");
    expect((created.run.counts as { shifts: { created: number } }).shifts.created).toBe(500);
    const versions = new Map(
      (
        await prisma.shift.findMany({
          where: {
            organisationId: org.organisationId,
            externalShiftId: { startsWith: "PLANDAY:4100001:6" },
          },
          select: { id: true, version: true },
        })
      ).map((s) => [s.id, s.version]),
    );
    for (const id of ids) {
      const fixture = t.mock.state.portal(4100001).shifts.get(id)!;
      t.mock.controls.editShift(id, { endDateTime: fixture.end.replace(":30:00", ":45:00") });
    }
    const started = Date.now();
    const recorder = recordTransactionOperations();
    const changed = await runSync(org).finally(recorder.stop);
    expect(changed.run.status).toBe("SUCCEEDED");
    expect((changed.run.counts as { shifts: { updated: number } }).shifts.updated).toBe(500);
    expect(Date.now() - started).toBeLessThan(60_000);
    // §6.1: a step's statements do not grow with its records (a page of 100 changed shifts would otherwise need
    // hundreds). 12 per page: run and lease fence, mapped employees, map rows, current shifts, the bulk UPDATE,
    // break sessions, rows read back, activity, map-row stamps, overlaps, run row. The step that completes SHIFTS
    // also selects row 16's out-of-window shifts (13).
    const sizes = recorder.transactions.map((operations) => operations.length);
    expect(sizes.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(13);
    expect(sizes.filter((size) => size === 13).length).toBeLessThanOrEqual(1);
    const shiftPages = t.mock.requestLog.filter(
      (e) => e.path === "/scheduling/v1.0/shifts" && e.seq > 0,
    ).length;
    expect(shiftPages).toBeGreaterThanOrEqual(12); // ≥ 6 pages of 100 per run
    const after = await prisma.shift.findMany({
      where: { id: { in: [...versions.keys()] } },
      select: { id: true, version: true },
    });
    for (const row of after) expect(row.version).toBe(versions.get(row.id)! + 1);
  });
});

describe("the connection after a SYNC (§7.2 FINALISE)", () => {
  it("records the watermarks and returns the connection to CONNECTED", async () => {
    const { initialSync } = await completeOnboarding(org);
    expect(initialSync!.run.status).toBe("SUCCEEDED");
    const connection = await connectionOf(org);
    expect(connection.status).toBe("CONNECTED");
    expect(connection.lastSuccessfulSyncAt).not.toBeNull();
    expect(connection.deletedShiftsCheckedAt).not.toBeNull();
    expect(connection.deactivationCheckedAt).not.toBeNull();
    expect(connection.consecutiveFailureCount).toBe(0);
    expect(connection.nextSyncAt).not.toBeNull();
    expect(initialSync!.run.cursor).toEqual({});
  });
});

describe("clock events (Beta, §6.8)", () => {
  beforeEach(() => {
    process.env.PLANDAY_CLOCK_MODE_ENABLED = "true";
    resetEnvCache();
  });
  afterEach(() => {
    delete process.env.PLANDAY_CLOCK_MODE_ENABLED;
    resetEnvCache();
  });

  it("records punches once as ClockEvents, and a punch-out ends the matched in-progress shift", async () => {
    await completeOnboarding(org, { activationMode: "CLOCK_EVENT" });
    const aisha = (await employeeFor(org, 1001))!;
    const { run } = await runKind(org, "CLOCK", "SCHEDULED");
    expect(run.status).toBe("SUCCEEDED");
    const events = await prisma.clockEvent.findMany({
      where: { organisationId: org.organisationId },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        employeeId: aisha.id,
        type: "CLOCK_IN",
        source: "PLANDAY",
        externalId: `${org.portalId}:800001:in`,
      }),
    );
    expect(events.some((e) => e.externalId?.includes(":800003:"))).toBe(false);

    t.mock.controls.upsertPunchClockShift({
      id: 800001,
      shiftId: specials().inProgressShiftId,
      departmentId: 101,
      employeeId: 1001,
      start: "2026-10-21T08:58:00",
      end: "2026-10-21T11:10:00",
    });
    await runKind(org, "CLOCK", "SCHEDULED");
    const ended = await shift(specials().inProgressShiftId);
    expect(ended.endsAt.toISOString()).toBe("2026-10-21T10:10:00.000Z");
    const count = await prisma.clockEvent.count({ where: { organisationId: org.organisationId } });
    await runKind(org, "CLOCK", "SCHEDULED");
    expect(await prisma.clockEvent.count({ where: { organisationId: org.organisationId } })).toBe(
      count,
    );
    expect((await shift(specials().inProgressShiftId)).version).toBe(ended.version);
  });

  it("a punch-in up to 60 minutes early moves the start of the matched future shift", async () => {
    t.mock.controls.addShift({
      id: 590020,
      employeeId: 1009,
      departmentId: 101,
      timeZone: "Europe/London",
      startDateTime: "2026-10-21T12:00:00",
      endDateTime: "2026-10-21T15:00:00",
    });
    await completeOnboarding(org, { activationMode: "CLOCK_EVENT" });
    const before = await shift(590020);
    t.mock.controls.upsertPunchClockShift({
      id: 800020,
      shiftId: 590020,
      departmentId: 101,
      employeeId: 1009,
      start: "2026-10-21T11:20:00",
      end: null,
    });
    await runKind(org, "CLOCK", "SCHEDULED");
    const after = await shift(590020);
    expect(after.startsAt.toISOString()).toBe("2026-10-21T10:20:00.000Z");
    expect(after.endsAt).toEqual(before.endsAt);
    expect(after.version).toBe(before.version + 1);

    // The next SYNC keeps the punched start (row 12, not 13): the shift stays in progress, Work Mode continues.
    const { run } = await runSync(org);
    expect(run.status).toBe("SUCCEEDED");
    const kept = await shift(590020);
    expect(kept.startsAt).toEqual(after.startsAt);
    expect(kept.version).toBe(after.version);
    expect(kept.status).toBe("SCHEDULED");
    expect(run.warnings).not.toContainEqual(
      expect.objectContaining({ code: "IN_PROGRESS_START_IGNORED" }),
    );
    // Planday extends it: the end follows, the start stays.
    t.mock.controls.editShift(590020, { endDateTime: "2026-10-21T16:00:00" });
    await runSync(org);
    const extended = await shift(590020);
    expect(extended.startsAt).toEqual(after.startsAt);
    expect(extended.endsAt.toISOString()).toBe("2026-10-21T15:00:00.000Z");
  });
});
