import { randomUUID } from "node:crypto";
import { prisma, type Device, type Prisma } from "@workmode/db";
import { mobileBreakResponseSchema } from "@workmode/validation/mobile";
import { describe, expect, it } from "vitest";
import { POST as endRoute } from "@/app/api/mobile/v1/breaks/[id]/end/route";
import { POST as startRoute } from "@/app/api/mobile/v1/breaks/start/route";
import { issueMobileTokens } from "@/server/mobileAuth";
import { callRoute, createTestDevice, createTestOrg, type ErrorBody } from "../helpers";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function bearer(device: Device): Promise<Record<string, string>> {
  const { accessToken } = await issueMobileTokens(device);
  return { authorization: `Bearer ${accessToken}` };
}

async function setup(breakPolicy: Partial<Prisma.BreakPolicyUncheckedCreateInput> = {}) {
  const org = await createTestOrg();
  const { device, employee } = await createTestDevice(org.organisation.id);
  const connected = await prisma.device.update({
    where: { id: device.id },
    data: {
      permissionState: "APPROVED",
      selectionState: "CONFIGURED",
      lastDeviceSyncAt: new Date(),
    },
  });
  const policy = await prisma.breakPolicy.create({
    data: { organisationId: org.organisation.id, name: "Breaks", ...breakPolicy },
  });
  await prisma.organisation.update({
    where: { id: org.organisation.id },
    data: { defaultBreakPolicyId: policy.id },
  });
  const now = Date.now();
  const shift = await prisma.shift.create({
    data: {
      organisationId: org.organisation.id,
      employeeId: employee.id,
      startsAt: new Date(now - 2 * HOUR),
      endsAt: new Date(now + 4 * HOUR),
      timezone: "Europe/London",
    },
  });
  return { org, device: connected, employee, policy, shift, headers: await bearer(connected) };
}

function startBody(
  shiftId: string,
  requestedAt: Date = new Date(),
  extra: Record<string, unknown> = {},
) {
  return { clientBreakId: randomUUID(), shiftId, requestedAt: requestedAt.toISOString(), ...extra };
}

async function start(headers: Record<string, string>, body: Record<string, unknown>) {
  return callRoute<ErrorBody & Record<string, unknown>>(startRoute, {
    method: "POST",
    path: "/api/mobile/v1/breaks/start",
    headers,
    body,
  });
}

async function end(headers: Record<string, string>, id: string, body: Record<string, unknown>) {
  return callRoute<ErrorBody & Record<string, unknown>>(endRoute, {
    method: "POST",
    path: `/api/mobile/v1/breaks/${id}/end`,
    params: { id },
    headers,
    body,
  });
}

const countActivity = (
  employeeId: string,
  type: "BREAK_STARTED" | "BREAK_ENDED" | "BREAK_EXPIRED",
) => prisma.activityEvent.count({ where: { employeeId, type } });

describe("POST /api/mobile/v1/breaks/start (live)", () => {
  it("starts a break under the resolved policy, is idempotent on clientBreakId and refuses overlaps", async () => {
    const { headers, shift, employee, policy } = await setup();
    const body = startBody(shift.id);

    const res = await start(headers, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const parsed = mobileBreakResponseSchema.parse(res.body);
    expect(parsed.breakSession.status).toBe("ACTIVE");
    expect(parsed.breakSession.shiftId).toBe(shift.id);
    expect(parsed.breakSession.clientBreakId).toBe(body.clientBreakId);
    expect(parsed.breakSession.restrictionBehaviour).toBe("RELAX_ALL");
    const startedAt = Date.parse(parsed.breakSession.startedAt);
    expect(Date.parse(parsed.breakSession.plannedEndsAt) - startedAt).toBe(15 * MINUTE);
    expect(Math.abs(Date.now() - startedAt)).toBeLessThan(10_000);
    expect(parsed.allowance.breaksTaken).toBe(1);
    expect(parsed.allowance.breaksRemaining).toBe(1);
    expect(parsed.allowance.canStartNow).toBe(false);

    const row = await prisma.breakSession.findUniqueOrThrow({
      where: { id: parsed.breakSession.id },
    });
    expect(row.breakPolicyId).toBe(policy.id);
    expect(row.employeeId).toBe(employee.id);
    expect(await countActivity(employee.id, "BREAK_STARTED")).toBe(1);
    const workState = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(workState.activeBreakSessionId).toBe(parsed.breakSession.id);
    expect(workState.expectedState).toBe("ON_BREAK");
    expect(workState.breaksTakenCount).toBe(1);

    // Retry with the same clientBreakId → the same session, nothing new written.
    const replay = await start(headers, body);
    expect(replay.status).toBe(201);
    expect(mobileBreakResponseSchema.parse(replay.body).breakSession.id).toBe(
      parsed.breakSession.id,
    );
    expect(await prisma.breakSession.count({ where: { shiftId: shift.id } })).toBe(1);
    expect(await countActivity(employee.id, "BREAK_STARTED")).toBe(1);

    // A different break while one is running.
    const overlap = await start(headers, startBody(shift.id));
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe("BREAK_ALREADY_ACTIVE");
    expect(await prisma.breakSession.count({ where: { shiftId: shift.id } })).toBe(1);
  });

  it("refuses too-soon, limit-reached, not-on-shift and foreign shifts with structured codes", async () => {
    const { headers, org, employee, shift } = await setup({
      maxBreaksPerShift: 1,
      minGapBetweenBreaksMinutes: 0,
    });
    const now = Date.now();
    const fresh = await prisma.shift.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        startsAt: new Date(now + 5 * HOUR),
        endsAt: new Date(now + 9 * HOUR),
        timezone: "Europe/London",
      },
    });
    const notStarted = await start(headers, startBody(fresh.id));
    expect(notStarted.status).toBe(409);
    expect(notStarted.body.error.code).toBe("NOT_ON_SHIFT");

    // Shift started 10 minutes ago: minMinutesAfterShiftStart (60) not reached.
    await prisma.shift.update({
      where: { id: shift.id },
      data: { startsAt: new Date(now - 10 * MINUTE) },
    });
    const tooSoon = await start(headers, startBody(shift.id));
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.error.code).toBe("BREAK_TOO_SOON");
    expect((tooSoon.body.error.details as { reason: string }).reason).toBe(
      "MIN_MINUTES_AFTER_SHIFT_START",
    );
    await prisma.shift.update({
      where: { id: shift.id },
      data: { startsAt: new Date(now - 2 * HOUR) },
    });

    const first = await start(headers, startBody(shift.id));
    expect(first.status).toBe(201);
    const session = mobileBreakResponseSchema.parse(first.body).breakSession;
    const ended = await end(headers, session.id, {
      endedAt: new Date().toISOString(),
      reason: "EMPLOYEE_ENDED",
    });
    expect(ended.status).toBe(200);

    const limit = await start(headers, startBody(shift.id));
    expect(limit.status).toBe(409);
    expect(limit.body.error.code).toBe("BREAK_LIMIT_REACHED");

    const other = await createTestDevice(org.organisation.id);
    const foreignShift = await prisma.shift.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: other.employee.id,
        startsAt: new Date(now - HOUR),
        endsAt: new Date(now + HOUR),
        timezone: "Europe/London",
      },
    });
    const foreign = await start(headers, startBody(foreignShift.id));
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/mobile/v1/breaks/start (concurrency and idempotency keys)", () => {
  it("serialises concurrent starts on one shift: exactly one break, the other refused BREAK_ALREADY_ACTIVE", async () => {
    const { headers, shift, employee } = await setup();
    const results = await Promise.all([
      start(headers, startBody(shift.id)),
      start(headers, startBody(shift.id)),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([201, 409]);
    const refused = results.find((r) => r.status === 409)!;
    expect(refused.body.error.code).toBe("BREAK_ALREADY_ACTIVE");
    expect(await prisma.breakSession.count({ where: { shiftId: shift.id } })).toBe(1);
    expect(
      await prisma.breakSession.count({ where: { shiftId: shift.id, status: "ACTIVE" } }),
    ).toBe(1);
    expect(await countActivity(employee.id, "BREAK_STARTED")).toBe(1);
  });

  it("never answers with another employee's session for a colliding clientBreakId (CONFLICT)", async () => {
    const { headers, shift, org, employee } = await setup();
    const other = await createTestDevice(org.organisation.id);
    const now = Date.now();
    const otherShift = await prisma.shift.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: other.employee.id,
        startsAt: new Date(now - 2 * HOUR),
        endsAt: new Date(now + 4 * HOUR),
        timezone: "Europe/London",
      },
    });
    const clientBreakId = randomUUID();
    const theirs = await prisma.breakSession.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: other.employee.id,
        shiftId: otherShift.id,
        startedAt: new Date(now - 5 * MINUTE),
        plannedEndsAt: new Date(now + 10 * MINUTE),
        clientBreakId,
      },
    });

    const res = await start(headers, { ...startBody(shift.id), clientBreakId });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(await prisma.breakSession.count({ where: { employeeId: employee.id } })).toBe(0);
    const untouched = await prisma.breakSession.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(untouched.status).toBe("ACTIVE");
    expect(untouched.employeeId).toBe(other.employee.id);

    // The same device's own key still replays idempotently.
    const mine = startBody(shift.id);
    const first = await start(headers, mine);
    expect(first.status).toBe(201);
    const replay = await start(headers, mine);
    expect(replay.status).toBe(201);
    expect(mobileBreakResponseSchema.parse(replay.body).breakSession.id).toBe(
      mobileBreakResponseSchema.parse(first.body).breakSession.id,
    );
  });
});

describe("POST /api/mobile/v1/breaks/start (offline reconciliation)", () => {
  it("accepts a late request at its device-reported start and records it as already expired", async () => {
    const { headers, shift, employee } = await setup();
    const requestedAt = new Date(Date.now() - 40 * MINUTE);
    const res = await start(headers, startBody(shift.id, requestedAt));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const parsed = mobileBreakResponseSchema.parse(res.body);
    expect(parsed.breakSession.status).toBe("ENDED");
    expect(parsed.breakSession.endReason).toBe("EXPIRED");
    expect(
      Math.abs(Date.parse(parsed.breakSession.startedAt) - requestedAt.getTime()),
    ).toBeLessThan(1000);
    expect(parsed.breakSession.endedAt).toBe(parsed.breakSession.plannedEndsAt);
    expect(parsed.allowance.breaksTaken).toBe(1);
    expect(parsed.allowance.minutesUsed).toBe(15);
    expect(await countActivity(employee.id, "BREAK_STARTED")).toBe(1);
    expect(await countActivity(employee.id, "BREAK_EXPIRED")).toBe(1);
  });

  it("records a late request the current policy refuses as ENDED / POLICY_CHANGED, but refuses it live", async () => {
    const { headers, shift, employee } = await setup({ employeeTriggeredAllowed: false });

    const live = await start(headers, startBody(shift.id));
    expect(live.status).toBe(409);
    expect(live.body.error.code).toBe("EMPLOYEE_BREAKS_NOT_ALLOWED");
    expect(await prisma.breakSession.count({ where: { shiftId: shift.id } })).toBe(0);

    const requestedAt = new Date(Date.now() - 20 * MINUTE);
    const late = await start(
      headers,
      startBody(shift.id, requestedAt, { requestedDurationMinutes: 10 }),
    );
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    const parsed = mobileBreakResponseSchema.parse(late.body);
    expect(parsed.breakSession.status).toBe("ENDED");
    expect(parsed.breakSession.endReason).toBe("POLICY_CHANGED");
    expect(
      Math.abs(Date.parse(parsed.breakSession.startedAt) - requestedAt.getTime()),
    ).toBeLessThan(1000);
    expect(parsed.allowance.canStartNow).toBe(false);
    expect(await countActivity(employee.id, "BREAK_STARTED")).toBe(1);
    expect(await countActivity(employee.id, "BREAK_ENDED")).toBe(1);
    const started = await prisma.activityEvent.findFirstOrThrow({
      where: { employeeId: employee.id, type: "BREAK_STARTED" },
    });
    expect((started.metadata as { refusalCode?: string }).refusalCode).toBe(
      "EMPLOYEE_BREAKS_NOT_ALLOWED",
    );
  });

  it("rejects a request older than the reconciliation window", async () => {
    const { headers, shift } = await setup();
    const res = await start(headers, startBody(shift.id, new Date(Date.now() - 30 * HOUR)));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/mobile/v1/breaks/:id/end", () => {
  it("ends the employee's active break once, clamps the reported end and is idempotent", async () => {
    const { headers, shift, employee, org } = await setup();
    const started = mobileBreakResponseSchema.parse(
      (await start(headers, startBody(shift.id))).body,
    ).breakSession;

    // A reported end far in the future is clamped to the planned end / receive time.
    const res = await end(headers, started.id, {
      endedAt: new Date(Date.now() + 3 * HOUR).toISOString(),
      reason: "EMPLOYEE_ENDED",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const parsed = mobileBreakResponseSchema.parse(res.body);
    expect(parsed.breakSession.status).toBe("ENDED");
    expect(parsed.breakSession.endReason).toBe("EMPLOYEE_ENDED");
    expect(Date.parse(parsed.breakSession.endedAt!)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(Date.parse(parsed.breakSession.endedAt!)).toBeGreaterThanOrEqual(
      Date.parse(started.startedAt),
    );
    expect(await countActivity(employee.id, "BREAK_ENDED")).toBe(1);
    const workState = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(workState.activeBreakSessionId).toBeNull();
    expect(workState.expectedState).toBe("WORKING");

    const replay = await end(headers, started.id, {
      endedAt: new Date().toISOString(),
      reason: "EXPIRED",
    });
    expect(replay.status).toBe(200);
    const replayed = mobileBreakResponseSchema.parse(replay.body).breakSession;
    expect(replayed.endedAt).toBe(parsed.breakSession.endedAt);
    expect(replayed.endReason).toBe("EMPLOYEE_ENDED");
    expect(await countActivity(employee.id, "BREAK_ENDED")).toBe(1);

    // Another employee's (other organisation's) session: 404, never 403.
    const otherOrg = await createTestOrg();
    const other = await createTestDevice(otherOrg.organisation.id);
    const otherShift = await prisma.shift.create({
      data: {
        organisationId: otherOrg.organisation.id,
        employeeId: other.employee.id,
        startsAt: new Date(Date.now() - HOUR),
        endsAt: new Date(Date.now() + HOUR),
        timezone: "Europe/London",
      },
    });
    const foreignSession = await prisma.breakSession.create({
      data: {
        organisationId: otherOrg.organisation.id,
        employeeId: other.employee.id,
        shiftId: otherShift.id,
        startedAt: new Date(),
        plannedEndsAt: new Date(Date.now() + 10 * MINUTE),
        clientBreakId: randomUUID(),
      },
    });
    const foreign = await end(headers, foreignSession.id, {
      endedAt: new Date().toISOString(),
      reason: "EMPLOYEE_ENDED",
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("NOT_FOUND");
    expect(
      (await prisma.breakSession.findUniqueOrThrow({ where: { id: foreignSession.id } })).status,
    ).toBe("ACTIVE");
    expect(
      await prisma.breakSession.count({ where: { organisationId: org.organisation.id } }),
    ).toBe(1);

    const missing = await end(headers, randomUUID(), {
      endedAt: new Date().toISOString(),
      reason: "EMPLOYEE_ENDED",
    });
    expect(missing.status).toBe(404);
  });
});
