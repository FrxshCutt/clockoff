import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createMockPlanday,
  FROZEN_NOW,
  MOCK_CUSTOMER_APP_ID,
  MOCK_PORTAL_CREDENTIALS,
  MOCK_REFRESH_TOKEN,
  MOCK_SECOND_PORTAL_ID,
  MockControlError,
  runControlAction,
  type MockPlanday,
} from "./index";

/**
 * Mock Planday's endpoints and controls (plan §12.2, §12.4), exercised with raw requests the way the client
 * makes them. The client × mock contract suite (stage 2C) covers the client's side.
 */

const API = "https://openapi.planday.com";
const ID = "https://id.planday.com";
const PARTNER_APP_ID = "0b8a3f1e-1111-4222-8333-444455556666";
const CALLBACK = "https://app.clockoff.test/api/integrations/planday/callback";
const SCOPE =
  "openid offline_access department:read employeegroup:read employee:read shift:read punchclockshift:read";

let mock: MockPlanday;
let clock: number;

beforeEach(() => {
  clock = FROZEN_NOW.getTime();
  mock = createMockPlanday({ now: () => clock, partnerAppIds: [PARTNER_APP_ID, null, ""] });
});

function form(path: string, fields: Record<string, string>, init: RequestInit = {}) {
  return mock.fetch(`${ID}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    ...init,
  });
}

async function refresh(clientId = MOCK_CUSTOMER_APP_ID, refreshToken = MOCK_REFRESH_TOKEN) {
  return form("/connect/token", {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function accessToken(clientId = MOCK_CUSTOMER_APP_ID, refreshToken = MOCK_REFRESH_TOKEN) {
  const response = await refresh(clientId, refreshToken);
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

function get(
  path: string,
  token: string,
  clientId: string = MOCK_CUSTOMER_APP_ID,
  init: RequestInit = {},
) {
  return mock.fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-ClientId": clientId,
      Accept: "application/json",
    },
    ...init,
  });
}

async function getJson<T = Record<string, unknown>>(path: string, token: string): Promise<T> {
  const response = await get(path, token);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

type Paged<T = Record<string, unknown>> = {
  data: T[];
  paging: { offset: number; limit: number; total: number } | null;
};

describe("token endpoint", () => {
  it("answers the refresh grant with an access token only (no rotation by default)", async () => {
    const response = await refresh();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["access_token", "expires_in", "token_type"]);
    expect(body).toMatchObject({ expires_in: 3600, token_type: "Bearer" });
    expect(mock.requestLog[0]).toMatchObject({
      method: "POST",
      host: "id.planday.com",
      path: "/connect/token",
      clientId: MOCK_CUSTOMER_APP_ID,
      form: {
        client_id: MOCK_CUSTOMER_APP_ID,
        grant_type: "refresh_token",
        refresh_token: MOCK_REFRESH_TOKEN,
      },
      status: 200,
    });
    expect(mock.unexpectedRequests).toEqual([]);
  });

  it("refuses a token another app owns, unknown apps and grant types, and non-form bodies", async () => {
    const other = MOCK_PORTAL_CREDENTIALS[MOCK_SECOND_PORTAL_ID]!;
    expect(await (await refresh(other.appId, MOCK_REFRESH_TOKEN)).json()).toEqual({
      error: "invalid_grant",
    });
    const unknown = await refresh("5f0c6a3e-0000-4000-8000-0000000000aa");
    expect([unknown.status, await unknown.json()]).toEqual([400, { error: "invalid_client" }]);
    const grant = await form("/connect/token", {
      client_id: MOCK_CUSTOMER_APP_ID,
      grant_type: "client_credentials",
    });
    expect(await grant.json()).toEqual({ error: "unsupported_grant_type" });
    const json = await mock.fetch(`${ID}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: MOCK_CUSTOMER_APP_ID }),
    });
    expect(json.status).toBe(400);
    expect(mock.unexpectedRequests.map((u) => u.reason)).toEqual([
      "/connect/token body must be application/x-www-form-urlencoded",
    ]);
  });

  it("flags a client secret, X-ClientId and an Authorization header on identity requests", async () => {
    await form(
      "/connect/token",
      {
        client_id: MOCK_CUSTOMER_APP_ID,
        grant_type: "refresh_token",
        refresh_token: MOCK_REFRESH_TOKEN,
        client_secret: "nope",
      },
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-ClientId": MOCK_CUSTOMER_APP_ID,
          Authorization: "Basic eA==",
        },
      },
    );
    expect(mock.unexpectedRequests.map((u) => u.reason)).toEqual([
      expect.stringContaining("X-ClientId on an identity request"),
      expect.stringContaining("Authorization header on an identity request"),
      expect.stringContaining("client_secret sent"),
    ]);
  });

  it("rotates refresh tokens when asked and invalidates the old one", async () => {
    const before = await accessToken();
    mock.controls.setRotateRefreshTokens(true);
    const body = (await (await refresh()).json()) as {
      refresh_token?: string;
      access_token: string;
    };
    expect(body.refresh_token).toMatch(/^mock-rt-/);
    expect(await (await refresh()).json()).toEqual({ error: "invalid_grant" });
    expect((await refresh(MOCK_CUSTOMER_APP_ID, body.refresh_token)).status).toBe(200);
    // Access tokens issued before the rotation keep working.
    expect((await get("/portal/v1.0/info", before)).status).toBe(200);
  });

  it("revokes refresh tokens with and without their live access tokens (notes §12 Q5)", async () => {
    const token = await accessToken();
    expect(mock.controls.revokeRefreshToken({ keepAccessTokens: true })).toBe(3);
    expect((await refresh()).status).toBe(400);
    expect((await get("/portal/v1.0/info", token)).status).toBe(200);

    mock.controls.reset();
    const second = await accessToken();
    expect(mock.controls.revokeRefreshToken(MOCK_REFRESH_TOKEN)).toBe(1);
    expect(await (await refresh()).json()).toEqual({ error: "invalid_grant" });
    expect((await get("/portal/v1.0/info", second)).status).toBe(401);
    // Other portals' grants are untouched.
    const cafe = MOCK_PORTAL_CREDENTIALS[MOCK_SECOND_PORTAL_ID]!;
    expect((await refresh(cafe.appId, cafe.refreshToken)).status).toBe(200);
  });

  it("re-authorises an app with a new refresh token", async () => {
    mock.controls.revokeRefreshToken("all");
    const { refreshToken, portalId } = mock.controls.reauthorize(MOCK_CUSTOMER_APP_ID);
    expect(portalId).toBe(4100001);
    expect(refreshToken).not.toBe(MOCK_REFRESH_TOKEN);
    expect((await refresh(MOCK_CUSTOMER_APP_ID, refreshToken)).status).toBe(200);
    expect(() => mock.controls.reauthorize(MOCK_CUSTOMER_APP_ID, { portalId: 4100002 })).toThrow(
      MockControlError,
    );
  });

  it("expires access tokens after an hour on the mock clock, or on demand", async () => {
    const token = await accessToken();
    clock += 3_599_000;
    expect((await get("/portal/v1.0/info", token)).status).toBe(200);
    clock += 1_000;
    expect((await get("/portal/v1.0/info", token)).status).toBe(401);
    const fresh = await accessToken();
    mock.controls.expireAccessTokens();
    expect((await get("/portal/v1.0/info", fresh)).status).toBe(401);
    const later = await accessToken();
    mock.controls.advanceClock(3_600_000);
    expect((await get("/portal/v1.0/info", later)).status).toBe(401);
  });
});

describe("revocation endpoint", () => {
  it("revokes the grant and, by default, its access tokens", async () => {
    const token = await accessToken();
    const response = await form("/connect/revocation", {
      client_id: MOCK_CUSTOMER_APP_ID,
      token: MOCK_REFRESH_TOKEN,
    });
    expect([response.status, await response.text()]).toEqual([200, ""]);
    expect((await refresh()).status).toBe(400);
    expect((await get("/portal/v1.0/info", token)).status).toBe(401);
  });

  it("can leave live access tokens valid, and ignores unknown tokens", async () => {
    mock.controls.setRevocationKillsAccessTokens(false);
    const token = await accessToken();
    await form("/connect/revocation", {
      client_id: MOCK_CUSTOMER_APP_ID,
      token: MOCK_REFRESH_TOKEN,
    });
    expect((await refresh()).status).toBe(400);
    expect((await get("/portal/v1.0/info", token)).status).toBe(200);
    const unknown = await form("/connect/revocation", {
      client_id: MOCK_CUSTOMER_APP_ID,
      token: "nope",
    });
    expect(unknown.status).toBe(200);
    const missing = await form("/connect/revocation", { client_id: MOCK_CUSTOMER_APP_ID });
    expect(missing.status).toBe(400);
  });
});

describe("authorization code flow (method A)", () => {
  async function authorize(params: Record<string, string>) {
    const query = new URLSearchParams({
      client_id: PARTNER_APP_ID,
      response_type: "code",
      redirect_uri: CALLBACK,
      scope: SCOPE,
      state: "state-123",
      ...params,
    });
    return mock.fetch(`${ID}/connect/authorize?${query}`, { redirect: "manual" });
  }

  it("redirects with a single-use code bound to the redirect URI", async () => {
    const response = await authorize({});
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("state")).toBe("state-123");
    const code = location.searchParams.get("code")!;

    const wrongUri = await form("/connect/token", {
      client_id: PARTNER_APP_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${CALLBACK}/x`,
    });
    expect(await wrongUri.json()).toEqual({ error: "invalid_grant" });

    const fields = {
      client_id: PARTNER_APP_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
    };
    const exchanged = (await (await form("/connect/token", fields)).json()) as Record<
      string,
      string
    >;
    expect(exchanged).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: SCOPE });
    expect(exchanged.refresh_token).toMatch(/^mock-rt-/);
    expect(exchanged.id_token).toMatch(/^eyJ/);
    const replay = await form("/connect/token", fields);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });

    const info = await get("/portal/v1.0/info", exchanged.access_token!, PARTNER_APP_ID);
    expect(((await info.json()) as { data: { id: number } }).data.id).toBe(4100001);
    expect((await refresh(PARTNER_APP_ID, exchanged.refresh_token)).status).toBe(200);
    expect(mock.unexpectedRequests).toEqual([]);
  });

  it("checks PKCE when a challenge was sent", async () => {
    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const response = await authorize({ code_challenge: challenge, code_challenge_method: "S256" });
    const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
    const base = {
      client_id: PARTNER_APP_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
    };
    expect((await form("/connect/token", base)).status).toBe(400);
    expect((await form("/connect/token", { ...base, code_verifier: "w".repeat(64) })).status).toBe(
      400,
    );
    const again = await authorize({ code_challenge: challenge, code_challenge_method: "S256" });
    const code2 = new URL(again.headers.get("location")!).searchParams.get("code")!;
    expect(
      (await form("/connect/token", { ...base, code: code2, code_verifier: verifier })).status,
    ).toBe(200);
  });

  it("refuses unknown clients without redirecting and bad scopes with an error redirect", async () => {
    const unknown = await authorize({ client_id: "0b8a3f1e-0000-4000-8000-000000000000" });
    expect([unknown.status, await unknown.json()]).toEqual([
      400,
      { error: "invalid_client", error_description: "unknown client_id" },
    ]);
    const noOidc = await authorize({ scope: "department:read" });
    expect(noOidc.status).toBe(302);
    expect(new URL(noOidc.headers.get("location")!).searchParams.get("error")).toBe(
      "invalid_scope",
    );
    const codes = await authorize({ response_type: "token" });
    expect(new URL(codes.headers.get("location")!).searchParams.get("error")).toBe(
      "unsupported_response_type",
    );
  });

  it("issues codes through the control the dev authorize route uses", async () => {
    const { code, portalId } = mock.controls.issueAuthorizationCode({
      clientId: PARTNER_APP_ID,
      redirectUri: CALLBACK,
      scope: SCOPE,
      portalId: MOCK_SECOND_PORTAL_ID,
    });
    expect(portalId).toBe(4100002);
    const body = (await (
      await form("/connect/token", {
        client_id: PARTNER_APP_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK,
      })
    ).json()) as { access_token: string };
    const info = await get("/portal/v1.0/info", body.access_token, PARTNER_APP_ID);
    expect(((await info.json()) as { data: { name: string } }).data.name).toBe("Mock Cafe Co");
    expect(() =>
      mock.controls.issueAuthorizationCode({
        clientId: "nope",
        redirectUri: CALLBACK,
        scope: SCOPE,
      }),
    ).toThrow(/invalid_client/);
  });

  it("issues method B tokens for ClockOff's App ID", async () => {
    const { refreshToken } = mock.controls.issueTokenForApp(PARTNER_APP_ID);
    const token = await accessToken(PARTNER_APP_ID, refreshToken);
    expect(
      (await get("/hr/v1.0/departments?limit=50&offset=0", token, PARTNER_APP_ID)).status,
    ).toBe(200);
    // The token is the partner app's: the customer's App ID cannot use it.
    expect((await get("/portal/v1.0/info", token, MOCK_CUSTOMER_APP_ID)).status).toBe(401);
  });
});

describe("API authentication and scopes", () => {
  it("needs a valid bearer token issued to the X-ClientId app", async () => {
    const token = await accessToken();
    expect((await get("/portal/v1.0/info", "mock-at-unknown")).status).toBe(401);
    const noClient = await mock.fetch(`${API}/portal/v1.0/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(noClient.status).toBe(401);
    expect(noClient.headers.get("www-authenticate")).toContain("invalid_token");
    expect((await get("/portal/v1.0/info", token, PARTNER_APP_ID)).status).toBe(401);
  });

  it("answers 403 for an endpoint whose scope the app lacks", async () => {
    mock.controls.setScopes(MOCK_CUSTOMER_APP_ID, ["employee:read", "shift:read"]);
    const token = await accessToken();
    expect((await get("/hr/v1.0/departments?limit=1&offset=0", token)).status).toBe(403);
    expect((await get("/hr/v1.0/employeegroups?limit=1&offset=0", token)).status).toBe(403);
    expect((await get("/hr/v1.0/employees?limit=1&offset=0", token)).status).toBe(200);
    // Portal info has no documented scope.
    expect((await get("/portal/v1.0/info", token)).status).toBe(200);
  });

  it("sends x-ratelimit headers on every API answer", async () => {
    const token = await accessToken();
    const first = await get("/portal/v1.0/info", token);
    expect(first.headers.get("x-ratelimit-limit")).toBe(
      "750, 20;w=1, 750;w=60, 100;w=1, 2000;w=60",
    );
    expect(first.headers.get("x-ratelimit-remaining")).toBe("749");
    expect(Number(first.headers.get("x-ratelimit-reset"))).toBeGreaterThan(0);
    const second = await get("/portal/v1.0/info", token);
    expect(second.headers.get("x-ratelimit-remaining")).toBe("748");
    mock.controls.setRateLimitHeaders({ remaining: 1, resetSeconds: 3 });
    const low = await get("/portal/v1.0/info", token);
    expect([
      low.headers.get("x-ratelimit-remaining"),
      low.headers.get("x-ratelimit-reset"),
    ]).toEqual(["1", "3"]);
  });
});

describe("API endpoints", () => {
  let token: string;
  beforeEach(async () => {
    token = await accessToken();
  });

  it("serves the portal info", async () => {
    const body = await getJson<{ data: Record<string, unknown> }>("/portal/v1.0/info", token);
    expect(body.data).toMatchObject({
      id: 4100001,
      name: "Mock Bistro Group",
      companyName: "Mock Bistro Group Ltd",
      timeZone: "Europe/London",
      portals: [],
    });
  });

  it("pages with offset, limit and total, lowers HR limits and rejects out-of-range scheduling limits", async () => {
    const first = await getJson<Paged>("/hr/v1.0/departments?limit=2&offset=0", token);
    expect(first.paging).toEqual({ offset: 0, limit: 2, total: 3 });
    expect(first.data).toEqual([
      { id: 101, name: "Bar", number: "BAR-01" },
      { id: 102, name: "Kitchen", number: "KIT-01" },
    ]);
    const second = await getJson<Paged>("/hr/v1.0/departments?limit=2&offset=2", token);
    expect(second.data.map((d) => d.id)).toEqual([103]);
    const clamped = await getJson<Paged>("/hr/v1.0/employees?limit=500&offset=0", token);
    expect(clamped.paging!.limit).toBe(50);
    expect((await get("/scheduling/v1.0/shifts?limit=5001&offset=0", token)).status).toBe(400);
    expect((await get("/scheduling/v1.0/shifts/deleted?limit=1001&offset=0", token)).status).toBe(
      400,
    );
    expect((await get("/hr/v1.0/departments?limit=0&offset=0", token)).status).toBe(400);
    expect((await get("/hr/v1.0/departments?limit=abc&offset=0", token)).status).toBe(400);
  });

  it("caps the page size and serves null paging when asked", async () => {
    mock.controls.capPageSize(1);
    const capped = await getJson<Paged>("/hr/v1.0/employeegroups?limit=50&offset=0", token);
    expect(capped.paging).toEqual({ offset: 0, limit: 1, total: 4 });
    expect(capped.data).toHaveLength(1);
    mock.controls.setPagingNull(true);
    const nulled = await getJson<Paged>("/hr/v1.0/employeegroups?limit=50&offset=3", token);
    expect(nulled.paging).toBeNull();
    expect(nulled.data).toEqual([{ id: 204, name: "Supervisors" }]);
    mock.controls.capPageSize(null);
    expect(
      (await getJson<Paged>("/hr/v1.0/employeegroups?limit=50&offset=0", token)).data,
    ).toHaveLength(4);
  });

  it("lists active employees with the strip-set fields, and the deactivated one separately", async () => {
    const active = await getJson<Paged>("/hr/v1.0/employees?limit=50&offset=0", token);
    expect(active.paging!.total).toBe(11);
    expect(active.data.map((e) => e.id)).not.toContain(1011);
    expect(active.data[0]).toMatchObject({
      id: 1001,
      firstName: "Aisha",
      email: "aisha.khan@mockbistro.test",
      departments: [101],
      primaryDepartmentId: 101,
      employeeGroups: [201],
      ssn: "SENTINEL-PII-ssn-1001",
      securityGroups: [1],
    });
    const deactivated = await getJson<Paged>(
      "/hr/v1.0/employees/deactivated?limit=50&offset=0",
      token,
    );
    expect(deactivated.data.map((e) => e.id)).toEqual([1011]);
    expect(deactivated.data[0]).toMatchObject({ deactivationDate: "2026-10-12" });
    for (const key of ["securityGroups", "supervisorId", "primaryDepartmentId"]) {
      expect(deactivated.data[0]).not.toHaveProperty(key);
    }
    const since = await getJson<Paged>(
      "/hr/v1.0/employees/deactivated?limit=50&offset=0&deactivatedFrom=2026-10-13T00:00:00Z",
      token,
    );
    expect(since.data).toEqual([]);
  });

  it("serves the by-id employee shape, 400 for removed people", async () => {
    const body = await getJson<{ data: Record<string, unknown> }>("/hr/v1.0/employees/1001", token);
    expect(body.data).toMatchObject({
      id: 1001,
      isDeactivated: false,
      gender: "Female",
      jobTitle: "SENTINEL-PII-jobTitle-1001",
      custom_1: { name: "Shoe size", value: "SENTINEL-PII-CUSTOM-1001" },
    });
    for (const key of ["hiredDate", "dateTimeDeleted", "cellPhoneWithoutCountryPrefix"]) {
      expect(body.data).not.toHaveProperty(key);
    }
    const hannah = await getJson<{ data: Record<string, unknown> }>(
      "/hr/v1.0/employees/1011",
      token,
    );
    expect(hannah.data).toMatchObject({ isDeactivated: true, deactivationDate: "2026-10-12" });
    mock.controls.removeEmployee(1005);
    expect((await get("/hr/v1.0/employees/1005", token)).status).toBe(400);
    expect((await get("/hr/v1.0/employees/999999", token)).status).toBe(400);
    const active = await getJson<Paged>("/hr/v1.0/employees?limit=50&offset=0", token);
    expect(active.data.map((e) => e.id)).not.toContain(1005);
  });

  it("deactivates, reactivates and adds employees", async () => {
    mock.controls.deactivateEmployee(1002, { effectiveDate: "2026-11-30", stayOnActiveList: true });
    const ids = async (path: string) =>
      (await getJson<Paged>(`${path}?limit=50&offset=0`, token)).data.map((e) => e.id);
    expect(await ids("/hr/v1.0/employees")).toContain(1002);
    expect(await ids("/hr/v1.0/employees/deactivated")).toEqual([1002, 1011]);
    mock.controls.deactivateEmployee(1003);
    expect(await ids("/hr/v1.0/employees")).not.toContain(1003);
    const deactivated = await getJson<Paged>(
      "/hr/v1.0/employees/deactivated?limit=50&offset=0",
      token,
    );
    expect(deactivated.data.find((e) => e.id === 1003)).toMatchObject({
      deactivationDate: "2026-10-21",
    });
    mock.controls.reactivateEmployee(1003);
    expect(await ids("/hr/v1.0/employees")).toContain(1003);
    mock.controls.addEmployee({
      id: 1013,
      firstName: "Nia",
      lastName: "Brown",
      departments: [101],
    });
    const added = await getJson<{ data: Record<string, unknown> }>(
      "/hr/v1.0/employees/1013",
      token,
    );
    expect(added.data).toMatchObject({ primaryDepartmentId: 101, ssn: "SENTINEL-PII-ssn-1013" });
    mock.controls.editEmployee(1013, { lastName: "Green" });
    expect(
      (await getJson<{ data: Record<string, unknown> }>("/hr/v1.0/employees/1013", token)).data
        .lastName,
    ).toBe("Green");
  });

  it("filters shifts on date, inclusive, and serves the documented model", async () => {
    const all = await getJson<Paged>(
      "/scheduling/v1.0/shifts?limit=100&offset=0&from=2026-10-19&to=2026-11-15",
      token,
    );
    expect(all.paging!.total).toBe(60);
    const day = await getJson<Paged>(
      "/scheduling/v1.0/shifts?limit=100&offset=0&from=2026-10-21&to=2026-10-21",
      token,
    );
    expect(day.data.every((s) => s.date === "2026-10-21")).toBe(true);
    const inProgress = mock.fixture.specials.inProgressShiftId;
    expect(day.data.find((s) => s.id === inProgress)).toEqual({
      id: inProgress,
      departmentId: 101,
      employeeId: 1001,
      employeeGroupId: 201,
      positionId: null,
      shiftTypeId: 1,
      date: "2026-10-21",
      comment: `SENTINEL-PII-COMMENT-${inProgress}`,
      timeZone: "Europe/London",
      punchClockShiftId: 800001,
      startDateTime: "2026-10-21T09:00:00",
      endDateTime: "2026-10-21T17:00:00",
      status: "PunchclockStarted",
      dateTimeCreated: "2026-10-12T08:00:00Z",
      dateTimeModified: "2026-10-12T08:00:00Z",
      skillIds: [],
    });
    expect(
      (await get("/scheduling/v1.0/shifts?limit=100&offset=0&from=2026-10-22&to=2026-10-21", token))
        .status,
    ).toBe(400);
    expect(
      (await get("/scheduling/v1.0/shifts?limit=100&offset=0&from=21-10-2026", token)).status,
    ).toBe(400);
  });

  it("encodes date-times in the format set by setDateTimeFormat", async () => {
    const id = mock.fixture.specials.dstShiftId!;
    const read = async () =>
      (await getJson<{ data: Record<string, string> }>(`/scheduling/v1.0/shifts/${id}`, token))
        .data;
    expect(await read()).toMatchObject({
      date: "2026-10-24",
      startDateTime: "2026-10-24T22:00:00",
      endDateTime: "2026-10-25T06:00:00",
    });
    mock.controls.setDateTimeFormat("utc");
    expect(await read()).toMatchObject({
      startDateTime: "2026-10-24T21:00:00Z",
      endDateTime: "2026-10-25T06:00:00Z",
    });
    mock.controls.setDateTimeFormat("offset");
    expect(await read()).toMatchObject({
      startDateTime: "2026-10-24T22:00:00+01:00",
      endDateTime: "2026-10-25T06:00:00+00:00",
    });
    mock.controls.setDateTimeFormat("utc-without-z");
    expect(await read()).toMatchObject({
      date: "2026-10-24",
      startDateTime: "2026-10-24T21:00:00",
    });
    // A start within the UTC offset of midnight: `date` disagrees with the UTC-without-Z start (plan §4.8).
    mock.controls.editShift(id, { startDateTime: "2026-10-24T00:30:00" });
    expect(await read()).toMatchObject({
      date: "2026-10-24",
      startDateTime: "2026-10-23T23:30:00",
    });
  });

  it("edits, reassigns and deletes shifts", async () => {
    const id = mock.fixture.specials.forSaleShiftId;
    clock += 60_000;
    const edited = mock.controls.editShift(id, {
      startDateTime: "2026-10-29T11:00:00Z",
      endDateTime: new Date("2026-10-29T19:00:00Z"),
    });
    expect([edited.start, edited.end]).toEqual(["2026-10-29T11:00:00", "2026-10-29T19:00:00"]); // GMT after 25 Oct
    const read = async () =>
      (await getJson<{ data: Record<string, unknown> }>(`/scheduling/v1.0/shifts/${id}`, token))
        .data;
    expect(await read()).toMatchObject({
      startDateTime: "2026-10-29T11:00:00",
      dateTimeModified: "2026-10-21T10:31:00Z",
    });
    mock.controls.reassignShift(id, null);
    expect(await read()).toMatchObject({ employeeId: null, status: "Open" });
    mock.controls.reassignShift(id, 1009);
    expect(await read()).toMatchObject({ employeeId: 1009, status: "Assigned" });
    mock.controls.setShiftStatus(id, "SomethingNew");
    expect(await read()).toMatchObject({ status: "SomethingNew" });

    mock.controls.deleteShift(id);
    const missing = await get(`/scheduling/v1.0/shifts/${id}`, token);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ status: 404, title: "Not Found" });
    const deleted = await getJson<Paged>(
      "/scheduling/v1.0/shifts/deleted?limit=100&offset=0&deletedFrom=2026-10-20T00:00:00Z",
      token,
    );
    expect(deleted.data).toEqual([
      expect.objectContaining({ id, dateTimeDeleted: "2026-10-21T10:31:00Z", deletedBy: 900001 }),
    ]);
    expect(deleted.data[0]).not.toHaveProperty("punchClockShiftId");
    expect(
      (
        await getJson<Paged>(
          "/scheduling/v1.0/shifts/deleted?limit=100&offset=0&deletedFrom=2026-10-22T00:00:00Z",
          token,
        )
      ).data,
    ).toEqual([]);

    const added = mock.controls.addShift({
      employeeId: 1001,
      departmentId: 101,
      startDateTime: "2026-11-20T10:00:00",
      endDateTime: "2026-11-20T18:00:00",
    });
    expect(added.id).toBe(500061);
    expect(
      await getJson<{ data: Record<string, unknown> }>(
        `/scheduling/v1.0/shifts/${added.id}`,
        token,
      ),
    ).toMatchObject({
      data: { status: "Assigned", date: "2026-11-20" },
    });
  });

  it("refuses shift ranges longer than setMaxShiftRangeDays", async () => {
    mock.controls.setMaxShiftRangeDays(14);
    expect(
      (await get("/scheduling/v1.0/shifts?limit=100&offset=0&from=2026-10-19&to=2026-11-01", token))
        .status,
    ).toBe(200);
    expect(
      (await get("/scheduling/v1.0/shifts?limit=100&offset=0&from=2026-10-19&to=2026-11-02", token))
        .status,
    ).toBe(400);
  });

  it("serves schedule days with the hidden day", async () => {
    const body = await getJson<Paged>(
      "/scheduling/v1.0/scheduleDay?departmentId=102&from=2026-11-04&to=2026-11-06&limit=50&offset=0",
      token,
    );
    expect(body.data.map((d) => [d.date, d.isVisible])).toEqual([
      ["2026-11-04", true],
      ["2026-11-05", false],
      ["2026-11-06", true],
    ]);
    expect(body.data[1]).toMatchObject({
      departmentId: 102,
      lockState: "Unlocked",
      description: "SENTINEL-PII-DAYNOTE-102-2026-11-05",
    });
    mock.controls.setScheduleDayVisible(102, "2026-11-05", true);
    mock.controls.setScheduleDayVisible(101, "2026-11-04", false);
    const after = await getJson<Paged>(
      "/scheduling/v1.0/scheduleDay?departmentId=102&from=2026-11-05&to=2026-11-05&limit=50&offset=0",
      token,
    );
    expect(after.data[0]!.isVisible).toBe(true);
    expect(
      (
        await get(
          "/scheduling/v1.0/scheduleDay?from=2026-11-05&to=2026-11-05&limit=50&offset=0",
          token,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await get(
          "/scheduling/v1.0/scheduleDay?departmentId=999&from=2026-11-05&to=2026-11-05&limit=50&offset=0",
          token,
        )
      ).status,
    ).toBe(400);
  });

  it("serves punch clock records overlapping the window, and their breaks", async () => {
    const body = await getJson<Paged>(
      "/punchclock/v1.0/punchclockshifts?from=2026-10-21T08:30&to=2026-10-21T12:30&limit=50&offset=0",
      token,
    );
    expect(body.data.map((p) => p.id)).toEqual([800001, 800003]);
    expect(body.data[0]).toEqual({
      id: 800001,
      shiftId: mock.fixture.specials.inProgressShiftId,
      departmentId: 101,
      employeeId: 1001,
      startDateTime: "2026-10-21T08:58",
      endDateTime: null,
      shiftStartDateTime: "2026-10-21T09:00",
      shiftEndDateTime: "2026-10-21T17:00",
      description: "SENTINEL-PII-PUNCHNOTE-800001",
      isApproved: false,
    });
    const breaks = await getJson<{ data: unknown[]; paging: unknown }>(
      "/punchclock/v1.0/punchclockshifts/800002/breaks",
      token,
    );
    expect(breaks).toEqual({
      data: [
        {
          id: 810001,
          punchClocksShiftId: 800002,
          startDateTime: "2026-10-19T13:00",
          endDateTime: "2026-10-19T13:30",
          duration: "00:30:00",
        },
      ],
      paging: { total: 1 },
    });
    expect((await get("/punchclock/v1.0/punchclockshifts/1/breaks", token)).status).toBe(404);
    expect((await get("/punchclock/v1.0/punchclockshifts?limit=50&offset=0", token)).status).toBe(
      400,
    );
    mock.controls.upsertPunchClockShift({
      id: 800001,
      shiftId: mock.fixture.specials.inProgressShiftId,
      departmentId: 101,
      employeeId: 1001,
      start: "2026-10-21T08:58",
      end: "2026-10-21T11:00",
    });
    const out = await getJson<Paged>(
      "/punchclock/v1.0/punchclockshifts?from=2026-10-21T08:30&to=2026-10-21T12:30&limit=50&offset=0&employeeId=1001",
      token,
    );
    expect(out.data).toEqual([
      expect.objectContaining({ id: 800001, endDateTime: "2026-10-21T11:00" }),
    ]);
  });

  it("changes departments and employee groups", async () => {
    mock.controls.upsertDepartment({ id: 101, name: "Cocktail Bar", number: "BAR-01" });
    mock.controls.upsertDepartment({ id: 104, name: "Terrace", number: "TER-01" });
    mock.controls.removeDepartment(103);
    const departments = await getJson<Paged>("/hr/v1.0/departments?limit=50&offset=0", token);
    expect(departments.data.map((d) => d.name)).toEqual(["Cocktail Bar", "Kitchen", "Terrace"]);
    mock.controls.upsertEmployeeGroup({ id: 205, name: "Runners" });
    mock.controls.removeEmployeeGroup(201);
    const groups = await getJson<Paged>("/hr/v1.0/employeegroups?limit=50&offset=0", token);
    expect(groups.data.map((g) => g.id)).toEqual([202, 203, 204, 205]);
  });

  it("serves each portal its own data", async () => {
    const cafe = MOCK_PORTAL_CREDENTIALS[MOCK_SECOND_PORTAL_ID]!;
    const cafeToken = await accessToken(cafe.appId, cafe.refreshToken);
    const response = await get("/hr/v1.0/employees/1001", cafeToken, cafe.appId);
    expect(((await response.json()) as { data: { firstName: string } }).data.firstName).toBe(
      "Maya",
    );
    const zara = await get("/hr/v1.0/employees/1003", cafeToken, cafe.appId);
    expect(((await zara.json()) as { data: { email: string } }).data.email).toBe("");
    // Controls default to the main portal; portalId names another.
    mock.controls.editShift(500001, { status: "OnDuty" }, { portalId: MOCK_SECOND_PORTAL_ID });
    const main = await getJson<{ data: { status: string } }>(
      "/scheduling/v1.0/shifts/500001",
      token,
    );
    expect(main.data.status).not.toBe("OnDuty");
  });
});

describe("faults", () => {
  let token: string;
  beforeEach(async () => {
    token = await accessToken();
  });

  it("answers queued 429s with Retry-After, x-ratelimit-reset, both or neither", async () => {
    mock.controls.queueRateLimit({ count: 1, retryAfterSeconds: 7, resetSeconds: 5 });
    const both = await get("/portal/v1.0/info", token);
    expect([
      both.status,
      both.headers.get("retry-after"),
      both.headers.get("x-ratelimit-reset"),
      both.headers.get("x-ratelimit-remaining"),
    ]).toEqual([429, "7", "5", "0"]);
    expect((await get("/portal/v1.0/info", token)).status).toBe(200);

    mock.controls.queueRateLimit({ count: 2 });
    const neither = await get("/portal/v1.0/info", token);
    expect([
      neither.status,
      neither.headers.get("retry-after"),
      neither.headers.get("x-ratelimit-reset"),
    ]).toEqual([429, null, null]);
    expect((await get("/portal/v1.0/info", token)).status).toBe(429);
    expect((await get("/portal/v1.0/info", token)).status).toBe(200);
  });

  it("applies a fault only to its path, including path templates and the token endpoint", async () => {
    mock.controls.queueRateLimit({ path: "/hr/v1.0/employees/{employeeId}", resetSeconds: 1 });
    expect((await get("/portal/v1.0/info", token)).status).toBe(200);
    expect((await get("/hr/v1.0/employees/1002", token)).status).toBe(429);
    expect((await get("/hr/v1.0/employees/1002", token)).status).toBe(200);
    // Without a path a fault never hits the identity server.
    mock.controls.queue5xx({ count: 1 });
    expect((await refresh()).status).toBe(200);
    expect((await get("/portal/v1.0/info", token)).status).toBe(500);
    mock.controls.queueRateLimit({ path: "/connect/token", retryAfterSeconds: 2 });
    expect((await refresh()).status).toBe(429);
    mock.controls.queueError({ path: "/connect/token", status: 400 });
    expect(await (await refresh()).json()).toEqual({ error: "invalid_grant" });
    expect((await refresh()).status).toBe(200);
  });

  it("answers queued 5xx with ProblemDetails", async () => {
    mock.controls.queue5xx({ path: "/hr/v1.0/departments", count: 2, status: 503 });
    const first = await get("/hr/v1.0/departments?limit=50&offset=0", token);
    expect([first.status, ((await first.json()) as { status: number }).status]).toEqual([503, 503]);
    expect((await get("/hr/v1.0/departments?limit=50&offset=0", token)).status).toBe(503);
    expect((await get("/hr/v1.0/departments?limit=50&offset=0", token)).status).toBe(200);
  });

  it("malforms 2xx bodies: a dropped field, an unsafe id, a non-JSON body", async () => {
    mock.controls.queueMalformed({ path: "/hr/v1.0/employees", count: 1 });
    const missing = await getJson<Paged>("/hr/v1.0/employees?limit=50&offset=0", token);
    expect(missing.data[0]).not.toHaveProperty("id");
    expect(missing.data[1]).toHaveProperty("id", 1002);
    mock.controls.queueMalformed({ path: "/scheduling/v1.0/shifts/{shiftId}", mode: "unsafe-id" });
    const unsafe = await get("/scheduling/v1.0/shifts/500001", token);
    expect(await unsafe.text()).toContain('"id":9007199254740992');
    mock.controls.queueMalformed({ mode: "not-json" });
    const html = await get("/portal/v1.0/info", token);
    expect([html.status, html.headers.get("content-type")]).toEqual([
      200,
      "text/html; charset=utf-8",
    ]);
    await expect(html.json()).rejects.toThrow();
    mock.controls.queueMalformed({ path: "/connect/token" });
    expect(await (await refresh()).json()).not.toHaveProperty("access_token");
    // An empty list loses `data` itself.
    mock.controls.queueMalformed({ path: "/scheduling/v1.0/shifts/deleted" });
    expect(
      await getJson("/scheduling/v1.0/shifts/deleted?limit=100&offset=0", token),
    ).not.toHaveProperty("data");
  });

  it("waits with latency and lets the caller abort", async () => {
    mock.controls.setLatency(30);
    const started = Date.now();
    expect((await get("/portal/v1.0/info", token)).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    const controller = new AbortController();
    const pending = get("/portal/v1.0/info", token, MOCK_CUSTOMER_APP_ID, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5)); // in flight: logged, waiting
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.requestLog.at(-1)).toMatchObject({ aborted: true, status: null });
    const already = AbortSignal.abort();
    await expect(
      get("/portal/v1.0/info", token, MOCK_CUSTOMER_APP_ID, { signal: already }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("unexpected requests", () => {
  it("records unknown paths, forbidden and undocumented parameters, bodies and missing limits", async () => {
    const token = await accessToken();
    expect((await get("/hr/v1/Departments", token)).status).toBe(404);
    await get("/hr/v1.0/employees?limit=50&offset=0&special=Ssn&searchQuery=x", token);
    await get(
      "/scheduling/v1.0/shifts?limit=100&offset=0&from=2026-10-19&to=2026-10-20&departmentId[]=101&shiftStatus=Assigned",
      token,
    );
    await get("/hr/v1.0/employeegroups", token);
    await get("/hr/v1.0/employeegroups?limit=50&limit=50", token);
    await mock.fetch(`${API}/portal/v1.0/info`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-ClientId": MOCK_CUSTOMER_APP_ID,
        "X-OpenAPI-Region": "EU",
      },
      body: "{}",
    });
    expect((await mock.fetch(`${API}/hr/v1.0/departments`, { method: "POST" })).status).toBe(405);
    expect(mock.unexpectedRequests.map((u) => u.reason)).toEqual([
      expect.stringContaining("unknown path"),
      expect.stringContaining('"special" is never sent'),
      expect.stringContaining('"searchQuery" is never sent'),
      expect.stringContaining('"departmentId[]" is not documented'),
      expect.stringContaining('"shiftStatus" is never sent'),
      expect.stringContaining("without an explicit limit"),
      expect.stringContaining('"limit" sent more than once'),
      "request body on a GET",
      "X-OpenAPI-Region header (retired)",
      expect.stringContaining("ClockOff only reads from Planday"),
    ]);
  });

  it("throws for any other host", async () => {
    await expect(mock.fetch("https://example.com/hr/v1.0/departments")).rejects.toThrow(TypeError);
    await expect(mock.fetch("http://openapi.planday.com/portal/v1.0/info")).rejects.toThrow(
      /no route/,
    );
    expect(mock.unexpectedRequests).toHaveLength(2);
    expect(mock.requestLog).toHaveLength(0);
  });

  it("accepts Request objects", async () => {
    const response = await mock.fetch(
      new Request(`${ID}/connect/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: MOCK_CUSTOMER_APP_ID,
          grant_type: "refresh_token",
          refresh_token: MOCK_REFRESH_TOKEN,
        }),
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("reset and JSON controls", () => {
  it("restores the fixture, the grants and both logs", async () => {
    mock.controls.revokeRefreshToken("all");
    mock.controls.deleteShift(500001);
    mock.controls.setDateTimeFormat("utc");
    mock.controls.advanceClock(10_000_000);
    await mock.fetch("https://example.com/").catch(() => undefined);
    await refresh();
    mock.controls.reset();
    expect(mock.requestLog).toEqual([]);
    expect(mock.unexpectedRequests).toEqual([]);
    expect(mock.state.settings.dateTimeFormat).toBe("local");
    expect(mock.state.now()).toBe(FROZEN_NOW.getTime());
    expect(mock.state.portal(4100001).shifts.has(500001)).toBe(true);
    expect((await refresh()).status).toBe(200);
    expect(mock.requestLog[0]!.seq).toBe(1);
  });

  it("runs controls from JSON and rejects invalid ones", async () => {
    const edited = runControlAction(mock.controls, {
      action: "editShift",
      id: 500002,
      patch: { endDateTime: "2026-10-19T19:00:00" },
    }) as { end: string };
    expect(edited.end).toBe("2026-10-19T19:00:00");
    expect(runControlAction(mock.controls, { action: "setPagingNull", enabled: true })).toBeNull();
    expect(mock.state.settings.pagingNull).toBe(true);
    expect(
      runControlAction(mock.controls, { action: "issueTokenForApp", appId: PARTNER_APP_ID }),
    ).toMatchObject({
      portalId: 4100001,
    });
    expect(
      runControlAction(mock.controls, { action: "revokeRefreshToken", keepAccessTokens: true }),
    ).toEqual({
      revoked: 4,
    });
    expect(() => runControlAction(mock.controls, { action: "dropDatabase" })).toThrow(
      MockControlError,
    );
    expect(() => runControlAction(mock.controls, { action: "editShift", id: "x" })).toThrow(
      /invalid control request/,
    );
    expect(() => runControlAction(mock.controls, { action: "deleteShift", id: 1 })).toThrow(
      /has no shift 1/,
    );
  });
});
