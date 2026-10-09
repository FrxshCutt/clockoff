import { prisma } from "@clockoff/db";
import { MOCK_SECOND_PORTAL_ID } from "@clockoff/integrations/planday/mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completeOnboarding,
  connectViaMethod,
  createPlandayOrg,
  employeeFor,
  installPlanday,
  runSync,
  shiftFor,
  uninstallPlanday,
  type PlandayOrg,
  type PlandayTestContext,
} from "./plandayHarness";

/**
 * Tenant isolation of the sync (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §2.6, §6.9, §11, §13.2
 * `tenantIsolation.test.ts`, the sync-level part; the HTTP 404 cases arrive with the stage 5 routes): two
 * organisations on portals 4100001 and 4100002, whose Planday ids overlap, sync side by side without a single
 * cross-link, and a mapping that points at another organisation's record is never followed.
 */

let t: PlandayTestContext;
let a: PlandayOrg;
let b: PlandayOrg;

beforeEach(async () => {
  t = installPlanday();
  a = await createPlandayOrg();
  b = await createPlandayOrg();
  await connectViaMethod(a);
  await connectViaMethod(b, { portalId: MOCK_SECOND_PORTAL_ID });
});

afterEach(() => {
  expect(t.mock.unexpectedRequests).toEqual([]);
  uninstallPlanday();
});

async function crossLinks(org: PlandayOrg): Promise<string[]> {
  const maps = await prisma.externalEntityMap.findMany({
    where: { integrationId: org.integrationId },
  });
  const problems: string[] = [];
  for (const map of maps) {
    if (map.organisationId !== org.organisationId) problems.push(`map ${map.id} organisation`);
    const owner =
      map.entityType === "EMPLOYEE"
        ? await prisma.employee.findUnique({
            where: { id: map.internalId },
            select: { organisationId: true },
          })
        : map.entityType === "SHIFT"
          ? await prisma.shift.findUnique({
              where: { id: map.internalId },
              select: { organisationId: true },
            })
          : map.entityType === "LOCATION"
            ? await prisma.location.findUnique({
                where: { id: map.internalId },
                select: { organisationId: true },
              })
            : map.entityType === "TEAM"
              ? await prisma.team.findUnique({
                  where: { id: map.internalId },
                  select: { organisationId: true },
                })
              : await prisma.department.findUnique({
                  where: { id: map.internalId },
                  select: { organisationId: true },
                });
    if (owner && owner.organisationId !== org.organisationId) {
      problems.push(`${map.entityType} ${map.externalId} → another organisation`);
    }
  }
  const shifts = await prisma.shift.findMany({
    where: { organisationId: org.organisationId },
    include: {
      employee: { select: { organisationId: true } },
      location: { select: { organisationId: true } },
    },
  });
  for (const shift of shifts) {
    if (shift.employee.organisationId !== org.organisationId)
      problems.push(`shift ${shift.id} employee`);
    if (shift.location && shift.location.organisationId !== org.organisationId) {
      problems.push(`shift ${shift.id} location`);
    }
  }
  return problems;
}

describe("two portals with overlapping ids (§2.6, D-050)", () => {
  it("sync side by side with no cross-links", async () => {
    await completeOnboarding(a);
    await completeOnboarding(b, { includedDepartmentIds: ["101"] });
    await runSync(a);
    await runSync(b);

    const aishaA = await employeeFor(a, 1001);
    const mayaB = await employeeFor(b, 1001);
    expect(aishaA?.organisationId).toBe(a.organisationId);
    expect(mayaB?.organisationId).toBe(b.organisationId);
    expect(aishaA?.firstName).toBe("Aisha");
    expect(mayaB?.firstName).toBe("Maya");
    expect(aishaA?.externalEmployeeId).toBe("PLANDAY:4100001:1001");
    expect(mayaB?.externalEmployeeId).toBe("PLANDAY:4100002:1001");
    expect(await crossLinks(a)).toEqual([]);
    expect(await crossLinks(b)).toEqual([]);
    const shiftsB = await prisma.shift.findMany({
      where: { organisationId: b.organisationId, managedByIntegrationId: b.integrationId },
    });
    expect(shiftsB.length).toBeGreaterThan(0);
    expect(shiftsB.every((s) => s.externalShiftId?.startsWith("PLANDAY:4100002:"))).toBe(true);
  });

  it("never follows a mapping that points at another organisation's location", async () => {
    const onboardingA = await completeOnboarding(a);
    await completeOnboarding(b, { includedDepartmentIds: ["101"] });
    const foreignLocation = onboardingA.locationIds["101"]!;
    // A forged mapping (the wizard checks body ids against the organisation, D-056; the worker must too).
    await prisma.integrationMappingConfig.update({
      where: { integrationId: b.integrationId },
      data: { departmentMappings: { "101": { target: "LOCATION", locationId: foreignLocation } } },
    });
    const { run } = await runSync(b);
    expect(run.status).not.toBe("FAILED");
    expect(run.warnings).toContainEqual(
      expect.objectContaining({ code: "DEPARTMENT_TARGET_MISSING", externalId: "101" }),
    );
    expect(
      await prisma.shift.count({
        where: { organisationId: b.organisationId, locationId: foreignLocation },
      }),
    ).toBe(0);
    expect(
      await prisma.employee.count({
        where: { organisationId: b.organisationId, primaryLocationId: foreignLocation },
      }),
    ).toBe(0);
    expect(await crossLinks(b)).toEqual([]);
    // B's shifts lose the location instead of borrowing A's.
    expect((await shiftFor(b, 500004))?.locationId).toBeNull();
  });
});
