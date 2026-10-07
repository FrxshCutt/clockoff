import { prisma } from "@clockoff/db";
import type {
  EmployeeDetailResponse,
  EmployeeResponse,
  ListEmployeesResponse,
} from "@clockoff/validation/employees";
import {
  createEmployeeInviteResponseSchema,
  employeeInviteResponseSchema,
  inviteInstructionsResponseSchema,
  type CreateEmployeeInviteResponse,
  type EmployeeInviteResponse,
  type InviteInstructionsResponse,
} from "@clockoff/validation/invites";
import { describe, expect, it } from "vitest";
import { POST as createInviteRoute } from "@/app/api/employees/[id]/invites/route";
import { GET as getEmployeeRoute } from "@/app/api/employees/[id]/route";
import { GET as listEmployeesRoute, POST as createEmployeeRoute } from "@/app/api/employees/route";
import { GET as instructionsRoute } from "@/app/api/invites/[id]/instructions/route";
import { POST as resendRoute } from "@/app/api/invites/[id]/resend/route";
import { POST as revokeRoute } from "@/app/api/invites/[id]/revoke/route";
import {
  callRoute,
  createTestDevice,
  createTestOrg,
  loginAs,
  testEmails,
  type CookieJar,
  type ErrorBody,
} from "../helpers";

const INVITE_CODE = /^[BCDFGHJ-NP-TV-XZ2-9]{6}$/;
const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const org = await createTestOrg({ firstLocationName: "High Street" });
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  return { org, jar };
}

async function createEmployee(jar: CookieJar, body: Record<string, unknown>) {
  const res = await callRoute<EmployeeResponse>(createEmployeeRoute, {
    method: "POST",
    path: "/api/employees",
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.employee;
}

async function invite(jar: CookieJar, employeeId: string, body: Record<string, unknown> = {}) {
  return callRoute<CreateEmployeeInviteResponse>(createInviteRoute, {
    method: "POST",
    path: `/api/employees/${employeeId}/invites`,
    params: { id: employeeId },
    jar,
    body,
  });
}

async function inviteStatusOf(employeeId: string) {
  return (await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } })).inviteStatus;
}

async function getDetail(jar: CookieJar, employeeId: string) {
  const res = await callRoute<EmployeeDetailResponse>(getEmployeeRoute, {
    path: `/api/employees/${employeeId}`,
    params: { id: employeeId },
    jar,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.employee;
}

/** Ids returned by `GET /api/employees?inviteStatus=…`. */
async function listedWith(jar: CookieJar, inviteStatus: string) {
  const res = await callRoute<ListEmployeesResponse>(listEmployeesRoute, {
    path: "/api/employees",
    jar,
    query: { inviteStatus },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items.map((e) => e.id);
}

describe("POST /api/employees/:id/invites", () => {
  it("LINK: creates a SENT invite with instructions and moves the employee to INVITED", async () => {
    const { org, jar } = await setup();
    const employee = await createEmployee(jar, { firstName: "Jane", lastName: "Smith" });
    const res = await invite(jar, employee.id, { channel: "LINK" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = createEmployeeInviteResponseSchema.parse(res.body);
    expect(body.invite).toMatchObject({
      employeeId: employee.id,
      channel: "LINK",
      status: "SENT",
      acceptedAt: null,
      revokedAt: null,
    });
    expect(body.invite.code).toMatch(INVITE_CODE);
    expect(body.invite.sentAt).not.toBeNull();
    const expiresIn = Date.parse(body.invite.expiresAt) - Date.now();
    expect(expiresIn).toBeGreaterThan(13 * DAY);
    expect(expiresIn).toBeLessThanOrEqual(14 * DAY);

    expect(body.instructions).toMatchObject({
      employee: { id: employee.id, firstName: "Jane", lastName: "Smith" },
      companyCode: org.joinCode.code,
      inviteCode: body.invite.code,
    });
    expect(body.instructions.steps.length).toBeGreaterThanOrEqual(5);
    expect(body.instructions.canSee.length).toBeGreaterThan(0);
    expect(body.instructions.cannotSee.length).toBeGreaterThan(0);
    expect(body.instructions.copyText).toContain(org.joinCode.code);
    expect(body.instructions.copyText).toContain(body.invite.code);
    expect(body.instructions.copyText).toContain("cannot see");
    expect(() => new URL(body.instructions.appStoreUrl)).not.toThrow();

    expect(await inviteStatusOf(employee.id)).toBe("INVITED");
    expect(
      await prisma.auditLog.count({
        where: { action: "employee.invite_created", entityId: body.invite.id },
      }),
    ).toBe(1);
    // No activity event until the employee actually joins.
    expect(await prisma.activityEvent.count({ where: { employeeId: employee.id } })).toBe(0);
    // No email for LINK.
    expect(testEmails().sent).toHaveLength(0);

    // A new invite supersedes the previous live one.
    const second = await invite(jar, employee.id, {});
    expect(second.status).toBe(201);
    expect(
      (await prisma.employeeInvite.findUniqueOrThrow({ where: { id: body.invite.id } })).status,
    ).toBe("REVOKED");
    expect(second.body.invite.code).not.toBe(body.invite.code);
    expect(await inviteStatusOf(employee.id)).toBe("INVITED");

    const detail = await callRoute<EmployeeDetailResponse>(getEmployeeRoute, {
      path: `/api/employees/${employee.id}`,
      params: { id: employee.id },
      jar,
    });
    expect(detail.body.employee.latestInvite?.id).toBe(second.body.invite.id);
  });

  it("EMAIL: needs an address, emails the instructions and marks the invite SENT", async () => {
    const { org, jar } = await setup();
    const noEmail = await createEmployee(jar, { firstName: "No", lastName: "Mail" });
    const refused = await invite(jar, noEmail.id, { channel: "EMAIL" });
    expect(refused.status).toBe(400);
    expect((refused.body as unknown as ErrorBody).error.details).toMatchObject({
      fieldErrors: { channel: [expect.any(String)] },
    });

    const employee = await createEmployee(jar, {
      firstName: "Mail",
      lastName: "Me",
      email: "mail.me@example.test",
    });
    const res = await invite(jar, employee.id, { channel: "EMAIL" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.invite).toMatchObject({ channel: "EMAIL", status: "SENT" });
    const sent = testEmails().sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("mail.me@example.test");
    expect(sent[0]?.subject).toContain(org.organisation.name);
    expect(sent[0]?.text).toContain(res.body.invite.code);
    expect(sent[0]?.text).toContain(org.joinCode.code);
    // No login link is ever mailed: joining is by code + name.
    expect(sent[0]?.text).not.toContain("token=");
  });

  it("SMS is not available yet (501 COMING_SOON) and needs a phone number", async () => {
    const { jar } = await setup();
    const noPhone = await createEmployee(jar, { firstName: "No", lastName: "Phone" });
    const missing = await invite(jar, noPhone.id, { channel: "SMS" });
    expect(missing.status).toBe(400);

    const withPhone = await createEmployee(jar, {
      firstName: "Has",
      lastName: "Phone",
      phone: "+44 7700 900123",
    });
    const res = await invite(jar, withPhone.id, { channel: "SMS" });
    expect(res.status).toBe(501);
    expect((res.body as unknown as ErrorBody).error.code).toBe("COMING_SOON");
    expect(await prisma.employeeInvite.count({ where: { employeeId: withPhone.id } })).toBe(0);
    expect(await inviteStatusOf(withPhone.id)).toBe("NOT_INVITED");
  });

  it("refuses inactive and already-linked employees and unknown ids", async () => {
    const { org, jar } = await setup();
    const inactive = await prisma.employee.create({
      data: {
        organisationId: org.organisation.id,
        firstName: "In",
        lastName: "Active",
        employmentStatus: "INACTIVE",
        inviteStatus: "DEACTIVATED",
      },
    });
    const a = await invite(jar, inactive.id);
    expect(a.status).toBe(409);
    expect((a.body as unknown as ErrorBody).error.code).toBe("EMPLOYEE_INACTIVE");

    const { employee: linked } = await createTestDevice(org.organisation.id);
    const b = await invite(jar, linked.id);
    expect(b.status).toBe(409);
    expect((b.body as unknown as ErrorBody).error.code).toBe("EMPLOYEE_ALREADY_LINKED");

    const c = await invite(jar, org.owner.id);
    expect(c.status).toBe(404);
    expect((c.body as unknown as ErrorBody).error.code).toBe("EMPLOYEE_NOT_FOUND");

    const d = await invite(jar, linked.id, { channel: "FAX" });
    expect(d.status).toBe(400);
  });

  it("re-invites an employee whose only phone was deactivated: the dead link is ended and they read INVITED", async () => {
    const { org, jar } = await setup();
    // What `POST /api/devices/:id/deactivate` leaves behind: an active link whose every device is inactive.
    const { employee, device } = await createTestDevice(org.organisation.id, { isActive: false });
    expect((await getDetail(jar, employee.id)).inviteStatus).toBe("DEACTIVATED");

    const res = await invite(jar, employee.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.invite.status).toBe("SENT");
    expect(
      (await prisma.employeeUserLink.findUniqueOrThrow({ where: { employeeId: employee.id } }))
        .unlinkedAt,
    ).not.toBeNull();
    expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).isActive).toBe(
      false,
    );
    expect(await inviteStatusOf(employee.id)).toBe("INVITED");
    expect((await getDetail(jar, employee.id)).inviteStatus).toBe("INVITED");
    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: "employee.invite_created", entityId: res.body.invite.id },
    });
    expect(auditRow.after).toMatchObject({ endedDeadLink: true });

    // Re-sending it is fine (nothing left to unlink)…
    const resent = await callRoute<EmployeeInviteResponse>(resendRoute, {
      method: "POST",
      path: `/api/invites/${res.body.invite.id}/resend`,
      params: { id: res.body.invite.id },
      jar,
      body: {},
    });
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    expect(await inviteStatusOf(employee.id)).toBe("INVITED");

    // …while an employee whose phone IS still in use stays EMPLOYEE_ALREADY_LINKED and keeps the link.
    const active = await createTestDevice(org.organisation.id);
    const refused = await invite(jar, active.employee.id);
    expect(refused.status).toBe(409);
    expect((refused.body as unknown as ErrorBody).error.code).toBe("EMPLOYEE_ALREADY_LINKED");
    expect(
      (
        await prisma.employeeUserLink.findUniqueOrThrow({
          where: { employeeId: active.employee.id },
        })
      ).unlinkedAt,
    ).toBeNull();
  });
});

describe("invite lifecycle: instructions → resend → revoke", () => {
  it("walks the lifecycle and keeps employee.inviteStatus in step", async () => {
    const { org, jar } = await setup();
    const employee = await createEmployee(jar, {
      firstName: "Life",
      lastName: "Cycle",
      email: "life@example.test",
    });
    const created = await invite(jar, employee.id);
    const inviteId = created.body.invite.id;

    const instructions = await callRoute<InviteInstructionsResponse>(instructionsRoute, {
      path: `/api/invites/${inviteId}/instructions`,
      params: { id: inviteId },
      jar,
    });
    expect(instructions.status).toBe(200);
    const parsed = inviteInstructionsResponseSchema.parse(instructions.body);
    expect(parsed.instructions.inviteCode).toBe(created.body.invite.code);
    expect(parsed.instructions.companyCode).toBe(org.joinCode.code);

    // Revoking the company code is reflected in the instructions (null) rather than hidden.
    await prisma.companyJoinCode.update({
      where: { id: org.joinCode.id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    const withoutCode = await callRoute<InviteInstructionsResponse>(instructionsRoute, {
      path: `/api/invites/${inviteId}/instructions`,
      params: { id: inviteId },
      jar,
    });
    expect(withoutCode.body.instructions.companyCode).toBeNull();
    expect(withoutCode.body.instructions.copyText).toContain("revoked");
    await prisma.companyJoinCode.update({
      where: { id: org.joinCode.id },
      data: { status: "ACTIVE", revokedAt: null },
    });

    // Resend extends the expiry and may switch channel (EMAIL → an email goes out).
    await prisma.employeeInvite.update({
      where: { id: inviteId },
      data: { expiresAt: new Date(Date.now() + DAY) },
    });
    const resent = await callRoute<EmployeeInviteResponse>(resendRoute, {
      method: "POST",
      path: `/api/invites/${inviteId}/resend`,
      params: { id: inviteId },
      jar,
      body: { channel: "EMAIL" },
    });
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    const resentInvite = employeeInviteResponseSchema.parse(resent.body).invite;
    expect(resentInvite).toMatchObject({ id: inviteId, channel: "EMAIL", status: "SENT" });
    expect(resentInvite.code).toBe(created.body.invite.code);
    expect(Date.parse(resentInvite.expiresAt) - Date.now()).toBeGreaterThan(13 * DAY);
    expect(testEmails().sent.map((m) => m.to)).toEqual(["life@example.test"]);
    expect(
      await prisma.auditLog.count({
        where: { action: "employee.invite_resent", entityId: inviteId },
      }),
    ).toBe(1);
    expect(await inviteStatusOf(employee.id)).toBe("INVITED");

    // Revoke → REVOKED; no other live invite and not linked → NOT_INVITED. Idempotent.
    const revoked = await callRoute<EmployeeInviteResponse>(revokeRoute, {
      method: "POST",
      path: `/api/invites/${inviteId}/revoke`,
      params: { id: inviteId },
      jar,
      body: {},
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.invite.status).toBe("REVOKED");
    expect(revoked.body.invite.revokedAt).not.toBeNull();
    expect(await inviteStatusOf(employee.id)).toBe("NOT_INVITED");
    const again = await callRoute<EmployeeInviteResponse>(revokeRoute, {
      method: "POST",
      path: `/api/invites/${inviteId}/revoke`,
      params: { id: inviteId },
      jar,
      body: {},
    });
    expect(again.status).toBe(200);
    expect(
      await prisma.auditLog.count({
        where: { action: "employee.invite_revoked", entityId: inviteId },
      }),
    ).toBe(1);

    // A revoked invite can neither be re-sent nor shared.
    const resendRevoked = await callRoute<ErrorBody>(resendRoute, {
      method: "POST",
      path: `/api/invites/${inviteId}/resend`,
      params: { id: inviteId },
      jar,
      body: {},
    });
    expect(resendRevoked.status).toBe(400);
    expect(resendRevoked.body.error.code).toBe("INVITE_INVALID");
    const shareRevoked = await callRoute<ErrorBody>(instructionsRoute, {
      path: `/api/invites/${inviteId}/instructions`,
      params: { id: inviteId },
      jar,
    });
    expect(shareRevoked.status).toBe(400);
    expect(shareRevoked.body.error.code).toBe("INVITE_INVALID");
  });

  it("an expired invite reads as EXPIRED, drops the employee back to NOT_INVITED and can be revived by a resend", async () => {
    const { jar } = await setup();
    const employee = await createEmployee(jar, { firstName: "Ex", lastName: "Pired" });
    const created = await invite(jar, employee.id);
    const inviteId = created.body.invite.id;
    expect(await listedWith(jar, "INVITED")).toContain(employee.id);
    await prisma.employeeInvite.update({
      where: { id: inviteId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const detail = await getDetail(jar, employee.id);
    expect(detail.latestInvite?.status).toBe("EXPIRED");
    // Nothing recomputed the stored column (expiry is passive), yet the API derives the lifecycle live:
    // the detail, the list and the `inviteStatus` filter all agree the employee is NOT_INVITED again.
    expect(await inviteStatusOf(employee.id)).toBe("INVITED");
    expect(detail.inviteStatus).toBe("NOT_INVITED");
    expect(await listedWith(jar, "INVITED")).not.toContain(employee.id);
    expect(await listedWith(jar, "NOT_INVITED")).toContain(employee.id);
    expect(await listedWith(jar, "NOT_INVITED,INVITED")).toContain(employee.id);
    expect(await listedWith(jar, "JOINED,DEACTIVATED")).not.toContain(employee.id);

    const resent = await callRoute<EmployeeInviteResponse>(resendRoute, {
      method: "POST",
      path: `/api/invites/${inviteId}/resend`,
      params: { id: inviteId },
      jar,
      body: {},
    });
    expect(resent.status).toBe(200);
    expect(resent.body.invite.status).toBe("SENT");
    expect(await inviteStatusOf(employee.id)).toBe("INVITED");
    expect((await getDetail(jar, employee.id)).inviteStatus).toBe("INVITED");
    expect(await listedWith(jar, "INVITED")).toContain(employee.id);
    expect(await listedWith(jar, "NOT_INVITED")).not.toContain(employee.id);
  });

  it("unknown invite ids are 404 INVITE_INVALID", async () => {
    const { org, jar } = await setup();
    for (const [handler, method] of [
      [instructionsRoute, "GET"],
      [resendRoute, "POST"],
      [revokeRoute, "POST"],
    ] as const) {
      const res = await callRoute<ErrorBody>(handler, {
        method,
        path: `/api/invites/${org.owner.id}/x`,
        params: { id: org.owner.id },
        jar,
        ...(method === "POST" ? { body: {} } : {}),
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("INVITE_INVALID");
    }
  });
});
