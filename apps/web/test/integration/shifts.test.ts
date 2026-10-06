import { randomUUID } from "node:crypto";
import { prisma } from "@workmode/db";
import {
  addLocalDays,
  buildShiftInstants,
  instantToLocal,
  localDateOf,
} from "@workmode/shared/time/time";
import {
  bulkShiftActionResponseSchema,
  createShiftResponseSchema,
  listShiftsResponseSchema,
  shiftResponseSchema,
  type BulkShiftActionResponse,
  type CreateShiftResponse,
  type ListShiftsResponse,
  type ShiftResponse,
} from "@workmode/validation/shifts";
import { describe, expect, it, vi } from "vitest";
import { POST as bulkRoute } from "@/app/api/shifts/bulk/route";
import { POST as cancelRoute } from "@/app/api/shifts/[id]/cancel/route";
import { POST as duplicateRoute } from "@/app/api/shifts/[id]/duplicate/route";
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/shifts/[id]/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/shifts/route";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { markCompletedShifts, materialiseRecurrences } from "@/server/shifts";
import { callRoute, createTestOrg, loginAs, type CookieJar, type ErrorBody } from "../helpers";

/**
 * Test seam (this file only): `afterFindShift` runs right after the service has read a shift through the
 * repository and before it writes it — where another manager's concurrent edit would land. Pass-through
 * when unset.
 */
const seam = vi.hoisted(() => ({ afterFindShift: null as null | (() => Promise<void>) }));
vi.mock("@/server/shifts/shifts.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/shifts/shifts.repository")>();
  return {
    ...actual,
    findShift: async (...args: Parameters<typeof actual.findShift>) => {
      const row = await actual.findShift(...args);
      if (seam.afterFindShift) await seam.afterFindShift();
      return row;
    },
  };
});

/**
 * Shift scheduling API: local-time and instant creation (overnight, DST), limits, overlaps, recurrence
 * materialisation, PATCH versioning, cancel / duplicate / delete, bulk actions, listing and the job hooks.
 * The organisation is Europe/London; fixed dates are in March 2027 (GMT until the 28th).
 */

const TZ = "Europe/London";
const MINUTE = 60_000;

async function setup() {
  const org = await createTestOrg({ firstLocationName: "High Street", timezone: TZ });
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  const organisationId = org.organisation.id;
  const employee = await prisma.employee.create({
    data: { organisationId, firstName: "Jane", lastName: "Smith", jobTitle: "Barista" },
  });
  const location = await prisma.location.findFirstOrThrow({ where: { organisationId } });
  return { org, jar, organisationId, employee, location };
}

async function create(jar: CookieJar, body: unknown, expectStatus = 201) {
  const res = await callRoute<CreateShiftResponse & ErrorBody>(createRoute, {
    method: "POST",
    path: "/api/shifts",
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
  if (expectStatus === 201) expect(() => createShiftResponseSchema.parse(res.body)).not.toThrow();
  return res.body;
}

async function createOne(jar: CookieJar, body: unknown) {
  const res = await create(jar, body);
  return res.shifts[0]!;
}

async function patch(jar: CookieJar, id: string, body: unknown, expectStatus = 200) {
  const res = await callRoute<ShiftResponse & ErrorBody>(patchRoute, {
    method: "PATCH",
    path: `/api/shifts/${id}`,
    params: { id },
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
  if (expectStatus === 200) expect(() => shiftResponseSchema.parse(res.body)).not.toThrow();
  return res.body;
}

async function get(jar: CookieJar, id: string) {
  return callRoute<ShiftResponse & ErrorBody>(getRoute, {
    path: `/api/shifts/${id}`,
    params: { id },
    jar,
  });
}

async function list(jar: CookieJar, query: Record<string, string> = {}, expectStatus = 200) {
  const res = await callRoute<ListShiftsResponse & ErrorBody>(listRoute, {
    path: "/api/shifts",
    query,
    jar,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
  if (expectStatus === 200) expect(() => listShiftsResponseSchema.parse(res.body)).not.toThrow();
  return res.body;
}

async function bulk(jar: CookieJar, body: unknown) {
  const res = await callRoute<BulkShiftActionResponse & ErrorBody>(bulkRoute, {
    method: "POST",
    path: "/api/shifts/bulk",
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(() => bulkShiftActionResponseSchema.parse(res.body)).not.toThrow();
  return res.body;
}

function collectEvents(organisationId: string, type: string) {
  const seen: RealtimeEvent[] = [];
  const unsubscribe = getEventBus().subscribe(organisationId, (e) => {
    if (e.type === type) seen.push(e);
  });
  return { seen, unsubscribe };
}

/** Local date of tomorrow in the organisation's timezone (series tests need dates inside the 8-week horizon). */
function tomorrowLocal(): string {
  return addLocalDays(localDateOf(new Date(), TZ), 1);
}

describe("shifts: create", () => {
  it("creates a shift from local times in the organisation timezone and returns display fields", async () => {
    const { jar, organisationId, employee, location } = await setup();
    const events = collectEvents(organisationId, "SCHEDULE_CHANGED");
    const res = await create(jar, {
      employeeId: employee.id,
      locationId: location.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
      notes: "Till training",
    });
    events.unsubscribe();
    expect(res.warnings).toEqual([]);
    expect(res.skippedOccurrences).toEqual([]);
    expect(res.shifts).toHaveLength(1);
    const shift = res.shifts[0]!;
    expect(shift).toMatchObject({
      startsAt: "2027-03-10T09:00:00.000Z",
      endsAt: "2027-03-10T17:00:00.000Z",
      timezone: TZ,
      durationMinutes: 480,
      status: "SCHEDULED",
      source: "MANUAL",
      notes: "Till training",
      recurrenceRule: null,
      parentRecurrenceId: null,
      version: 1,
      scheduledBreaks: [],
      isOvernight: false,
      localDate: "2027-03-10",
      localStartTime: "09:00",
      localEndTime: "17:00",
    });
    expect(shift.employee).toMatchObject({
      id: employee.id,
      firstName: "Jane",
      lastName: "Smith",
      jobTitle: "Barista",
    });
    expect(shift.location).toEqual({ id: location.id, name: "High Street" });
    expect(shift.displayRange).toContain("09:00");
    expect(shift.displayRange).toContain("17:00");

    const activity = await prisma.activityEvent.findFirst({
      where: { organisationId, type: "SHIFT_CREATED" },
    });
    expect(activity?.employeeId).toBe(employee.id);
    expect(activity?.actorType).toBe("MANAGER");
    expect(activity?.metadata).toMatchObject({
      shiftId: shift.id,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
    });
    expect(
      await prisma.auditLog.count({
        where: { organisationId, action: "shift.created", entityId: shift.id },
      }),
    ).toBe(1);
    expect(events.seen).toHaveLength(1);
    expect(events.seen[0]?.employeeId).toBe(employee.id);
    expect(events.seen[0]?.payload).toEqual({
      employeeId: employee.id,
      shiftIds: [shift.id],
      reason: "CREATED",
    });

    const fetched = await get(jar, shift.id);
    expect(fetched.status).toBe(200);
    expect(fetched.body.shift).toEqual(shift);
  });

  it("treats an end time at or before the start as an overnight shift", async () => {
    const { jar, employee } = await setup();
    const shift = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "22:00",
      endTime: "06:00",
    });
    expect(shift).toMatchObject({
      startsAt: "2027-03-10T22:00:00.000Z",
      endsAt: "2027-03-11T06:00:00.000Z",
      isOvernight: true,
      durationMinutes: 480,
      localDate: "2027-03-10",
      localEndTime: "06:00",
    });
    expect(shift.displayRange).toContain("(+1)");
  });

  it("shifts a nonexistent DST start time forward and reports it as a warning", async () => {
    const { jar, employee } = await setup();
    // Europe/London springs forward at 01:00 GMT on 28 March 2027: 01:30 does not exist.
    const res = await create(jar, {
      employeeId: employee.id,
      date: "2027-03-28",
      startTime: "01:30",
      endTime: "09:00",
    });
    expect(res.warnings.map((w) => w.code)).toEqual(["START_NONEXISTENT_LOCAL_TIME_SHIFTED"]);
    expect(res.warnings[0]?.message).toMatch(/clocks go forward/);
    expect(res.shifts[0]).toMatchObject({
      startsAt: "2027-03-28T01:30:00.000Z",
      localStartTime: "02:30",
      localEndTime: "09:00",
      durationMinutes: 390,
    });
  });

  it("takes the timezone from the request, then the location, then the organisation", async () => {
    const { jar, employee, location } = await setup();
    await prisma.location.update({
      where: { id: location.id },
      data: { timezone: "America/New_York" },
    });
    const viaLocation = await createOne(jar, {
      employeeId: employee.id,
      locationId: location.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
    });
    // 09:00 EST (UTC-5; US DST starts 14 March 2027) is 14:00Z.
    expect(viaLocation).toMatchObject({
      timezone: "America/New_York",
      startsAt: "2027-03-10T14:00:00.000Z",
    });
    const explicit = await createOne(jar, {
      employeeId: employee.id,
      locationId: location.id,
      timezone: "Asia/Tokyo",
      date: "2027-03-11",
      startTime: "09:00",
      endTime: "17:00",
    });
    expect(explicit).toMatchObject({
      timezone: "Asia/Tokyo",
      startsAt: "2027-03-11T00:00:00.000Z",
    });
    const instant = await createOne(jar, {
      employeeId: employee.id,
      startsAt: "2027-03-12T09:00:00+01:00",
      endsAt: "2027-03-12T17:00:00+01:00",
    });
    expect(instant).toMatchObject({
      timezone: TZ,
      startsAt: "2027-03-12T08:00:00.000Z",
      localStartTime: "08:00",
    });
  });

  it("enforces the 15-minute minimum (SHIFT_TOO_SHORT) and the 24-hour maximum", async () => {
    const { jar, employee } = await setup();
    const short = await create(
      jar,
      { employeeId: employee.id, date: "2027-03-10", startTime: "09:00", endTime: "09:10" },
      400,
    );
    expect(short.error.code).toBe("SHIFT_TOO_SHORT");
    expect(short.error.details).toMatchObject({ durationMinutes: 10, minDurationMinutes: 15 });
    const long = await create(
      jar,
      { employeeId: employee.id, startsAt: "2027-03-10T09:00:00Z", endsAt: "2027-03-11T10:00:00Z" },
      400,
    );
    expect(long.error.code).toBe("VALIDATION_ERROR");
    expect(long.error.details).toMatchObject({ reason: "SHIFT_TOO_LONG" });
    // The local-time contract refuses equal times (ambiguous: 0 h or 24 h); a 24-hour shift uses instants.
    const equal = await create(
      jar,
      { employeeId: employee.id, date: "2027-03-10", startTime: "09:00", endTime: "09:00" },
      400,
    );
    expect(equal.error.code).toBe("VALIDATION_ERROR");
    expect(equal.error.details).toMatchObject({ fieldErrors: { endTime: expect.any(Array) } });
    const full = await createOne(jar, {
      employeeId: employee.id,
      startsAt: "2027-03-10T09:00:00Z",
      endsAt: "2027-03-11T09:00:00Z",
    });
    expect(full.durationMinutes).toBe(1440);
    expect(await prisma.shift.count({ where: { employeeId: employee.id } })).toBe(1);
  });

  it("rejects overlapping shifts for the employee but allows adjacent ones and allowOverlap", async () => {
    const { jar, employee } = await setup();
    const existing = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
    });
    const overlap = await create(
      jar,
      { employeeId: employee.id, date: "2027-03-10", startTime: "16:00", endTime: "20:00" },
      409,
    );
    expect(overlap.error.code).toBe("SHIFT_OVERLAP");
    expect(overlap.error.details).toEqual({ conflictingShiftIds: [existing.id] });
    const adjacent = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "17:00",
      endTime: "21:00",
    });
    expect(adjacent.startsAt).toBe(existing.endsAt);
    const forced = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "16:00",
      endTime: "18:00",
      allowOverlap: true,
    });
    expect(forced.status).toBe("SCHEDULED");
    // Cancelled shifts no longer block the slot.
    await callRoute(cancelRoute, {
      method: "POST",
      path: `/api/shifts/${existing.id}/cancel`,
      params: { id: existing.id },
      jar,
      body: {},
    });
    await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "12:00",
    });
    expect(await prisma.shift.count({ where: { employeeId: employee.id } })).toBe(4);
  });

  it("requires an active employee of the organisation and a location of the organisation", async () => {
    const { jar, organisationId, employee } = await setup();
    await prisma.employee.update({
      where: { id: employee.id },
      data: { employmentStatus: "INACTIVE" },
    });
    const inactive = await create(
      jar,
      { employeeId: employee.id, date: "2027-03-10", startTime: "09:00", endTime: "17:00" },
      409,
    );
    expect(inactive.error.code).toBe("EMPLOYEE_INACTIVE");
    const missing = await create(
      jar,
      { employeeId: randomUUID(), date: "2027-03-10", startTime: "09:00", endTime: "17:00" },
      404,
    );
    expect(missing.error.code).toBe("EMPLOYEE_NOT_FOUND");
    const active = await prisma.employee.create({
      data: { organisationId, firstName: "Sam", lastName: "Lee" },
    });
    const noLocation = await create(
      jar,
      {
        employeeId: active.id,
        locationId: randomUUID(),
        date: "2027-03-10",
        startTime: "09:00",
        endTime: "17:00",
      },
      404,
    );
    expect(noLocation.error.code).toBe("NOT_FOUND");
    expect(await prisma.shift.count({ where: { organisationId } })).toBe(0);
  });

  it("validates request bodies and scheduled breaks", async () => {
    const { jar, employee } = await setup();
    const mixed = await create(
      jar,
      {
        employeeId: employee.id,
        date: "2027-03-10",
        startTime: "09:00",
        endTime: "17:00",
        startsAt: "2027-03-10T09:00:00Z",
      },
      400,
    );
    expect(mixed.error.code).toBe("VALIDATION_ERROR");
    const outside = await create(
      jar,
      {
        employeeId: employee.id,
        date: "2027-03-10",
        startTime: "09:00",
        endTime: "17:00",
        scheduledBreaks: [{ offsetMinutesFromStart: 470, durationMinutes: 30 }],
      },
      400,
    );
    expect(outside.error.details).toMatchObject({ reason: "SCHEDULED_BREAK_OUTSIDE_SHIFT" });
    const overlapping = await create(
      jar,
      {
        employeeId: employee.id,
        date: "2027-03-10",
        startTime: "09:00",
        endTime: "17:00",
        scheduledBreaks: [
          { offsetMinutesFromStart: 120, durationMinutes: 30 },
          { offsetMinutesFromStart: 140, durationMinutes: 15 },
        ],
      },
      400,
    );
    expect(overlapping.error.details).toMatchObject({ reason: "SCHEDULED_BREAKS_OVERLAP" });
    const ok = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
      scheduledBreaks: [
        { offsetMinutesFromStart: 300, durationMinutes: 15 },
        { offsetMinutesFromStart: 120, durationMinutes: 30 },
      ],
    });
    // Sorted by offset.
    expect(ok.scheduledBreaks.map((b) => [b.offsetMinutesFromStart, b.durationMinutes])).toEqual([
      [120, 30],
      [300, 15],
    ]);
  });
});

describe("shifts: recurrence", () => {
  it("materialises occurrences up to 8 weeks, skips conflicts, and the job tops up idempotently", async () => {
    const { jar, organisationId, employee } = await setup();
    const first = tomorrowLocal();
    const until = addLocalDays(first, 84); // 13 weekly occurrences in total
    const clash = buildShiftInstants({
      date: addLocalDays(first, 14),
      startTime: "10:00",
      endTime: "14:00",
      timezone: TZ,
    });
    const conflicting = await prisma.shift.create({
      data: {
        organisationId,
        employeeId: employee.id,
        startsAt: clash.startsAt,
        endsAt: clash.endsAt,
        timezone: TZ,
      },
    });

    const res = await create(jar, {
      employeeId: employee.id,
      date: first,
      startTime: "10:00",
      endTime: "14:00",
      recurrence: { rule: "FREQ=WEEKLY", until },
    });
    // 8 occurrences start inside the 56-day horizon; the third collides with the existing shift.
    expect(res.shifts).toHaveLength(7);
    expect(res.skippedOccurrences).toHaveLength(1);
    expect(res.skippedOccurrences[0]).toMatchObject({
      startsAt: clash.startsAt.toISOString(),
      endsAt: clash.endsAt.toISOString(),
      conflictingShiftIds: [conflicting.id],
    });
    const anchor = res.shifts[0]!;
    expect(anchor.localDate).toBe(first);
    expect(anchor.recurrenceRule).toMatch(/FREQ=WEEKLY/);
    expect(anchor.recurrenceRule).toMatch(/COUNT=13/);
    expect(anchor.parentRecurrenceId).toBeNull();
    for (const child of res.shifts.slice(1)) {
      expect(child.parentRecurrenceId).toBe(anchor.id);
      expect(child.recurrenceRule).toBeNull();
      expect(child.localStartTime).toBe("10:00");
      expect(child.localEndTime).toBe("14:00");
    }
    expect(res.shifts.map((s) => s.localDate)).toEqual(
      [0, 1, 3, 4, 5, 6, 7].map((k) => addLocalDays(first, 7 * k)),
    );
    expect(
      await prisma.activityEvent.count({ where: { organisationId, type: "SHIFT_CREATED" } }),
    ).toBe(7);

    // The job creates the remaining occurrences once, never twice, and never re-creates the skipped one.
    const events = collectEvents(organisationId, "SCHEDULE_CHANGED");
    const first_run = await materialiseRecurrences(organisationId, 120);
    expect(first_run).toMatchObject({ seriesProcessed: 1, created: 5, skipped: 0, failed: 0 });
    const second_run = await materialiseRecurrences(organisationId, 120);
    expect(second_run).toMatchObject({ seriesProcessed: 1, created: 0, skipped: 0, failed: 0 });
    events.unsubscribe();
    expect(events.seen).toHaveLength(1);
    expect((events.seen[0]?.payload as { reason: string; shiftIds: string[] }).reason).toBe(
      "MATERIALISED",
    );
    expect((events.seen[0]?.payload as { shiftIds: string[] }).shiftIds).toHaveLength(5);

    const series = await prisma.shift.findMany({
      where: { OR: [{ id: anchor.id }, { parentRecurrenceId: anchor.id }] },
      orderBy: { startsAt: "asc" },
    });
    expect(series).toHaveLength(12);
    expect(series.map((s) => localDateOf(s.startsAt, TZ))).toEqual(
      [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((k) => addLocalDays(first, 7 * k)),
    );
    expect(series.every((s) => instantToLocal(s.startsAt, TZ).time === "10:00")).toBe(true);
    expect(series.slice(7).every((s) => s.source === "MANUAL" && s.status === "SCHEDULED")).toBe(
      true,
    );
    // The seam form (`materialiseRecurrences(now)`) also works.
    expect(await materialiseRecurrences(new Date())).toMatchObject({ created: 0, failed: 0 });
  });

  it("rejects an invalid or empty series", async () => {
    const { jar, employee } = await setup();
    const before = await create(
      jar,
      {
        employeeId: employee.id,
        date: "2027-03-10",
        startTime: "09:00",
        endTime: "17:00",
        recurrence: { rule: "FREQ=WEEKLY", until: "2027-03-01" },
      },
      400,
    );
    expect(before.error.code).toBe("INVALID_RECURRENCE");
    const bad = await create(
      jar,
      {
        employeeId: employee.id,
        date: "2027-03-10",
        startTime: "09:00",
        endTime: "17:00",
        recurrence: { rule: "FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=31", until: "2027-12-31" },
      },
      400,
    );
    expect(bad.error.code).toBe("INVALID_RECURRENCE");
  });

  it("applies THIS_AND_FUTURE edits to the later occurrences only, splitting the series", async () => {
    const { jar, employee } = await setup();
    const first = tomorrowLocal();
    const res = await create(jar, {
      employeeId: employee.id,
      date: first,
      startTime: "10:00",
      endTime: "14:00",
      recurrence: { rule: "FREQ=WEEKLY", until: addLocalDays(first, 21) },
    });
    expect(res.shifts).toHaveLength(4);
    const [anchor, second, third, fourth] = res.shifts as [
      (typeof res.shifts)[0],
      (typeof res.shifts)[0],
      (typeof res.shifts)[0],
      (typeof res.shifts)[0],
    ];

    const only = await patch(jar, third.id, { notes: "Just this one" });
    expect(only.shift.notes).toBe("Just this one");
    expect((await get(jar, fourth.id)).body.shift.notes).toBeNull();

    const edited = await patch(jar, second.id, {
      startTime: "11:00",
      endTime: "15:00",
      applyTo: "THIS_AND_FUTURE",
    });
    expect(edited.shift).toMatchObject({
      localStartTime: "11:00",
      localEndTime: "15:00",
      version: 2,
      parentRecurrenceId: null,
    });
    expect(edited.shift.recurrenceRule).toMatch(/COUNT=3/);

    const rows = await prisma.shift.findMany({
      where: { employeeId: employee.id },
      orderBy: { startsAt: "asc" },
    });
    expect(rows.map((r) => instantToLocal(r.startsAt, TZ).time)).toEqual([
      "10:00",
      "11:00",
      "11:00",
      "11:00",
    ]);
    expect(rows[0]?.id).toBe(anchor.id);
    expect(rows[0]?.recurrenceRule).toMatch(/COUNT=1/);
    expect(rows[0]?.version).toBe(1);
    expect(rows[2]?.parentRecurrenceId).toBe(second.id);
    expect(rows[3]?.parentRecurrenceId).toBe(second.id);
    expect(rows[2]?.notes).toBe("Just this one");
    expect(rows.slice(1).every((r) => r.version === 2 || r.id === third.id)).toBe(true);
    expect(rows[2]?.version).toBe(3);
  });
});

describe("shifts: update, cancel, duplicate, delete", () => {
  it("bumps the version on PATCH, records SHIFT_UPDATED and enforces expectedVersion", async () => {
    const { jar, organisationId, employee } = await setup();
    const shift = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
    });
    const events = collectEvents(organisationId, "SCHEDULE_CHANGED");
    const updated = await patch(jar, shift.id, { endTime: "18:00", expectedVersion: 1 });
    events.unsubscribe();
    expect(updated.shift).toMatchObject({
      version: 2,
      endsAt: "2027-03-10T18:00:00.000Z",
      localEndTime: "18:00",
      durationMinutes: 540,
    });
    expect(updated.warnings).toBeUndefined();
    expect(events.seen.map((e) => (e.payload as { reason: string }).reason)).toEqual(["UPDATED"]);

    const stale = await patch(jar, shift.id, { notes: "late", expectedVersion: 1 }, 409);
    expect(stale.error.code).toBe("CONFLICT");
    expect(stale.error.details).toEqual({ currentVersion: 2 });

    const activity = await prisma.activityEvent.findFirst({
      where: { organisationId, type: "SHIFT_UPDATED" },
    });
    expect(activity?.metadata).toMatchObject({
      shiftId: shift.id,
      version: 2,
      changedFields: ["endTime"],
    });
    expect(
      await prisma.auditLog.count({
        where: { organisationId, action: "shift.updated", entityId: shift.id },
      }),
    ).toBe(1);

    const mixed = await patch(
      jar,
      shift.id,
      { endTime: "19:00", endsAt: "2027-03-10T19:00:00Z" },
      400,
    );
    expect(mixed.error.code).toBe("VALIDATION_ERROR");
    const other = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "19:00",
      endTime: "21:00",
    });
    const collide = await patch(jar, shift.id, { endTime: "20:00" }, 409);
    expect(collide.error.code).toBe("SHIFT_OVERLAP");
    expect(collide.error.details).toEqual({ conflictingShiftIds: [other.id] });
    const dst = await patch(jar, shift.id, {
      date: "2027-03-28",
      startTime: "01:30",
      endTime: "08:00",
    });
    expect(dst.warnings?.map((w) => w.code)).toEqual(["START_NONEXISTENT_LOCAL_TIME_SHIFTED"]);
  });

  it("ends the active break when an in-progress shift is shortened to end earlier", async () => {
    const { jar, organisationId, employee } = await setup();
    const now = Date.now();
    const shift = await createOne(jar, {
      employeeId: employee.id,
      startsAt: new Date(now - 60 * MINUTE).toISOString(),
      endsAt: new Date(now + 180 * MINUTE).toISOString(),
    });
    const session = await prisma.breakSession.create({
      data: {
        organisationId,
        employeeId: employee.id,
        shiftId: shift.id,
        startedAt: new Date(now - 10 * MINUTE),
        plannedEndsAt: new Date(now + 5 * MINUTE),
        clientBreakId: randomUUID(),
      },
    });
    const newEnd = new Date(now - 5 * MINUTE);
    const updated = await patch(jar, shift.id, { endsAt: newEnd.toISOString() });
    expect(updated.shift.endsAt).toBe(newEnd.toISOString());
    const ended = await prisma.breakSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(ended.status).toBe("ENDED");
    expect(ended.endReason).toBe("SHIFT_ENDED");
    expect(ended.endedAt?.toISOString()).toBe(newEnd.toISOString());
    const activity = await prisma.activityEvent.findFirst({
      where: { organisationId, type: "BREAK_ENDED" },
    });
    expect(activity?.metadata).toMatchObject({
      breakSessionId: session.id,
      shiftId: shift.id,
      endReason: "SHIFT_ENDED",
    });
  });

  it("cancels a shift once, recording SHIFT_CANCELLED", async () => {
    const { jar, organisationId, employee } = await setup();
    const shift = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
    });
    const events = collectEvents(organisationId, "SCHEDULE_CHANGED");
    const res = await callRoute<ShiftResponse & ErrorBody>(cancelRoute, {
      method: "POST",
      path: `/api/shifts/${shift.id}/cancel`,
      params: { id: shift.id },
      jar,
      body: { reason: "Store closed" },
    });
    events.unsubscribe();
    expect(res.status).toBe(200);
    expect(res.body.shift).toMatchObject({ status: "CANCELLED", version: 2 });
    expect(events.seen.map((e) => (e.payload as { reason: string }).reason)).toEqual(["CANCELLED"]);
    expect(
      await prisma.activityEvent.count({ where: { organisationId, type: "SHIFT_CANCELLED" } }),
    ).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { organisationId, action: "shift.cancelled" },
    });
    expect(audit.after).toMatchObject({ status: "CANCELLED", reason: "Store closed" });

    const again = await callRoute<ErrorBody>(cancelRoute, {
      method: "POST",
      path: `/api/shifts/${shift.id}/cancel`,
      params: { id: shift.id },
      jar,
      body: {},
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CONFLICT");
    // Cancelled shifts cannot be rescheduled (duplicate them instead); their notes can still be edited.
    const move = await patch(jar, shift.id, { startTime: "10:00" }, 409);
    expect(move.error.code).toBe("CONFLICT");
    expect(move.error.details).toEqual({ status: "CANCELLED" });
    const noted = await patch(jar, shift.id, { notes: "Reopened next week" });
    expect(noted.shift).toMatchObject({
      status: "CANCELLED",
      notes: "Reopened next week",
      version: 3,
      localStartTime: "09:00",
    });
    // Completed shifts neither: moved into the future they would stay COMPLETED and never activate.
    const done = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-11",
      startTime: "09:00",
      endTime: "17:00",
    });
    await prisma.shift.update({ where: { id: done.id }, data: { status: "COMPLETED" } });
    const moveDone = await patch(jar, done.id, { date: "2027-03-18" }, 409);
    expect(moveDone.error.code).toBe("CONFLICT");
    const cancelDone = await callRoute<ErrorBody>(cancelRoute, {
      method: "POST",
      path: `/api/shifts/${done.id}/cancel`,
      params: { id: done.id },
      jar,
      body: {},
    });
    expect(cancelDone.status).toBe(409);
  });

  it("refuses a write that races a concurrent change, even without expectedVersion", async () => {
    const { jar, employee } = await setup();
    const shift = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
    });
    // Another manager's edit lands between this request reading the shift and writing it: the write
    // inside the transaction is conditioned on the version that was read, so it must not overwrite.
    seam.afterFindShift = async () => {
      seam.afterFindShift = null;
      await prisma.shift.update({
        where: { id: shift.id },
        data: { notes: "Edited meanwhile", version: { increment: 1 } },
      });
    };
    try {
      const lost = await patch(jar, shift.id, { endTime: "18:00" }, 409);
      expect(lost.error.code).toBe("CONFLICT");
      expect(lost.error.details).toEqual({ currentVersion: 2 });
    } finally {
      seam.afterFindShift = null;
    }
    const row = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(row.notes).toBe("Edited meanwhile");
    expect(row.endsAt.toISOString()).toBe("2027-03-10T17:00:00.000Z");
    expect(row.version).toBe(2);
    // With the right version the edit goes through.
    const ok = await patch(jar, shift.id, { endTime: "18:00", expectedVersion: 2 });
    expect(ok.shift).toMatchObject({
      version: 3,
      localEndTime: "18:00",
      notes: "Edited meanwhile",
    });
  });

  it("duplicates a shift to another date with the same local times and breaks", async () => {
    const { jar, employee, location } = await setup();
    const source = await createOne(jar, {
      employeeId: employee.id,
      locationId: location.id,
      date: "2027-03-10",
      startTime: "22:00",
      endTime: "06:00",
      notes: "Night",
      scheduledBreaks: [{ offsetMinutesFromStart: 240, durationMinutes: 30 }],
    });
    const res = await callRoute<ShiftResponse & ErrorBody>(duplicateRoute, {
      method: "POST",
      path: `/api/shifts/${source.id}/duplicate`,
      params: { id: source.id },
      jar,
      body: { date: "2027-03-12" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.shift).toMatchObject({
      localDate: "2027-03-12",
      localStartTime: "22:00",
      localEndTime: "06:00",
      startsAt: "2027-03-12T22:00:00.000Z",
      endsAt: "2027-03-13T06:00:00.000Z",
      notes: "Night",
      version: 1,
      parentRecurrenceId: null,
    });
    expect(res.body.shift.location?.id).toBe(location.id);
    expect(res.body.shift.scheduledBreaks.map((b) => b.offsetMinutesFromStart)).toEqual([240]);
    const clash = await callRoute<ErrorBody>(duplicateRoute, {
      method: "POST",
      path: `/api/shifts/${source.id}/duplicate`,
      params: { id: source.id },
      jar,
      body: { date: "2027-03-10" },
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("SHIFT_OVERLAP");
  });

  it("soft-deletes a shift", async () => {
    const { jar, organisationId, employee } = await setup();
    const shift = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
    });
    const events = collectEvents(organisationId, "SCHEDULE_CHANGED");
    const res = await callRoute(deleteRoute, {
      method: "DELETE",
      path: `/api/shifts/${shift.id}`,
      params: { id: shift.id },
      jar,
    });
    events.unsubscribe();
    expect(res.status).toBe(204);
    expect((await get(jar, shift.id)).status).toBe(404);
    const row = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(events.seen.map((e) => (e.payload as { reason: string }).reason)).toEqual(["DELETED"]);
    expect(
      await prisma.auditLog.count({
        where: { organisationId, action: "shift.deleted", entityId: shift.id },
      }),
    ).toBe(1);
    // The slot is free again.
    await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
    });
  });
});

describe("shifts: bulk", () => {
  it("cancels, moves, repeats and deletes with per-item results", async () => {
    const { jar, organisationId, employee } = await setup();
    const s1 = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
    });
    const s2 = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-11",
      startTime: "09:00",
      endTime: "17:00",
    });
    const unknown = randomUUID();
    const cancelled = await bulk(jar, {
      action: "CANCEL",
      shiftIds: [s1.id, s2.id, unknown],
      payload: { reason: "Closed" },
    });
    expect(cancelled).toMatchObject({ action: "CANCEL", processed: 2, succeeded: 2 });
    expect(cancelled.failed).toEqual([
      { shiftId: unknown, code: "NOT_FOUND", message: expect.any(String) },
    ]);
    expect(cancelled.shifts.map((s) => s.status)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(
      await prisma.activityEvent.count({ where: { organisationId, type: "SHIFT_CANCELLED" } }),
    ).toBe(2);

    const s3 = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-12",
      startTime: "09:00",
      endTime: "17:00",
    });
    const s4 = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-13",
      startTime: "09:00",
      endTime: "17:00",
    });
    const blocked = await bulk(jar, {
      action: "MOVE",
      shiftIds: [s3.id],
      payload: { deltaDays: 1 },
    });
    expect(blocked).toMatchObject({ action: "MOVE", processed: 1, succeeded: 0 });
    expect(blocked.failed[0]).toMatchObject({ shiftId: s3.id, code: "SHIFT_OVERLAP" });
    const moved = await bulk(jar, {
      action: "MOVE",
      shiftIds: [s3.id],
      payload: { deltaDays: 5, deltaMinutes: 30 },
    });
    expect(moved).toMatchObject({ action: "MOVE", processed: 1, succeeded: 1, failed: [] });
    expect(moved.shifts[0]).toMatchObject({
      id: s3.id,
      localDate: "2027-03-17",
      localStartTime: "09:30",
      localEndTime: "17:30",
      version: 2,
    });
    const cannotMoveCancelled = await bulk(jar, {
      action: "MOVE",
      shiftIds: [s1.id],
      payload: { deltaDays: 30 },
    });
    expect(cannotMoveCancelled.failed[0]).toMatchObject({ shiftId: s1.id, code: "CONFLICT" });

    const repeated = await bulk(jar, {
      action: "REPEAT",
      shiftIds: [s4.id],
      payload: { weeks: 2 },
    });
    expect(repeated).toMatchObject({ action: "REPEAT", processed: 1, succeeded: 1, failed: [] });
    expect(repeated.shifts.map((s) => s.localDate)).toEqual(["2027-03-20", "2027-03-27"]);
    expect(
      repeated.shifts.every((s) => s.localStartTime === "09:00" && s.employee.id === employee.id),
    ).toBe(true);
    // Repeating again collides with the copies just made.
    const collide = await bulk(jar, { action: "REPEAT", shiftIds: [s4.id], payload: { weeks: 1 } });
    expect(collide.failed[0]).toMatchObject({ shiftId: s4.id, code: "SHIFT_OVERLAP" });

    const deleted = await bulk(jar, { action: "DELETE", shiftIds: [s3.id, unknown] });
    expect(deleted).toMatchObject({ action: "DELETE", processed: 1, succeeded: 1, shifts: [] });
    expect(deleted.failed).toHaveLength(1);
    expect((await get(jar, s3.id)).status).toBe(404);
    // One audit entry per bulk request (seven above), including the ones where every item failed: the
    // attempt and its per-item failures are part of the trail.
    expect(
      await prisma.auditLog.count({
        where: { organisationId, action: { startsWith: "shift.bulk_" } },
      }),
    ).toBe(7);
  });
});

describe("shifts: list and jobs", () => {
  it("lists shifts in a window with filters and defaults to the current week", async () => {
    const { jar, organisationId, employee } = await setup();
    const other = await prisma.employee.create({
      data: { organisationId, firstName: "Sam", lastName: "Lee" },
    });
    const today = localDateOf(new Date(), TZ);
    const thisWeek = await createOne(jar, {
      employeeId: employee.id,
      date: today,
      startTime: "10:00",
      endTime: "11:00",
    });
    const a = await createOne(jar, {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
    });
    const b = await createOne(jar, {
      employeeId: other.id,
      date: "2027-03-11",
      startTime: "09:00",
      endTime: "17:00",
    });

    const defaults = await list(jar);
    expect(defaults.shifts.map((s) => s.id)).toEqual([thisWeek.id]);

    const march = await list(jar, { from: "2027-03-01T00:00:00Z", to: "2027-03-31T00:00:00Z" });
    expect(march.shifts.map((s) => s.id)).toEqual([a.id, b.id]);
    const mine = await list(jar, {
      from: "2027-03-01T00:00:00Z",
      to: "2027-03-31T00:00:00Z",
      employeeId: employee.id,
    });
    expect(mine.shifts.map((s) => s.id)).toEqual([a.id]);
    // The window is half-open: a shift ending exactly at `from` is excluded, one starting before `to` is included.
    const edge = await list(jar, { from: "2027-03-10T17:00:00Z", to: "2027-03-11T09:30:00Z" });
    expect(edge.shifts.map((s) => s.id)).toEqual([b.id]);

    await callRoute(cancelRoute, {
      method: "POST",
      path: `/api/shifts/${a.id}/cancel`,
      params: { id: a.id },
      jar,
      body: {},
    });
    const cancelled = await list(jar, {
      from: "2027-03-01T00:00:00Z",
      to: "2027-03-31T00:00:00Z",
      status: "CANCELLED",
    });
    expect(cancelled.shifts.map((s) => s.id)).toEqual([a.id]);
    const scheduled = await list(jar, {
      from: "2027-03-01T00:00:00Z",
      to: "2027-03-31T00:00:00Z",
      status: "SCHEDULED",
    });
    expect(scheduled.shifts.map((s) => s.id)).toEqual([b.id]);

    const tooWide = await list(
      jar,
      { from: "2027-01-01T00:00:00Z", to: "2027-06-01T00:00:00Z" },
      400,
    );
    expect(tooWide.error.code).toBe("VALIDATION_ERROR");

    // Another organisation's employee id filters to nothing (never to their shifts).
    const foreign = await createTestOrg();
    const foreignEmployee = await prisma.employee.create({
      data: { organisationId: foreign.organisation.id, firstName: "Far", lastName: "Away" },
    });
    await prisma.shift.create({
      data: {
        organisationId: foreign.organisation.id,
        employeeId: foreignEmployee.id,
        startsAt: new Date("2027-03-10T09:00:00Z"),
        endsAt: new Date("2027-03-10T17:00:00Z"),
        timezone: TZ,
      },
    });
    const none = await list(jar, {
      from: "2027-03-01T00:00:00Z",
      to: "2027-03-31T00:00:00Z",
      employeeId: foreignEmployee.id,
    });
    expect(none.shifts).toEqual([]);
  });

  it("markCompletedShifts completes scheduled shifts that have ended", async () => {
    const { organisationId, employee } = await setup();
    const now = Date.now();
    const past = await prisma.shift.create({
      data: {
        organisationId,
        employeeId: employee.id,
        startsAt: new Date(now - 180 * MINUTE),
        endsAt: new Date(now - 60 * MINUTE),
        timezone: TZ,
      },
    });
    const future = await prisma.shift.create({
      data: {
        organisationId,
        employeeId: employee.id,
        startsAt: new Date(now + 60 * MINUTE),
        endsAt: new Date(now + 180 * MINUTE),
        timezone: TZ,
      },
    });
    expect(await markCompletedShifts(new Date(now))).toBeGreaterThanOrEqual(1);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: past.id } })).status).toBe(
      "COMPLETED",
    );
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: future.id } })).status).toBe(
      "SCHEDULED",
    );
    expect(await markCompletedShifts(new Date(now))).toBe(0);
  });

  it("requires a signed-in manager and a CSRF token", async () => {
    const { jar, organisationId, employee } = await setup();
    const body = {
      employeeId: employee.id,
      date: "2027-03-10",
      startTime: "09:00",
      endTime: "17:00",
    };
    const anonymous = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/shifts",
      body,
    });
    expect(anonymous.status).toBe(401);
    const noCsrf = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/shifts",
      jar,
      body,
      csrf: false,
    });
    expect(noCsrf.status).toBe(403);
    const listAnon = await callRoute<ErrorBody>(listRoute, { path: "/api/shifts" });
    expect(listAnon.status).toBe(401);
    expect(await prisma.shift.count({ where: { organisationId } })).toBe(0);
  });
});
