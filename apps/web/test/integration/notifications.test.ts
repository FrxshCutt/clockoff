import { prisma } from "@workmode/db";
import type {
  ListNotificationsResponse,
  MarkAllNotificationsReadResponse,
  NotificationResponse,
} from "@workmode/validation/notifications";
import { describe, expect, it } from "vitest";
import { POST as readRoute } from "@/app/api/notifications/[id]/read/route";
import { POST as readAllRoute } from "@/app/api/notifications/read-all/route";
import { GET as listRoute } from "@/app/api/notifications/route";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { createManagerNotification, notifyOrganisationManagers } from "@/server/notifications";
import {
  addMember,
  callRoute,
  createTestOrg,
  createTestUser,
  loginAs,
  type CookieJar,
  type ErrorBody,
} from "../helpers";

async function setup() {
  const org = await createTestOrg();
  const { user: manager } = await createTestUser({ name: "Shift Manager" });
  await addMember(org.organisation.id, manager, "MANAGER");
  const ownerJar = await loginAs(org.owner, { organisationId: org.organisation.id });
  const managerJar = await loginAs(manager, { organisationId: org.organisation.id });
  return { org, manager, ownerJar, managerJar };
}

async function list(jar: CookieJar, query: Record<string, string | number | boolean | undefined> = {}) {
  const res = await callRoute<ListNotificationsResponse>(listRoute, { path: "/api/notifications", query, jar });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

describe("createManagerNotification", () => {
  it("creates one row per recipient member, publishes notification.created and skips non-members", async () => {
    const { org, manager } = await setup();
    const { user: outsider } = await createTestUser();
    const events: RealtimeEvent[] = [];
    getEventBus().subscribe(org.organisation.id, (event) => events.push(event));

    const rows = await createManagerNotification({
      organisationId: org.organisation.id,
      userIds: [org.owner.id, manager.id, outsider.id],
      type: "EMPLOYEE_JOINED",
      title: "Sam joined",
      body: "Sam Worker joined from their phone.",
      href: "/employees/abc",
      metadata: { employeeId: "abc" },
    });
    expect(rows.map((r) => r.recipientId).sort()).toEqual([org.owner.id, manager.id].sort());
    expect(rows[0]).toMatchObject({
      organisationId: org.organisation.id,
      recipientType: "MANAGER_USER",
      channel: "IN_APP",
      metadata: { employeeId: "abc", href: "/employees/abc" },
    });
    expect(events.filter((e) => e.type === "notification.created")).toHaveLength(2);
    expect(events[0]?.payload).toMatchObject({ type: "EMPLOYEE_JOINED", recipientId: expect.any(String) });
    expect(await prisma.notification.count({ where: { recipientId: outsider.id } })).toBe(0);
  });

  it("respects a recipient's inApp preference for known types and accepts a single userId", async () => {
    const { org, manager } = await setup();
    await prisma.organisationMembership.updateMany({
      where: { organisationId: org.organisation.id, userId: manager.id },
      data: { notificationPreferences: { EMPLOYEE_JOINED: { inApp: false, email: false } } },
    });
    const muted = await createManagerNotification({
      organisationId: org.organisation.id,
      userIds: [org.owner.id, manager.id],
      type: "EMPLOYEE_JOINED",
      title: "t",
      body: "b",
    });
    expect(muted.map((r) => r.recipientId)).toEqual([org.owner.id]);

    // Unknown (additive) kinds are never muted by preferences; `db` may be passed positionally.
    const digest = await createManagerNotification(
      { organisationId: org.organisation.id, userId: manager.id, type: "COMPLIANCE_DIGEST", title: "t", body: "b" },
      prisma,
    );
    expect(digest).toHaveLength(1);
    expect(digest[0]?.metadata).toEqual({ href: null });
  });

  it("notifyOrganisationManagers fans out to every member, optionally by role", async () => {
    const { org, manager } = await setup();
    const owners = await notifyOrganisationManagers({
      organisationId: org.organisation.id,
      type: "INTEGRATION_ERROR",
      title: "Planday sync failed",
      body: "Reconnect the integration.",
      roles: ["OWNER"],
    });
    expect(owners.map((r) => r.recipientId)).toEqual([org.owner.id]);
    const everyone = await notifyOrganisationManagers({
      organisationId: org.organisation.id,
      type: "IMPORT_COMPLETED",
      title: "Import done",
      body: "12 shifts created.",
    });
    expect(everyone.map((r) => r.recipientId).sort()).toEqual([org.owner.id, manager.id].sort());
  });
});

describe("GET /api/notifications", () => {
  it("lists the caller's own notifications newest first with the unread count, and filters unreadOnly", async () => {
    const { org, manager, ownerJar, managerJar } = await setup();
    const [first] = await createManagerNotification({
      organisationId: org.organisation.id,
      userId: org.owner.id,
      type: "EMPLOYEE_JOINED",
      title: "First",
      body: "b",
      href: "/employees/1",
    });
    await prisma.notification.update({ where: { id: first!.id }, data: { readAt: new Date() } });
    await createManagerNotification({
      organisationId: org.organisation.id,
      userId: org.owner.id,
      type: "DEVICE_SYNC_DELAYED",
      title: "Second",
      body: "b",
    });
    await createManagerNotification({
      organisationId: org.organisation.id,
      userId: manager.id,
      type: "IMPORT_COMPLETED",
      title: "Manager only",
      body: "b",
    });

    const owner = await list(ownerJar);
    expect(owner.items.map((n) => n.title)).toEqual(["Second", "First"]);
    expect(owner.unreadCount).toBe(1);
    expect(owner.nextCursor).toBeNull();
    expect(owner.items[1]).toMatchObject({ href: "/employees/1", readAt: expect.any(String) });
    expect(owner.items[0]).toMatchObject({ href: null, readAt: null, channel: "IN_APP" });

    const unread = await list(ownerJar, { unreadOnly: true });
    expect(unread.items.map((n) => n.title)).toEqual(["Second"]);

    const asManager = await list(managerJar);
    expect(asManager.items.map((n) => n.title)).toEqual(["Manager only"]);
  });

  it("paginates with an opaque cursor and rejects a forged one", async () => {
    const { org, ownerJar } = await setup();
    for (const title of ["n1", "n2", "n3"]) {
      await createManagerNotification({
        organisationId: org.organisation.id,
        userId: org.owner.id,
        type: "EMPLOYEE_JOINED",
        title,
        body: "b",
      });
    }
    const page1 = await list(ownerJar, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await list(ownerJar, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const seen = new Set([...page1.items, ...page2.items].map((n) => n.id));
    expect(seen.size).toBe(3);

    const forged = await callRoute<ErrorBody>(listRoute, {
      path: "/api/notifications",
      query: { cursor: "not-a-cursor" },
      jar: ownerJar,
    });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("marking notifications read", () => {
  it("marks one notification read (idempotently), refuses someone else's, and marks all read", async () => {
    const { org, manager, ownerJar, managerJar } = await setup();
    const [mine] = await createManagerNotification({
      organisationId: org.organisation.id,
      userId: org.owner.id,
      type: "EMPLOYEE_JOINED",
      title: "Mine",
      body: "b",
    });
    const [theirs] = await createManagerNotification({
      organisationId: org.organisation.id,
      userId: manager.id,
      type: "EMPLOYEE_JOINED",
      title: "Theirs",
      body: "b",
    });

    const read = await callRoute<NotificationResponse>(readRoute, {
      method: "POST",
      path: `/api/notifications/${mine!.id}/read`,
      params: { id: mine!.id },
      jar: ownerJar,
      body: {},
    });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.notification.readAt).toEqual(expect.any(String));
    const again = await callRoute<NotificationResponse>(readRoute, {
      method: "POST",
      path: `/api/notifications/${mine!.id}/read`,
      params: { id: mine!.id },
      jar: ownerJar,
      body: {},
    });
    expect(again.body.notification.readAt).toBe(read.body.notification.readAt);

    const forbidden = await callRoute<ErrorBody>(readRoute, {
      method: "POST",
      path: `/api/notifications/${theirs!.id}/read`,
      params: { id: theirs!.id },
      jar: ownerJar,
      body: {},
    });
    expect(forbidden.status).toBe(404);
    expect(forbidden.body.error.code).toBe("NOT_FOUND");

    await createManagerNotification({
      organisationId: org.organisation.id,
      userId: manager.id,
      type: "OVERRIDE_EXPIRED",
      title: "Theirs 2",
      body: "b",
    });
    const all = await callRoute<MarkAllNotificationsReadResponse>(readAllRoute, {
      method: "POST",
      path: "/api/notifications/read-all",
      jar: managerJar,
      body: {},
    });
    expect(all.status).toBe(200);
    expect(all.body.updated).toBe(2);
    expect((await list(managerJar)).unreadCount).toBe(0);
    // The owner's feed is untouched by the manager's read-all.
    expect((await list(ownerJar)).unreadCount).toBe(0);
    expect(
      await prisma.notification.count({ where: { recipientId: org.owner.id, readAt: null } }),
    ).toBe(0);
  });
});
