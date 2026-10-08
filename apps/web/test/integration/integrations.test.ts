import { randomUUID } from "node:crypto";
import { prisma } from "@clockoff/db";
import { INTEGRATION_PROVIDERS } from "@clockoff/shared/enums";
import type {
  IntegrationResponse,
  ListIntegrationsResponse,
} from "@clockoff/validation/integrations";
import type { CurrentUser } from "@clockoff/validation/auth";
import { describe, expect, it } from "vitest";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { POST as connectRoute } from "@/app/api/integrations/[provider]/connect/route";
import { POST as disconnectRoute } from "@/app/api/integrations/[provider]/disconnect/route";
import { POST as notifyMeRoute } from "@/app/api/integrations/[provider]/notify-me/route";
import { POST as syncRoute } from "@/app/api/integrations/[provider]/sync/route";
import { GET as listRoute } from "@/app/api/integrations/route";
import { resetEnvCache } from "@/lib/env";
import {
  addMember,
  callRoute,
  createTestOrg,
  createTestUser,
  loginAs,
  type ErrorBody,
} from "../helpers";

async function setup() {
  const org = await createTestOrg();
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  return { org, jar };
}

describe("GET /api/integrations", () => {
  it("lists every provider in enum order as COMING_SOON / NOT_CONNECTED", async () => {
    const { jar } = await setup();
    const res = await callRoute<ListIntegrationsResponse>(listRoute, {
      path: "/api/integrations",
      jar,
    });
    expect(res.status).toBe(200);
    expect(res.body.integrations.map((i) => i.provider)).toEqual([...INTEGRATION_PROVIDERS]);
    for (const integration of res.body.integrations) {
      expect(integration).toMatchObject({
        availability: "COMING_SOON",
        status: "NOT_CONNECTED",
        notifyRequested: false,
        lastSyncAt: null,
        lastError: null,
        externalAccountName: null,
      });
      expect(integration.supportedActivationModes).toContain(integration.activationMode);
      expect(integration.website).toMatch(/^https:\/\//);
    }
    expect(res.body.integrations.find((i) => i.provider === "SEVENSHIFTS")?.displayName).toBe(
      "7shifts",
    );
  });
});

describe("connect / sync while providers are coming soon", () => {
  it("answers 501 COMING_SOON naming the provider, accepting kebab-case ids", async () => {
    const { org, jar } = await setup();
    const connect = await callRoute<ErrorBody>(connectRoute, {
      method: "POST",
      path: "/api/integrations/planday/connect",
      params: { provider: "planday" },
      jar,
      body: { activationMode: "SCHEDULED" },
    });
    expect(connect.status).toBe(501);
    expect(connect.body.error.code).toBe("COMING_SOON");
    expect(connect.body.error.details).toEqual({ provider: "PLANDAY" });

    const sync = await callRoute<ErrorBody>(syncRoute, {
      method: "POST",
      path: "/api/integrations/when-i-work/sync",
      params: { provider: "when-i-work" },
      jar,
      body: {},
    });
    expect(sync.status).toBe(501);
    expect(sync.body.error.details).toEqual({ provider: "WHEN_I_WORK" });
    expect(await prisma.integration.count({ where: { organisationId: org.organisation.id } })).toBe(
      0,
    );
  });

  it("validates the provider segment and the body", async () => {
    const { jar } = await setup();
    const unknown = await callRoute<ErrorBody>(connectRoute, {
      method: "POST",
      path: "/api/integrations/slack/connect",
      params: { provider: "slack" },
      jar,
      body: {},
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("VALIDATION_ERROR");

    const halfOauth = await callRoute<ErrorBody>(connectRoute, {
      method: "POST",
      path: "/api/integrations/deputy/connect",
      params: { provider: "deputy" },
      jar,
      body: { code: "abc" },
    });
    expect(halfOauth.status).toBe(400);
  });

  it("requires integrations:write (MANAGER → FORBIDDEN)", async () => {
    const { org } = await setup();
    const { user } = await createTestUser();
    await addMember(org.organisation.id, user, "MANAGER");
    const jar = await loginAs(user, { organisationId: org.organisation.id });
    const res = await callRoute<ErrorBody>(connectRoute, {
      method: "POST",
      path: "/api/integrations/planday/connect",
      params: { provider: "planday" },
      jar,
      body: {},
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});

describe("POST /api/integrations/:provider/notify-me", () => {
  it("records the request once, audits it and shows it in the list; any manager may ask", async () => {
    const { org } = await setup();
    const { user } = await createTestUser();
    await addMember(org.organisation.id, user, "MANAGER");
    const jar = await loginAs(user, { organisationId: org.organisation.id });

    const first = await callRoute<IntegrationResponse>(notifyMeRoute, {
      method: "POST",
      path: "/api/integrations/homebase/notify-me",
      params: { provider: "homebase" },
      jar,
      body: {},
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.integration).toMatchObject({
      provider: "HOMEBASE",
      notifyRequested: true,
      status: "NOT_CONNECTED",
      availability: "COMING_SOON",
    });

    const second = await callRoute<IntegrationResponse>(notifyMeRoute, {
      method: "POST",
      path: "/api/integrations/homebase/notify-me",
      params: { provider: "homebase" },
      jar,
      body: {},
    });
    expect(second.status).toBe(200);

    const rows = await prisma.integration.findMany({
      where: { organisationId: org.organisation.id },
    });
    expect(rows).toEqual([
      expect.objectContaining({ provider: "HOMEBASE", notifyRequested: true }),
    ]);
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "integration.notify_requested" },
      }),
    ).toBe(1);

    const list = await callRoute<ListIntegrationsResponse>(listRoute, {
      path: "/api/integrations",
      jar,
    });
    expect(list.body.integrations.find((i) => i.provider === "HOMEBASE")?.notifyRequested).toBe(
      true,
    );
    expect(list.body.integrations.find((i) => i.provider === "PLANDAY")?.notifyRequested).toBe(
      false,
    );
  });
});

describe("POST /api/integrations/:provider/disconnect", () => {
  it("is a no-op for a provider that was never connected", async () => {
    const { org, jar } = await setup();
    const res = await callRoute<IntegrationResponse>(disconnectRoute, {
      method: "POST",
      path: "/api/integrations/rotaready/disconnect",
      params: { provider: "rotaready" },
      jar,
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.integration).toMatchObject({ provider: "ROTAREADY", status: "NOT_CONNECTED" });
    expect(await prisma.integration.count({ where: { organisationId: org.organisation.id } })).toBe(
      0,
    );
  });

  it("accepts the documented { mode } body and rejects an unknown mode", async () => {
    const { jar } = await setup();
    const disconnect = (body: unknown) =>
      callRoute<IntegrationResponse | ErrorBody>(disconnectRoute, {
        method: "POST",
        path: "/api/integrations/deputy/disconnect",
        params: { provider: "deputy" },
        jar,
        body,
      });
    for (const mode of ["KEEP_RECORDS", "CANCEL_FUTURE_SHIFTS"]) {
      const res = await disconnect({ mode });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const bad = await disconnect({ mode: "DELETE_EVERYTHING" });
    expect(bad.status).toBe(400);
    expect((bad.body as ErrorBody).error.code).toBe("VALIDATION_ERROR");
    expect((await disconnect({ mode: "KEEP_RECORDS", extra: true })).status).toBe(400);
  });

  it("wipes stored credentials, keeps the connection row and marks the integration DISCONNECTED", async () => {
    const { org, jar } = await setup();
    const syncedAt = new Date("2026-10-01T09:15:00.000Z");
    const portalId = `test-portal-${randomUUID()}`;
    const integration = await prisma.integration.create({
      data: {
        organisationId: org.organisation.id,
        provider: "DEPUTY",
        status: "CONNECTED",
        settings: { externalAccountName: "Deputy Ltd" },
        connection: {
          create: {
            status: "CONNECTED",
            legacyEncryptedCredentials: new Uint8Array([1, 2, 3]),
            encryptedClientId: new Uint8Array([4]),
            encryptedRefreshToken: new Uint8Array([5]),
            encryptedAccessToken: new Uint8Array([6]),
            accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
            credentialHint: "4f2a",
            credentialVersion: 3,
            externalPortalId: portalId,
            lastSuccessfulSyncAt: syncedAt,
            nextSyncAt: new Date(Date.now() + 900_000),
            syncLeaseId: randomUUID(),
            syncLeaseExpiresAt: new Date(Date.now() + 90_000),
            pendingRunKind: "SYNC",
            pendingRunTrigger: "MANUAL",
            pendingRunRetryAuth: true,
            pendingRunRequestedAt: new Date(),
          },
        },
      },
    });
    const before = await callRoute<ListIntegrationsResponse>(listRoute, {
      path: "/api/integrations",
      jar,
    });
    expect(before.body.integrations.find((i) => i.provider === "DEPUTY")).toMatchObject({
      status: "CONNECTED",
      externalAccountName: "Deputy Ltd",
      lastSyncAt: syncedAt.toISOString(),
    });

    const res = await callRoute<IntegrationResponse>(disconnectRoute, {
      method: "POST",
      path: "/api/integrations/deputy/disconnect",
      params: { provider: "deputy" },
      jar,
      body: {},
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The last successful sync stays as history; only the secrets go.
    expect(res.body.integration).toMatchObject({
      status: "DISCONNECTED",
      lastSyncAt: syncedAt.toISOString(),
    });
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { integrationId: integration.id },
    });
    expect(connection).toMatchObject({
      status: "DISCONNECTED",
      legacyEncryptedCredentials: null,
      encryptedClientId: null,
      encryptedRefreshToken: null,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
      credentialHint: null,
      credentialVersion: 4,
      externalPortalId: portalId,
      lastSuccessfulSyncAt: syncedAt,
      nextSyncAt: null,
      syncLeaseId: null,
      syncLeaseExpiresAt: null,
      pendingRunKind: null,
      pendingRunTrigger: null,
      pendingRunRetryAuth: false,
      pendingRunRequestedAt: null,
    });
    expect(connection.disconnectedAt).toBeInstanceOf(Date);
    expect(
      await prisma.auditLog.findMany({
        where: { organisationId: org.organisation.id, action: "integration.disconnected" },
        select: { after: true },
      }),
    ).toEqual([
      { after: { provider: "DEPUTY", status: "DISCONNECTED", credentialsRemoved: true } },
    ]);

    // Idempotent: a second disconnect changes nothing and audits nothing.
    const again = await callRoute<IntegrationResponse>(disconnectRoute, {
      method: "POST",
      path: "/api/integrations/deputy/disconnect",
      params: { provider: "deputy" },
      jar,
      body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.integration.status).toBe("DISCONNECTED");
    expect(
      await prisma.integrationConnection.findUniqueOrThrow({
        where: { integrationId: integration.id },
      }),
    ).toMatchObject({ credentialVersion: 4, status: "DISCONNECTED" });
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "integration.disconnected" },
      }),
    ).toBe(1);
  });

  it("lets exactly one of two concurrent disconnects wipe and audit", async () => {
    const { org, jar } = await setup();
    const integration = await prisma.integration.create({
      data: {
        organisationId: org.organisation.id,
        provider: "DEPUTY",
        status: "CONNECTED",
        connection: {
          create: {
            status: "CONNECTED",
            legacyEncryptedCredentials: new Uint8Array([1, 2, 3]),
            credentialVersion: 2,
          },
        },
      },
    });
    const disconnect = () =>
      callRoute<IntegrationResponse>(disconnectRoute, {
        method: "POST",
        path: "/api/integrations/deputy/disconnect",
        params: { provider: "deputy" },
        jar,
        body: {},
      });

    const results = await Promise.all([disconnect(), disconnect()]);
    for (const res of results) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.integration.status).toBe("DISCONNECTED");
    }
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { integrationId: integration.id },
    });
    expect(connection).toMatchObject({
      status: "DISCONNECTED",
      legacyEncryptedCredentials: null,
      credentialVersion: 3,
    });
    expect(
      await prisma.auditLog.findMany({
        where: { organisationId: org.organisation.id, action: "integration.disconnected" },
        select: { after: true },
      }),
    ).toEqual([
      { after: { provider: "DEPUTY", status: "DISCONNECTED", credentialsRemoved: true } },
    ]);
  });

  it("does not re-wipe a connection that is already disconnected", async () => {
    // Integration.status still CONNECTED (an inconsistent row) but the connection already wiped.
    const { org, jar } = await setup();
    const disconnectedAt = new Date("2026-10-02T08:00:00.000Z");
    const integration = await prisma.integration.create({
      data: {
        organisationId: org.organisation.id,
        provider: "DEPUTY",
        status: "CONNECTED",
        connection: {
          create: {
            status: "DISCONNECTED",
            credentialVersion: 5,
            disconnectedAt,
            statusChangedAt: disconnectedAt,
          },
        },
      },
    });
    const res = await callRoute<IntegrationResponse>(disconnectRoute, {
      method: "POST",
      path: "/api/integrations/deputy/disconnect",
      params: { provider: "deputy" },
      jar,
      body: {},
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.integration.status).toBe("DISCONNECTED");
    expect(
      await prisma.integrationConnection.findUniqueOrThrow({
        where: { integrationId: integration.id },
      }),
    ).toMatchObject({ status: "DISCONNECTED", credentialVersion: 5, disconnectedAt });
    expect(
      await prisma.auditLog.findMany({
        where: { organisationId: org.organisation.id, action: "integration.disconnected" },
        select: { after: true },
      }),
    ).toEqual([
      { after: { provider: "DEPUTY", status: "DISCONNECTED", credentialsRemoved: false } },
    ]);
  });
});

describe("plandayEnabled on GET /api/auth/me", () => {
  it("follows PLANDAY_ENABLED, the switch the dashboard hides Planday-only surfaces behind", async () => {
    const { jar } = await setup();
    const saved = process.env.PLANDAY_ENABLED;
    const flag = async (value: "true" | "false") => {
      process.env.PLANDAY_ENABLED = value;
      resetEnvCache();
      const res = await callRoute<CurrentUser>(meRoute, { path: "/api/auth/me", jar });
      expect(res.status).toBe(200);
      return res.body.organisations.map((o) => o.plandayEnabled);
    };
    try {
      expect(await flag("false")).toEqual([false]);
      expect(await flag("true")).toEqual([true]);
    } finally {
      if (saved === undefined) delete process.env.PLANDAY_ENABLED;
      else process.env.PLANDAY_ENABLED = saved;
      resetEnvCache();
    }
  });
});

describe("Planday data model (migration 20261008140100_planday_integration)", () => {
  async function integrationFor(organisationId: string) {
    return prisma.integration.create({ data: { organisationId, provider: "PLANDAY" } });
  }

  it("defaults new rows to unmanaged MANUAL records and a CONNECTING connection", async () => {
    const { org } = await setup();
    const integration = await integrationFor(org.organisation.id);
    const connection = await prisma.integrationConnection.create({
      data: { integrationId: integration.id },
    });
    expect(connection).toMatchObject({
      status: "CONNECTING",
      authMethod: null,
      isMock: false,
      legacyEncryptedCredentials: null,
      credentialVersion: 0,
      scopesGranted: [],
      consecutiveFailureCount: 0,
      authProbeAttempts: 0,
      pendingRunRetryAuth: false,
    });
    const location = await prisma.location.create({
      data: { organisationId: org.organisation.id, name: "Front of house" },
    });
    const team = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Bar" },
    });
    const employee = await prisma.employee.create({
      data: { organisationId: org.organisation.id, firstName: "Ada", lastName: "Lovelace" },
    });
    for (const row of [location, team, employee]) {
      expect(row).toMatchObject({ source: "MANUAL", managedByIntegrationId: null });
    }
    expect(
      await prisma.organisation.findUniqueOrThrow({
        where: { id: org.organisation.id },
        select: { rotaSource: true, rotaSourceOtherText: true },
      }),
    ).toEqual({ rotaSource: null, rotaSourceOtherText: null });
    const config = await prisma.integrationMappingConfig.create({
      data: { organisationId: org.organisation.id, integrationId: integration.id },
    });
    expect(config).toMatchObject({
      includedDepartmentIds: [],
      excludedEmployeeIds: [],
      autoIncludeNewEmployees: true,
      importEmails: true,
      syncWindowDays: 28,
      respectHiddenDays: false,
      mappingVersion: 1,
      onboardingCompletedAt: null,
    });
  });

  it("allows one RUNNING sync run per integration", async () => {
    const { org } = await setup();
    const integration = await integrationFor(org.organisation.id);
    const run = { organisationId: org.organisation.id, integrationId: integration.id };
    const first = await prisma.integrationSyncRun.create({
      data: { ...run, trigger: "INITIAL", kind: "STRUCTURE", priority: 0 },
    });
    expect(first).toMatchObject({ status: "RUNNING", phase: "START", firstClaimedAt: null });
    await expect(
      prisma.integrationSyncRun.create({ data: { ...run, trigger: "MANUAL" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await prisma.integrationSyncRun.update({
      where: { id: first.id },
      data: { status: "SUCCEEDED", finishedAt: new Date() },
    });
    await expect(
      prisma.integrationSyncRun.create({ data: { ...run, trigger: "SCHEDULED" } }),
    ).resolves.toMatchObject({ status: "RUNNING", kind: "SYNC", priority: 3 });
    await expect(
      prisma.$executeRaw`UPDATE integration_sync_runs SET priority = 4 WHERE id = ${first.id}::uuid`,
    ).rejects.toThrow(/integration_sync_runs_priority_check/);
  });

  it("maps one employee or shift to one external record, but lets locations share a target", async () => {
    const { org } = await setup();
    const integration = await integrationFor(org.organisation.id);
    const base = {
      organisationId: org.organisation.id,
      integrationId: integration.id,
      provider: "PLANDAY" as const,
      lastSeenAt: new Date(),
    };
    const employeeId = randomUUID();
    await prisma.externalEntityMap.create({
      data: { ...base, entityType: "EMPLOYEE", externalId: "101", internalId: employeeId },
    });
    await expect(
      prisma.externalEntityMap.create({
        data: { ...base, entityType: "EMPLOYEE", externalId: "102", internalId: employeeId },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.externalEntityMap.create({
        data: { ...base, entityType: "EMPLOYEE", externalId: "101", internalId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    const locationId = randomUUID();
    await prisma.externalEntityMap.createMany({
      data: [
        { ...base, entityType: "LOCATION", externalId: "201", internalId: locationId },
        { ...base, entityType: "LOCATION", externalId: "202", internalId: locationId },
      ],
    });
    expect(
      await prisma.externalEntityMap.count({
        where: { integrationId: integration.id, internalId: locationId },
      }),
    ).toBe(2);
  });

  it("allows one ACTIVE onboarding session per organisation and provider", async () => {
    const { org } = await setup();
    const integration = await integrationFor(org.organisation.id);
    const session = {
      organisationId: org.organisation.id,
      integrationId: integration.id,
      provider: "PLANDAY" as const,
    };
    const first = await prisma.integrationOnboardingSession.create({ data: session });
    expect(first).toMatchObject({ status: "ACTIVE", currentStep: "CONNECT", completedSteps: [] });
    await expect(
      prisma.integrationOnboardingSession.create({ data: session }),
    ).rejects.toMatchObject({ code: "P2002" });
    await prisma.integrationOnboardingSession.update({
      where: { id: first.id },
      data: { status: "ABANDONED" },
    });
    await expect(
      prisma.integrationOnboardingSession.create({ data: session }),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("allows one live, non-mock connection per portal across organisations", async () => {
    const [{ org: a }, { org: b }, { org: c }] = await Promise.all([setup(), setup(), setup()]);
    const portalId = `test-portal-${randomUUID()}`;
    const [ia, ib, ic] = await Promise.all([
      integrationFor(a.organisation.id),
      integrationFor(b.organisation.id),
      integrationFor(c.organisation.id),
    ]);
    await prisma.integrationConnection.create({
      data: { integrationId: ia.id, status: "CONNECTED", externalPortalId: portalId },
    });
    await expect(
      prisma.integrationConnection.create({
        data: { integrationId: ib.id, status: "AUTH_ERROR", externalPortalId: portalId },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    // Mock connections and disconnected ones do not hold the portal.
    await prisma.integrationConnection.create({
      data: { integrationId: ib.id, status: "CONNECTED", externalPortalId: portalId, isMock: true },
    });
    await prisma.integrationConnection.create({
      data: { integrationId: ic.id, status: "DISCONNECTED", externalPortalId: portalId },
    });
    await prisma.integrationConnection.update({
      where: { integrationId: ia.id },
      data: { status: "DISCONNECTED" },
    });
    await expect(
      prisma.integrationConnection.update({
        where: { integrationId: ic.id },
        data: { status: "CONNECTED" },
      }),
    ).resolves.toMatchObject({ status: "CONNECTED" });
  });

  it("enforces the hand-written check constraints", async () => {
    const { org } = await setup();
    const organisationId = org.organisation.id;
    const integration = await integrationFor(organisationId);
    await expect(
      prisma.integrationMappingConfig.create({
        data: { organisationId, integrationId: integration.id, syncWindowDays: 6 },
      }),
    ).rejects.toThrow(/integration_mapping_configs_sync_window_days_check/);
    await expect(
      prisma.integrationMappingConfig.create({
        data: { organisationId, integrationId: integration.id, syncWindowDays: 56 },
      }),
    ).resolves.toMatchObject({ syncWindowDays: 56 });

    await expect(
      prisma.organisation.update({
        where: { id: organisationId },
        data: { rotaSource: "CSV", rotaSourceOtherText: "Spreadsheets" },
      }),
    ).rejects.toThrow(/organisations_rota_source_other_text_check/);
    await expect(
      prisma.organisation.update({
        where: { id: organisationId },
        data: { rotaSource: null, rotaSourceOtherText: "Spreadsheets" },
      }),
    ).rejects.toThrow(/organisations_rota_source_other_text_check/);
    await expect(
      prisma.organisation.update({
        where: { id: organisationId },
        data: { rotaSource: "OTHER", rotaSourceOtherText: "Spreadsheets" },
      }),
    ).resolves.toMatchObject({ rotaSource: "OTHER", rotaSourceOtherText: "Spreadsheets" });
  });
});
