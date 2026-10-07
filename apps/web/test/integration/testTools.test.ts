import { prisma } from "@clockoff/db";
import type { Permission } from "@clockoff/shared/permissions";
import { currentUserSchema, type CurrentUser } from "@clockoff/validation/auth";
import {
  createTestShiftResponseSchema,
  type CreateTestShiftResponse,
} from "@clockoff/validation/testTools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { POST as testShiftRoute } from "@/app/api/test-tools/test-shift/route";
import { resetEnvCache } from "@/lib/env";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { loadScheduleVersion } from "@/server/sync/scheduleVersion";
import { TEST_SHIFT_NOTES } from "@/server/testTools";
import {
  addMember,
  callRoute,
  createTestOrg,
  loginAs,
  type CookieJar,
  type ErrorBody,
} from "../helpers";

/**
 * Test seam (this file only): permissions listed in `withhold` are removed from the manager context
 * before the real `requirePermission` runs, standing in for a role without them (every built-in role
 * has `schedule:write`). `checked` records which permission each request asked for.
 */
const seam = vi.hoisted(() => ({ withhold: [] as string[], checked: [] as string[] }));
vi.mock("@/server/tenancy/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tenancy/context")>();
  return {
    ...actual,
    requirePermission: (...args: Parameters<typeof actual.requirePermission>) => {
      const [ctx, permission] = args;
      seam.checked.push(permission);
      const permissions = new Set<Permission>(ctx.permissions);
      for (const p of seam.withhold) permissions.delete(p as Permission);
      return actual.requirePermission({ ...ctx, permissions }, permission);
    },
  };
});

/**
 * Phone test tools: `POST /api/test-tools/test-shift` and `testToolsEnabled` on `GET /api/auth/me`.
 * Available only with DEV_TOOLS_ENABLED=true or when the organisation is listed in
 * TEST_TOOLS_ORGANISATION_IDS; 404 otherwise.
 */

const MINUTE = 60_000;
const saved = {
  DEV_TOOLS_ENABLED: process.env.DEV_TOOLS_ENABLED,
  TEST_TOOLS_ORGANISATION_IDS: process.env.TEST_TOOLS_ORGANISATION_IDS,
};

function configure(options: { devTools?: boolean; organisationIds?: string[] }) {
  process.env.DEV_TOOLS_ENABLED = options.devTools ? "true" : "false";
  process.env.TEST_TOOLS_ORGANISATION_IDS = (options.organisationIds ?? []).join(",");
  resetEnvCache();
}

beforeEach(() => {
  seam.withhold = [];
  seam.checked = [];
  configure({});
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
});

async function setup() {
  const org = await createTestOrg({ name: "ClockOff Test" });
  const organisationId = org.organisation.id;
  const jar = await loginAs(org.owner, { organisationId });
  const employee = await prisma.employee.create({
    data: { organisationId, firstName: "Zach", lastName: "Stephens" },
  });
  return { org, organisationId, jar, employee };
}

async function post(jar: CookieJar | undefined, body: unknown, options: { csrf?: boolean } = {}) {
  return callRoute<CreateTestShiftResponse & ErrorBody>(testShiftRoute, {
    method: "POST",
    path: "/api/test-tools/test-shift",
    ...(jar ? { jar } : {}),
    body,
    ...(options.csrf === false ? { csrf: false } : {}),
  });
}

async function me(jar: CookieJar): Promise<CurrentUser> {
  const res = await callRoute(meRoute, { path: "/api/auth/me", jar });
  expect(res.status).toBe(200);
  return currentUserSchema.parse(res.body);
}

function collectEvents(organisationId: string, type: string) {
  const seen: RealtimeEvent[] = [];
  const unsubscribe = getEventBus().subscribe(organisationId, (e) => {
    if (e.type === type) seen.push(e);
  });
  return { seen, unsubscribe };
}

describe("POST /api/test-tools/test-shift: availability", () => {
  it("answers 404 when neither DEV_TOOLS_ENABLED nor TEST_TOOLS_ORGANISATION_IDS is set, even anonymously", async () => {
    const { jar, organisationId, employee } = await setup();
    const res = await post(jar, { employeeId: employee.id });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect((await post(undefined, { employeeId: employee.id })).status).toBe(404);
    expect(await prisma.shift.count({ where: { organisationId } })).toBe(0);
    expect((await me(jar)).organisations[0]?.testToolsEnabled).toBe(false);
  });

  it("answers 404 to an organisation that is not listed, before permission and validation", async () => {
    const { jar, organisationId, employee } = await setup();
    const listed = await createTestOrg();
    configure({ organisationIds: [listed.organisation.id] });

    const res = await post(jar, { employeeId: employee.id });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    // An invalid body or a missing permission still reads as "no such route".
    expect((await post(jar, { employeeId: employee.id, durationMinutes: 5 })).status).toBe(404);
    seam.withhold = ["schedule:write"];
    expect((await post(jar, { employeeId: employee.id })).status).toBe(404);
    expect(seam.checked).toEqual([]);
    expect(await prisma.shift.count({ where: { organisationId } })).toBe(0);
    // Signed-out callers are asked to sign in first.
    expect((await post(undefined, { employeeId: employee.id })).status).toBe(401);
  });

  it("is enabled per organisation by TEST_TOOLS_ORGANISATION_IDS, and /api/auth/me says so", async () => {
    const { org, jar, organisationId, employee } = await setup();
    const other = await createTestOrg({ owner: org.owner });
    configure({ organisationIds: [organisationId.toUpperCase()] });

    const flags = Object.fromEntries(
      (await me(jar)).organisations.map((o) => [o.id, o.testToolsEnabled]),
    );
    expect(flags).toEqual({ [organisationId]: true, [other.organisation.id]: false });

    const res = await post(jar, { employeeId: employee.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("is enabled for every organisation while DEV_TOOLS_ENABLED=true", async () => {
    const { jar, employee } = await setup();
    configure({ devTools: true });
    expect((await me(jar)).organisations[0]?.testToolsEnabled).toBe(true);
    const res = await post(jar, { employeeId: employee.id, startsInMinutes: 5 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe("POST /api/test-tools/test-shift: creating the shift", () => {
  it("creates a MANUAL shift for the employee at now + N through the ordinary shift service", async () => {
    const { jar, organisationId, employee } = await setup();
    configure({ organisationIds: [organisationId] });
    const versionBefore = await loadScheduleVersion(organisationId, employee.id);
    const events = collectEvents(organisationId, "SCHEDULE_CHANGED");

    const before = Date.now();
    const res = await post(jar, {
      employeeId: employee.id,
      startsInMinutes: 7,
      durationMinutes: 45,
    });
    const after = Date.now();
    events.unsubscribe();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { shift, warnings } = createTestShiftResponseSchema.parse(res.body);
    expect(warnings).toEqual([]);

    const startsAt = Date.parse(shift.startsAt);
    expect(startsAt % MINUTE).toBe(0);
    expect(startsAt).toBeGreaterThanOrEqual(before + 7 * MINUTE);
    expect(startsAt).toBeLessThanOrEqual(after + 8 * MINUTE);
    expect(Date.parse(shift.endsAt) - startsAt).toBe(45 * MINUTE);
    expect(shift).toMatchObject({
      durationMinutes: 45,
      status: "SCHEDULED",
      source: "MANUAL",
      timezone: "Europe/London",
      notes: TEST_SHIFT_NOTES,
      recurrenceRule: null,
      location: null,
    });
    expect(shift.employee).toMatchObject({ id: employee.id, firstName: "Zach" });

    const row = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(row).toMatchObject({ organisationId, employeeId: employee.id, source: "MANUAL" });

    // Same side effects as POST /api/shifts: activity, audit, the phone's re-sync push, a new version.
    const activity = await prisma.activityEvent.findFirst({
      where: { organisationId, type: "SHIFT_CREATED" },
    });
    expect(activity?.employeeId).toBe(employee.id);
    expect(
      await prisma.auditLog.count({ where: { organisationId, action: "shift.created" } }),
    ).toBe(1);
    expect(events.seen).toHaveLength(1);
    expect(events.seen[0]?.payload).toMatchObject({
      employeeId: employee.id,
      shiftIds: [shift.id],
      reason: "CREATED",
    });
    expect(await loadScheduleVersion(organisationId, employee.id)).not.toBe(versionBefore);
  });

  it("defaults to a 30-minute shift starting in 20 minutes", async () => {
    const { jar, organisationId, employee } = await setup();
    configure({ organisationIds: [organisationId] });
    const before = Date.now();
    const res = await post(jar, { employeeId: employee.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const startsAt = Date.parse(res.body.shift.startsAt);
    expect(startsAt).toBeGreaterThanOrEqual(before + 20 * MINUTE);
    expect(startsAt).toBeLessThanOrEqual(Date.now() + 21 * MINUTE);
    expect(res.body.shift.durationMinutes).toBe(30);
  });

  it("rejects shifts shorter than 15 minutes and out-of-range or extra fields", async () => {
    const { jar, organisationId, employee } = await setup();
    configure({ organisationIds: [organisationId] });

    const short = await post(jar, { employeeId: employee.id, durationMinutes: 14 });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe("VALIDATION_ERROR");
    expect(
      (short.body.error.details as { fieldErrors: Record<string, string[]> }).fieldErrors
        .durationMinutes,
    ).toEqual(["Apple requires at least 15 minutes"]);

    for (const body of [
      { employeeId: employee.id, durationMinutes: 481 },
      { employeeId: employee.id, startsInMinutes: 0 },
      { employeeId: employee.id, startsInMinutes: 241 },
      // The organisation always comes from the session, never from the body.
      { employeeId: employee.id, organisationId },
    ]) {
      const res = await post(jar, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await prisma.shift.count({ where: { organisationId } })).toBe(0);
  });

  it("applies the overlap check like any other shift", async () => {
    const { jar, organisationId, employee } = await setup();
    configure({ organisationIds: [organisationId] });
    expect((await post(jar, { employeeId: employee.id })).status).toBe(201);
    const overlapping = await post(jar, { employeeId: employee.id, startsInMinutes: 25 });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.error.code).toBe("SHIFT_OVERLAP");
  });

  it("answers 404 for another organisation's employee (tenant isolation), even when both are listed", async () => {
    const { jar, organisationId } = await setup();
    const victim = await createTestOrg();
    const victimEmployee = await prisma.employee.create({
      data: { organisationId: victim.organisation.id, firstName: "B", lastName: "Only" },
    });
    configure({ organisationIds: [organisationId, victim.organisation.id] });

    const res = await post(jar, { employeeId: victimEmployee.id });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("EMPLOYEE_NOT_FOUND");
    expect(await prisma.shift.count({ where: { organisationId: victim.organisation.id } })).toBe(0);
    expect(await prisma.shift.count({ where: { organisationId } })).toBe(0);
  });

  it("requires schedule:write (the permission of POST /api/shifts), sign-in and the CSRF header", async () => {
    const { org, organisationId, employee } = await setup();
    configure({ organisationIds: [organisationId] });
    const manager = await createTestOrg();
    await addMember(organisationId, manager.owner, "MANAGER");
    const managerJar = await loginAs(manager.owner, { organisationId });

    // Withholding another permission does not matter; withholding schedule:write does.
    seam.withhold = ["employees:write"];
    expect((await post(managerJar, { employeeId: employee.id })).status).toBe(201);
    expect(seam.checked).toEqual(["schedule:write"]);

    seam.withhold = ["schedule:write"];
    const forbidden = await post(managerJar, { employeeId: employee.id, startsInMinutes: 120 });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    seam.withhold = [];

    expect((await post(undefined, { employeeId: employee.id })).status).toBe(401);
    const ownerJar = await loginAs(org.owner, { organisationId });
    const noCsrf = await post(ownerJar, { employeeId: employee.id }, { csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(await prisma.shift.count({ where: { organisationId } })).toBe(1);
  });

  it("is rate limited per IP", async () => {
    const { jar, organisationId, employee } = await setup();
    configure({ organisationIds: [organisationId] });
    // Invalid bodies still count: the limit applies before validation.
    for (let i = 0; i < 30; i++) {
      expect((await post(jar, { employeeId: employee.id, durationMinutes: 1 })).status).toBe(400);
    }
    const limited = await post(jar, { employeeId: employee.id });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });
});
