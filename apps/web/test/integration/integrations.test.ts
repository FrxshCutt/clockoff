import { prisma } from "@workmode/db";
import { INTEGRATION_PROVIDERS } from "@workmode/shared/enums";
import type {
  IntegrationResponse,
  ListIntegrationsResponse,
} from "@workmode/validation/integrations";
import { describe, expect, it } from "vitest";
import { POST as connectRoute } from "@/app/api/integrations/[provider]/connect/route";
import { POST as disconnectRoute } from "@/app/api/integrations/[provider]/disconnect/route";
import { POST as notifyMeRoute } from "@/app/api/integrations/[provider]/notify-me/route";
import { POST as syncRoute } from "@/app/api/integrations/[provider]/sync/route";
import { GET as listRoute } from "@/app/api/integrations/route";
import { addMember, callRoute, createTestOrg, createTestUser, loginAs, type ErrorBody } from "../helpers";

async function setup() {
  const org = await createTestOrg();
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  return { org, jar };
}

describe("GET /api/integrations", () => {
  it("lists every provider in enum order as COMING_SOON / NOT_CONNECTED", async () => {
    const { jar } = await setup();
    const res = await callRoute<ListIntegrationsResponse>(listRoute, { path: "/api/integrations", jar });
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
    expect(res.body.integrations.find((i) => i.provider === "SEVENSHIFTS")?.displayName).toBe("7shifts");
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
    expect(await prisma.integration.count({ where: { organisationId: org.organisation.id } })).toBe(0);
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

    const rows = await prisma.integration.findMany({ where: { organisationId: org.organisation.id } });
    expect(rows).toEqual([expect.objectContaining({ provider: "HOMEBASE", notifyRequested: true })]);
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "integration.notify_requested" },
      }),
    ).toBe(1);

    const list = await callRoute<ListIntegrationsResponse>(listRoute, { path: "/api/integrations", jar });
    expect(list.body.integrations.find((i) => i.provider === "HOMEBASE")?.notifyRequested).toBe(true);
    expect(list.body.integrations.find((i) => i.provider === "PLANDAY")?.notifyRequested).toBe(false);
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
    expect(await prisma.integration.count({ where: { organisationId: org.organisation.id } })).toBe(0);
  });

  it("removes stored credentials and marks a connected integration DISCONNECTED", async () => {
    const { org, jar } = await setup();
    const integration = await prisma.integration.create({
      data: {
        organisationId: org.organisation.id,
        provider: "DEPUTY",
        status: "CONNECTED",
        settings: { externalAccountName: "Deputy Ltd" },
        connection: {
          create: { encryptedCredentials: new Uint8Array([1, 2, 3]), lastSyncAt: new Date() },
        },
      },
    });
    const before = await callRoute<ListIntegrationsResponse>(listRoute, { path: "/api/integrations", jar });
    expect(before.body.integrations.find((i) => i.provider === "DEPUTY")).toMatchObject({
      status: "CONNECTED",
      externalAccountName: "Deputy Ltd",
      lastSyncAt: expect.any(String),
    });

    const res = await callRoute<IntegrationResponse>(disconnectRoute, {
      method: "POST",
      path: "/api/integrations/deputy/disconnect",
      params: { provider: "deputy" },
      jar,
      body: {},
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.integration).toMatchObject({ status: "DISCONNECTED", lastSyncAt: null });
    expect(await prisma.integrationConnection.count({ where: { integrationId: integration.id } })).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "integration.disconnected" },
      }),
    ).toBe(1);
  });
});
