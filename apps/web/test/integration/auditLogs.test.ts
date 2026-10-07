import { prisma } from "@clockoff/db";
import type { ListAuditLogsResponse } from "@clockoff/validation/auditLogs";
import { describe, expect, it } from "vitest";
import { GET as auditLogsRoute } from "@/app/api/audit-logs/route";
import { audit } from "@/server/audit/audit";
import {
  addMember,
  callRoute,
  createTestOrg,
  createTestUser,
  loginAs,
  type CookieJar,
  type ErrorBody,
} from "../helpers";

const DAY_MS = 24 * 3600_000;

async function setup() {
  const org = await createTestOrg();
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  return { org, jar };
}

/**
 * `createTestOrg` goes through the real service, which audits `organisation.created` at "now". The
 * tests below insert rows a few minutes / seconds in the past, so push that row further back to keep it
 * the oldest entry.
 */
async function backdateOrganisationCreated(organisationId: string, occurredAt: Date) {
  await prisma.auditLog.updateMany({
    where: { organisationId, action: "organisation.created" },
    data: { occurredAt },
  });
}

async function list(jar: CookieJar, query: Record<string, string | number | undefined> = {}) {
  const res = await callRoute<ListAuditLogsResponse>(auditLogsRoute, {
    path: "/api/audit-logs",
    query,
    jar,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

describe("GET /api/audit-logs", () => {
  it("lists manager actions newest first with the actor joined, and filters", async () => {
    const { org, jar } = await setup();
    const { user: admin } = await createTestUser({ name: "Ada Admin" });
    await addMember(org.organisation.id, admin, "ADMIN");
    const now = Date.now();
    await backdateOrganisationCreated(org.organisation.id, new Date(now - 10 * 60_000));
    const actor = (user: { id: string }) => ({
      organisation: { id: org.organisation.id },
      user,
      ip: "10.0.0.1",
      userAgent: "vitest",
    });
    await audit(actor(org.owner), {
      action: "policy.published",
      entityType: "Policy",
      entityId: "policy-1",
      after: { version: 1 },
      occurredAt: new Date(now - 3 * 60_000),
    });
    await audit(actor(admin), {
      action: "shift.created",
      entityType: "Shift",
      entityId: "shift-1",
      occurredAt: new Date(now - 2 * 60_000),
    });
    await audit(actor(org.owner), {
      action: "policy.archived",
      entityType: "Policy",
      entityId: "policy-1",
      before: { status: "ACTIVE" },
      occurredAt: new Date(now - 60_000),
    });

    const all = await list(jar);
    // organisation.created (from createTestOrg) is oldest and last.
    expect(all.items.map((i) => i.action)).toEqual([
      "policy.archived",
      "shift.created",
      "policy.published",
      "organisation.created",
    ]);
    expect(all.items[0]).toMatchObject({
      entityType: "Policy",
      entityId: "policy-1",
      actor: { id: org.owner.id, name: org.owner.name, email: org.owner.email },
      before: { status: "ACTIVE" },
      after: null,
      ip: "10.0.0.1",
      userAgent: "vitest",
    });
    expect(all.nextCursor).toBeNull();

    expect((await list(jar, { entityType: "Policy" })).items.map((i) => i.action)).toEqual([
      "policy.archived",
      "policy.published",
    ]);
    expect(
      (await list(jar, { entityType: "Policy", entityId: "policy-1", action: "policy.published" }))
        .items,
    ).toHaveLength(1);
    expect((await list(jar, { actorUserId: admin.id })).items.map((i) => i.action)).toEqual([
      "shift.created",
    ]);
    const window = await list(jar, {
      from: new Date(now - 150_000).toISOString(),
      to: new Date(now - 90_000).toISOString(),
    });
    expect(window.items.map((i) => i.action)).toEqual(["shift.created"]);
  });

  it("paginates with a cursor and rejects bad cursors / ranges", async () => {
    const { org, jar } = await setup();
    await backdateOrganisationCreated(org.organisation.id, new Date(Date.now() - 60_000));
    for (let i = 0; i < 4; i++) {
      await audit(
        { organisation: { id: org.organisation.id }, user: org.owner },
        {
          action: `thing.${i}`,
          entityType: "Thing",
          occurredAt: new Date(Date.now() - (10 - i) * 1000),
        },
      );
    }
    const page1 = await list(jar, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await list(jar, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    const page3 = await list(jar, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.items.map((i) => i.action)).toEqual(["organisation.created"]);
    expect(page3.nextCursor).toBeNull();
    const ids = new Set([...page1.items, ...page2.items, ...page3.items].map((i) => i.id));
    expect(ids.size).toBe(5);

    const bad = await callRoute<ErrorBody>(auditLogsRoute, {
      path: "/api/audit-logs",
      query: { cursor: "zzz" },
      jar,
    });
    expect(bad.status).toBe(400);
    const badRange = await callRoute<ErrorBody>(auditLogsRoute, {
      path: "/api/audit-logs",
      query: { from: "2026-10-06T10:00:00Z", to: "2026-10-06T09:00:00Z" },
      jar,
    });
    expect(badRange.status).toBe(400);
  });

  it("applies actorUserId inside the caller's organisation only", async () => {
    const { jar } = await setup();
    const other = await createTestOrg();
    await audit(
      { organisation: { id: other.organisation.id }, user: other.owner },
      { action: "other.thing", entityType: "Thing" },
    );
    // The other owner has audit rows (in their own organisation); none are visible here.
    expect((await list(jar, { actorUserId: other.owner.id })).items).toEqual([]);
    expect((await list(jar)).items.map((i) => i.action)).toEqual(["organisation.created"]);
  });

  it("hides rows older than the plan's audit retention", async () => {
    const { org, jar } = await setup();
    await audit(
      { organisation: { id: org.organisation.id }, user: org.owner },
      { action: "old.thing", entityType: "Thing", occurredAt: new Date(Date.now() - 40 * DAY_MS) },
    );
    // STARTER keeps 30 days.
    expect((await list(jar)).items.map((i) => i.action)).toEqual(["organisation.created"]);
    await prisma.organisation.update({ where: { id: org.organisation.id }, data: { plan: "PRO" } });
    expect((await list(jar)).items.map((i) => i.action)).toEqual([
      "organisation.created",
      "old.thing",
    ]);
  });

  it("requires audit:read (MANAGER → FORBIDDEN; ADMIN allowed)", async () => {
    const { org } = await setup();
    const { user: manager } = await createTestUser();
    await addMember(org.organisation.id, manager, "MANAGER");
    const managerJar = await loginAs(manager, { organisationId: org.organisation.id });
    const forbidden = await callRoute<ErrorBody>(auditLogsRoute, {
      path: "/api/audit-logs",
      jar: managerJar,
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");

    const { user: admin } = await createTestUser();
    await addMember(org.organisation.id, admin, "ADMIN");
    const adminJar = await loginAs(admin, { organisationId: org.organisation.id });
    const ok = await callRoute<ListAuditLogsResponse>(auditLogsRoute, {
      path: "/api/audit-logs",
      jar: adminJar,
    });
    expect(ok.status).toBe(200);
  });
});
