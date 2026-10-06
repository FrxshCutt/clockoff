import { prisma } from "@workmode/db";
import { listActivityResponseSchema } from "@workmode/validation/activity";
import { describe, expect, it } from "vitest";
import { GET as activityRoute } from "@/app/api/activity/route";
import { recordActivity } from "@/server/activity/recordActivity";
import { callRoute, createTestDevice, createTestOrg, loginAs, type ErrorBody } from "../helpers";

const MINUTE = 60_000;

describe("GET /api/activity", () => {
  it("pages newest first with an opaque cursor, filters, and never shows another tenant's events", async () => {
    const org = await createTestOrg({ firstLocationName: "Kitchen" });
    const organisationId = org.organisation.id;
    const location = await prisma.location.findFirstOrThrow({ where: { organisationId } });
    const a = await createTestDevice(organisationId);
    const b = await createTestDevice(organisationId);
    await prisma.employee.update({
      where: { id: a.employee.id },
      data: { firstName: "Ann", lastName: "Alpha", primaryLocationId: location.id },
    });
    const base = Date.now() - 60 * MINUTE;
    const types = ["WORK_MODE_STARTED", "BREAK_STARTED", "BREAK_ENDED", "WORK_MODE_ENDED", "SCHEDULE_SYNCED"] as const;
    for (const [i, type] of types.entries()) {
      await recordActivity({
        organisationId,
        employeeId: i % 2 === 0 ? a.employee.id : b.employee.id,
        deviceId: i % 2 === 0 ? a.device.id : b.device.id,
        actorType: "EMPLOYEE_DEVICE",
        type,
        occurredAt: new Date(base + i * MINUTE),
        metadata: { index: i },
      });
    }
    await recordActivity({
      organisationId,
      actorType: "MANAGER",
      actorUserId: org.owner.id,
      type: "POLICY_UPDATED",
      occurredAt: new Date(base + 10 * MINUTE),
      metadata: { policyId: "p" },
    });
    const other = await createTestOrg();
    const foreign = await createTestDevice(other.organisation.id);
    await recordActivity({
      organisationId: other.organisation.id,
      employeeId: foreign.employee.id,
      actorType: "SYSTEM",
      type: "DEVICE_SYNC_DELAYED",
      occurredAt: new Date(base + 20 * MINUTE),
    });
    const jar = await loginAs(org.owner, { organisationId });

    const first = await callRoute(activityRoute, { path: "/api/activity", query: { limit: 2 }, jar });
    expect(first.status).toBe(200);
    const page1 = listActivityResponseSchema.parse(first.body);
    expect(page1.items.map((e) => e.type)).toEqual(["POLICY_UPDATED", "SCHEDULE_SYNCED"]);
    expect(page1.items[0]!.actor?.id).toBe(org.owner.id);
    expect(page1.items[0]!.employee).toBeNull();
    expect(page1.items[0]!.summary).toContain("Work Policy");
    expect(page1.items[1]!.employee?.firstName).toBe("Ann");
    expect(page1.items[1]!.deviceId).toBe(a.device.id);
    expect(page1.items[1]!.metadata).toEqual({ index: 4 });
    expect(page1.nextCursor).not.toBeNull();

    const page2 = listActivityResponseSchema.parse(
      (await callRoute(activityRoute, { path: "/api/activity", query: { limit: 2, cursor: page1.nextCursor! }, jar })).body,
    );
    expect(page2.items.map((e) => e.type)).toEqual(["WORK_MODE_ENDED", "BREAK_ENDED"]);
    const page3 = listActivityResponseSchema.parse(
      (await callRoute(activityRoute, { path: "/api/activity", query: { limit: 2, cursor: page2.nextCursor! }, jar })).body,
    );
    expect(page3.items.map((e) => e.type)).toEqual(["BREAK_STARTED", "WORK_MODE_STARTED"]);
    expect(page3.nextCursor).toBeNull();

    const byEmployee = listActivityResponseSchema.parse(
      (await callRoute(activityRoute, { path: "/api/activity", query: { employeeId: b.employee.id }, jar })).body,
    );
    expect(byEmployee.items.map((e) => e.type)).toEqual(["WORK_MODE_ENDED", "BREAK_STARTED"]);

    const byType = listActivityResponseSchema.parse(
      (await callRoute(activityRoute, { path: "/api/activity", query: { type: "BREAK_STARTED,BREAK_ENDED" }, jar })).body,
    );
    expect(byType.items.map((e) => e.type)).toEqual(["BREAK_ENDED", "BREAK_STARTED"]);

    const byLocation = listActivityResponseSchema.parse(
      (await callRoute(activityRoute, { path: "/api/activity", query: { locationId: location.id }, jar })).body,
    );
    expect(byLocation.items.every((e) => e.employee?.id === a.employee.id)).toBe(true);
    expect(byLocation.items).toHaveLength(3);

    const byRange = listActivityResponseSchema.parse(
      (
        await callRoute(activityRoute, {
          path: "/api/activity",
          query: { from: new Date(base + MINUTE).toISOString(), to: new Date(base + 2 * MINUTE).toISOString() },
          jar,
        })
      ).body,
    );
    expect(byRange.items.map((e) => e.type)).toEqual(["BREAK_ENDED", "BREAK_STARTED"]);

    const foreignEmployee = listActivityResponseSchema.parse(
      (await callRoute(activityRoute, { path: "/api/activity", query: { employeeId: foreign.employee.id }, jar })).body,
    );
    expect(foreignEmployee.items).toEqual([]);
    const all = listActivityResponseSchema.parse((await callRoute(activityRoute, { path: "/api/activity", jar })).body);
    expect(all.items.some((e) => e.type === "DEVICE_SYNC_DELAYED")).toBe(false);

    const badCursor = await callRoute<ErrorBody>(activityRoute, { path: "/api/activity", query: { cursor: "nope" }, jar });
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.code).toBe("VALIDATION_ERROR");

    const badRange = await callRoute<ErrorBody>(activityRoute, {
      path: "/api/activity",
      query: { from: new Date(base + 2 * MINUTE).toISOString(), to: new Date(base).toISOString() },
      jar,
    });
    expect(badRange.status).toBe(400);
  });
});
