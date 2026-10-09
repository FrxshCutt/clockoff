import { prisma } from "@clockoff/db";
import {
  fixtureCsvCollision,
  fixtureCsvEmployees,
  fixtureNamesake,
  MOCK_NO_DEPARTMENTS_PORTAL_ID,
} from "@clockoff/integrations/planday/mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completeOnboarding,
  connectionOf,
  connectViaMethod,
  createPlandayOrg,
  deviceFor,
  employeeFor,
  installPlanday,
  interceptTransactionCall,
  recordTransactionOperations,
  runSync,
  shiftFor,
  uninstallPlanday,
  type PlandayOrg,
  type PlandayTestContext,
} from "./plandayHarness";

/**
 * Employees end to end (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.5, §13.2 `syncEmployees.test.ts`, the
 * sync-level parts): matching in the wizard (MATCH_EMPLOYEES over the complete staged set) and after onboarding
 * (rules 1 to 3 per page, a name alone only a possible match), the step 5 import, auto-include, the plan limit,
 * deactivation on positive evidence only, reactivation after the deactivation phases, and email minimisation.
 */

let t: PlandayTestContext;
let org: PlandayOrg;

const HOUR = 3_600_000;

beforeEach(async () => {
  t = installPlanday();
  org = await createPlandayOrg();
  await connectViaMethod(org);
});

afterEach(() => {
  expect(t.mock.unexpectedRequests).toEqual([]);
  uninstallPlanday();
});

function clockOffEmployee(fixture: {
  firstName: string;
  lastName: string;
  email: string | null;
  externalEmployeeId: string | null;
}) {
  return prisma.employee.create({
    data: { organisationId: org.organisationId, ...fixture },
  });
}

async function pending(externalId: number | string) {
  return prisma.pendingExternalEmployee.findUnique({
    where: {
      integrationId_externalId: {
        integrationId: org.integrationId,
        externalId: String(externalId),
      },
    },
  });
}

function addPlandayEmployee(id: number, firstName: string, lastName: string, email: string | null) {
  t.mock.controls.addEmployee({
    id,
    firstName,
    lastName,
    email,
    departments: [101],
    primaryDepartmentId: 101,
    employeeGroups: [],
  });
}

describe("matching in the wizard (§6.5)", () => {
  it("links a CSV employee by raw external id corroborated by the email (1007), keeping the CSV id", async () => {
    const priya = await clockOffEmployee(fixtureCsvEmployees[0]!);
    await completeOnboarding(org);
    const linked = await employeeFor(org, 1007);
    expect(linked?.id).toBe(priya.id);
    expect(linked?.managedByIntegrationId).toBe(org.integrationId);
    expect(linked?.externalEmployeeId).toBe("1007");
    expect(linked?.source).toBe("MANUAL");
    expect(
      await prisma.employee.count({
        where: { organisationId: org.organisationId, firstName: "Priya", deletedAt: null },
      }),
    ).toBe(1);
    // The session records what step 5 imported, for release (§9.3).
    const session = await prisma.integrationOnboardingSession.findFirstOrThrow({
      where: { integrationId: org.integrationId },
    });
    const imported = (
      session.state as { employeesImport: { createdIds: string[]; linkedIds: string[] } }
    ).employeesImport;
    expect(imported.linkedIds).toEqual([priya.id]);
    expect(imported.createdIds).toHaveLength(9);
  });

  it("never links a raw id without corroboration (Sam Jones holds 1008): Tom Harris is created", async () => {
    const sam = await clockOffEmployee(fixtureCsvCollision);
    await completeOnboarding(org);
    const tom = await employeeFor(org, 1008);
    expect(tom?.id).not.toBe(sam.id);
    expect(tom?.firstName).toBe("Tom");
    expect(tom?.externalEmployeeId).toBe(`PLANDAY:${org.portalId}:1008`);
    const untouched = await prisma.employee.findUniqueOrThrow({ where: { id: sam.id } });
    expect(untouched.managedByIntegrationId).toBeNull();
    expect(untouched.firstName).toBe("Sam");
  });

  it("links by email and overwrites the name with Planday's", async () => {
    const grace = await clockOffEmployee({
      firstName: "G.",
      lastName: "Lee-Smith",
      email: "Grace.Lee@mockbistro.test",
      externalEmployeeId: null,
    });
    await completeOnboarding(org);
    const linked = await employeeFor(org, 1009);
    expect(linked?.id).toBe(grace.id);
    expect(linked?.firstName).toBe("Grace");
    expect(linked?.lastName).toBe("Lee");
    expect(linked?.externalEmployeeId).toBe(`PLANDAY:${org.portalId}:1009`);
  });

  it("never merges namesakes, even when they arrive on different pages", async () => {
    const namesake = await clockOffEmployee(fixtureNamesake);
    t.mock.controls.capPageSize(1);
    const onboarding = await completeOnboarding(org);
    expect(onboarding.initialSync!.run.status).not.toBe("FAILED");
    expect(await employeeFor(org, 1005)).toBeNull();
    expect(await employeeFor(org, 1006)).toBeNull();
    const untouched = await prisma.employee.findUniqueOrThrow({ where: { id: namesake.id } });
    expect(untouched.managedByIntegrationId).toBeNull();
    for (const id of [1005, 1006]) {
      const row = await pending(id);
      expect(row?.reason).toBe("AMBIGUOUS_MATCH");
      expect(row?.matchedEmployeeId).toBeNull();
      expect(row?.candidateEmployeeIds).toEqual([namesake.id]);
    }
  });
});

describe("after onboarding (§6.5)", () => {
  it("a name alone is a possible match for a manager to confirm, never a link", async () => {
    await completeOnboarding(org);
    const nina = await clockOffEmployee({
      firstName: "Nina",
      lastName: "Brown",
      email: null,
      externalEmployeeId: null,
    });
    addPlandayEmployee(1098, "Nina", "Brown", "nina.brown@mockbistro.test");
    await runSync(org);
    expect(await employeeFor(org, 1098)).toBeNull();
    const row = await pending(1098);
    expect(row?.reason).toBe("POSSIBLE_MATCH");
    expect(row?.matchedEmployeeId).toBe(nina.id);
    expect(row?.matchSignal).toBe("NAME");
  });

  it("a raw CSV id without corroboration is a possible match too", async () => {
    await completeOnboarding(org);
    const other = await clockOffEmployee({
      firstName: "Kim",
      lastName: "Payroll",
      email: "kim@example.test",
      externalEmployeeId: "1099",
    });
    addPlandayEmployee(1099, "Ola", "Nowak", "ola.nowak@mockbistro.test");
    await runSync(org);
    const row = await pending(1099);
    expect(row?.reason).toBe("POSSIBLE_MATCH");
    expect(row?.matchSignal).toBe("EXTERNAL_ID_RAW");
    expect(row?.matchedEmployeeId).toBe(other.id);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: other.id } })).managedByIntegrationId,
    ).toBeNull();
  });

  it("imports a new in-scope employee with auto-include on", async () => {
    await completeOnboarding(org);
    addPlandayEmployee(1097, "Ian", "Grey", "ian.grey@mockbistro.test");
    const { run } = await runSync(org);
    const ian = await employeeFor(org, 1097);
    expect(ian).toMatchObject({
      firstName: "Ian",
      lastName: "Grey",
      email: "ian.grey@mockbistro.test",
      inviteStatus: "NOT_INVITED",
      source: "INTEGRATION",
      managedByIntegrationId: org.integrationId,
      externalEmployeeId: `PLANDAY:${org.portalId}:1097`,
    });
    expect((run.counts as { employees: { created: number } }).employees.created).toBe(1);
  });

  it("queues a new employee for a manager with auto-include off", async () => {
    await completeOnboarding(org, { autoIncludeNewEmployees: false });
    addPlandayEmployee(1097, "Ian", "Grey", "ian.grey@mockbistro.test");
    const { run } = await runSync(org);
    expect(await employeeFor(org, 1097)).toBeNull();
    const row = await pending(1097);
    expect(row?.reason).toBe("NEW_EMPLOYEE");
    expect(row?.workEmail).toBe("ian.grey@mockbistro.test");
    expect((run.counts as { pending: number }).pending).toBe(1);
  });

  it("queues new employees beyond the plan's limit", async () => {
    await completeOnboarding(org);
    await prisma.organisation.update({
      where: { id: org.organisationId },
      data: { plan: "STARTER" },
    });
    const active = await prisma.employee.count({
      where: { organisationId: org.organisationId, employmentStatus: "ACTIVE", deletedAt: null },
    });
    await prisma.employee.createMany({
      data: Array.from({ length: 25 - active }, (_, i) => ({
        organisationId: org.organisationId,
        firstName: "Filler",
        lastName: `Person ${i}`,
      })),
    });
    addPlandayEmployee(1097, "Ian", "Grey", "ian.grey@mockbistro.test");
    await runSync(org);
    expect(await employeeFor(org, 1097)).toBeNull();
    expect((await pending(1097))?.reason).toBe("PLAN_LIMIT");
  });

  it("an employee a manager archived is not imported again; their shifts are cancelled, never moved to a copy", async () => {
    await completeOnboarding(org);
    const aisha = (await employeeFor(org, 1001))!;
    const future = (await shiftFor(org, 500018))!;
    // What archiveEmployee writes.
    await prisma.employee.update({
      where: { id: aisha.id },
      data: { deletedAt: t.now(), employmentStatus: "INACTIVE", inviteStatus: "DEACTIVATED" },
    });
    const count = () => prisma.employee.count({ where: { organisationId: org.organisationId } });
    const before = await count();
    for (let i = 0; i < 2; i++) {
      const { run } = await runSync(org);
      expect(run.status).toBe("SUCCEEDED");
      expect((run.counts as { employees: { created: number } }).employees.created).toBe(0);
      expect(await count()).toBe(before);
    }
    const map = await prisma.externalEntityMap.findFirstOrThrow({
      where: { integrationId: org.integrationId, entityType: "EMPLOYEE", externalId: "1001" },
    });
    expect(map.internalId).toBe(aisha.id);
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: future.id } });
    expect(shift.employeeId).toBe(aisha.id);
    expect(shift.status).toBe("CANCELLED");
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: aisha.id } })).deletedAt,
    ).not.toBeNull();
  });

  it("a link committed by another writer during the import (P2002) is applied once more as an update (§6.2 step 5)", async () => {
    await completeOnboarding(org);
    const existing = await clockOffEmployee({
      firstName: "Existing",
      lastName: "Person",
      email: null,
      externalEmployeeId: null,
    });
    addPlandayEmployee(1097, "Ian", "Grey", "ian.grey@mockbistro.test");
    // A manager links Planday's 1097 to the existing employee (pending queue) between the step's reads and its insert.
    const intercept = interceptTransactionCall(
      "externalEntityMap",
      "createMany",
      async () => {
        await prisma.externalEntityMap.create({
          data: {
            organisationId: org.organisationId,
            integrationId: org.integrationId,
            provider: "PLANDAY",
            entityType: "EMPLOYEE",
            externalId: "1097",
            internalId: existing.id,
            lastSeenAt: t.now(),
          },
        });
        await prisma.employee.update({
          where: { id: existing.id },
          data: { managedByIntegrationId: org.integrationId },
        });
      },
      (args) => JSON.stringify(args).includes('"externalId":"1097"'),
    );
    let result: Awaited<ReturnType<typeof runSync>>;
    try {
      result = await runSync(org);
    } finally {
      intercept.stop();
    }
    expect(intercept.fired()).toBe(true);
    expect(result.run.status).not.toBe("FAILED");
    expect(result.run.errorCode).toBeNull();
    // No duplicate: 1097 is the existing employee, now with Planday's managed fields.
    expect((await employeeFor(org, 1097))?.id).toBe(existing.id);
    expect(await prisma.employee.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({
      firstName: "Ian",
      lastName: "Grey",
    });
    expect(
      await prisma.employee.count({
        where: { organisationId: org.organisationId, firstName: "Ian", lastName: "Grey" },
      }),
    ).toBe(1);
  });

  it("two Planday people sharing an email are never folded into one employee", async () => {
    await completeOnboarding(org);
    addPlandayEmployee(1095, "Sam", "One", "shared@mockbistro.test");
    addPlandayEmployee(1096, "Sam", "Two", "shared@mockbistro.test");
    await runSync(org);
    const first = await employeeFor(org, 1095);
    expect(first).not.toBeNull();
    expect(await employeeFor(org, 1096)).toBeNull();
    const row = await pending(1096);
    expect(row?.reason).toBe("AMBIGUOUS_MATCH");
    expect(row?.candidateEmployeeIds).toEqual([first!.id]);
  });
});

describe("deactivation and reactivation (§6.5, D-045)", () => {
  beforeEach(async () => {
    await completeOnboarding(org);
  });

  it("deactivates a person on Planday's deactivated list: devices, tokens and link revoked, never deleted", async () => {
    const grace = (await employeeFor(org, 1009))!;
    const { device } = await deviceFor(org.organisationId, grace.id);
    t.mock.controls.deactivateEmployee(1009);
    const { run } = await runSync(org);
    expect(run.status).not.toBe("FAILED");
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: grace.id } });
    expect(after.employmentStatus).toBe("INACTIVE");
    expect(after.inviteStatus).toBe("DEACTIVATED");
    expect(after.deletedAt).toBeNull();
    expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).isActive).toBe(
      false,
    );
    expect(
      await prisma.refreshToken.count({ where: { deviceId: device.id, revokedAt: null } }),
    ).toBe(0);
    expect(
      await prisma.employeeUserLink.count({ where: { employeeId: grace.id, unlinkedAt: null } }),
    ).toBe(0);
    const activity = await prisma.activityEvent.findFirst({
      where: {
        organisationId: org.organisationId,
        employeeId: grace.id,
        type: "EMPLOYEE_DEACTIVATED",
      },
    });
    expect(activity?.metadata).toMatchObject({
      source: "PLANDAY",
      reason: "DEACTIVATED_IN_PLANDAY",
    });
    expect((run.counts as { employees: { cancelled: number } }).employees.cancelled).toBe(1);
    // Inactive employees keep their shifts (§6.5).
    expect((await shiftFor(org, 500032))?.status).toBe("SCHEDULED");
  });

  it("a future dismissal on both lists changes nothing, twice", async () => {
    const tom = (await employeeFor(org, 1008))!;
    t.mock.controls.deactivateEmployee(1008, {
      effectiveDate: "2026-11-30",
      stayOnActiveList: true,
    });
    const first = await runSync(org);
    const second = await runSync(org);
    for (const { run } of [first, second]) {
      const counts = run.counts as { employees: { cancelled: number; updated: number } };
      expect(counts.employees.cancelled).toBe(0);
      expect(counts.employees.updated).toBe(0);
    }
    expect(first.run.warnings).toContainEqual(
      expect.objectContaining({ code: "DEACTIVATION_SCHEDULED" }),
    );
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: tom.id } })).employmentStatus,
    ).toBe("ACTIVE");
    expect(
      await prisma.activityEvent.count({
        where: {
          employeeId: tom.id,
          type: { in: ["EMPLOYEE_DEACTIVATED", "EMPLOYEE_REACTIVATED"] },
        },
      }),
    ).toBe(0);
  });

  it("a person who can no longer be read (by-id 400) is flagged missing, never deactivated", async () => {
    const leo = (await employeeFor(org, 1012))!;
    const { device } = await deviceFor(org.organisationId, leo.id);
    t.mock.controls.removeEmployee(1012);
    const { run } = await runSync(org);
    expect(run.warnings).toContainEqual(
      expect.objectContaining({ code: "EMPLOYEE_NOT_VISIBLE", externalId: "1012" }),
    );
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: leo.id } })).employmentStatus,
    ).toBe("ACTIVE");
    expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).isActive).toBe(
      true,
    );
    const map = await prisma.externalEntityMap.findFirst({
      where: { integrationId: org.integrationId, entityType: "EMPLOYEE", externalId: "1012" },
    });
    expect(map?.upstreamMissingSince).not.toBeNull();
    expect(t.mock.requestLog.some((e) => e.path === "/hr/v1.0/employees/1012")).toBe(true);
  });

  it("re-checks more than 20 invisible people in turn: none waits forever behind the same 20", async () => {
    const ids = Array.from({ length: 22 }, (_, i) => 1200 + i);
    for (const id of ids) addPlandayEmployee(id, "Absent", `Person ${id}`, null);
    await prisma.organisation.update({
      where: { id: org.organisationId },
      data: { plan: "BUSINESS" },
    });
    await runSync(org); // imports them (auto-include)
    for (const id of ids) expect(await employeeFor(org, id)).not.toBeNull();
    for (const id of ids) t.mock.controls.removeEmployee(id);
    const flagged = async () =>
      prisma.externalEntityMap.count({
        where: {
          integrationId: org.integrationId,
          entityType: "EMPLOYEE",
          externalId: { in: ids.map(String) },
          upstreamMissingSince: { not: null },
        },
      });
    const rechecked = async (run: () => Promise<unknown>) => {
      const from = t.mock.requestLog.length;
      await run();
      return new Set(
        t.mock.requestLog
          .slice(from)
          .map((e) => /^\/hr\/v1\.0\/employees\/(\d+)$/.exec(e.path)?.[1])
          .filter((id): id is string => id !== undefined && ids.includes(Number(id))),
      );
    };
    const first = await rechecked(() => runSync(org));
    expect(first.size).toBe(20);
    expect(await flagged()).toBe(20);
    // The two people the first run could not reach come first, then the least recently re-checked.
    const second = await rechecked(() => runSync(org));
    expect(await flagged()).toBe(22);
    const third = await rechecked(() => runSync(org));
    expect(new Set([...second, ...third]).size).toBe(22);
  });

  it("deactivates on a by-id read with isDeactivated (the list's overlap no longer names the person)", async () => {
    const grace = (await employeeFor(org, 1009))!;
    // The deactivation predates the watermark's one-day overlap: only the absent check can see it.
    await prisma.integrationConnection.update({
      where: { integrationId: org.integrationId },
      data: { deactivationCheckedAt: new Date(t.now().getTime() + 3 * 24 * HOUR) },
    });
    t.mock.controls.deactivateEmployee(1009);
    await runSync(org);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: grace.id } })).employmentStatus,
    ).toBe("INACTIVE");
    const activity = await prisma.activityEvent.findFirst({
      where: { employeeId: grace.id, type: "EMPLOYEE_DEACTIVATED" },
    });
    expect(activity?.metadata).toMatchObject({ reason: "REMOVED_FROM_PLANDAY" });
  });

  it("reactivates in REACTIVATIONS, after the deactivation phases of the same run", async () => {
    const grace = (await employeeFor(org, 1009))!;
    t.mock.controls.deactivateEmployee(1009);
    await runSync(org);
    t.mock.controls.reactivateEmployee(1009);
    const { run } = await runSync(org);
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: grace.id } });
    expect(after.employmentStatus).toBe("ACTIVE");
    expect(after.inviteStatus).not.toBe("DEACTIVATED");
    expect(
      await prisma.activityEvent.count({
        where: { employeeId: grace.id, type: "EMPLOYEE_REACTIVATED" },
      }),
    ).toBe(1);
    expect(
      (run.counts as { employees: { updated: number } }).employees.updated,
    ).toBeGreaterThanOrEqual(1);
  });

  it("leaves an employee a manager deactivated inactive, with a warning", async () => {
    const grace = (await employeeFor(org, 1009))!;
    await prisma.employee.update({
      where: { id: grace.id },
      data: { employmentStatus: "INACTIVE", inviteStatus: "DEACTIVATED" },
    });
    const { run } = await runSync(org);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: grace.id } })).employmentStatus,
    ).toBe("INACTIVE");
    expect(run.warnings).toContainEqual(
      expect.objectContaining({ code: "EMPLOYEE_INACTIVE_IN_CLOCKOFF", externalId: "1009" }),
    );
  });
});

describe("emails and data (§6.5, D-042)", () => {
  it("with importEmails off, no email is stored, and pending rows keep only hasEmail", async () => {
    await completeOnboarding(org, { importEmails: false, autoIncludeNewEmployees: false });
    const imported = await prisma.employee.findMany({
      where: { organisationId: org.organisationId, managedByIntegrationId: org.integrationId },
      select: { email: true },
    });
    expect(imported.length).toBe(10);
    expect(imported.every((e) => e.email === null)).toBe(true);
    addPlandayEmployee(1097, "Ian", "Grey", "ian.grey@mockbistro.test");
    await runSync(org);
    const row = await pending(1097);
    expect(row?.workEmail).toBeNull();
    expect(row?.hasEmail).toBe(true);
  });

  it("imports a person without an email (they join with the company code and their name)", async () => {
    await completeOnboarding(org);
    const daniel = await employeeFor(org, 1004);
    expect(daniel).toMatchObject({ firstName: "Daniel", lastName: "Evans", email: null });
  });

  it("a portal without departments imports through 'Not in any department'", async () => {
    uninstallPlanday();
    t = installPlanday();
    org = await createPlandayOrg();
    await connectViaMethod(org, { portalId: MOCK_NO_DEPARTMENTS_PORTAL_ID });
    const onboarding = await completeOnboarding(org, { includedDepartmentIds: ["none"] });
    const catalog = (
      await prisma.integrationMappingConfig.findUniqueOrThrow({
        where: { integrationId: org.integrationId },
      })
    ).catalog as { departments: unknown[]; unassignedEmployeeCount: number };
    expect(catalog.departments).toEqual([]);
    expect(catalog.unassignedEmployeeCount).toBe(3);
    const locationId = onboarding.locationIds.none;
    const employees = await prisma.employee.findMany({
      where: { organisationId: org.organisationId, managedByIntegrationId: org.integrationId },
    });
    expect(employees).toHaveLength(3);
    expect(employees.every((e) => e.primaryLocationId === locationId)).toBe(true);
    const shifts = await prisma.shift.findMany({
      where: { organisationId: org.organisationId, managedByIntegrationId: org.integrationId },
    });
    expect(shifts.length).toBeGreaterThan(0);
    expect(shifts.every((s) => s.locationId === locationId)).toBe(true);
    expect((await connectionOf(org)).externalPortalId).toBe(String(MOCK_NO_DEPARTMENTS_PORTAL_ID));
  });
});

describe("departments and groups in a SYNC (§6.3, §6.4)", () => {
  it("renames a managed location, flags a missing department, and keeps a new one excluded", async () => {
    const onboarding = await completeOnboarding(org, { newTeamGroupIds: ["201", "202"] });
    const kitchen = onboarding.locationIds["102"]!;
    t.mock.controls.upsertDepartment({ id: 102, name: "Main Kitchen", number: "K1" });
    t.mock.controls.upsertDepartment({ id: 104, name: "Terrace", number: "T1" });
    const { run } = await runSync(org);
    expect((await prisma.location.findUniqueOrThrow({ where: { id: kitchen } })).name).toBe(
      "Main Kitchen",
    );
    const config = await prisma.integrationMappingConfig.findUniqueOrThrow({
      where: { integrationId: org.integrationId },
    });
    expect(config.includedDepartmentIds).not.toContain("104");
    const terrace = (
      config.catalog as { departments: Array<{ externalId: string; notifiedAt: string | null }> }
    ).departments.find((d) => d.externalId === "104");
    expect(terrace?.notifiedAt).not.toBeNull();
    expect(run.warnings).toContainEqual(
      expect.objectContaining({ code: "DEPARTMENT_NEW", externalId: "104" }),
    );

    t.mock.controls.removeDepartment(101);
    const second = await runSync(org);
    expect(second.run.warnings).toContainEqual(
      expect.objectContaining({ code: "DEPARTMENT_MISSING", externalId: "101" }),
    );
    const map = await prisma.externalEntityMap.findFirst({
      where: { integrationId: org.integrationId, entityType: "LOCATION", externalId: "101" },
    });
    expect(map?.upstreamRemovedAt).not.toBeNull();
    const bar = await prisma.location.findUniqueOrThrow({
      where: { id: onboarding.locationIds["101"]! },
    });
    expect(bar.deletedAt).toBeNull();
  });

  it("a managed location renamed to a name already taken gets a suffix once, then settles", async () => {
    const onboarding = await completeOnboarding(org);
    const kitchen = onboarding.locationIds["102"]!;
    await prisma.location.create({
      data: { organisationId: org.organisationId, name: "Main Kitchen", timezone: "Europe/London" },
    });
    t.mock.controls.upsertDepartment({ id: 102, name: "Main Kitchen", number: "K1" });
    await runSync(org);
    expect((await prisma.location.findUniqueOrThrow({ where: { id: kitchen } })).name).toBe(
      "Main Kitchen (Planday)",
    );
    // The next SYNC decides nothing for it: no rename attempt (which would lock the organisation row).
    const recorder = recordTransactionOperations();
    try {
      await runSync(org);
    } finally {
      recorder.stop();
    }
    expect(recorder.transactions.flat()).not.toContain("location.findFirst");
    expect((await prisma.location.findUniqueOrThrow({ where: { id: kitchen } })).name).toBe(
      "Main Kitchen (Planday)",
    );
  });

  it("keeps team memberships of mapped teams equal to Planday's groups, and renames managed teams", async () => {
    const onboarding = await completeOnboarding(org, { newTeamGroupIds: ["201", "204"] });
    const ben = (await employeeFor(org, 1002))!; // groups 201, 204
    const teams = async () =>
      (await prisma.employeeTeam.findMany({ where: { employeeId: ben.id } }))
        .map((r) => r.teamId)
        .sort();
    expect(await teams()).toEqual([onboarding.teamIds["201"]!, onboarding.teamIds["204"]!].sort());
    // A manager's own team stays.
    const own = await prisma.team.create({
      data: { organisationId: org.organisationId, name: "Fire wardens" },
    });
    await prisma.employeeTeam.create({ data: { employeeId: ben.id, teamId: own.id } });
    t.mock.controls.editEmployee(1002, { employeeGroups: [201] });
    t.mock.controls.upsertEmployeeGroup({ id: 201, name: "Mixologists" });
    await runSync(org);
    expect(await teams()).toEqual([onboarding.teamIds["201"]!, own.id].sort());
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: onboarding.teamIds["201"]! } })).name,
    ).toBe("Mixologists");
  });
});
