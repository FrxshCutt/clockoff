import { randomUUID } from "node:crypto";
import { prisma } from "@workmode/db";
import { generateEmployeeInviteCode } from "@workmode/shared/joinCode";
import {
  joinConfirmResponseSchema,
  joinLookupResponseSchema,
  mobileTokensSchema,
  type JoinConfirmResponse,
  type JoinLookupResponse,
  type MobileRefreshResponse,
} from "@workmode/validation/mobile";
import type { OkResponse } from "@workmode/validation/primitives";
import { describe, expect, it } from "vitest";
import { POST as logoutRoute } from "@/app/api/mobile/v1/auth/logout/route";
import { POST as refreshRoute } from "@/app/api/mobile/v1/auth/refresh/route";
import { POST as confirmRoute } from "@/app/api/mobile/v1/join/confirm/route";
import { POST as lookupRoute } from "@/app/api/mobile/v1/join/lookup/route";
import { POST as leaveRoute } from "@/app/api/mobile/v1/leave-workplace/route";
import { hashToken } from "@/lib/tokens";
import { callRoute, createTestDevice, createTestOrg, type ErrorBody, type TestOrg } from "../helpers";

/**
 * `/api/mobile/v1/join/*`, `/auth/*` and `/leave-workplace` through the real route handlers: company +
 * invite code normalisation, SINGLE / NONE / AMBIGUOUS matching, the confirm transaction, token rotation
 * and reuse detection, logout, leaving, and the per-IP / per-company-code rate limits.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const DEVICE = {
  platform: "IOS",
  appVersion: "1.0.0 (12)",
  osVersion: "17.5.1",
  model: "iPhone15,2",
} as const;

async function setup(options: { firstLocationName?: string } = {}) {
  const org = await createTestOrg({ firstLocationName: options.firstLocationName ?? "High Street" });
  const location = await prisma.location.findFirstOrThrow({
    where: { organisationId: org.organisation.id },
  });
  return { org, location };
}

async function seedEmployee(
  org: TestOrg,
  firstName: string,
  lastName: string,
  extra: {
    jobTitle?: string;
    primaryLocationId?: string;
    employmentStatus?: "ACTIVE" | "INACTIVE";
    deletedAt?: Date;
  } = {},
) {
  return prisma.employee.create({
    data: {
      organisationId: org.organisation.id,
      firstName,
      lastName,
      jobTitle: extra.jobTitle ?? null,
      primaryLocationId: extra.primaryLocationId ?? null,
      employmentStatus: extra.employmentStatus ?? "ACTIVE",
      deletedAt: extra.deletedAt ?? null,
    },
  });
}

async function seedInvite(
  org: TestOrg,
  employeeId: string,
  overrides: { status?: "PENDING" | "SENT" | "REVOKED" | "ACCEPTED"; expiresAt?: Date } = {},
) {
  const code = generateEmployeeInviteCode();
  const invite = await prisma.employeeInvite.create({
    data: {
      organisationId: org.organisation.id,
      employeeId,
      code,
      tokenHash: `hash-${randomUUID()}`,
      channel: "LINK",
      status: overrides.status ?? "SENT",
      sentAt: new Date(),
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * DAY),
    },
  });
  await prisma.employee.update({ where: { id: employeeId }, data: { inviteStatus: "INVITED" } });
  return invite;
}

function lookup(body: Record<string, unknown>, ip?: string) {
  return callRoute<JoinLookupResponse>(lookupRoute, {
    method: "POST",
    path: "/api/mobile/v1/join/lookup",
    body,
    ...(ip ? { ip } : {}),
  });
}

function confirm(body: Record<string, unknown>, ip?: string) {
  return callRoute<JoinConfirmResponse>(confirmRoute, {
    method: "POST",
    path: "/api/mobile/v1/join/confirm",
    body,
    ...(ip ? { ip } : {}),
  });
}

function refresh(refreshToken: string) {
  return callRoute<MobileRefreshResponse>(refreshRoute, {
    method: "POST",
    path: "/api/mobile/v1/auth/refresh",
    body: { refreshToken },
  });
}

function bearer(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` };
}

function errorOf(res: { body: unknown }): ErrorBody["error"] {
  return (res.body as ErrorBody).error;
}

async function joinAs(
  org: TestOrg,
  employeeId: string,
  firstName: string,
  lastName: string,
  inviteCode?: string,
) {
  const res = await confirm({
    companyCode: org.joinCode.code,
    employeeId,
    firstName,
    lastName,
    ...(inviteCode ? { inviteCode } : {}),
    device: DEVICE,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return joinConfirmResponseSchema.parse(res.body);
}

describe("POST /api/mobile/v1/join/lookup", () => {
  it("matches a single active, unlinked employee by name (case / whitespace-insensitive) and previews them", async () => {
    const { org, location } = await setup();
    const jane = await seedEmployee(org, "Jane", "Smith", {
      jobTitle: "Barista",
      primaryLocationId: location.id,
    });
    const res = await lookup({
      companyCode: org.joinCode.code.toLowerCase(),
      firstName: "  jane ",
      lastName: "SMITH",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = joinLookupResponseSchema.parse(res.body);
    expect(body).toEqual({
      organisation: { name: org.organisation.name },
      match: "SINGLE",
      employeePreview: {
        id: jane.id,
        firstName: "Jane",
        lastName: "Smith",
        jobTitle: "Barista",
        locationName: "High Street",
      },
    });
    // Nothing beyond the preview fields leaks (no email, no ids of other things).
    expect(Object.keys(body.employeePreview ?? {}).sort()).toEqual(
      ["firstName", "id", "jobTitle", "lastName", "locationName"].sort(),
    );
  });

  it("accepts the company code however it was typed and rejects unknown or revoked codes", async () => {
    const { org } = await setup();
    await seedEmployee(org, "Ann", "Lee");
    const [word, digits] = org.joinCode.code.split("-") as [string, string];
    for (const typed of [
      `${word}${digits}`,
      `${word.toLowerCase()} ${digits}`,
      `${word}—${digits}`,
      ` ${word}-${digits} `,
    ]) {
      const res = await lookup({ companyCode: typed, firstName: "Ann", lastName: "Lee" });
      expect(res.status, `${typed}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.match).toBe("SINGLE");
    }

    const unknown = await lookup({ companyCode: "NOPE-0000", firstName: "Ann", lastName: "Lee" });
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe("INVALID_COMPANY_CODE");

    const malformed = await lookup({ companyCode: "BREW", firstName: "Ann", lastName: "Lee" });
    expect(malformed.status).toBe(400);
    expect(errorOf(malformed).code).toBe("VALIDATION_ERROR");

    await prisma.companyJoinCode.update({
      where: { id: org.joinCode.id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    const revoked = await lookup({ companyCode: org.joinCode.code, firstName: "Ann", lastName: "Lee" });
    expect(revoked.status).toBe(404);
    expect(errorOf(revoked).code).toBe("INVALID_COMPANY_CODE");
  });

  it("is NONE for unknown names, inactive or archived employees and employees already linked to a phone", async () => {
    const { org } = await setup();
    await seedEmployee(org, "Ina", "Active", { employmentStatus: "INACTIVE" });
    await seedEmployee(org, "Gone", "Archived", { deletedAt: new Date() });
    const linked = await createTestDevice(org.organisation.id);
    const other = await createTestOrg();
    await seedEmployee(other, "Else", "Where");

    for (const [firstName, lastName] of [
      ["Nobody", "Here"],
      ["Ina", "Active"],
      ["Gone", "Archived"],
      [linked.employee.firstName, linked.employee.lastName],
      ["Else", "Where"], // exists, but in another organisation
    ] as const) {
      const res = await lookup({ companyCode: org.joinCode.code, firstName, lastName });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body, `${firstName} ${lastName}`).toEqual({
        organisation: { name: org.organisation.name },
        match: "NONE",
        employeePreview: null,
      });
    }
  });

  it("is AMBIGUOUS for duplicate names and an invite code picks one of them", async () => {
    const { org } = await setup();
    const first = await seedEmployee(org, "Sam", "Patel", { jobTitle: "Chef" });
    const second = await seedEmployee(org, "Sam", "Patel", { jobTitle: "Server" });
    const invite = await seedInvite(org, second.id);

    const ambiguous = await lookup({ companyCode: org.joinCode.code, firstName: "sam", lastName: "patel" });
    expect(ambiguous.status).toBe(200);
    expect(ambiguous.body).toEqual({
      organisation: { name: org.organisation.name },
      match: "AMBIGUOUS",
      employeePreview: null,
    });

    const withCode = await lookup({
      companyCode: org.joinCode.code,
      firstName: "Sam",
      lastName: "Patel",
      inviteCode: `${invite.code.slice(0, 3).toLowerCase()}-${invite.code.slice(3)}`,
    });
    expect(withCode.status, JSON.stringify(withCode.body)).toBe(200);
    expect(withCode.body.match).toBe("SINGLE");
    expect(withCode.body.employeePreview?.id).toBe(second.id);
    expect(withCode.body.employeePreview?.jobTitle).toBe("Server");

    // The code identifies the employee but the typed name must still (loosely) match.
    const wrongName = await lookup({
      companyCode: org.joinCode.code,
      firstName: "Sam",
      lastName: "Jones",
      inviteCode: invite.code,
    });
    expect(wrongName.status).toBe(200);
    expect(wrongName.body.match).toBe("NONE");

    // Confirming an ambiguous name without the code is refused; with it, the code's employee joins.
    const noCode = await confirm({
      companyCode: org.joinCode.code,
      employeeId: second.id,
      firstName: "Sam",
      lastName: "Patel",
      device: DEVICE,
    });
    expect(noCode.status).toBe(409);
    expect(errorOf(noCode).code).toBe("AMBIGUOUS_MATCH");
    const joined = await joinAs(org, second.id, "Sam", "Patel", invite.code);
    expect(joined.employee.id).toBe(second.id);

    // Once one of them joined, the other is the single remaining match by name.
    const remaining = await lookup({ companyCode: org.joinCode.code, firstName: "Sam", lastName: "Patel" });
    expect(remaining.body.match).toBe("SINGLE");
    expect(remaining.body.employeePreview?.id).toBe(first.id);
  });

  it("rejects unknown, expired, revoked, accepted and foreign invite codes with INVALID_INVITE_CODE", async () => {
    const { org } = await setup();
    const employee = await seedEmployee(org, "Code", "Holder");
    const expired = await seedInvite(org, employee.id, { expiresAt: new Date(Date.now() - 1000) });
    const revoked = await seedInvite(org, employee.id, { status: "REVOKED" });
    const accepted = await seedInvite(org, employee.id, { status: "ACCEPTED" });
    const other = await createTestOrg();
    const stranger = await seedEmployee(other, "Code", "Holder");
    const foreign = await seedInvite(other, stranger.id);

    for (const code of ["ZZZZ99", expired.code, revoked.code, accepted.code, foreign.code]) {
      const res = await lookup({
        companyCode: org.joinCode.code,
        firstName: "Code",
        lastName: "Holder",
        inviteCode: code,
      });
      expect(res.status, code).toBe(400);
      expect(errorOf(res).code, code).toBe("INVALID_INVITE_CODE");
    }
    // Without a code the employee still matches by name.
    const byName = await lookup({ companyCode: org.joinCode.code, firstName: "Code", lastName: "Holder" });
    expect(byName.body.match).toBe("SINGLE");
  });

  it("asks for an invite code when the organisation requires one", async () => {
    const { org } = await setup();
    const employee = await seedEmployee(org, "Needs", "Code");
    const invite = await seedInvite(org, employee.id);
    const current = await prisma.organisation.findUniqueOrThrow({ where: { id: org.organisation.id } });
    await prisma.organisation.update({
      where: { id: org.organisation.id },
      data: {
        settings: { ...(current.settings as Record<string, unknown>), requireInviteCodeToJoin: true },
      },
    });

    const withoutCode = await lookup({ companyCode: org.joinCode.code, firstName: "Needs", lastName: "Code" });
    expect(withoutCode.body.match).toBe("AMBIGUOUS");
    const withCode = await lookup({
      companyCode: org.joinCode.code,
      firstName: "Needs",
      lastName: "Code",
      inviteCode: invite.code,
    });
    expect(withCode.body.match).toBe("SINGLE");

    const confirmWithout = await confirm({
      companyCode: org.joinCode.code,
      employeeId: employee.id,
      firstName: "Needs",
      lastName: "Code",
      device: DEVICE,
    });
    expect(confirmWithout.status).toBe(409);
    expect(errorOf(confirmWithout).code).toBe("AMBIGUOUS_MATCH");
  });

  it("validates strictly: unknown keys (privacy) and missing fields are rejected", async () => {
    const { org } = await setup();
    const extra = await lookup({
      companyCode: org.joinCode.code,
      firstName: "A",
      lastName: "B",
      installedApps: ["com.example.social"],
    });
    expect(extra.status).toBe(400);
    expect(errorOf(extra).code).toBe("VALIDATION_ERROR");
    const missing = await lookup({ companyCode: org.joinCode.code, firstName: "A" });
    expect(missing.status).toBe(400);
  });

  it("is rate limited per IP (10/h) and per company code (20/15min) independently", async () => {
    const { org } = await setup();
    const other = await createTestOrg();
    const body = { companyCode: org.joinCode.code, firstName: "No", lastName: "Body" };

    // Per IP: the handler's preset.
    for (let i = 0; i < 10; i++) {
      const res = await lookup(body, "203.0.113.50");
      expect(res.status, `attempt ${String(i + 1)}`).toBe(200);
    }
    const perIp = await lookup(body, "203.0.113.50");
    expect(perIp.status).toBe(429);
    expect(errorOf(perIp).code).toBe("RATE_LIMITED");
    expect(errorOf(perIp).details).toMatchObject({ retryAfterSeconds: expect.any(Number) });
    // Another IP is unaffected by that counter…
    expect((await lookup(body, "203.0.113.51")).status).toBe(200);

    // …but the company code has its own budget across addresses (11 so far on this code).
    for (let i = 12; i <= 20; i++) {
      const res = await lookup(body, `198.51.100.${String(i)}`);
      expect(res.status, `code attempt ${String(i)}`).toBe(200);
    }
    const perCode = await lookup(body, "198.51.100.200");
    expect(perCode.status).toBe(429);
    expect(errorOf(perCode).code).toBe("RATE_LIMITED");
    // A different code from a fresh address still works, and the limit is keyed on the canonical code.
    const otherCode = await lookup({ ...body, companyCode: other.joinCode.code }, "198.51.100.201");
    expect(otherCode.status).toBe(200);
    const sameCodeTypedDifferently = await lookup(
      { ...body, companyCode: org.joinCode.code.replace("-", " ").toLowerCase() },
      "198.51.100.202",
    );
    expect(sameCodeTypedDifferently.status).toBe(429);
  });
});

describe("POST /api/mobile/v1/join/confirm → tokens → refresh → logout → leave-workplace", () => {
  it("links the phone, accepts the invite, records EMPLOYEE_JOINED and issues working tokens; a second confirm is EMPLOYEE_ALREADY_LINKED", async () => {
    const { org, location } = await setup();
    const employee = await seedEmployee(org, "Jane", "Smith", {
      jobTitle: "Barista",
      primaryLocationId: location.id,
    });
    const invite = await seedInvite(org, employee.id);

    const res = await confirm({
      companyCode: org.joinCode.code,
      employeeId: employee.id,
      firstName: "jane",
      lastName: "smith",
      inviteCode: invite.code,
      device: DEVICE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const joined = joinConfirmResponseSchema.parse(res.body);
    expect(joined.employee).toEqual({
      id: employee.id,
      firstName: "Jane",
      lastName: "Smith",
      jobTitle: "Barista",
      primaryLocation: { id: location.id, name: "High Street", timezone: null },
    });
    expect(joined.organisation).toEqual({
      id: org.organisation.id,
      name: org.organisation.name,
      timezone: org.organisation.timezone,
    });
    expect(joined.accessToken.split(".")).toHaveLength(3);
    expect(Date.parse(joined.accessTokenExpiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(joined.refreshTokenExpiresAt)).toBeGreaterThan(Date.parse(joined.accessTokenExpiresAt));

    // Database effects of the join transaction.
    const device = await prisma.device.findUniqueOrThrow({ where: { id: joined.deviceId } });
    expect(device).toMatchObject({
      organisationId: org.organisation.id,
      employeeId: employee.id,
      platform: "IOS",
      appVersion: DEVICE.appVersion,
      osVersion: DEVICE.osVersion,
      deviceModel: DEVICE.model,
      isActive: true,
      pushTokenEncrypted: null,
    });
    const mobileUser = await prisma.mobileUser.findUniqueOrThrow({ where: { id: device.mobileUserId } });
    expect(mobileUser).toMatchObject({ firstName: "Jane", lastName: "Smith" });
    const link = await prisma.employeeUserLink.findUniqueOrThrow({ where: { employeeId: employee.id } });
    expect(link.mobileUserId).toBe(mobileUser.id);
    expect(link.unlinkedAt).toBeNull();
    expect(await prisma.employeeWorkState.count({ where: { employeeId: employee.id } })).toBe(1);
    expect(await prisma.employeeInvite.findUniqueOrThrow({ where: { id: invite.id } })).toMatchObject({
      status: "ACCEPTED",
    });
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } })).inviteStatus,
    ).toBe("JOINED");
    const activity = await prisma.activityEvent.findMany({ where: { employeeId: employee.id } });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      type: "EMPLOYEE_JOINED",
      actorType: "EMPLOYEE_DEVICE",
      actorUserId: null,
      deviceId: device.id,
    });
    expect(activity[0]?.metadata).toMatchObject({ viaInviteCode: true, inviteId: invite.id });
    expect(JSON.stringify(activity[0]?.metadata)).not.toContain("Smith");
    const stored = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(joined.refreshToken) },
    });
    expect(stored.deviceId).toBe(device.id);

    // Joined employees no longer match by name; claiming them again is a conflict, not "not found".
    const again = await lookup({ companyCode: org.joinCode.code, firstName: "Jane", lastName: "Smith" });
    expect(again.body.match).toBe("NONE");
    const second = await confirm({
      companyCode: org.joinCode.code,
      employeeId: employee.id,
      firstName: "Jane",
      lastName: "Smith",
      device: DEVICE,
    });
    expect(second.status).toBe(409);
    expect(errorOf(second).code).toBe("EMPLOYEE_ALREADY_LINKED");
    expect(await prisma.device.count({ where: { employeeId: employee.id } })).toBe(1);

    // Refresh rotates; replaying the rotated token revokes the family.
    const rotated = await refresh(joined.refreshToken);
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    const tokens = mobileTokensSchema.parse(rotated.body);
    expect(tokens.refreshToken).not.toBe(joined.refreshToken);
    const reused = await refresh(joined.refreshToken);
    expect(reused.status).toBe(401);
    expect(errorOf(reused).code).toBe("TOKEN_REUSED");
    expect(await prisma.refreshToken.count({ where: { deviceId: device.id, revokedAt: null } })).toBe(0);
    const dead = await refresh(tokens.refreshToken);
    expect(dead.status).toBe(401);
    expect(errorOf(dead).code).toBe("TOKEN_REUSED");

    // Logout needs a device token; it revokes the device's refresh tokens and leaves it linked and active.
    const unauthenticated = await callRoute<ErrorBody>(logoutRoute, {
      method: "POST",
      path: "/api/mobile/v1/auth/logout",
      body: {},
    });
    expect(unauthenticated.status).toBe(401);
    const loggedOut = await callRoute(logoutRoute, {
      method: "POST",
      path: "/api/mobile/v1/auth/logout",
      headers: bearer(tokens.accessToken),
      body: {},
    });
    expect(loggedOut.status, JSON.stringify(loggedOut.body)).toBe(204);
    expect(await prisma.refreshToken.count({ where: { deviceId: device.id, revokedAt: null } })).toBe(0);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).isActive).toBe(true);

    // Leaving unlinks, deactivates this phone and revokes everything; the access token stops working.
    const left = await callRoute<OkResponse>(leaveRoute, {
      method: "POST",
      path: "/api/mobile/v1/leave-workplace",
      headers: bearer(tokens.accessToken),
      body: {},
    });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(left.body).toEqual({ ok: true });
    expect(await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).toMatchObject({
      isActive: false,
      pushTokenEncrypted: null,
    });
    expect(
      (await prisma.employeeUserLink.findUniqueOrThrow({ where: { employeeId: employee.id } })).unlinkedAt,
    ).not.toBeNull();
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });
    expect(after).toMatchObject({ employmentStatus: "ACTIVE", inviteStatus: "NOT_INVITED" });
    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: "employee.left_workplace", entityId: employee.id },
    });
    expect(auditRow.actorUserId).toBeNull();
    expect(auditRow.organisationId).toBe(org.organisation.id);
    // No activity event for leaving itself.
    expect(await prisma.activityEvent.count({ where: { employeeId: employee.id } })).toBe(1);
    const dormant = await callRoute<ErrorBody>(leaveRoute, {
      method: "POST",
      path: "/api/mobile/v1/leave-workplace",
      headers: bearer(tokens.accessToken),
      body: {},
    });
    expect(dormant.status).toBe(401);
    expect(dormant.body.error.code).toBe("DEVICE_INACTIVE");

    // The employee can join again from a (new) phone: the link is re-pointed, not duplicated.
    const back = await lookup({ companyCode: org.joinCode.code, firstName: "Jane", lastName: "Smith" });
    expect(back.body.match).toBe("SINGLE");
    const rejoined = await joinAs(org, employee.id, "Jane", "Smith");
    expect(rejoined.deviceId).not.toBe(device.id);
    const links = await prisma.employeeUserLink.findMany({ where: { employeeId: employee.id } });
    expect(links).toHaveLength(1);
    expect(links[0]?.unlinkedAt).toBeNull();
    expect(links[0]?.mobileUserId).toBe(
      (await prisma.device.findUniqueOrThrow({ where: { id: rejoined.deviceId } })).mobileUserId,
    );
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } })).inviteStatus,
    ).toBe("JOINED");
  });

  it("refuses an ambiguous name, a mismatching employee id, an inactive employee and bad input", async () => {
    const { org } = await setup();
    const a = await seedEmployee(org, "Sam", "Patel");
    await seedEmployee(org, "Sam", "Patel");
    const solo = await seedEmployee(org, "Only", "One");
    const inactive = await seedEmployee(org, "In", "Active", { employmentStatus: "INACTIVE" });

    const ambiguous = await confirm({
      companyCode: org.joinCode.code,
      employeeId: a.id,
      firstName: "Sam",
      lastName: "Patel",
      device: DEVICE,
    });
    expect(ambiguous.status).toBe(409);
    expect(errorOf(ambiguous).code).toBe("AMBIGUOUS_MATCH");

    // The name resolves to `solo`, but the phone claims somebody else.
    const mismatch = await confirm({
      companyCode: org.joinCode.code,
      employeeId: a.id,
      firstName: "Only",
      lastName: "One",
      device: DEVICE,
    });
    expect(mismatch.status).toBe(404);
    expect(errorOf(mismatch).code).toBe("EMPLOYEE_NOT_FOUND");

    const notActive = await confirm({
      companyCode: org.joinCode.code,
      employeeId: inactive.id,
      firstName: "In",
      lastName: "Active",
      device: DEVICE,
    });
    expect(notActive.status).toBe(404);
    expect(errorOf(notActive).code).toBe("EMPLOYEE_NOT_FOUND");

    const badCode = await confirm({
      companyCode: "NOPE-0000",
      employeeId: solo.id,
      firstName: "Only",
      lastName: "One",
      device: DEVICE,
    });
    expect(badCode.status).toBe(404);
    expect(errorOf(badCode).code).toBe("INVALID_COMPANY_CODE");

    const leaky = await confirm({
      companyCode: org.joinCode.code,
      employeeId: solo.id,
      firstName: "Only",
      lastName: "One",
      device: { ...DEVICE, identifierForVendor: "ABC" },
    });
    expect(leaky.status).toBe(400);
    expect(errorOf(leaky).code).toBe("VALIDATION_ERROR");
    const noDevice = await confirm({
      companyCode: org.joinCode.code,
      employeeId: solo.id,
      firstName: "Only",
      lastName: "One",
    });
    expect(noDevice.status).toBe(400);

    expect(await prisma.device.count({ where: { organisationId: org.organisation.id } })).toBe(0);
    expect(await prisma.employeeUserLink.count({ where: { employee: { organisationId: org.organisation.id } } })).toBe(0);
  });

  it("lets an employee whose phone the manager deactivated join again from a new phone", async () => {
    const { org } = await setup();
    const { employee, device: oldDevice } = await createTestDevice(org.organisation.id);
    // What `POST /api/devices/:id/deactivate` does: the device is retired, the link row is left as is.
    await prisma.device.update({
      where: { id: oldDevice.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });

    const found = await lookup({
      companyCode: org.joinCode.code,
      firstName: employee.firstName,
      lastName: employee.lastName,
    });
    expect(found.body.match).toBe("SINGLE");
    const joined = await joinAs(org, employee.id, employee.firstName, employee.lastName);
    expect(joined.deviceId).not.toBe(oldDevice.id);
    const devices = await prisma.device.findMany({ where: { employeeId: employee.id }, orderBy: { createdAt: "asc" } });
    expect(devices.map((d) => d.isActive)).toEqual([false, true]);
    const link = await prisma.employeeUserLink.findUniqueOrThrow({ where: { employeeId: employee.id } });
    expect(link.mobileUserId).toBe(devices[1]?.mobileUserId);
    expect(link.unlinkedAt).toBeNull();
  });

  it("leave-workplace ends a running break and keeps INVITED when another live invite exists", async () => {
    const { org } = await setup();
    const employee = await seedEmployee(org, "Brk", "Taker");
    const joined = await joinAs(org, employee.id, "Brk", "Taker");
    const now = Date.now();
    const shift = await prisma.shift.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        startsAt: new Date(now - HOUR),
        endsAt: new Date(now + 3 * HOUR),
        timezone: org.organisation.timezone,
      },
    });
    const breakSession = await prisma.breakSession.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        shiftId: shift.id,
        deviceId: joined.deviceId,
        startedAt: new Date(now - 5 * 60_000),
        plannedEndsAt: new Date(now + 10 * 60_000),
        clientBreakId: randomUUID(),
      },
    });
    // A manager re-invited them in the meantime (e.g. for a second phone): the invite survives leaving.
    await seedInvite(org, employee.id);

    const left = await callRoute<OkResponse>(leaveRoute, {
      method: "POST",
      path: "/api/mobile/v1/leave-workplace",
      headers: bearer(joined.accessToken),
      body: {},
    });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(await prisma.breakSession.findUniqueOrThrow({ where: { id: breakSession.id } })).toMatchObject({
      status: "ENDED",
      endReason: "EMPLOYEE_ENDED",
    });
    expect(
      await prisma.activityEvent.count({
        where: { employeeId: employee.id, type: "BREAK_ENDED", actorType: "EMPLOYEE_DEVICE", deviceId: joined.deviceId },
      }),
    ).toBe(1);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } })).inviteStatus,
    ).toBe("INVITED");
    // Shifts are kept.
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe("SCHEDULED");
  });
});

describe("POST /api/mobile/v1/auth/refresh and /logout", () => {
  it("validates the token shape, maps unknown tokens to INVALID_TOKEN and logout without a body revokes every token of the device", async () => {
    const { org } = await setup();
    const employee = await seedEmployee(org, "Tok", "Ens");
    const joined = await joinAs(org, employee.id, "Tok", "Ens");

    const short = await refresh("short");
    expect(short.status).toBe(400);
    expect(errorOf(short).code).toBe("VALIDATION_ERROR");
    const unknown = await refresh("x".repeat(43));
    expect(unknown.status).toBe(401);
    expect(errorOf(unknown).code).toBe("INVALID_TOKEN");

    // Rotate once (the old row is marked replaced, the successor is the only usable token), then a
    // body-less logout revokes every token of the device.
    const rotated = await refresh(joined.refreshToken);
    expect(rotated.status).toBe(200);
    expect(
      await prisma.refreshToken.count({
        where: { deviceId: joined.deviceId, revokedAt: null, replacedById: null },
      }),
    ).toBe(1);
    const loggedOut = await callRoute(logoutRoute, {
      method: "POST",
      path: "/api/mobile/v1/auth/logout",
      headers: bearer(joined.accessToken),
      body: {},
    });
    expect(loggedOut.status).toBe(204);
    expect(await prisma.refreshToken.count({ where: { deviceId: joined.deviceId, revokedAt: null } })).toBe(0);
    const afterLogout = await refresh(mobileTokensSchema.parse(rotated.body).refreshToken);
    expect(afterLogout.status).toBe(401);
    expect(errorOf(afterLogout).code).toBe("TOKEN_REUSED");

    // A refresh token of ANOTHER device presented at logout only revokes this device's tokens.
    const otherEmployee = await seedEmployee(org, "Other", "Phone");
    const other = await joinAs(org, otherEmployee.id, "Other", "Phone");
    const crossLogout = await callRoute(logoutRoute, {
      method: "POST",
      path: "/api/mobile/v1/auth/logout",
      headers: bearer(joined.accessToken),
      body: { refreshToken: other.refreshToken },
    });
    expect(crossLogout.status).toBe(204);
    expect(await prisma.refreshToken.count({ where: { deviceId: other.deviceId, revokedAt: null } })).toBe(1);
    expect((await refresh(other.refreshToken)).status).toBe(200);
  });
});
