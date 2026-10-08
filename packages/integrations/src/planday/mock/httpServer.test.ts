import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FROZEN_NOW,
  MOCK_CUSTOMER_APP_ID,
  MOCK_PLANDAY_DEFAULT_PORT,
  MOCK_REFRESH_TOKEN,
  MockPlandayForbiddenError,
  startMockPlandayHttpServer,
  type MockPlandayHttpServer,
} from "./index";

/**
 * Mock Planday over HTTP (plan §12.1): the same handler as the in-process mock under `/openapi/*` and `/id/*`
 * (the paths the web app's mock-mode transport rewrites the two Planday hosts to), plus `POST /__control` and
 * `GET /__health`. Refuses to start in production.
 */

let server: MockPlandayHttpServer;

beforeAll(async () => {
  server = await startMockPlandayHttpServer({ port: 0, now: () => FROZEN_NOW });
});

afterAll(async () => {
  await server.close();
});

async function accessToken(): Promise<string> {
  const response = await fetch(`${server.url}/id/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: MOCK_CUSTOMER_APP_ID,
      grant_type: "refresh_token",
      refresh_token: MOCK_REFRESH_TOKEN,
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

function api(path: string, token: string): Promise<Response> {
  return fetch(`${server.url}/openapi${path}`, {
    headers: { Authorization: `Bearer ${token}`, "X-ClientId": MOCK_CUSTOMER_APP_ID },
  });
}

function control(body: unknown): Promise<Response> {
  return fetch(`${server.url}/__control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("startMockPlandayHttpServer", () => {
  it("listens on 127.0.0.1 (default port 4010; 0 picks a free one)", () => {
    expect(MOCK_PLANDAY_DEFAULT_PORT).toBe(4010);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.port).toBeGreaterThan(0);
  });

  it("answers GET /__health", async () => {
    const response = await fetch(`${server.url}/__health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      mock: "planday",
      now: FROZEN_NOW.toISOString(),
      portals: [4100001, 4100002, 4100003],
    });
  });

  it("serves the identity server under /id/* and the API under /openapi/*", async () => {
    const token = await accessToken();
    const info = await api("/portal/v1.0/info", token);
    expect(info.status).toBe(200);
    expect(info.headers.get("x-ratelimit-limit")).toBe("750, 20;w=1, 750;w=60, 100;w=1, 2000;w=60");
    expect(((await info.json()) as { data: { name: string } }).data.name).toBe("Mock Bistro Group");

    const shifts = await api(
      "/scheduling/v1.0/shifts?limit=100&offset=0&from=2026-10-19&to=2026-11-15",
      token,
    );
    expect(((await shifts.json()) as { paging: { total: number } }).paging.total).toBe(60);
    expect((await api("/portal/v1.0/info", "nope")).status).toBe(401);

    const lastApi = server.mock.requestLog.at(-1)!;
    expect(lastApi).toMatchObject({
      host: "openapi.planday.com",
      path: "/portal/v1.0/info",
      status: 401,
    });
    expect(server.mock.unexpectedRequests).toEqual([]);
  });

  it("passes redirects through, so a browser reaches the callback", async () => {
    const query = new URLSearchParams({
      client_id: MOCK_CUSTOMER_APP_ID,
      response_type: "code",
      redirect_uri: "http://localhost:3000/api/integrations/planday/callback",
      scope: "openid offline_access department:read employee:read",
      state: "s",
    });
    const response = await fetch(`${server.url}/id/connect/authorize?${query}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/api/integrations/planday/callback");
    expect(location.searchParams.get("code")).toMatch(/^mock-code-/);
    expect(location.searchParams.get("state")).toBe("s");
  });

  it("runs controls through POST /__control, shared with every client of the server", async () => {
    const token = await accessToken();
    const id = server.mock.fixture.specials.forSaleShiftId;
    const edit = await control({
      action: "editShift",
      id,
      patch: { startDateTime: "2026-10-29T12:00:00", endDateTime: "2026-10-29T20:00:00" },
    });
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({
      ok: true,
      result: { id, start: "2026-10-29T12:00:00" },
    });
    const read = await api(`/scheduling/v1.0/shifts/${id}`, token);
    expect(((await read.json()) as { data: { startDateTime: string } }).data.startDateTime).toBe(
      "2026-10-29T12:00:00",
    );

    const issued = await control({ action: "reauthorize", appId: MOCK_CUSTOMER_APP_ID });
    expect(
      ((await issued.json()) as { result: { refreshToken: string } }).result.refreshToken,
    ).toMatch(/^mock-rt-/);

    const log = await control({ action: "requestLog" });
    expect(((await log.json()) as { result: unknown[] }).result.length).toBeGreaterThan(0);

    expect(await (await control({ action: "nope" })).json()).toMatchObject({ ok: false });
    expect((await control({ action: "deleteShift", id: 1 })).status).toBe(400);
    const notJson = await fetch(`${server.url}/__control`, { method: "POST", body: "{" });
    expect(notJson.status).toBe(400);
    expect((await fetch(`${server.url}/__control`)).status).toBe(405);

    expect(await (await control({ action: "reset" })).json()).toEqual({ ok: true, result: null });
    const after = await api(`/scheduling/v1.0/shifts/${id}`, await accessToken());
    expect(((await after.json()) as { data: { startDateTime: string } }).data.startDateTime).toBe(
      "2026-10-29T10:00:00",
    );
  });

  it("answers 404 outside /openapi/* and /id/* and records it", async () => {
    await control({ action: "clearLogs" });
    const response = await fetch(`${server.url}/hr/v1.0/departments`);
    expect(response.status).toBe(404);
    expect(server.mock.unexpectedRequests).toEqual([
      expect.objectContaining({ path: "/hr/v1.0/departments" }),
    ]);
    const unexpected = await control({ action: "unexpectedRequests" });
    expect(((await unexpected.json()) as { result: unknown[] }).result).toHaveLength(1);
    await control({ action: "clearLogs" });
    expect(server.mock.unexpectedRequests).toEqual([]);
  });

  it("refuses to start in production", async () => {
    await expect(
      startMockPlandayHttpServer({ port: 0, env: { NODE_ENV: "production" } }),
    ).rejects.toThrowError(MockPlandayForbiddenError);
    await expect(
      startMockPlandayHttpServer({ port: 0, env: { RAILWAY_ENVIRONMENT_NAME: "production" } }),
    ).rejects.toThrowError(/never runs in production/);
  });

  it("refuses to start in a production process whatever env it is given", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(startMockPlandayHttpServer({ port: 0, env: {} })).rejects.toThrowError(
        MockPlandayForbiddenError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
