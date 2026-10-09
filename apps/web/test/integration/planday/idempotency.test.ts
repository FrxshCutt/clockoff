import { prisma } from "@clockoff/db";
import { mobileSyncResponseSchema } from "@clockoff/validation/mobile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as syncRoute } from "@/app/api/mobile/v1/sync/route";
import { readoptIntegrationRecords } from "@/server/integrations/sink/readoption";
import { cancelIntegrationShifts } from "@/server/shifts/shifts.integration";
import { callRoute } from "../../helpers";
import {
  completeOnboarding,
  connectViaMethod,
  createPlandayOrg,
  deviceFor,
  employeeFor,
  installPlanday,
  runSync,
  shiftFor,
  uninstallPlanday,
  type PlandayOrg,
  type PlandayTestContext,
} from "./plandayHarness";

/**
 * Idempotency (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.2, §13.2 `idempotency.test.ts`): a SYNC over an
 * unchanged portal writes nothing a manager or a phone could see — no activity, audit or notification rows, no
 * `shifts.version` change, the same `scheduleVersion` — and changes that are undone in Planday end where they began.
 */

let t: PlandayTestContext;
let org: PlandayOrg;

interface RunCounts {
  employees: Record<string, number>;
  locations: Record<string, number>;
  teams: Record<string, number>;
  shifts: Record<string, number>;
  clockEvents: Record<string, number>;
}

beforeEach(async () => {
  t = installPlanday();
  org = await createPlandayOrg();
  await connectViaMethod(org);
});

afterEach(() => {
  expect(t.mock.unexpectedRequests).toEqual([]);
  uninstallPlanday();
});

async function snapshot() {
  const [shifts, employees, activity, audit, notifications] = await Promise.all([
    prisma.shift.findMany({
      where: { organisationId: org.organisationId },
      select: {
        id: true,
        version: true,
        status: true,
        startsAt: true,
        endsAt: true,
        employeeId: true,
      },
      orderBy: { id: "asc" },
    }),
    prisma.employee.findMany({
      where: { organisationId: org.organisationId },
      select: { id: true, firstName: true, lastName: true, email: true, employmentStatus: true },
      orderBy: { id: "asc" },
    }),
    prisma.activityEvent.count({ where: { organisationId: org.organisationId } }),
    prisma.auditLog.count({ where: { organisationId: org.organisationId } }),
    prisma.notification.count({ where: { organisationId: org.organisationId } }),
  ]);
  return { shifts, employees, activity, audit, notifications };
}

function expectNothingChanged(counts: RunCounts) {
  for (const entity of ["employees", "locations", "teams", "shifts", "clockEvents"] as const) {
    expect(counts[entity].created, entity).toBe(0);
    expect(counts[entity].updated, entity).toBe(0);
    expect(counts[entity].cancelled, entity).toBe(0);
  }
}

describe("a SYNC over an unchanged portal (§6.2)", () => {
  it("changes nothing the second time: counts zero except skipped, no rows, same versions", async () => {
    await completeOnboarding(org);
    const aisha = (await employeeFor(org, 1001))!;
    const { headers } = await deviceFor(org.organisationId, aisha.id);
    await runSync(org);
    const v1 = mobileSyncResponseSchema.parse(
      (await callRoute(syncRoute, { path: "/api/mobile/v1/sync", headers })).body,
    ).scheduleVersion;
    // After the phone's sync (it records its own SCHEDULE_SYNCED activity).
    const before = await snapshot();

    const { run } = await runSync(org);
    expect(run.status).toBe("SUCCEEDED");
    const counts = run.counts as unknown as RunCounts;
    expectNothingChanged(counts);
    expect(counts.shifts.skipped).toBeGreaterThan(0);
    expect(counts.employees.skipped).toBe(10);
    expect(await snapshot()).toEqual(before);
    const v2 = mobileSyncResponseSchema.parse(
      (await callRoute(syncRoute, { path: "/api/mobile/v1/sync", headers })).body,
    ).scheduleVersion;
    expect(v2).toBe(v1);
  });

  it("a settings save that changes no target re-hashes at most: no version moves", async () => {
    await completeOnboarding(org);
    const before = await snapshot();
    await prisma.integrationMappingConfig.update({
      where: { integrationId: org.integrationId },
      data: {
        autoIncludeNewEmployees: false,
        syncWindowDays: 42,
        mappingVersion: { increment: 1 },
      },
    });
    const { run } = await runSync(org);
    expectNothingChanged(run.counts as unknown as RunCounts);
    expect((await snapshot()).shifts).toEqual(before.shifts);
  });
});

describe("changes undone in Planday end where they began (§6.2)", () => {
  it("hide then unhide a day (respectHiddenDays on)", async () => {
    await completeOnboarding(org, { respectHiddenDays: true });
    t.mock.controls.setScheduleDayVisible(102, "2026-11-12", false); // Kitchen: 500054 (1003), 500055 (1008)
    await runSync(org);
    expect((await shiftFor(org, 500054))?.status).toBe("CANCELLED");
    t.mock.controls.setScheduleDayVisible(102, "2026-11-12", true);
    await runSync(org);
    const shift = (await shiftFor(org, 500054))!;
    expect(shift.status).toBe("SCHEDULED");
    const settled = await snapshot();
    const { run } = await runSync(org);
    expectNothingChanged(run.counts as unknown as RunCounts);
    expect((await snapshot()).shifts).toEqual(settled.shifts);
  });

  it("deactivate then reactivate an employee", async () => {
    await completeOnboarding(org);
    const grace = (await employeeFor(org, 1009))!;
    t.mock.controls.deactivateEmployee(1009);
    await runSync(org);
    t.mock.controls.reactivateEmployee(1009);
    await runSync(org);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: grace.id } })).employmentStatus,
    ).toBe("ACTIVE");
    const settled = await snapshot();
    const { run } = await runSync(org);
    expectNothingChanged(run.counts as unknown as RunCounts);
    expect(await snapshot()).toEqual(settled);
  });

  it("reassign X → Y (unmapped) → X ends with the original shift SCHEDULED for X", async () => {
    await completeOnboarding(org);
    const original = (await shiftFor(org, 500048))!; // 1001, 9 Nov
    t.mock.controls.reassignShift(500048, 1010);
    await runSync(org);
    expect((await shiftFor(org, 500048))?.status).toBe("CANCELLED");
    t.mock.controls.reassignShift(500048, 1001);
    await runSync(org);
    const back = (await shiftFor(org, 500048))!;
    expect(back.id).toBe(original.id);
    expect(back.status).toBe("SCHEDULED");
    expect(back.employeeId).toBe(original.employeeId);
    const settled = await snapshot();
    const { run } = await runSync(org);
    expectNothingChanged(run.counts as unknown as RunCounts);
    expect(await snapshot()).toEqual(settled);
  });
});

describe("re-adoption on a same-portal reconnect (§5.7, sink helper for stage 5)", () => {
  it("takes the records back, reverts edits made while disconnected and reinstates cancelled future shifts", async () => {
    await completeOnboarding(org);
    const counts = async () => ({
      employees: await prisma.employee.count({ where: { organisationId: org.organisationId } }),
      shifts: await prisma.shift.count({ where: { organisationId: org.organisationId } }),
      maps: await prisma.externalEntityMap.count({ where: { integrationId: org.integrationId } }),
    });
    const before = await counts();
    const planned = (await shiftFor(org, 500018))!;
    const now = t.now();

    // The disconnect transaction with CANCEL_FUTURE_SHIFTS (§5.8 step 2), as stage 5 writes it.
    await prisma.$transaction(async (tx) => {
      const future = await tx.shift.findMany({
        where: {
          organisationId: org.organisationId,
          managedByIntegrationId: org.integrationId,
          status: "SCHEDULED",
          startsAt: { gt: now },
        },
      });
      await cancelIntegrationShifts(
        tx,
        {
          organisationId: org.organisationId,
          actorType: "MANAGER",
          actorUserId: org.owner.id,
          integrationId: org.integrationId,
        },
        future.map((current) => ({ current, reason: "DISCONNECTED" as const })),
        now,
      );
      const where = {
        organisationId: org.organisationId,
        managedByIntegrationId: org.integrationId,
      };
      await tx.employee.updateMany({ where, data: { managedByIntegrationId: null } });
      await tx.location.updateMany({ where, data: { managedByIntegrationId: null } });
      await tx.team.updateMany({ where, data: { managedByIntegrationId: null } });
      await tx.shift.updateMany({ where, data: { managedByIntegrationId: null } });
      await tx.integrationConnection.update({
        where: { integrationId: org.integrationId },
        data: {
          status: "DISCONNECTED",
          encryptedClientId: null,
          encryptedRefreshToken: null,
          encryptedAccessToken: null,
          credentialVersion: { increment: 1 },
        },
      });
    });
    // While disconnected the records are ClockOff's: a manager edits a (cancelled) shift's times.
    await prisma.shift.update({
      where: { id: planned.id },
      data: {
        startsAt: new Date(planned.startsAt.getTime() + 3_600_000),
        version: { increment: 1 },
      },
    });

    await connectViaMethod(org);
    const readopted = await prisma.$transaction((tx) =>
      readoptIntegrationRecords(tx, {
        organisationId: org.organisationId,
        integrationId: org.integrationId,
        now: t.now(),
      }),
    );
    expect(readopted.employees).toBe(10);
    expect(readopted.locations).toBe(2);
    expect(readopted.shifts).toBe(before.shifts);
    expect(
      await prisma.externalEntityMap.count({
        where: { integrationId: org.integrationId, lastHash: { not: null } },
      }),
    ).toBe(0);

    const { run } = await runSync(org, { trigger: "RECOVERY" });
    expect(run.status).toBe("SUCCEEDED");
    const back = (await shiftFor(org, 500018))!;
    expect(back.id).toBe(planned.id);
    expect(back.status).toBe("SCHEDULED");
    expect(back.startsAt).toEqual(planned.startsAt);
    expect(back.managedByIntegrationId).toBe(org.integrationId);
    expect(await counts()).toEqual(before);
    expect(
      await prisma.shift.count({
        where: {
          organisationId: org.organisationId,
          managedByIntegrationId: org.integrationId,
          status: "CANCELLED",
        },
      }),
    ).toBe(0);
  });
});
