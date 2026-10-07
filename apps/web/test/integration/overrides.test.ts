import { randomUUID } from "node:crypto";
import { prisma } from "@clockoff/db";
import { mobileSyncResponseSchema } from "@clockoff/validation/mobile";
import {
  listOverridesResponseSchema,
  overrideResponseSchema,
} from "@clockoff/validation/overrides";
import { describe, expect, it } from "vitest";
import { GET as syncRoute } from "@/app/api/mobile/v1/sync/route";
import { POST as revokeRoute } from "@/app/api/overrides/[id]/revoke/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/overrides/route";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { issueMobileTokens } from "@/server/mobileAuth";
import {
  addMember,
  callRoute,
  createTestDevice,
  createTestOrg,
  createTestUser,
  loginAs,
  type CookieJar,
  type ErrorBody,
} from "../helpers";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function fixture() {
  const org = await createTestOrg();
  const organisationId = org.organisation.id;
  const { device, employee } = await createTestDevice(organisationId);
  const connected = await prisma.device.update({
    where: { id: device.id },
    data: {
      permissionState: "APPROVED",
      selectionState: "CONFIGURED",
      lastDeviceSyncAt: new Date(),
    },
  });
  const now = Date.now();
  const shift = await prisma.shift.create({
    data: {
      organisationId,
      employeeId: employee.id,
      startsAt: new Date(now - HOUR),
      endsAt: new Date(now + 3 * HOUR),
      timezone: "Europe/London",
    },
  });
  const managerUser = await createTestUser({ name: "Shift Manager" });
  await addMember(organisationId, managerUser.user, "MANAGER");
  const ownerJar = await loginAs(org.owner, { organisationId });
  const managerJar = await loginAs(managerUser.user, { organisationId });
  return {
    org,
    organisationId,
    device: connected,
    employee,
    shift,
    ownerJar,
    managerJar,
    managerUser,
  };
}

type OverrideBody = Record<string, unknown>;

async function create(jar: CookieJar, body: OverrideBody) {
  return callRoute<ErrorBody & { override?: unknown }>(createRoute, {
    method: "POST",
    path: "/api/overrides",
    jar,
    body,
  });
}

async function revoke(jar: CookieJar, id: string, body: OverrideBody = {}) {
  return callRoute<ErrorBody & { override?: unknown }>(revokeRoute, {
    method: "POST",
    path: `/api/overrides/${id}/revoke`,
    params: { id },
    jar,
    body,
  });
}

describe("POST /api/overrides", () => {
  it("lets a MANAGER exempt an employee, audits, records OVERRIDE_CREATED and updates the work state", async () => {
    const { organisationId, employee, managerJar, managerUser, device } = await fixture();
    const seen: RealtimeEvent[] = [];
    const unsubscribe = getEventBus().subscribe(organisationId, (e) => seen.push(e));

    const res = await create(managerJar, {
      employeeId: employee.id,
      type: "EXEMPT_TEMPORARILY",
      reason: "Family emergency",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { override } = overrideResponseSchema.parse(res.body);
    expect(override.status).toBe("ACTIVE");
    expect(override.employee?.id).toBe(employee.id);
    expect(override.createdBy?.id).toBe(managerUser.user.id);
    expect(override.payload).toEqual({});
    expect(Date.parse(override.expiresAt) - Date.parse(override.startsAt)).toBe(60 * MINUTE);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { organisationId, action: "override.created" },
    });
    expect(audit.entityId).toBe(override.id);
    expect(audit.actorUserId).toBe(managerUser.user.id);
    const activity = await prisma.activityEvent.findFirstOrThrow({
      where: { organisationId, type: "OVERRIDE_CREATED" },
    });
    expect(activity.actorType).toBe("MANAGER");
    expect(activity.actorUserId).toBe(managerUser.user.id);
    expect(activity.employeeId).toBe(employee.id);
    expect((activity.metadata as { overrideId: string }).overrideId).toBe(override.id);

    const workState = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(workState.expectedState).toBe("MANAGER_OVERRIDE");
    expect(workState.expectedRestriction).toBe("NONE");
    expect(
      seen.some(
        (e) =>
          e.type === "OVERRIDE_CREATED" &&
          (e.payload as { overrideId: string }).overrideId === override.id,
      ),
    ).toBe(true);
    expect(seen.some((e) => e.type === "override.changed")).toBe(true);

    // The device learns about it through /sync.
    const { accessToken } = await issueMobileTokens(device);
    const bundle = mobileSyncResponseSchema.parse(
      (
        await callRoute(syncRoute, {
          path: "/api/mobile/v1/sync",
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).body,
    );
    expect(bundle.activeOverrides.map((o) => o.id)).toEqual([override.id]);
    expect(bundle.expectedState.state).toBe("MANAGER_OVERRIDE");
    unsubscribe();
  });

  it("caps the duration by role and reserves EMERGENCY_POLICY_OVERRIDE for org:manage, organisation-wide", async () => {
    const { employee, managerJar, ownerJar } = await fixture();

    const tooLong = await create(managerJar, {
      employeeId: employee.id,
      type: "EXEMPT_TEMPORARILY",
      reason: "Long cover",
      durationMinutes: 25 * 60,
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe("OVERRIDE_TOO_LONG");

    const ownerLong = await create(ownerJar, {
      employeeId: employee.id,
      type: "EXEMPT_TEMPORARILY",
      reason: "Long cover",
      durationMinutes: 25 * 60,
    });
    expect(ownerLong.status).toBe(201);

    const ownerTooLong = await create(ownerJar, {
      employeeId: employee.id,
      type: "EXEMPT_TEMPORARILY",
      reason: "Way too long",
      expiresAt: new Date(Date.now() + 8 * 24 * HOUR).toISOString(),
    });
    expect(ownerTooLong.status).toBe(400);
    expect(ownerTooLong.body.error.code).toBe("OVERRIDE_TOO_LONG");

    const past = await create(ownerJar, {
      employeeId: employee.id,
      type: "EXEMPT_TEMPORARILY",
      reason: "In the past",
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    expect(past.status).toBe(400);
    expect(past.body.error.code).toBe("VALIDATION_ERROR");

    const managerEmergency = await create(managerJar, {
      type: "EMERGENCY_POLICY_OVERRIDE",
      reason: "Fire alarm",
    });
    expect(managerEmergency.status).toBe(403);
    expect(managerEmergency.body.error.code).toBe("FORBIDDEN");

    const scoped = await create(ownerJar, {
      employeeId: employee.id,
      type: "EMERGENCY_POLICY_OVERRIDE",
      reason: "Fire alarm",
    });
    expect(scoped.status).toBe(400);
    expect(scoped.body.error.code).toBe("VALIDATION_ERROR");

    const emergency = await create(ownerJar, {
      type: "EMERGENCY_POLICY_OVERRIDE",
      reason: "Fire alarm",
    });
    expect(emergency.status).toBe(201);
    const { override } = overrideResponseSchema.parse(emergency.body);
    expect(override.employee).toBeNull();
    expect(override.type).toBe("EMERGENCY_POLICY_OVERRIDE");
    const activity = await prisma.activityEvent.findFirstOrThrow({
      where: { type: "OVERRIDE_CREATED", metadata: { path: ["overrideId"], equals: override.id } },
    });
    expect(activity.employeeId).toBeNull();
    expect((activity.metadata as { orgWide: boolean }).orgWide).toBe(true);

    const missingEmployee = await create(managerJar, {
      type: "EXEMPT_TEMPORARILY",
      reason: "No one",
    });
    expect(missingEmployee.status).toBe(400);
  });

  it("merges a referenced break policy into a TEMPORARY_EXCEPTION payload and defaults END_WORK_MODE_EARLY to the shift end", async () => {
    const { organisationId, employee, managerJar, shift, device } = await fixture();
    const breakPolicy = await prisma.breakPolicy.create({
      data: {
        organisationId,
        name: "Games only",
        restrictionBehaviour: "RELAX_CATEGORIES",
        relaxedCategories: ["GAMES", "GAMES", "NOT_A_CATEGORY"],
      },
    });

    const exception = await create(managerJar, {
      employeeId: employee.id,
      type: "TEMPORARY_EXCEPTION",
      reason: "Waiting for a delivery",
      durationMinutes: 30,
      payload: { breakPolicyId: breakPolicy.id },
    });
    expect(exception.status, JSON.stringify(exception.body)).toBe(201);
    const stored = overrideResponseSchema.parse(exception.body).override;
    expect(stored.payload).toEqual({
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["GAMES"],
      breakPolicyId: breakPolicy.id,
    });
    const { accessToken } = await issueMobileTokens(device);
    const bundle = mobileSyncResponseSchema.parse(
      (
        await callRoute(syncRoute, {
          path: "/api/mobile/v1/sync",
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).body,
    );
    expect(bundle.activeOverrides[0]?.breakBehaviour).toEqual({
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["GAMES"],
    });
    expect(bundle.expectedState.effectiveRestriction).toBe("BREAK_RELAXED");
    expect(bundle.expectedState.relaxation?.liftedCategories).toEqual(["GAMES"]);

    const explicit = await create(managerJar, {
      employeeId: employee.id,
      type: "TEMPORARY_EXCEPTION",
      reason: "Second exception",
      payload: { restrictionBehaviour: "KEEP_RESTRICTIONS" },
    });
    expect(overrideResponseSchema.parse(explicit.body).override.payload).toEqual({
      restrictionBehaviour: "KEEP_RESTRICTIONS",
      relaxedCategories: [],
    });

    const bare = await create(managerJar, {
      employeeId: employee.id,
      type: "TEMPORARY_EXCEPTION",
      reason: "Third exception",
    });
    expect(overrideResponseSchema.parse(bare.body).override.payload).toEqual({
      restrictionBehaviour: "RELAX_ALL",
      relaxedCategories: [],
    });

    const payloadOnLifting = await create(managerJar, {
      employeeId: employee.id,
      type: "EXEMPT_TEMPORARILY",
      reason: "Payload not allowed",
      payload: { restrictionBehaviour: "RELAX_ALL" },
    });
    expect(payloadOnLifting.status).toBe(400);

    const other = await createTestOrg();
    const foreignPolicy = await prisma.breakPolicy.create({
      data: { organisationId: other.organisation.id, name: "Theirs" },
    });
    const foreign = await create(managerJar, {
      employeeId: employee.id,
      type: "TEMPORARY_EXCEPTION",
      reason: "Foreign policy",
      payload: { breakPolicyId: foreignPolicy.id },
    });
    expect(foreign.status).toBe(404);

    const early = await create(managerJar, {
      employeeId: employee.id,
      type: "END_WORK_MODE_EARLY",
      reason: "Sent home early",
    });
    expect(early.status).toBe(201);
    expect(overrideResponseSchema.parse(early.body).override.expiresAt).toBe(
      shift.endsAt.toISOString(),
    );

    const inactive = await prisma.employee.create({
      data: { organisationId, firstName: "Gone", lastName: "Away", employmentStatus: "INACTIVE" },
    });
    const forInactive = await create(managerJar, {
      employeeId: inactive.id,
      type: "EXEMPT_TEMPORARILY",
      reason: "Not here",
    });
    expect(forInactive.status).toBe(409);
    expect(forInactive.body.error.code).toBe("EMPLOYEE_INACTIVE");

    const unknown = await create(managerJar, {
      employeeId: randomUUID(),
      type: "EXEMPT_TEMPORARILY",
      reason: "Nobody",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("EMPLOYEE_NOT_FOUND");
  });
});

describe("POST /api/overrides/:id/revoke and GET /api/overrides", () => {
  it("revokes once (idempotent), refuses expired overrides, audits and lists with filters", async () => {
    const { organisationId, employee, managerJar, ownerJar } = await fixture();
    const seen: RealtimeEvent[] = [];
    const unsubscribe = getEventBus().subscribe(organisationId, (e) => seen.push(e));
    const created = overrideResponseSchema.parse(
      (
        await create(managerJar, {
          employeeId: employee.id,
          type: "EXEMPT_TEMPORARILY",
          reason: "Cover shift",
        })
      ).body,
    ).override;

    const revoked = await revoke(managerJar, created.id, { reason: "Back at work" });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const revokedDto = overrideResponseSchema.parse(revoked.body).override;
    expect(revokedDto.status).toBe("REVOKED");
    expect(revokedDto.revokedAt).not.toBeNull();
    expect(
      await prisma.auditLog.count({ where: { organisationId, action: "override.revoked" } }),
    ).toBe(1);
    expect(seen.filter((e) => e.type === "OVERRIDE_REVOKED")).toHaveLength(1);
    const workState = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(workState.expectedState).toBe("WORKING");

    const again = await revoke(managerJar, created.id);
    expect(again.status).toBe(200);
    expect(overrideResponseSchema.parse(again.body).override.revokedAt).toBe(revokedDto.revokedAt);
    expect(
      await prisma.auditLog.count({ where: { organisationId, action: "override.revoked" } }),
    ).toBe(1);

    const expired = await prisma.managerOverride.create({
      data: {
        organisationId,
        employeeId: employee.id,
        type: "EXEMPT_TEMPORARILY",
        reason: "Old one",
        startsAt: new Date(Date.now() - 2 * HOUR),
        expiresAt: new Date(Date.now() - HOUR),
      },
    });
    const expiredRes = await revoke(ownerJar, expired.id);
    expect(expiredRes.status).toBe(409);
    expect(expiredRes.body.error.code).toBe("OVERRIDE_EXPIRED");

    const missing = await revoke(ownerJar, randomUUID());
    expect(missing.status).toBe(404);

    const active = overrideResponseSchema.parse(
      (
        await create(ownerJar, {
          employeeId: employee.id,
          type: "END_WORK_MODE_EARLY",
          reason: "Going home",
        })
      ).body,
    ).override;

    const all = listOverridesResponseSchema.parse(
      (await callRoute(listRoute, { path: "/api/overrides", jar: managerJar })).body,
    );
    expect(all.items.map((o) => o.id)).toEqual([active.id, expired.id, created.id]);
    expect(all.items.map((o) => o.status)).toEqual(["ACTIVE", "EXPIRED", "REVOKED"]);

    const onlyActive = listOverridesResponseSchema.parse(
      (
        await callRoute(listRoute, {
          path: "/api/overrides",
          query: { status: "ACTIVE" },
          jar: managerJar,
        })
      ).body,
    );
    expect(onlyActive.items.map((o) => o.id)).toEqual([active.id]);

    const revokedOrExpired = listOverridesResponseSchema.parse(
      (
        await callRoute(listRoute, {
          path: "/api/overrides",
          query: { status: "REVOKED,EXPIRED", type: "EXEMPT_TEMPORARILY" },
          jar: managerJar,
        })
      ).body,
    );
    expect(revokedOrExpired.items.map((o) => o.id)).toEqual([expired.id, created.id]);

    const paged = listOverridesResponseSchema.parse(
      (await callRoute(listRoute, { path: "/api/overrides", query: { limit: 2 }, jar: managerJar }))
        .body,
    );
    expect(paged.items).toHaveLength(2);
    expect(paged.nextCursor).not.toBeNull();
    const rest = listOverridesResponseSchema.parse(
      (
        await callRoute(listRoute, {
          path: "/api/overrides",
          query: { limit: 2, cursor: paged.nextCursor! },
          jar: managerJar,
        })
      ).body,
    );
    expect(rest.items.map((o) => o.id)).toEqual([created.id]);
    expect(rest.nextCursor).toBeNull();

    const other = await createTestOrg();
    const otherJar = await loginAs(other.owner, { organisationId: other.organisation.id });
    const foreignList = listOverridesResponseSchema.parse(
      (
        await callRoute(listRoute, {
          path: "/api/overrides",
          query: { employeeId: employee.id },
          jar: otherJar,
        })
      ).body,
    );
    expect(foreignList.items).toEqual([]);
    unsubscribe();
  });
});
