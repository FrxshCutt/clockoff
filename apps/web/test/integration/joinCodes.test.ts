import { prisma } from "@workmode/db";
import { JOIN_CODE_REGEX } from "@workmode/shared/joinCode";
import type { JoinCodeResponse } from "@workmode/validation/organisation";
import { describe, expect, it, vi } from "vitest";
import { POST as regenerateRoute } from "@/app/api/organisations/current/join-code/regenerate/route";
import { POST as revokeRoute } from "@/app/api/organisations/current/join-code/revoke/route";
import { GET as getRoute } from "@/app/api/organisations/current/join-code/route";
import {
  addMember,
  callRoute,
  createTestOrg,
  createTestUser,
  loginAs,
  type CookieJar,
  type ErrorBody,
} from "../helpers";

const PATH = "/api/organisations/current/join-code";

/**
 * Codes the next draws must return (consumed in order); empty = the real CSPRNG generator. Lets a test
 * force a collision with an existing code to exercise the P2002 retry without touching the database schema.
 */
const { forcedDraws } = vi.hoisted(() => ({ forcedDraws: [] as string[] }));
vi.mock("@workmode/shared/joinCode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workmode/shared/joinCode")>();
  return {
    ...actual,
    generateJoinCode: (...args: Parameters<typeof actual.generateJoinCode>) =>
      forcedDraws.shift() ?? actual.generateJoinCode(...args),
  };
});

async function setup() {
  const org = await createTestOrg();
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  return { org, jar };
}

async function get(jar: CookieJar) {
  const res = await callRoute<JoinCodeResponse>(getRoute, { path: PATH, jar });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

describe("GET /api/organisations/current/join-code", () => {
  it("returns the active code (created with the organisation) and an empty history", async () => {
    const { org, jar } = await setup();
    const body = await get(jar);
    expect(body.current).toMatchObject({
      id: org.joinCode.id,
      code: org.joinCode.code,
      status: "ACTIVE",
      revokedAt: null,
      createdBy: { id: org.owner.id, name: org.owner.name },
    });
    expect(body.history).toEqual([]);
  });

  it("is readable by a MANAGER (employees:read)", async () => {
    const { org } = await setup();
    const { user } = await createTestUser();
    await addMember(org.organisation.id, user, "MANAGER");
    const jar = await loginAs(user, { organisationId: org.organisation.id });
    const res = await callRoute<JoinCodeResponse>(getRoute, { path: PATH, jar });
    expect(res.status).toBe(200);
    expect(res.body.current?.code).toBe(org.joinCode.code);
  });
});

describe("POST /api/organisations/current/join-code/regenerate", () => {
  it("revokes the active code, creates a new WORD-#### code and audits the change", async () => {
    const { org, jar } = await setup();
    const res = await callRoute<JoinCodeResponse>(regenerateRoute, {
      method: "POST",
      path: `${PATH}/regenerate`,
      jar,
      body: {},
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.current).not.toBeNull();
    expect(res.body.current?.code).toMatch(JOIN_CODE_REGEX);
    expect(res.body.current?.code).not.toBe(org.joinCode.code);
    expect(res.body.current?.createdBy?.id).toBe(org.owner.id);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0]).toMatchObject({ code: org.joinCode.code, status: "REVOKED" });
    expect(res.body.history[0]?.revokedAt).not.toBeNull();

    const active = await prisma.companyJoinCode.findMany({
      where: { organisationId: org.organisation.id, status: "ACTIVE" },
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.code).toBe(res.body.current?.code);

    const auditRow = await prisma.auditLog.findFirst({
      where: { organisationId: org.organisation.id, action: "join_code.regenerated" },
    });
    expect(auditRow).toMatchObject({
      actorUserId: org.owner.id,
      entityType: "CompanyJoinCode",
      entityId: res.body.current?.id,
    });
    expect(auditRow?.before).toMatchObject({ code: org.joinCode.code });
    expect(auditRow?.after).toMatchObject({ code: res.body.current?.code });
  });

  it("keeps a full history across several regenerations, newest first", async () => {
    const { org, jar } = await setup();
    const codes = [org.joinCode.code];
    for (let i = 0; i < 2; i++) {
      const res = await callRoute<JoinCodeResponse>(regenerateRoute, {
        method: "POST",
        path: `${PATH}/regenerate`,
        jar,
        body: {},
      });
      codes.push(res.body.current!.code);
    }
    const body = await get(jar);
    expect(body.current?.code).toBe(codes[2]);
    expect(body.history.map((c) => c.code)).toEqual([codes[1], codes[0]]);
    expect(new Set(codes).size).toBe(3);
  });

  it("requires org:manage (MANAGER → FORBIDDEN) and the CSRF header", async () => {
    const { org, jar } = await setup();
    const { user } = await createTestUser();
    await addMember(org.organisation.id, user, "MANAGER");
    const managerJar = await loginAs(user, { organisationId: org.organisation.id });
    const forbidden = await callRoute<ErrorBody>(regenerateRoute, {
      method: "POST",
      path: `${PATH}/regenerate`,
      jar: managerJar,
      body: {},
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");

    const noCsrf = await callRoute<ErrorBody>(regenerateRoute, {
      method: "POST",
      path: `${PATH}/regenerate`,
      jar,
      body: {},
      csrf: false,
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("CSRF_FAILED");

    const unchanged = await get(jar);
    expect(unchanged.current?.code).toBe(org.joinCode.code);
  });

  it("rejects unknown body fields", async () => {
    const { jar } = await setup();
    const res = await callRoute<ErrorBody>(regenerateRoute, {
      method: "POST",
      path: `${PATH}/regenerate`,
      jar,
      body: { code: "HACK-0001" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("draws again when the generated code collides with an existing one (P2002 on `code`)", async () => {
    const { org, jar } = await setup();
    const other = await createTestOrg();
    // First draw = the other organisation's ACTIVE code (globally unique); the second draw is real.
    forcedDraws.push(other.joinCode.code);
    const res = await callRoute<JoinCodeResponse>(regenerateRoute, {
      method: "POST",
      path: `${PATH}/regenerate`,
      jar,
      body: {},
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(forcedDraws).toEqual([]);
    expect(res.body.current?.code).toMatch(JOIN_CODE_REGEX);
    expect(res.body.current?.code).not.toBe(other.joinCode.code);
    expect(res.body.history.map((c) => c.code)).toEqual([org.joinCode.code]);

    // The failed attempt rolled back completely: one ACTIVE code here, the other tenant untouched,
    // exactly one audit row.
    const rows = await prisma.companyJoinCode.findMany({
      where: { organisationId: org.organisation.id },
    });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "ACTIVE")).toHaveLength(1);
    const otherRow = await prisma.companyJoinCode.findUniqueOrThrow({
      where: { id: other.joinCode.id },
    });
    expect(otherRow).toMatchObject({ status: "ACTIVE", organisationId: other.organisation.id });
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "join_code.regenerated" },
      }),
    ).toBe(1);
  });

  it("gives up with CONFLICT (nothing changed) when every draw collides", async () => {
    const { org, jar } = await setup();
    const other = await createTestOrg();
    for (let i = 0; i < 16; i++) forcedDraws.push(other.joinCode.code);
    try {
      const res = await callRoute<ErrorBody>(regenerateRoute, {
        method: "POST",
        path: `${PATH}/regenerate`,
        jar,
        body: {},
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
    } finally {
      forcedDraws.length = 0;
    }
    const body = await get(jar);
    expect(body.current?.code).toBe(org.joinCode.code);
    expect(body.history).toEqual([]);
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "join_code.regenerated" },
      }),
    ).toBe(0);
  });

  it("serialises concurrent regenerations: exactly one ACTIVE code survives", async () => {
    const { org, jar } = await setup();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        callRoute<JoinCodeResponse>(regenerateRoute, {
          method: "POST",
          path: `${PATH}/regenerate`,
          jar: jar.clone(),
          body: {},
        }),
      ),
    );
    for (const res of results) expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await prisma.companyJoinCode.findMany({
      where: { organisationId: org.organisation.id },
    });
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.status === "ACTIVE")).toHaveLength(1);
    expect(new Set(rows.map((r) => r.code)).size).toBe(4);
    const body = await get(jar);
    expect(body.current?.status).toBe("ACTIVE");
    expect(body.history).toHaveLength(3);
    expect(body.history.every((c) => c.status === "REVOKED" && c.revokedAt !== null)).toBe(true);
  });
});

describe("POST /api/organisations/current/join-code/revoke", () => {
  it("leaves the organisation without an active code, is idempotent and audits once", async () => {
    const { org, jar } = await setup();
    const first = await callRoute<JoinCodeResponse>(revokeRoute, {
      method: "POST",
      path: `${PATH}/revoke`,
      jar,
      body: {},
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.current).toBeNull();
    expect(first.body.history).toHaveLength(1);
    expect(first.body.history[0]).toMatchObject({ code: org.joinCode.code, status: "REVOKED" });

    const second = await callRoute<JoinCodeResponse>(revokeRoute, {
      method: "POST",
      path: `${PATH}/revoke`,
      jar,
      body: {},
    });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "join_code.revoked" },
      }),
    ).toBe(1);

    // Regenerating afterwards brings a code back.
    const regenerated = await callRoute<JoinCodeResponse>(regenerateRoute, {
      method: "POST",
      path: `${PATH}/regenerate`,
      jar,
      body: {},
    });
    expect(regenerated.body.current?.status).toBe("ACTIVE");
    expect(regenerated.body.history).toHaveLength(1);
  });

  it("requires org:manage", async () => {
    const { org } = await setup();
    const { user } = await createTestUser();
    await addMember(org.organisation.id, user, "MANAGER");
    const jar = await loginAs(user, { organisationId: org.organisation.id });
    const res = await callRoute<ErrorBody>(revokeRoute, {
      method: "POST",
      path: `${PATH}/revoke`,
      jar,
      body: {},
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});
