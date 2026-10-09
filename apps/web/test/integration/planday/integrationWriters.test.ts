import { randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@clockoff/db";
import { describe, expect, it } from "vitest";
import {
  deactivateManagedEmployee,
  importExternalEmployees,
  linkExternalEmployee,
  reactivateManagedEmployee,
  updateManagedEmployee,
  type ManagedEmployeeMemberships,
} from "@/server/employees/employees.integration";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import {
  createManagedLocations,
  renameManagedLocation,
} from "@/server/locations/locations.integration";
import {
  bulkRescheduleIntegrationShifts,
  cancelIntegrationShift,
  cancelIntegrationShifts,
  cancelReplacedShift,
  createIntegrationShifts,
  isNotManagedByIntegration,
  publishIntegrationShiftWrite,
  recreateIntegrationShift,
  reinstateIntegrationShift,
  rescheduleIntegrationShift,
  supersedeIntegrationShift,
  type IntegrationShiftActor,
  type IntegrationShiftInput,
} from "@/server/shifts/shifts.integration";
import { loadScheduleVersion } from "@/server/sync/scheduleVersion";
import {
  createManagedTeams,
  renameManagedTeam,
  syncManagedTeamMemberships,
} from "@/server/teams/teams.integration";
import { createTestDevice, createTestOrg } from "../../helpers";

/**
 * The integration writers (plan §6.5, §6.6, §6.9) against the test database: every change bumps `version`
 * (so `scheduleVersion` moves), activity rows carry `{ source: "PLANDAY", reason }`, ended shifts are never
 * modified, records another integration (or nobody) manages are refused, and every write stays inside the
 * run's organisation. The sync-level behaviour (decisions, pages, runs) is covered by the stage 3C suites.
 */

const TZ = "Europe/London";
const PORTAL = "4100001";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const tx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(fn, { timeout: 30_000 });

async function setup() {
  const org = await createTestOrg({ timezone: TZ, firstLocationName: "High Street" });
  const organisationId = org.organisation.id;
  const integration = await prisma.integration.create({
    data: { organisationId, provider: "PLANDAY", status: "CONNECTED" },
  });
  await prisma.integrationMappingConfig.create({
    data: { organisationId, integrationId: integration.id },
  });
  const now = new Date();
  const record = { organisationId, integrationId: integration.id };
  const actor: IntegrationShiftActor = {
    organisationId,
    actorType: "SYSTEM",
    actorUserId: null,
    integrationId: integration.id,
  };
  const { location, team, employeeIds } = await tx(async (t) => {
    const [location] = await createManagedLocations(
      t,
      record,
      [{ externalId: "200", name: "Kitchen", timezone: TZ, lastHash: null }],
      now,
    );
    const [team] = await createManagedTeams(
      t,
      record,
      [{ externalId: "300", name: "Chefs", lastHash: null }],
      now,
    );
    const memberships: ManagedEmployeeMemberships = {
      mappedLocationIds: [location!.locationId],
      locationIds: [location!.locationId],
      mappedTeamIds: [team!.teamId],
      teamIds: [team!.teamId],
    };
    const { employeeIds } = await importExternalEmployees(
      t,
      record,
      ["1001", "1002"].map((id, i) => ({
        externalId: id,
        externalEmployeeId: `PLANDAY:${PORTAL}:${id}`,
        fields: {
          firstName: i === 0 ? "Ava" : "Ben",
          lastName: "Planday",
          email: `${id}@example.test`,
          primaryLocationId: location!.locationId,
        },
        memberships,
        lastHash: `hash-${id}`,
      })),
      now,
    );
    return { location: location!, team: team!, employeeIds };
  });
  return {
    org,
    organisationId,
    integrationId: integration.id,
    actor,
    record,
    now,
    locationId: location.locationId,
    teamId: team.teamId,
    a: employeeIds[0]!,
    b: employeeIds[1]!,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

function shiftInput(
  f: Fixture,
  externalId: string,
  employeeId: string,
  startsAt: Date,
  endsAt: Date,
): IntegrationShiftInput {
  return {
    externalId,
    externalShiftId: `PLANDAY:${PORTAL}:${externalId}`,
    employeeId,
    locationId: f.locationId,
    startsAt,
    endsAt,
    timezone: TZ,
    lastHash: `hash-${externalId}`,
  };
}

async function createShift(
  f: Fixture,
  externalId: string,
  employeeId: string,
  startsAt: Date,
  endsAt: Date,
) {
  const result = await tx((t) =>
    createIntegrationShifts(
      t,
      f.actor,
      f.integrationId,
      [shiftInput(f, externalId, employeeId, startsAt, endsAt)],
      { recordActivity: false, now: f.now },
    ),
  );
  return result.rows[0]!;
}

async function startBreak(f: Fixture, shiftId: string, employeeId: string, startedAt: Date) {
  return prisma.breakSession.create({
    data: {
      organisationId: f.organisationId,
      employeeId,
      shiftId,
      startedAt,
      plannedEndsAt: new Date(startedAt.getTime() + 30 * MINUTE),
      clientBreakId: randomUUID(),
    },
  });
}

async function expectRejects(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe("createIntegrationShifts", () => {
  it("creates managed SCHEDULED shifts with map rows, activity and schedule changes", async () => {
    const f = await setup();
    const start = new Date(f.now.getTime() + 24 * HOUR);
    // An overlapping manual shift does not block a Planday shift (D-034).
    await prisma.shift.create({
      data: {
        organisationId: f.organisationId,
        employeeId: f.a,
        startsAt: start,
        endsAt: new Date(start.getTime() + 2 * HOUR),
        timezone: TZ,
      },
    });
    const result = await tx((t) =>
      createIntegrationShifts(
        t,
        f.actor,
        f.integrationId,
        [
          shiftInput(f, "5001", f.a, start, new Date(start.getTime() + 8 * HOUR)),
          shiftInput(
            f,
            "5002",
            f.a,
            new Date(start.getTime() + 24 * HOUR),
            new Date(start.getTime() + 30 * HOUR),
          ),
          shiftInput(f, "5003", f.b, start, new Date(start.getTime() + 4 * HOUR)),
        ],
        { recordActivity: true, now: f.now },
      ),
    );
    expect(result.rows.map((r) => r.externalShiftId)).toEqual([
      `PLANDAY:${PORTAL}:5001`,
      `PLANDAY:${PORTAL}:5002`,
      `PLANDAY:${PORTAL}:5003`,
    ]);
    for (const row of result.rows) {
      expect(row).toMatchObject({
        status: "SCHEDULED",
        source: "INTEGRATION",
        managedByIntegrationId: f.integrationId,
        notes: null,
        version: 1,
        timezone: TZ,
        locationId: f.locationId,
      });
    }
    const maps = await prisma.externalEntityMap.findMany({
      where: { integrationId: f.integrationId, entityType: "SHIFT" },
      orderBy: { externalId: "asc" },
    });
    expect(maps.map((m) => [m.externalId, m.internalId, m.lastHash])).toEqual(
      result.rows.map((r, i) => [`500${i + 1}`, r.id, `hash-500${i + 1}`]),
    );
    expect(result.activities).toHaveLength(3);
    expect(result.activities[0]).toMatchObject({ type: "SHIFT_CREATED", actorType: "SYSTEM" });
    expect(result.activities[0]!.metadata).toMatchObject({ source: "PLANDAY", reason: "CREATED" });
    expect(result.scheduleChanges).toEqual(
      expect.arrayContaining([
        { employeeId: f.a, shiftIds: [result.rows[0]!.id, result.rows[1]!.id], reason: "CREATED" },
        { employeeId: f.b, shiftIds: [result.rows[2]!.id], reason: "CREATED" },
      ]),
    );

    // The first SYNC after onboarding records one summary instead of a row per shift.
    const quiet = await tx((t) =>
      createIntegrationShifts(
        t,
        f.actor,
        f.integrationId,
        [
          shiftInput(
            f,
            "5004",
            f.b,
            new Date(start.getTime() + 48 * HOUR),
            new Date(start.getTime() + 52 * HOUR),
          ),
        ],
        { recordActivity: false, now: f.now },
      ),
    );
    expect(quiet.activities).toEqual([]);
    expect(quiet.scheduleChanges).toHaveLength(1);
  });

  it("writes nothing for an employee or location of another organisation", async () => {
    const f = await setup();
    const other = await setup();
    const start = new Date(f.now.getTime() + 24 * HOUR);
    const err = await expectRejects(
      tx((t) =>
        createIntegrationShifts(
          t,
          f.actor,
          f.integrationId,
          [
            shiftInput(f, "5001", f.a, start, new Date(start.getTime() + HOUR)),
            shiftInput(f, "5002", other.a, start, new Date(start.getTime() + HOUR)),
          ],
          { recordActivity: true, now: f.now },
        ),
      ),
    );
    expect(err).toMatchObject({
      code: "NOT_FOUND",
      details: { reason: "TARGET_NOT_IN_ORGANISATION", missing: { EMPLOYEE: [other.a] } },
    });
    // Another organisation's integration id is refused too.
    const foreign = await expectRejects(
      tx((t) =>
        createIntegrationShifts(
          t,
          f.actor,
          other.integrationId,
          [shiftInput(f, "5001", f.a, start, new Date(start.getTime() + HOUR))],
          { recordActivity: true, now: f.now },
        ),
      ),
    );
    expect(foreign).toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.shift.count({ where: { organisationId: f.organisationId } })).toBe(0);
    expect(await prisma.shift.count({ where: { organisationId: other.organisationId } })).toBe(0);
  });

  it("refuses a second shift for a mapped id and replaces the map row of a deleted one", async () => {
    const f = await setup();
    const start = new Date(f.now.getTime() + 24 * HOUR);
    const first = await createShift(f, "5001", f.a, start, new Date(start.getTime() + HOUR));
    const err = await expectRejects(
      tx((t) =>
        createIntegrationShifts(
          t,
          f.actor,
          f.integrationId,
          [shiftInput(f, "5001", f.a, start, new Date(start.getTime() + HOUR))],
          { recordActivity: true, now: f.now },
        ),
      ),
    );
    expect(err).toMatchObject({ code: "CONFLICT", details: { reason: "EXTERNAL_ID_MAPPED" } });

    await prisma.shift.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    const again = await createShift(f, "5001", f.a, start, new Date(start.getTime() + HOUR));
    expect(again.id).not.toBe(first.id);
    expect(again.externalShiftId).toBe(`PLANDAY:${PORTAL}:5001`);
    expect(
      (await prisma.shift.findUniqueOrThrow({ where: { id: first.id } })).externalShiftId,
    ).toBe(`PLANDAY:${PORTAL}:5001:deleted:${first.id}`);
    const map = await prisma.externalEntityMap.findMany({
      where: { integrationId: f.integrationId, entityType: "SHIFT", externalId: "5001" },
    });
    expect(map.map((m) => m.internalId)).toEqual([again.id]);
  });
});

describe("rescheduling", () => {
  it("bumps the version, moves scheduleVersion and records SHIFT_UPDATED", async () => {
    const f = await setup();
    const start = new Date(f.now.getTime() + 24 * HOUR);
    const shift = await createShift(f, "5001", f.a, start, new Date(start.getTime() + 4 * HOUR));
    const before = await loadScheduleVersion(f.organisationId, f.a);
    const result = await tx((t) =>
      rescheduleIntegrationShift(
        t,
        f.actor,
        shift,
        {
          startsAt: new Date(start.getTime() + HOUR),
          endsAt: new Date(start.getTime() + 6 * HOUR),
        },
        f.now,
      ),
    );
    expect(result.rows[0]).toMatchObject({
      id: shift.id,
      version: 2,
      startsAt: new Date(start.getTime() + HOUR),
      endsAt: new Date(start.getTime() + 6 * HOUR),
    });
    expect(await loadScheduleVersion(f.organisationId, f.a)).not.toBe(before);
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({ type: "SHIFT_UPDATED", actorType: "SYSTEM" });
    expect(result.activities[0]!.metadata).toMatchObject({
      source: "PLANDAY",
      reason: "RESCHEDULED",
      changedFields: ["startsAt", "endsAt"],
      version: 2,
    });
    expect(result.scheduleChanges).toEqual([
      { employeeId: f.a, shiftIds: [shift.id], reason: "UPDATED" },
    ]);
  });

  it("reassigns a future shift in place and tells both employees", async () => {
    const f = await setup();
    const start = new Date(f.now.getTime() + 24 * HOUR);
    const shift = await createShift(f, "5001", f.a, start, new Date(start.getTime() + 4 * HOUR));
    const result = await tx((t) =>
      bulkRescheduleIntegrationShifts(
        t,
        f.actor,
        [{ current: shift, patch: { endsAt: shift.endsAt, employeeId: f.b, locationId: null } }],
        f.now,
      ),
    );
    expect(result.rows[0]).toMatchObject({ employeeId: f.b, locationId: null, version: 2 });
    expect(result.activities[0]!.metadata).toMatchObject({
      reason: "REASSIGNED",
      previousEmployeeId: f.a,
    });
    expect(result.scheduleChanges).toEqual(
      expect.arrayContaining([
        { employeeId: f.b, shiftIds: [shift.id], reason: "UPDATED" },
        { employeeId: f.a, shiftIds: [shift.id], reason: "UPDATED" },
      ]),
    );
  });

  it("retries a concurrent change once with the fresh row", async () => {
    const f = await setup();
    const start = new Date(f.now.getTime() + 24 * HOUR);
    const stale = await createShift(f, "5001", f.a, start, new Date(start.getTime() + 4 * HOUR));
    // Another writer bumped the version after the sink read the row.
    await prisma.shift.update({ where: { id: stale.id }, data: { version: { increment: 1 } } });
    const result = await tx((t) =>
      bulkRescheduleIntegrationShifts(
        t,
        f.actor,
        [{ current: stale, patch: { endsAt: new Date(start.getTime() + 5 * HOUR) } }],
        f.now,
      ),
    );
    expect(result.rows[0]).toMatchObject({
      version: 3,
      endsAt: new Date(start.getTime() + 5 * HOUR),
    });
    expect(result.skipped).toEqual([]);
  });

  it("never modifies ended shifts and refuses shifts it does not manage", async () => {
    const f = await setup();
    const past = new Date(f.now.getTime() - 5 * HOUR);
    const ended = await createShift(f, "5001", f.a, past, new Date(past.getTime() + 2 * HOUR));
    const result = await tx((t) =>
      rescheduleIntegrationShift(
        t,
        f.actor,
        ended,
        { endsAt: new Date(f.now.getTime() + HOUR) },
        f.now,
      ),
    );
    expect(result.rows).toEqual([]);
    expect(result.skipped).toEqual([{ shiftId: ended.id, reason: "ENDED" }]);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: ended.id } })).version).toBe(1);

    const manual = await prisma.shift.create({
      data: {
        organisationId: f.organisationId,
        employeeId: f.a,
        startsAt: new Date(f.now.getTime() + 48 * HOUR),
        endsAt: new Date(f.now.getTime() + 50 * HOUR),
        timezone: TZ,
      },
    });
    const refused = await expectRejects(
      tx((t) =>
        rescheduleIntegrationShift(
          t,
          f.actor,
          manual,
          { endsAt: new Date(manual.endsAt.getTime() + HOUR) },
          f.now,
        ),
      ),
    );
    expect(isNotManagedByIntegration(refused)).toBe(true);

    const other = await setup();
    const foreign = await createShift(other, "5001", other.a, manual.startsAt, manual.endsAt);
    const crossOrg = await expectRejects(
      tx((t) => cancelIntegrationShift(t, f.actor, foreign, f.now, "DELETED")),
    );
    expect(crossOrg).toMatchObject({ code: "NOT_FOUND" });
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe(
      "SCHEDULED",
    );
  });

  it("ends a running break on END_NOW", async () => {
    const f = await setup();
    const shift = await createShift(
      f,
      "5001",
      f.a,
      new Date(f.now.getTime() - 2 * HOUR),
      new Date(f.now.getTime() + 3 * HOUR),
    );
    const session = await startBreak(f, shift.id, f.a, new Date(f.now.getTime() - 5 * MINUTE));
    const endsAt = new Date(Math.ceil(f.now.getTime() / MINUTE) * MINUTE + MINUTE);
    const result = await tx((t) =>
      rescheduleIntegrationShift(
        t,
        f.actor,
        shift,
        { endsAt, endRunningBreak: true, reason: "END_NOW" },
        f.now,
      ),
    );
    expect(result.rows[0]).toMatchObject({ endsAt, version: 2 });
    const ended = await prisma.breakSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(ended).toMatchObject({ status: "ENDED", endReason: "SHIFT_ENDED" });
    expect(result.activities.map((a) => a.type).sort()).toEqual(["BREAK_ENDED", "SHIFT_UPDATED"]);
  });
});

describe("cancelling and reinstating", () => {
  it("cancels (never deletes), marks the map row and ends a running break", async () => {
    const f = await setup();
    const future = await createShift(
      f,
      "5001",
      f.a,
      new Date(f.now.getTime() + 24 * HOUR),
      new Date(f.now.getTime() + 28 * HOUR),
    );
    const running = await createShift(
      f,
      "5002",
      f.b,
      new Date(f.now.getTime() - HOUR),
      new Date(f.now.getTime() + 3 * HOUR),
    );
    const ended = await createShift(
      f,
      "5003",
      f.a,
      new Date(f.now.getTime() - 6 * HOUR),
      new Date(f.now.getTime() - 4 * HOUR),
    );
    const session = await startBreak(f, running.id, f.b, new Date(f.now.getTime() - 10 * MINUTE));
    const result = await tx((t) =>
      cancelIntegrationShifts(
        t,
        f.actor,
        [
          { current: future, reason: "DELETED" },
          { current: running, reason: "NOT_FOUND" },
          { current: ended, reason: "DELETED" },
        ],
        f.now,
      ),
    );
    expect(result.rows.map((r) => [r.id, r.status, r.version, r.deletedAt])).toEqual([
      [future.id, "CANCELLED", 2, null],
      [running.id, "CANCELLED", 2, null],
    ]);
    expect(result.skipped).toEqual([{ shiftId: ended.id, reason: "ENDED" }]);
    expect(
      (await prisma.breakSession.findUniqueOrThrow({ where: { id: session.id } })).endReason,
    ).toBe("SHIFT_ENDED");
    const maps = await prisma.externalEntityMap.findMany({
      where: { integrationId: f.integrationId, entityType: "SHIFT" },
      orderBy: { externalId: "asc" },
    });
    expect(maps.map((m) => m.upstreamRemovedAt !== null)).toEqual([true, true, false]);
    const cancelled = result.activities.filter((a) => a.type === "SHIFT_CANCELLED");
    expect(cancelled.map((a) => (a.metadata as { reason: string }).reason).sort()).toEqual([
      "DELETED",
      "NOT_FOUND",
    ]);
    expect(result.scheduleChanges).toEqual(
      expect.arrayContaining([
        { employeeId: f.a, shiftIds: [future.id], reason: "CANCELLED" },
        { employeeId: f.b, shiftIds: [running.id], reason: "CANCELLED" },
      ]),
    );
  });

  it("reinstates with the full target, and only what the integration cancelled", async () => {
    const f = await setup();
    const start = new Date(f.now.getTime() + 24 * HOUR);
    const shift = await createShift(f, "5001", f.a, start, new Date(start.getTime() + 4 * HOUR));
    const cancelled = await tx((t) =>
      cancelIntegrationShift(t, f.actor, shift, f.now, "OUT_OF_SCOPE"),
    );
    const target = {
      startsAt: new Date(start.getTime() + HOUR),
      endsAt: new Date(start.getTime() + 5 * HOUR),
      employeeId: f.b,
      locationId: null,
    };
    const result = await tx((t) =>
      reinstateIntegrationShift(t, f.actor, cancelled.rows[0]!, target, f.now),
    );
    expect(result.rows[0]).toMatchObject({ status: "SCHEDULED", version: 3, ...target });
    expect(result.activities[0]!.metadata).toMatchObject({
      reason: "REINSTATED",
      previousEmployeeId: f.a,
    });
    expect(result.scheduleChanges.map((c) => c.employeeId).sort()).toEqual([f.a, f.b].sort());
    const map = await prisma.externalEntityMap.findFirstOrThrow({
      where: { integrationId: f.integrationId, internalId: shift.id },
    });
    expect(map.upstreamRemovedAt).toBeNull();

    // A cancellation the integration did not make (no upstreamRemovedAt) is left alone.
    const again = await tx((t) =>
      cancelIntegrationShift(t, f.actor, result.rows[0]!, f.now, "DELETED"),
    );
    await prisma.externalEntityMap.update({
      where: { id: map.id },
      data: { upstreamRemovedAt: null },
    });
    const skipped = await tx((t) =>
      reinstateIntegrationShift(t, f.actor, again.rows[0]!, target, f.now),
    );
    expect(skipped.skipped).toEqual([{ shiftId: shift.id, reason: "NOT_REMOVED_UPSTREAM" }]);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe(
      "CANCELLED",
    );
  });

  it("recreates a shift the integration cancelled once its own times passed, and nothing else", async () => {
    const f = await setup();
    const start = new Date(f.now.getTime() + 2 * HOUR);
    const shift = await createShift(f, "5001", f.a, start, new Date(start.getTime() + 4 * HOUR));
    const cancelled = await tx((t) =>
      cancelIntegrationShift(t, f.actor, shift, f.now, "OUT_OF_WINDOW"),
    );
    const later = new Date(f.now.getTime() + 48 * HOUR); // the cancelled shift's times have passed
    const newStart = new Date(later.getTime() + 24 * HOUR);
    const result = await tx((t) =>
      recreateIntegrationShift(
        t,
        f.actor,
        cancelled.rows[0]!,
        shiftInput(f, "5001", f.b, newStart, new Date(newStart.getTime() + 4 * HOUR)),
        later,
      ),
    );
    const fresh = result.rows[0]!;
    expect(fresh.id).not.toBe(shift.id);
    expect(fresh).toMatchObject({
      status: "SCHEDULED",
      employeeId: f.b,
      startsAt: newStart,
      externalShiftId: `PLANDAY:${PORTAL}:5001`,
      managedByIntegrationId: f.integrationId,
    });
    expect(result.activities[0]!.metadata).toMatchObject({ reason: "REINSTATED" });
    // The ended copy keeps its status, times and version; only its external id moves aside.
    expect(await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).toMatchObject({
      status: "CANCELLED",
      startsAt: shift.startsAt,
      version: cancelled.rows[0]!.version,
      externalShiftId: `PLANDAY:${PORTAL}:5001:superseded:${shift.id}`,
    });
    const map = await prisma.externalEntityMap.findFirstOrThrow({
      where: { integrationId: f.integrationId, entityType: "SHIFT", externalId: "5001" },
    });
    expect(map).toMatchObject({ internalId: fresh.id, upstreamRemovedAt: null });

    // Not cancelled, or cancelled by someone else (no upstreamRemovedAt): skipped.
    const other = await createShift(f, "5002", f.a, start, new Date(start.getTime() + 4 * HOUR));
    const replacement = shiftInput(f, "5002", f.a, newStart, new Date(newStart.getTime() + HOUR));
    expect(
      (await tx((t) => recreateIntegrationShift(t, f.actor, other, replacement, later))).skipped,
    ).toEqual([{ shiftId: other.id, reason: "WRONG_STATUS" }]);
    const manual = await tx((t) => cancelIntegrationShift(t, f.actor, other, f.now, "DELETED"));
    await prisma.externalEntityMap.updateMany({
      where: { integrationId: f.integrationId, internalId: other.id },
      data: { upstreamRemovedAt: null },
    });
    expect(
      (await tx((t) => recreateIntegrationShift(t, f.actor, manual.rows[0]!, replacement, later)))
        .skipped,
    ).toEqual([{ shiftId: other.id, reason: "NOT_REMOVED_UPSTREAM" }]);
  });

  it("supersedes an in-progress shift reassigned to another mapped employee", async () => {
    const f = await setup();
    const running = await createShift(
      f,
      "5001",
      f.a,
      new Date(f.now.getTime() - HOUR),
      new Date(f.now.getTime() + 3 * HOUR),
    );
    const result = await tx((t) =>
      supersedeIntegrationShift(
        t,
        f.actor,
        running,
        shiftInput(f, "5001", f.b, running.startsAt, running.endsAt),
        f.now,
      ),
    );
    const old = await prisma.shift.findUniqueOrThrow({ where: { id: running.id } });
    expect(old).toMatchObject({
      status: "CANCELLED",
      version: 2,
      externalShiftId: `PLANDAY:${PORTAL}:5001:superseded:${running.id}`,
    });
    const fresh = result.rows.find((r) => r.id !== running.id)!;
    expect(fresh).toMatchObject({
      employeeId: f.b,
      status: "SCHEDULED",
      externalShiftId: `PLANDAY:${PORTAL}:5001`,
    });
    const map = await prisma.externalEntityMap.findFirstOrThrow({
      where: { integrationId: f.integrationId, entityType: "SHIFT", externalId: "5001" },
    });
    expect(map.internalId).toBe(fresh.id);
    expect(result.activities.map((a) => a.type).sort()).toEqual([
      "SHIFT_CANCELLED",
      "SHIFT_CREATED",
    ]);
    expect(result.scheduleChanges).toEqual(
      expect.arrayContaining([
        { employeeId: f.a, shiftIds: [running.id], reason: "CANCELLED" },
        { employeeId: f.b, shiftIds: [fresh.id], reason: "CREATED" },
      ]),
    );
  });

  it("publishes activity and one SCHEDULE_CHANGED per employee after commit", async () => {
    const f = await setup();
    const start = new Date(f.now.getTime() + 24 * HOUR);
    const seen: RealtimeEvent[] = [];
    const unsubscribe = getEventBus().subscribe(f.organisationId, (e) => seen.push(e));
    const result = await tx((t) =>
      createIntegrationShifts(
        t,
        f.actor,
        f.integrationId,
        [
          shiftInput(f, "5001", f.a, start, new Date(start.getTime() + HOUR)),
          shiftInput(
            f,
            "5002",
            f.a,
            new Date(start.getTime() + 2 * HOUR),
            new Date(start.getTime() + 3 * HOUR),
          ),
        ],
        { recordActivity: true, now: f.now },
      ),
    );
    expect(seen).toEqual([]);
    publishIntegrationShiftWrite(f.organisationId, result);
    unsubscribe();
    expect(seen.filter((e) => e.type === "activity.recorded")).toHaveLength(2);
    const changed = seen.filter((e) => e.type === "SCHEDULE_CHANGED");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toMatchObject({ employeeId: f.a, reason: "CREATED" });
  });
});

describe("cancelReplacedShift", () => {
  it("cancels a manager's future shift on their behalf, and nothing else", async () => {
    const f = await setup();
    const start = new Date(f.now.getTime() + 24 * HOUR);
    const manual = await prisma.shift.create({
      data: {
        organisationId: f.organisationId,
        employeeId: f.a,
        startsAt: start,
        endsAt: new Date(start.getTime() + 4 * HOUR),
        timezone: TZ,
        source: "CSV_IMPORT",
      },
    });
    const result = await tx((t) =>
      cancelReplacedShift(t, {
        organisationId: f.organisationId,
        shiftId: manual.id,
        approvedByUserId: f.org.owner.id,
        now: f.now,
        replacedByExternalShiftId: `PLANDAY:${PORTAL}:5001`,
      }),
    );
    expect(result?.rows[0]).toMatchObject({ status: "CANCELLED", version: 2 });
    expect(result?.activities[0]!.metadata).toMatchObject({
      source: "PLANDAY",
      reason: "REPLACED_BY_PLANDAY",
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { organisationId: f.organisationId, action: "integration.conflicting_shift_replaced" },
    });
    expect(audit).toMatchObject({ actorUserId: f.org.owner.id, entityId: manual.id });
    expect(audit.after).toEqual({
      status: "CANCELLED",
      replacedByExternalShiftId: `PLANDAY:${PORTAL}:5001`,
    });

    const replace = (shiftId: string, organisationId = f.organisationId) =>
      tx((t) =>
        cancelReplacedShift(t, { organisationId, shiftId, approvedByUserId: null, now: f.now }),
      );
    const managed = await createShift(f, "5009", f.a, start, new Date(start.getTime() + HOUR));
    const inProgress = await prisma.shift.create({
      data: {
        organisationId: f.organisationId,
        employeeId: f.b,
        startsAt: new Date(f.now.getTime() - HOUR),
        endsAt: new Date(f.now.getTime() + HOUR),
        timezone: TZ,
      },
    });
    const other = await setup();
    const foreign = await prisma.shift.create({
      data: {
        organisationId: other.organisationId,
        employeeId: other.a,
        startsAt: start,
        endsAt: new Date(start.getTime() + HOUR),
        timezone: TZ,
      },
    });
    expect(await replace(managed.id)).toBeNull();
    expect(await replace(inProgress.id)).toBeNull();
    expect(await replace(foreign.id)).toBeNull();
    expect(await replace(manual.id)).toBeNull(); // already cancelled
    const untouched = await prisma.shift.findMany({
      where: { id: { in: [managed.id, inProgress.id, foreign.id] } },
    });
    expect(untouched.every((s) => s.status === "SCHEDULED" && s.version === 1)).toBe(true);
  });
});

describe("employee writers", () => {
  it("imports managed, NOT_INVITED employees with map rows and memberships", async () => {
    const f = await setup();
    const employees = await prisma.employee.findMany({
      where: { id: { in: [f.a, f.b] } },
      include: { locations: true, teams: true },
      orderBy: { firstName: "asc" },
    });
    expect(employees.map((e) => e.firstName)).toEqual(["Ava", "Ben"]);
    for (const employee of employees) {
      expect(employee).toMatchObject({
        source: "INTEGRATION",
        managedByIntegrationId: f.integrationId,
        inviteStatus: "NOT_INVITED",
        employmentStatus: "ACTIVE",
        primaryLocationId: f.locationId,
      });
      expect(employee.locations.map((l) => l.locationId)).toEqual([f.locationId]);
      expect(employee.teams.map((t) => t.teamId)).toEqual([f.teamId]);
    }
    expect(employees[0]!.externalEmployeeId).toBe(`PLANDAY:${PORTAL}:1001`);
    expect(
      await prisma.externalEntityMap.count({
        where: { integrationId: f.integrationId, entityType: "EMPLOYEE" },
      }),
    ).toBe(2);
  });

  it("links an existing employee without touching invite status, devices or other teams", async () => {
    const f = await setup();
    const device = await createTestDevice(f.organisationId);
    const own = await prisma.team.create({
      data: { organisationId: f.organisationId, name: "Own" },
    });
    await prisma.employee.update({
      where: { id: device.employee.id },
      data: {
        externalEmployeeId: "PAYROLL-7",
        inviteStatus: "CONNECTED",
        teams: { create: { teamId: own.id } },
      },
    });
    await tx((t) =>
      linkExternalEmployee(
        t,
        f.record,
        {
          employeeId: device.employee.id,
          externalId: "1003",
          externalEmployeeId: `PLANDAY:${PORTAL}:1003`,
          fields: { firstName: "Cara", lastName: "Linked", primaryLocationId: f.locationId },
          memberships: {
            mappedLocationIds: [f.locationId],
            locationIds: [],
            mappedTeamIds: [f.teamId],
            teamIds: [f.teamId],
          },
          lastHash: "hash-1003",
        },
        f.now,
      ),
    );
    const linked = await prisma.employee.findUniqueOrThrow({
      where: { id: device.employee.id },
      include: { teams: true, devices: true },
    });
    expect(linked).toMatchObject({
      firstName: "Cara",
      lastName: "Linked",
      externalEmployeeId: "PAYROLL-7",
      inviteStatus: "CONNECTED",
      source: "MANUAL",
      managedByIntegrationId: f.integrationId,
      primaryLocationId: f.locationId,
    });
    expect(linked.teams.map((t) => t.teamId).sort()).toEqual([f.teamId, own.id].sort());
    expect(linked.devices.every((d) => d.isActive)).toBe(true);

    // An employee another integration manages is refused.
    const second = await prisma.integration.create({
      data: { organisationId: f.organisationId, provider: "DEPUTY" },
    });
    const refused = await expectRejects(
      tx((t) =>
        linkExternalEmployee(
          t,
          { organisationId: f.organisationId, integrationId: second.id },
          {
            employeeId: f.a,
            externalId: "9",
            externalEmployeeId: "DEPUTY:9",
            fields: { firstName: "X", lastName: "Y", primaryLocationId: null },
            memberships: { mappedLocationIds: [], locationIds: [], mappedTeamIds: [], teamIds: [] },
            lastHash: null,
          },
          f.now,
        ),
      ),
    );
    expect(isNotManagedByIntegration(refused)).toBe(true);
  });

  it("updates managed fields and mapped memberships only", async () => {
    const f = await setup();
    const own = await prisma.team.create({
      data: { organisationId: f.organisationId, name: "Own" },
    });
    await prisma.employeeTeam.create({ data: { employeeId: f.a, teamId: own.id } });
    await tx((t) =>
      updateManagedEmployee(t, f.record, {
        employeeId: f.a,
        fields: { firstName: "Ava", lastName: "Renamed", email: null, primaryLocationId: null },
        memberships: {
          mappedLocationIds: [f.locationId],
          locationIds: [],
          mappedTeamIds: [f.teamId],
          teamIds: [],
        },
      }),
    );
    const employee = await prisma.employee.findUniqueOrThrow({
      where: { id: f.a },
      include: { teams: true, locations: true },
    });
    expect(employee).toMatchObject({ lastName: "Renamed", email: null, primaryLocationId: null });
    expect(employee.teams.map((t) => t.teamId)).toEqual([own.id]);
    expect(employee.locations).toEqual([]);

    const manual = await prisma.employee.create({
      data: { organisationId: f.organisationId, firstName: "M", lastName: "Anual" },
    });
    const refused = await expectRejects(
      tx((t) =>
        updateManagedEmployee(t, f.record, {
          employeeId: manual.id,
          fields: { firstName: "X", lastName: "Y", primaryLocationId: null },
          memberships: { mappedLocationIds: [], locationIds: [], mappedTeamIds: [], teamIds: [] },
        }),
      ),
    );
    expect(isNotManagedByIntegration(refused)).toBe(true);
    const memberships = await expectRejects(
      tx((t) =>
        syncManagedTeamMemberships(t, f.record, [
          { employeeId: manual.id, mappedTeamIds: [f.teamId], teamIds: [f.teamId] },
        ]),
      ),
    );
    expect(isNotManagedByIntegration(memberships)).toBe(true);
  });

  it("deactivates like a manager would, as SYSTEM, and reactivates only its own deactivations", async () => {
    const f = await setup();
    const device = await createTestDevice(f.organisationId);
    const employeeId = device.employee.id;
    await prisma.employee.update({
      where: { id: employeeId },
      data: { managedByIntegrationId: f.integrationId, inviteStatus: "CONNECTED" },
    });
    await prisma.externalEntityMap.create({
      data: {
        organisationId: f.organisationId,
        integrationId: f.integrationId,
        provider: "PLANDAY",
        entityType: "EMPLOYEE",
        externalId: "1004",
        internalId: employeeId,
        lastSeenAt: f.now,
      },
    });
    await prisma.refreshToken.create({
      data: {
        deviceId: device.device.id,
        tokenHash: randomUUID(),
        expiresAt: new Date(f.now.getTime() + 24 * HOUR),
      },
    });
    const shift = await createShift(
      f,
      "5001",
      employeeId,
      new Date(f.now.getTime() - HOUR),
      new Date(f.now.getTime() + HOUR),
    );
    const session = await startBreak(
      f,
      shift.id,
      employeeId,
      new Date(f.now.getTime() - 5 * MINUTE),
    );

    const input = {
      organisationId: f.organisationId,
      employeeId,
      integrationId: f.integrationId,
      now: f.now,
    };
    const result = await tx((t) =>
      deactivateManagedEmployee(t, { ...input, reason: "DEACTIVATED_IN_PLANDAY" }),
    );
    expect(result.changed).toBe(true);
    const employee = await prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: { devices: true, userLink: true },
    });
    expect(employee).toMatchObject({
      employmentStatus: "INACTIVE",
      inviteStatus: "DEACTIVATED",
      deletedAt: null,
    });
    expect(employee.devices.every((d) => !d.isActive)).toBe(true);
    expect(employee.userLink?.unlinkedAt).not.toBeNull();
    expect(
      await prisma.refreshToken.count({ where: { deviceId: device.device.id, revokedAt: null } }),
    ).toBe(0);
    expect(
      (await prisma.breakSession.findUniqueOrThrow({ where: { id: session.id } })).status,
    ).toBe("ENDED");
    expect(await prisma.shift.count({ where: { employeeId, deletedAt: null } })).toBe(1);
    const deactivated = result.activities.find((a) => a.type === "EMPLOYEE_DEACTIVATED");
    expect(deactivated).toMatchObject({ actorType: "SYSTEM" });
    expect(deactivated!.metadata).toMatchObject({
      source: "PLANDAY",
      reason: "DEACTIVATED_IN_PLANDAY",
    });
    const map = await prisma.externalEntityMap.findFirstOrThrow({
      where: { integrationId: f.integrationId, internalId: employeeId },
    });
    expect(map.upstreamRemovedAt).not.toBeNull();
    expect(
      (await tx((t) => deactivateManagedEmployee(t, { ...input, reason: "REMOVED_FROM_PLANDAY" })))
        .reason,
    ).toBe("ALREADY_INACTIVE");

    const back = await tx((t) => reactivateManagedEmployee(t, input));
    expect(back.changed).toBe(true);
    expect(back.activities[0]).toMatchObject({ type: "EMPLOYEE_REACTIVATED" });
    expect(await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } })).toMatchObject({
      employmentStatus: "ACTIVE",
      inviteStatus: "NOT_INVITED",
    });

    // A manager's own deactivation is never undone by the sync.
    await prisma.employee.update({
      where: { id: employeeId },
      data: { employmentStatus: "INACTIVE", inviteStatus: "DEACTIVATED" },
    });
    const kept = await tx((t) => reactivateManagedEmployee(t, input));
    expect(kept).toMatchObject({ changed: false, reason: "DEACTIVATED_BY_MANAGER" });
  });
});

describe("location and team writers", () => {
  it("names a new managed location apart from an existing one and renames only managed rows", async () => {
    const f = await setup();
    const manual = await prisma.location.findFirstOrThrow({
      where: { organisationId: f.organisationId, name: "High Street" },
    });
    const [created] = await tx((t) =>
      createManagedLocations(
        t,
        f.record,
        [{ externalId: "201", name: "high street", timezone: TZ, lastHash: null }],
        f.now,
      ),
    );
    expect(created!.name).toBe("high street (Planday)");
    const row = await prisma.location.findUniqueOrThrow({ where: { id: created!.locationId } });
    expect(row).toMatchObject({
      source: "INTEGRATION",
      managedByIntegrationId: f.integrationId,
      timezone: TZ,
    });

    const renamed = await tx((t) =>
      renameManagedLocation(t, f.record, { locationId: f.locationId, name: "Pastry" }),
    );
    expect(renamed).toEqual({ renamed: true, name: "Pastry" });
    const refused = await expectRejects(
      tx((t) => renameManagedLocation(t, f.record, { locationId: manual.id, name: "Other" })),
    );
    expect(isNotManagedByIntegration(refused)).toBe(true);

    expect(
      await tx((t) => renameManagedTeam(t, f.record, { teamId: f.teamId, name: "Cooks" })),
    ).toEqual({ renamed: true });
    const own = await prisma.team.create({
      data: { organisationId: f.organisationId, name: "Own" },
    });
    const teamRefused = await expectRejects(
      tx((t) => renameManagedTeam(t, f.record, { teamId: own.id, name: "Other" })),
    );
    expect(isNotManagedByIntegration(teamRefused)).toBe(true);
  });
});
