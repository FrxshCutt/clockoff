import { prisma } from "@workmode/db";
import { NOTIFICATION_PREFERENCE_DEFAULTS } from "@workmode/validation/notifications";
import type { BillingResponse, SettingsResponse } from "@workmode/validation/settings";
import { describe, expect, it } from "vitest";
import { POST as requestDemoRoute } from "@/app/api/request-demo/route";
import { GET as billingRoute } from "@/app/api/settings/billing/route";
import { GET as getSettingsRoute, PATCH as patchSettingsRoute } from "@/app/api/settings/route";
import {
  addMember,
  callRoute,
  createTestOrg,
  createTestUser,
  loginAs,
  uniqueEmail,
  type ErrorBody,
} from "../helpers";

async function setup() {
  const org = await createTestOrg({ firstLocationName: "High Street" });
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  return { org, jar };
}

describe("GET /api/settings", () => {
  it("returns the organisation, the caller's role and their notification preferences (defaults applied)", async () => {
    const { org, jar } = await setup();
    const res = await callRoute<SettingsResponse>(getSettingsRoute, { path: "/api/settings", jar });
    expect(res.status).toBe(200);
    expect(res.body.organisation).toMatchObject({
      id: org.organisation.id,
      name: org.organisation.name,
    });
    expect(res.body.role).toBe("OWNER");
    expect(res.body.notificationPreferences).toEqual(NOTIFICATION_PREFERENCE_DEFAULTS);
  });
});

describe("PATCH /api/settings", () => {
  it("updates the caller's own notification preferences (merged over defaults) and audits", async () => {
    const { org, jar } = await setup();
    const { user: colleague } = await createTestUser();
    const colleagueMembership = await addMember(org.organisation.id, colleague, "ADMIN");

    const res = await callRoute<SettingsResponse>(patchSettingsRoute, {
      method: "PATCH",
      path: "/api/settings",
      jar,
      body: {
        notificationPreferences: {
          EMPLOYEE_JOINED: { email: true },
          OVERRIDE_EXPIRED: { inApp: false },
        },
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.notificationPreferences).toEqual({
      ...NOTIFICATION_PREFERENCE_DEFAULTS,
      EMPLOYEE_JOINED: { inApp: true, email: true },
      OVERRIDE_EXPIRED: { inApp: false, email: false },
    });

    const stored = await prisma.organisationMembership.findUniqueOrThrow({
      where: { id: org.membership.id },
    });
    expect(stored.notificationPreferences).toMatchObject({
      EMPLOYEE_JOINED: { inApp: true, email: true },
    });
    const untouched = await prisma.organisationMembership.findUniqueOrThrow({
      where: { id: colleagueMembership.id },
    });
    expect(untouched.notificationPreferences).toEqual({});

    const auditRow = await prisma.auditLog.findFirst({
      where: {
        organisationId: org.organisation.id,
        action: "membership.notification_preferences_updated",
      },
    });
    expect(auditRow?.entityId).toBe(org.membership.id);

    const again = await callRoute<SettingsResponse>(getSettingsRoute, {
      path: "/api/settings",
      jar,
    });
    expect(again.body.notificationPreferences.EMPLOYEE_JOINED).toEqual({
      inApp: true,
      email: true,
    });
  });

  it("requires org:manage for organisation fields and writes nothing when refused", async () => {
    const { org } = await setup();
    const { user } = await createTestUser();
    await addMember(org.organisation.id, user, "MANAGER");
    const jar = await loginAs(user, { organisationId: org.organisation.id });

    const res = await callRoute<ErrorBody>(patchSettingsRoute, {
      method: "PATCH",
      path: "/api/settings",
      jar,
      body: {
        organisation: { name: "Hijacked" },
        notificationPreferences: { EMPLOYEE_JOINED: { email: true } },
      },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    const org2 = await prisma.organisation.findUniqueOrThrow({
      where: { id: org.organisation.id },
    });
    expect(org2.name).toBe(org.organisation.name);
    const membership = await prisma.organisationMembership.findFirstOrThrow({
      where: { organisationId: org.organisation.id, userId: user.id },
    });
    expect(membership.notificationPreferences).toEqual({});

    // Managers may still change their own preferences.
    const own = await callRoute<SettingsResponse>(patchSettingsRoute, {
      method: "PATCH",
      path: "/api/settings",
      jar,
      body: { notificationPreferences: { DEVICE_SYNC_DELAYED: { inApp: false } } },
    });
    expect(own.status).toBe(200);
    expect(own.body.role).toBe("MANAGER");
    expect(own.body.notificationPreferences.DEVICE_SYNC_DELAYED).toEqual({
      inApp: false,
      email: false,
    });
  });

  it("lets an OWNER update organisation fields through the audited organisations path", async () => {
    const { org, jar } = await setup();
    const res = await callRoute<SettingsResponse>(patchSettingsRoute, {
      method: "PATCH",
      path: "/api/settings",
      jar,
      body: { organisation: { name: "Renamed via settings", settings: { timeFormat: "H12" } } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.organisation).toMatchObject({
      name: "Renamed via settings",
      settings: { timeFormat: "H12", weekStartsOn: "MONDAY" },
    });
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "organisation.updated" },
      }),
    ).toBe(1);
  });

  it("rejects an empty patch and unknown keys", async () => {
    const { jar } = await setup();
    const empty = await callRoute<ErrorBody>(patchSettingsRoute, {
      method: "PATCH",
      path: "/api/settings",
      jar,
      body: {},
    });
    expect(empty.status).toBe(400);
    const unknown = await callRoute<ErrorBody>(patchSettingsRoute, {
      method: "PATCH",
      path: "/api/settings",
      jar,
      body: { theme: "dark" },
    });
    expect(unknown.status).toBe(400);
  });

  it("rejects an invalid IANA timezone before anything is written (VALIDATION_ERROR, not INVALID_TIMEZONE)", async () => {
    const { org, jar } = await setup();
    const res = await callRoute<ErrorBody>(patchSettingsRoute, {
      method: "PATCH",
      path: "/api/settings",
      jar,
      body: { organisation: { timezone: "Mars/Olympus" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toMatchObject({ source: "body" });
    const row = await prisma.organisation.findUniqueOrThrow({ where: { id: org.organisation.id } });
    expect(row.timezone).toBe(org.organisation.timezone);
  });
});

describe("GET /api/settings/billing", () => {
  it("reports the plan, its limits, live usage and the plan catalogue", async () => {
    const { org, jar } = await setup();
    await prisma.employee.createMany({
      data: [
        { organisationId: org.organisation.id, firstName: "A", lastName: "Active" },
        {
          organisationId: org.organisation.id,
          firstName: "B",
          lastName: "Inactive",
          employmentStatus: "INACTIVE",
        },
      ],
    });
    await prisma.integration.create({
      data: { organisationId: org.organisation.id, provider: "PLANDAY", status: "CONNECTED" },
    });

    const res = await callRoute<BillingResponse>(billingRoute, {
      path: "/api/settings/billing",
      jar,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      plan: "STARTER",
      planName: "Starter",
      billingStatus: "TRIAL",
      limits: { employees: 25, locations: 1, integrations: 0 },
      usage: { employees: 1, locations: 1, integrations: 1 },
      trialEndsAt: null,
      manageUrl: null,
    });
    expect(res.body.plans?.map((p) => p.id)).toEqual(["STARTER", "BUSINESS", "PRO", "ENTERPRISE"]);
    expect(res.body.plans?.find((p) => p.isCurrent)?.id).toBe("STARTER");
    expect(res.body.plans?.find((p) => p.id === "ENTERPRISE")?.limits.employees).toBe("UNLIMITED");
  });
});

// The public marketing form is organisation-level API surface too (no tenant yet).
describe("POST /api/request-demo", () => {
  const valid = {
    name: "Dana Manager",
    email: uniqueEmail("demo"),
    company: "Harbour Cafe",
    teamSize: "10-25",
    message: "We run three cafes.",
    source: "pricing",
  };

  it("stores the request and answers { ok: true } without a session", async () => {
    const res = await callRoute<{ ok: true }>(requestDemoRoute, {
      method: "POST",
      path: "/api/request-demo",
      body: valid,
      ip: "203.0.113.10",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const row = await prisma.demoRequest.findFirst({ where: { email: valid.email } });
    expect(row).toMatchObject({
      name: valid.name,
      company: valid.company,
      teamSize: "10-25",
      source: "pricing",
    });
  });

  it("silently drops submissions that fill the honeypot", async () => {
    const email = uniqueEmail("bot");
    const res = await callRoute<{ ok: true }>(requestDemoRoute, {
      method: "POST",
      path: "/api/request-demo",
      body: { ...valid, email, website: "https://spam.example" },
      ip: "203.0.113.11",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await prisma.demoRequest.count({ where: { email } })).toBe(0);
  });

  it("validates strictly and refuses foreign origins", async () => {
    const invalid = await callRoute<ErrorBody>(requestDemoRoute, {
      method: "POST",
      path: "/api/request-demo",
      body: { name: "", email: "nope", company: "X" },
      ip: "203.0.113.12",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

    const unknownField = await callRoute<ErrorBody>(requestDemoRoute, {
      method: "POST",
      path: "/api/request-demo",
      body: { ...valid, phoneContacts: [] },
      ip: "203.0.113.12",
    });
    expect(unknownField.status).toBe(400);

    const foreign = await callRoute<ErrorBody>(requestDemoRoute, {
      method: "POST",
      path: "/api/request-demo",
      body: valid,
      origin: "https://evil.example",
      ip: "203.0.113.13",
    });
    expect(foreign.status).toBe(403);
  });

  it("is rate limited to 5 per hour per IP", async () => {
    const ip = "203.0.113.99";
    for (let i = 0; i < 5; i++) {
      const res = await callRoute(requestDemoRoute, {
        method: "POST",
        path: "/api/request-demo",
        body: { ...valid, email: uniqueEmail(`rl${i}`) },
        ip,
      });
      expect(res.status).toBe(200);
    }
    const blocked = await callRoute<ErrorBody>(requestDemoRoute, {
      method: "POST",
      path: "/api/request-demo",
      body: { ...valid, email: uniqueEmail("rl-blocked") },
      ip,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });
});
