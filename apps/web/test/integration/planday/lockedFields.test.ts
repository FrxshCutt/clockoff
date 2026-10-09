import { prisma } from "@clockoff/db";
import { addLocalDays, buildShiftInstants, localDateOf } from "@clockoff/shared/time/time";
import type {
  BulkEmployeeActionResponse,
  EmployeeDetailResponse,
  EmployeeResponse,
} from "@clockoff/validation/employees";
import type { LocationResponse, TeamResponse } from "@clockoff/validation/locationsTeams";
import type { BulkShiftActionResponse, ShiftResponse } from "@clockoff/validation/shifts";
import { describe, expect, it } from "vitest";
import { DELETE as deleteDepartmentRoute } from "@/app/api/departments/[id]/route";
import { POST as assignLocationRoute } from "@/app/api/employees/[id]/assign-location/route";
import { POST as assignPolicyRoute } from "@/app/api/employees/[id]/assign-policy/route";
import { POST as assignTeamRoute } from "@/app/api/employees/[id]/assign-team/route";
import { POST as deactivateRoute } from "@/app/api/employees/[id]/deactivate/route";
import {
  GET as getEmployeeRoute,
  PATCH as patchEmployeeRoute,
} from "@/app/api/employees/[id]/route";
import { POST as bulkEmployeesRoute } from "@/app/api/employees/bulk/route";
import {
  DELETE as deleteLocationRoute,
  PATCH as patchLocationRoute,
} from "@/app/api/locations/[id]/route";
import { POST as cancelShiftRoute } from "@/app/api/shifts/[id]/cancel/route";
import { POST as duplicateShiftRoute } from "@/app/api/shifts/[id]/duplicate/route";
import { DELETE as deleteShiftRoute, PATCH as patchShiftRoute } from "@/app/api/shifts/[id]/route";
import { POST as bulkShiftsRoute } from "@/app/api/shifts/bulk/route";
import { POST as addMembersRoute } from "@/app/api/teams/[id]/members/route";
import { DELETE as deleteTeamRoute, PATCH as patchTeamRoute } from "@/app/api/teams/[id]/route";
import { resetEnvCache } from "@/lib/env";
import { importExternalEmployee } from "@/server/employees/employees.integration";
import { createManagedLocations } from "@/server/locations/locations.integration";
import { createIntegrationShifts } from "@/server/shifts/shifts.integration";
import { createManagedTeams } from "@/server/teams/teams.integration";
import { callRoute, createTestOrg, loginAs, type CookieJar, type ErrorBody } from "../../helpers";

/**
 * "Managed in Planday" (plan §6.5 Locked fields, §6.6 Read-only, §6.9, §13.2 `lockedFields.test.ts`): records an
 * integration manages keep their synced fields locked against manager edits (409 INTEGRATION_MANAGED,
 * `details.provider = "PLANDAY"`), while every ClockOff-only field, duplicating a shift and the employee
 * lifecycle actions stay available. The managed records are written through the integration writers, as the
 * sync does.
 */

const TZ = "Europe/London";
const PORTAL = "4100001";

interface ManagedFixture {
  jar: CookieJar;
  organisationId: string;
  integrationId: string;
  manualLocationId: string;
  managedLocationId: string;
  managedTeamId: string;
  employeeId: string;
  managedShiftId: string;
  manualShiftId: string;
  tomorrow: string;
}

async function setup(): Promise<ManagedFixture> {
  const org = await createTestOrg({ timezone: TZ, firstLocationName: "High Street" });
  const organisationId = org.organisation.id;
  const jar = await loginAs(org.owner, { organisationId });
  const manualLocation = await prisma.location.findFirstOrThrow({ where: { organisationId } });
  const integration = await prisma.integration.create({
    data: { organisationId, provider: "PLANDAY", status: "CONNECTED" },
  });
  await prisma.integrationMappingConfig.create({
    data: { organisationId, integrationId: integration.id, importEmails: true },
  });
  const now = new Date();
  const tomorrow = addLocalDays(localDateOf(now, TZ), 1);
  const morning = buildShiftInstants({
    date: tomorrow,
    startTime: "09:00",
    endTime: "13:00",
    timezone: TZ,
  });
  const evening = buildShiftInstants({
    date: tomorrow,
    startTime: "17:00",
    endTime: "21:00",
    timezone: TZ,
  });
  const actor = { organisationId, integrationId: integration.id };
  const ids = await prisma.$transaction(async (tx) => {
    const [location] = await createManagedLocations(
      tx,
      actor,
      [{ externalId: "200", name: "Kitchen", timezone: TZ, lastHash: null }],
      now,
    );
    const [team] = await createManagedTeams(
      tx,
      actor,
      [{ externalId: "300", name: "Chefs", lastHash: null }],
      now,
    );
    const { employeeId } = await importExternalEmployee(
      tx,
      actor,
      {
        externalId: "1001",
        externalEmployeeId: `PLANDAY:${PORTAL}:1001`,
        fields: {
          firstName: "Ava",
          lastName: "Planday",
          email: "ava@example.test",
          primaryLocationId: location!.locationId,
        },
        memberships: {
          mappedLocationIds: [location!.locationId],
          locationIds: [location!.locationId],
          mappedTeamIds: [team!.teamId],
          teamIds: [team!.teamId],
        },
        lastHash: null,
      },
      now,
    );
    const shifts = await createIntegrationShifts(
      tx,
      { organisationId, actorType: "SYSTEM", actorUserId: null },
      integration.id,
      [
        {
          externalId: "5001",
          externalShiftId: `PLANDAY:${PORTAL}:5001`,
          employeeId,
          locationId: location!.locationId,
          startsAt: morning.startsAt,
          endsAt: morning.endsAt,
          timezone: TZ,
          lastHash: null,
        },
      ],
      { recordActivity: true, now },
    );
    return {
      managedLocationId: location!.locationId,
      managedTeamId: team!.teamId,
      employeeId,
      managedShiftId: shifts.rows[0]!.id,
    };
  });
  const manualShift = await prisma.shift.create({
    data: {
      organisationId,
      employeeId: ids.employeeId,
      startsAt: evening.startsAt,
      endsAt: evening.endsAt,
      timezone: TZ,
    },
  });
  return {
    jar,
    organisationId,
    integrationId: integration.id,
    manualLocationId: manualLocation.id,
    manualShiftId: manualShift.id,
    tomorrow,
    ...ids,
  };
}

function expectManaged(res: { status: number; body: unknown }, fields?: string[]): void {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  const error = (res.body as ErrorBody).error;
  expect(error.code).toBe("INTEGRATION_MANAGED");
  expect(error.details).toMatchObject({ provider: "PLANDAY", ...(fields ? { fields } : {}) });
}

async function patchEmployee(f: ManagedFixture, body: unknown) {
  return callRoute<EmployeeResponse & ErrorBody>(patchEmployeeRoute, {
    method: "PATCH",
    path: `/api/employees/${f.employeeId}`,
    params: { id: f.employeeId },
    jar: f.jar,
    body,
  });
}

async function employeePost<T>(
  f: ManagedFixture,
  handler: typeof assignPolicyRoute,
  action: string,
  body: unknown,
) {
  return callRoute<T & ErrorBody>(handler, {
    method: "POST",
    path: `/api/employees/${f.employeeId}/${action}`,
    params: { id: f.employeeId },
    jar: f.jar,
    body,
  });
}

async function seedPublishedPolicy(organisationId: string) {
  const policy = await prisma.policy.create({
    data: { organisationId, name: "Front of house", status: "ACTIVE" },
  });
  const version = await prisma.policyVersion.create({
    data: {
      policyId: policy.id,
      versionNumber: 1,
      restrictionConfig: {
        categories: ["SOCIAL_MEDIA"],
        requireEmployeeAppSelection: true,
        alwaysAllowedNote: ["Phone"],
        shieldMessage: "Work Mode is on.",
        activationMode: "SCHEDULED",
        preShiftWarningMinutes: 10,
      },
      publishedAt: new Date(),
    },
  });
  return prisma.policy.update({
    where: { id: policy.id },
    data: { currentVersionId: version.id },
  });
}

describe("managed employees", () => {
  it("lock name, email, external id and primary location; policy and other fields stay editable", async () => {
    const f = await setup();

    const detail = await callRoute<EmployeeDetailResponse>(getEmployeeRoute, {
      path: `/api/employees/${f.employeeId}`,
      params: { id: f.employeeId },
      jar: f.jar,
    });
    expect(detail.body.employee.managedBy).toEqual({
      provider: "PLANDAY",
      integrationId: f.integrationId,
    });
    expect(detail.body.employee.source).toBe("INTEGRATION");

    expectManaged(await patchEmployee(f, { firstName: "Changed" }), ["firstName"]);
    expectManaged(await patchEmployee(f, { lastName: "Changed" }), ["lastName"]);
    expectManaged(await patchEmployee(f, { email: "someone@example.test" }), ["email"]);
    expectManaged(await patchEmployee(f, { email: null }), ["email"]);
    expectManaged(await patchEmployee(f, { externalEmployeeId: "P-7" }), ["externalEmployeeId"]);
    expectManaged(await patchEmployee(f, { primaryLocationId: f.manualLocationId }), [
      "primaryLocationId",
    ]);
    // A mixed body is refused as a whole: nothing in it is written.
    expectManaged(await patchEmployee(f, { firstName: "Changed", jobTitle: "Chef" }), [
      "firstName",
    ]);
    expectManaged(
      await employeePost(f, assignLocationRoute, "assign-location", {
        primaryLocationId: f.manualLocationId,
      }),
      ["primaryLocationId"],
    );
    const unchanged = await prisma.employee.findUniqueOrThrow({ where: { id: f.employeeId } });
    expect(unchanged).toMatchObject({
      firstName: "Ava",
      lastName: "Planday",
      email: "ava@example.test",
      externalEmployeeId: `PLANDAY:${PORTAL}:1001`,
      primaryLocationId: f.managedLocationId,
      jobTitle: null,
    });

    // Sending the current values (the edit form does) is not a change; ClockOff-only fields save.
    const saved = await patchEmployee(f, {
      firstName: "Ava",
      lastName: "Planday",
      email: "AVA@example.test",
      externalEmployeeId: `PLANDAY:${PORTAL}:1001`,
      primaryLocationId: f.managedLocationId,
      jobTitle: "Chef",
      phone: "+44 7700 900123",
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.employee.jobTitle).toBe("Chef");
    expect(saved.body.employee.firstName).toBe("Ava");

    const policy = await seedPublishedPolicy(f.organisationId);
    const assigned = await employeePost<EmployeeResponse>(f, assignPolicyRoute, "assign-policy", {
      policyId: policy.id,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.employee.policyOverride).toEqual({ id: policy.id, name: policy.name });
    const viaPatch = await patchEmployee(f, { policyId: null });
    expect(viaPatch.status, JSON.stringify(viaPatch.body)).toBe(200);

    // Team overrides stay editable (a ClockOff-only team next to the managed one).
    const own = await prisma.team.create({
      data: { organisationId: f.organisationId, name: "Closers" },
    });
    const teams = await employeePost<EmployeeResponse>(f, assignTeamRoute, "assign-team", {
      teamIds: [f.managedTeamId, own.id],
    });
    expect(teams.status, JSON.stringify(teams.body)).toBe(200);
    expect(teams.body.employee.teams.map((t) => t.id).sort()).toEqual(
      [f.managedTeamId, own.id].sort(),
    );
  });

  it("refuses the bulk location action per item and keeps deactivation available", async () => {
    const f = await setup();
    const manual = await prisma.employee.create({
      data: { organisationId: f.organisationId, firstName: "Ben", lastName: "Manual" },
    });
    const bulk = await callRoute<BulkEmployeeActionResponse>(bulkEmployeesRoute, {
      method: "POST",
      path: "/api/employees/bulk",
      jar: f.jar,
      body: {
        action: "ASSIGN_LOCATION",
        employeeIds: [f.employeeId, manual.id],
        payload: { primaryLocationId: f.manualLocationId },
      },
    });
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(200);
    expect(bulk.body.succeeded).toBe(1);
    expect(bulk.body.failed).toEqual([
      expect.objectContaining({ employeeId: f.employeeId, code: "INTEGRATION_MANAGED" }),
    ]);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: manual.id } })).primaryLocationId,
    ).toBe(f.manualLocationId);

    const deactivated = await employeePost<EmployeeResponse>(f, deactivateRoute, "deactivate", {});
    expect(deactivated.status, JSON.stringify(deactivated.body)).toBe(200);
    expect(deactivated.body.employee.employmentStatus).toBe("INACTIVE");
  });

  it("leaves email editable while the integration does not import emails", async () => {
    const f = await setup();
    await prisma.integrationMappingConfig.update({
      where: { integrationId: f.integrationId },
      data: { importEmails: false },
    });
    const res = await patchEmployee(f, { email: "ava.work@example.test" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.employee.email).toBe("ava.work@example.test");
    expectManaged(await patchEmployee(f, { firstName: "Changed" }), ["firstName"]);
  });

  it("unlocks everything once the integration no longer manages the employee", async () => {
    const f = await setup();
    // What a disconnect does (§5.8): the records become ClockOff-managed and editable.
    await prisma.employee.update({
      where: { id: f.employeeId },
      data: { managedByIntegrationId: null },
    });
    const res = await patchEmployee(f, { firstName: "Changed", email: "x@example.test" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.employee.managedBy).toBeNull();
  });
});

describe("managed shifts", () => {
  it("refuse update, cancel and delete; duplicating creates an ordinary manual shift", async () => {
    const f = await setup();
    const before = await prisma.shift.findUniqueOrThrow({ where: { id: f.managedShiftId } });
    expect(before).toMatchObject({
      source: "INTEGRATION",
      managedByIntegrationId: f.integrationId,
    });

    const params = { id: f.managedShiftId };
    expectManaged(
      await callRoute<ErrorBody>(patchShiftRoute, {
        method: "PATCH",
        path: `/api/shifts/${f.managedShiftId}`,
        params,
        jar: f.jar,
        body: { notes: "Bring knives" },
      }),
    );
    expectManaged(
      await callRoute<ErrorBody>(patchShiftRoute, {
        method: "PATCH",
        path: `/api/shifts/${f.managedShiftId}`,
        params,
        jar: f.jar,
        body: { startTime: "10:00" },
      }),
    );
    expectManaged(
      await callRoute<ErrorBody>(cancelShiftRoute, {
        method: "POST",
        path: `/api/shifts/${f.managedShiftId}/cancel`,
        params,
        jar: f.jar,
        body: {},
      }),
    );
    expectManaged(
      await callRoute<ErrorBody>(deleteShiftRoute, {
        method: "DELETE",
        path: `/api/shifts/${f.managedShiftId}`,
        params,
        jar: f.jar,
      }),
    );
    const after = await prisma.shift.findUniqueOrThrow({ where: { id: f.managedShiftId } });
    expect(after).toMatchObject({
      version: before.version,
      status: "SCHEDULED",
      notes: null,
      deletedAt: null,
    });

    const duplicate = await callRoute<ShiftResponse & ErrorBody>(duplicateShiftRoute, {
      method: "POST",
      path: `/api/shifts/${f.managedShiftId}/duplicate`,
      params,
      jar: f.jar,
      body: { date: addLocalDays(f.tomorrow, 7) },
    });
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(201);
    expect(duplicate.body.shift).toMatchObject({
      source: "MANUAL",
      managedBy: null,
      externalShiftId: null,
    });
  });

  it("fail per item in bulk cancel, move and delete while manual shifts go through", async () => {
    const f = await setup();
    const bulk = async (body: unknown) => {
      const res = await callRoute<BulkShiftActionResponse>(bulkShiftsRoute, {
        method: "POST",
        path: "/api/shifts/bulk",
        jar: f.jar,
        body,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body;
    };
    const ids = [f.managedShiftId, f.manualShiftId];
    const refused = [
      expect.objectContaining({ shiftId: f.managedShiftId, code: "INTEGRATION_MANAGED" }),
    ];

    const moved = await bulk({
      action: "MOVE",
      shiftIds: ids,
      payload: { deltaDays: 1, deltaMinutes: 0 },
    });
    expect(moved.succeeded).toBe(1);
    expect(moved.failed).toEqual(refused);

    const repeated = await bulk({ action: "REPEAT", shiftIds: ids, payload: { weeks: 1 } });
    expect(repeated.failed).toEqual([]);
    expect(repeated.shifts.every((s) => s.source === "MANUAL" && s.managedBy === null)).toBe(true);

    const cancelled = await bulk({ action: "CANCEL", shiftIds: ids });
    expect(cancelled.succeeded).toBe(1);
    expect(cancelled.failed).toEqual(refused);

    const deleted = await bulk({ action: "DELETE", shiftIds: ids });
    expect(deleted.succeeded).toBe(1);
    expect(deleted.failed).toEqual(refused);

    const managed = await prisma.shift.findUniqueOrThrow({ where: { id: f.managedShiftId } });
    expect(managed).toMatchObject({ status: "SCHEDULED", deletedAt: null, version: 1 });
    const manual = await prisma.shift.findUniqueOrThrow({ where: { id: f.manualShiftId } });
    expect(manual.deletedAt).not.toBeNull();
  });
});

describe("managed locations and teams", () => {
  it("refuse renaming or deleting a managed location; other fields stay editable", async () => {
    const f = await setup();
    const path = `/api/locations/${f.managedLocationId}`;
    const params = { id: f.managedLocationId };
    expectManaged(
      await callRoute<ErrorBody>(patchLocationRoute, {
        method: "PATCH",
        path,
        params,
        jar: f.jar,
        body: { name: "Back kitchen" },
      }),
      ["name"],
    );
    expectManaged(
      await callRoute<ErrorBody>(deleteLocationRoute, {
        method: "DELETE",
        path,
        params,
        jar: f.jar,
      }),
    );
    const edited = await callRoute<LocationResponse & ErrorBody>(patchLocationRoute, {
      method: "PATCH",
      path,
      params,
      jar: f.jar,
      body: { name: "Kitchen", address: "1 High Street", timezone: "Europe/Dublin" },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.location).toMatchObject({
      name: "Kitchen",
      address: "1 High Street",
      timezone: "Europe/Dublin",
      source: "INTEGRATION",
      managedBy: { provider: "PLANDAY", integrationId: f.integrationId },
    });

    // The manager's own location is unaffected.
    const own = await callRoute<LocationResponse>(patchLocationRoute, {
      method: "PATCH",
      path: `/api/locations/${f.manualLocationId}`,
      params: { id: f.manualLocationId },
      jar: f.jar,
      body: { name: "Front of house" },
    });
    expect(own.status).toBe(200);
  });

  it("refuse renaming or deleting a managed team; members stay editable", async () => {
    const f = await setup();
    const path = `/api/teams/${f.managedTeamId}`;
    const params = { id: f.managedTeamId };
    expectManaged(
      await callRoute<ErrorBody>(patchTeamRoute, {
        method: "PATCH",
        path,
        params,
        jar: f.jar,
        body: { name: "Cooks" },
      }),
      ["name"],
    );
    expectManaged(
      await callRoute<ErrorBody>(deleteTeamRoute, { method: "DELETE", path, params, jar: f.jar }),
    );
    const located = await callRoute<TeamResponse & ErrorBody>(patchTeamRoute, {
      method: "PATCH",
      path,
      params,
      jar: f.jar,
      body: { name: "Chefs", locationId: f.managedLocationId },
    });
    expect(located.status, JSON.stringify(located.body)).toBe(200);
    expect(located.body.team.location?.id).toBe(f.managedLocationId);

    const other = await prisma.employee.create({
      data: { organisationId: f.organisationId, firstName: "Cara", lastName: "Manual" },
    });
    const members = await callRoute<TeamResponse & ErrorBody>(addMembersRoute, {
      method: "POST",
      path: `${path}/members`,
      params,
      jar: f.jar,
      body: { employeeIds: [other.id] },
    });
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    expect(members.body.team.memberCount).toBe(2);
  });

  it("refuses deleting a ClockOff department an integration maps employees into", async () => {
    const f = await setup();
    const department = await prisma.department.create({
      data: { organisationId: f.organisationId, name: "Kitchen staff" },
    });
    const remove = () =>
      callRoute<ErrorBody>(deleteDepartmentRoute, {
        method: "DELETE",
        path: `/api/departments/${department.id}`,
        params: { id: department.id },
        jar: f.jar,
      });

    await prisma.integrationMappingConfig.update({
      where: { integrationId: f.integrationId },
      data: {
        departmentMappings: { "201": { target: "DEPARTMENT", departmentId: department.id } },
      },
    });
    const byConfig = await remove();
    expect(byConfig.status, JSON.stringify(byConfig.body)).toBe(409);
    expect(byConfig.body.error).toMatchObject({
      code: "CONFLICT",
      details: { reason: "INTEGRATION_MAPPING_TARGET", provider: "PLANDAY" },
    });

    // A DEPARTMENT map row alone (the mapping already applied) also holds it.
    await prisma.integrationMappingConfig.update({
      where: { integrationId: f.integrationId },
      data: { departmentMappings: {} },
    });
    const mapRow = await prisma.externalEntityMap.create({
      data: {
        organisationId: f.organisationId,
        integrationId: f.integrationId,
        provider: "PLANDAY",
        entityType: "DEPARTMENT",
        externalId: "201",
        internalId: department.id,
        lastSeenAt: new Date(),
      },
    });
    expect((await remove()).status).toBe(409);

    await prisma.externalEntityMap.delete({ where: { id: mapRow.id } });
    expect((await remove()).status).toBe(204);
  });

  it("allows deleting a mapped department after a disconnect, or while Planday is switched off", async () => {
    const f = await setup();
    const make = (name: string) =>
      prisma.department.create({ data: { organisationId: f.organisationId, name } });
    const remove = (id: string) =>
      callRoute<ErrorBody>(deleteDepartmentRoute, {
        method: "DELETE",
        path: `/api/departments/${id}`,
        params: { id },
        jar: f.jar,
      });
    const bar = await make("Bar staff");
    const kitchen = await make("Kitchen staff");
    await prisma.integrationMappingConfig.update({
      where: { integrationId: f.integrationId },
      data: {
        departmentMappings: {
          "201": { target: "DEPARTMENT", departmentId: bar.id },
          "202": { target: "DEPARTMENT", departmentId: kitchen.id },
        },
      },
    });
    await prisma.externalEntityMap.create({
      data: {
        organisationId: f.organisationId,
        integrationId: f.integrationId,
        provider: "PLANDAY",
        entityType: "DEPARTMENT",
        externalId: "201",
        internalId: bar.id,
        lastSeenAt: new Date(),
      },
    });
    expect((await remove(bar.id)).status).toBe(409);

    // The kill switch hides the Planday settings: the target cannot be changed, so the delete goes ahead.
    const flag = process.env.PLANDAY_ENABLED;
    process.env.PLANDAY_ENABLED = "false";
    resetEnvCache();
    try {
      expect((await remove(kitchen.id)).status).toBe(204);
    } finally {
      if (flag === undefined) delete process.env.PLANDAY_ENABLED;
      else process.env.PLANDAY_ENABLED = flag;
      resetEnvCache();
    }

    // Disconnected (§5.8): the mapping config and map rows are kept for a reconnect, and no longer hold it.
    await prisma.integration.update({
      where: { id: f.integrationId },
      data: { status: "DISCONNECTED" },
    });
    expect((await remove(bar.id)).status).toBe(204);
    const config = await prisma.integrationMappingConfig.findUniqueOrThrow({
      where: { integrationId: f.integrationId },
    });
    expect(config.departmentMappings).toHaveProperty("201");
  });
});
