import { prisma } from "@workmode/db";
import { describe, expect, it } from "vitest";
import { GET as healthRoute } from "@/app/api/health/route";
import { recordActivity } from "@/server/activity/recordActivity";
import { audit } from "@/server/audit/audit";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { callRoute, createTestDevice, createTestOrg } from "../helpers";

describe("recordActivity", () => {
  it("writes the event, publishes it to the organisation's subscribers only, and is idempotent per device", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const { device, employee } = await createTestDevice(orgA.organisation.id);
    const seenA: RealtimeEvent[] = [];
    const seenB: RealtimeEvent[] = [];
    const unsubA = getEventBus().subscribe(orgA.organisation.id, (e) => seenA.push(e));
    const unsubB = getEventBus().subscribe(orgB.organisation.id, (e) => seenB.push(e));

    const input = {
      organisationId: orgA.organisation.id,
      employeeId: employee.id,
      deviceId: device.id,
      actorType: "EMPLOYEE_DEVICE" as const,
      type: "BREAK_STARTED" as const,
      occurredAt: new Date("2026-10-06T09:30:00.000Z"),
      metadata: { breakSessionId: "b-1" },
      clientEventId: "evt-123",
    };
    const first = await recordActivity(input);
    expect(first.created).toBe(true);
    expect(first.event.occurredAt.toISOString()).toBe("2026-10-06T09:30:00.000Z");
    const retry = await recordActivity(input);
    expect(retry.created).toBe(false);
    expect(retry.event.id).toBe(first.event.id);
    expect(
      await prisma.activityEvent.count({
        where: { deviceId: device.id, clientEventId: "evt-123" },
      }),
    ).toBe(1);

    expect(seenA).toHaveLength(1);
    expect(seenA[0]).toMatchObject({
      type: "activity.recorded",
      organisationId: orgA.organisation.id,
      employeeId: employee.id,
      payload: { eventId: first.event.id, eventType: "BREAK_STARTED" },
    });
    expect(seenB).toHaveLength(0);
    unsubA();
    unsubB();
  });

  it("is safe inside a caller's transaction (duplicate does not abort it)", async () => {
    const org = await createTestOrg();
    const { device } = await createTestDevice(org.organisation.id);
    const input = {
      organisationId: org.organisation.id,
      deviceId: device.id,
      actorType: "EMPLOYEE_DEVICE" as const,
      type: "SETUP_COMPLETED" as const,
      clientEventId: "tx-1",
    };
    const results = await prisma.$transaction(async (tx) => {
      const a = await recordActivity(input, { db: tx, publish: false });
      const b = await recordActivity(input, { db: tx, publish: false });
      const c = await recordActivity(
        { ...input, clientEventId: "tx-2" },
        { db: tx, publish: false },
      );
      return [a, b, c];
    });
    expect(results.map((r) => r.created)).toEqual([true, false, true]);
  });

  it("records manager / system events without idempotency keys", async () => {
    const org = await createTestOrg();
    const a = await recordActivity({
      organisationId: org.organisation.id,
      actorType: "SYSTEM",
      type: "SCHEDULE_SYNCED",
    });
    const b = await recordActivity({
      organisationId: org.organisation.id,
      actorType: "SYSTEM",
      type: "SCHEDULE_SYNCED",
    });
    expect(a.event.id).not.toBe(b.event.id);
  });
});

describe("audit", () => {
  it("stores actor, ip, user agent and JSON snapshots", async () => {
    const org = await createTestOrg();
    const row = await audit(
      {
        organisation: org.organisation,
        user: org.owner,
        ip: "198.51.100.4",
        userAgent: "Mozilla/5.0",
      },
      {
        action: "policy.updated",
        entityType: "Policy",
        entityId: "p-1",
        before: { name: "Old", at: new Date("2026-01-01T00:00:00.000Z") },
        after: { name: "New", removed: undefined },
      },
    );
    expect(row).toMatchObject({
      organisationId: org.organisation.id,
      actorUserId: org.owner.id,
      ip: "198.51.100.4",
      userAgent: "Mozilla/5.0",
      action: "policy.updated",
      entityType: "Policy",
      entityId: "p-1",
      before: { name: "Old", at: "2026-01-01T00:00:00.000Z" },
      after: { name: "New" },
    });
  });
});

describe("audit with empty snapshots", () => {
  it("stores null snapshots as SQL NULL", async () => {
    const org = await createTestOrg();
    const row = await audit(
      { organisation: org.organisation },
      { action: "x.y", entityType: "X", before: null },
    );
    expect(row.before).toBeNull();
    expect(row.after).toBeNull();
    expect(row.actorUserId).toBeNull();
  });
});

describe("GET /api/health", () => {
  it("reports database reachability and that every migration is applied", async () => {
    const res = await callRoute<{ status: string; database: string; migrations: string }>(
      healthRoute,
      {
        path: "/api/health",
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", database: "ok", migrations: "up_to_date" });
    expect(Object.keys(res.body).sort()).toEqual(["database", "migrations", "status", "time"]);
  });
});
