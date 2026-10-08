import { describe, expect, it, vi } from "vitest";
import {
  CredentialPersistError,
  CredentialsWipedError,
  LeaseLostError,
  type CredentialStore,
  type StoredCredentials,
} from "@clockoff/shared/providers/credentialStore";
import {
  accessTokenHash,
  createInMemoryCredentialStore,
  createPlandayClient,
  type PlandayClientOptions,
} from "./client";
import { FORBIDDEN_QUERY_PARAMS } from "./constants";
import { PlandayError } from "./errors";
import { abortErrorFor, PlandayBudgets, type PlandayFetch, type Sleep } from "./http";

// ---------------------------------------------------------------------------------------------------------
// A small fake Planday: an identity server that issues and rotates tokens, and API routes given per test.
// (The full Mock Planday is exercised against this client by client.contract.test.ts, stage 2C.)
// ---------------------------------------------------------------------------------------------------------

const T0 = Date.parse("2026-10-21T10:30:00Z");
const CLIENT_ID = "5f0c6a3e-0000-4000-8000-00000000c0de";

interface Call {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly form: URLSearchParams | null;
  readonly signal: AbortSignal | undefined;
}
type Route = (call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const list = (data: unknown[]) =>
  json({ data, paging: { offset: 0, limit: 50, total: data.length } });

function fakePlanday(routes: Record<string, Route> = {}, options: { rotate?: boolean } = {}) {
  let clock = T0;
  const calls: Call[] = [];
  const live = new Map<string, number>([["at-0", T0 + 3_600_000]]);
  let refresh = "rt-0";
  let issued = 0;
  let tokenGate: Promise<void> | null = null;
  const server = {
    calls,
    revoked: false,
    rotate: options.rotate ?? false,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    expireAll: () => live.clear(),
    gateTokens(): () => void {
      let open!: () => void;
      tokenGate = new Promise((resolve) => (open = resolve));
      return () => {
        tokenGate = null;
        open();
      };
    },
    currentRefreshToken: () => refresh,
    tokenRequests: () => calls.filter((c) => c.url.pathname === "/connect/token").length,
    apiCalls: () => calls.filter((c) => c.url.host === "openapi.planday.com"),
  };
  const fetch: PlandayFetch = async (url, init) => {
    const u = new URL(url);
    const call: Call = {
      url: u,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      form: init.method === "POST" ? new URLSearchParams(String(init.body)) : null,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    if (u.host === "id.planday.com" && u.pathname === "/connect/token") {
      if (tokenGate) await tokenGate;
      const form = call.form as URLSearchParams;
      if (
        server.revoked ||
        form.get("client_id") !== CLIENT_ID ||
        form.get("refresh_token") !== refresh
      ) {
        return json({ error: "invalid_grant" }, 400);
      }
      issued++;
      const accessToken = `at-${issued}`;
      live.set(accessToken, clock + 3_600_000);
      const body: Record<string, unknown> = {
        access_token: accessToken,
        expires_in: 3600,
        token_type: "Bearer",
      };
      if (server.rotate) {
        refresh = `rt-${issued}`;
        body.refresh_token = refresh;
      }
      return json(body);
    }
    if (u.host !== "openapi.planday.com") throw new Error(`unexpected host ${u.host}`);
    const bearer = call.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const expiry = live.get(bearer);
    if (expiry === undefined || expiry <= clock || call.headers.get("x-clientid") !== CLIENT_ID) {
      return json({}, 401);
    }
    const route = routes[u.pathname];
    if (!route) return json({ title: "Not Found" }, 404);
    return route(call);
  };
  return { server, fetch };
}

function storeWith(server: { now: () => number }, overrides: Partial<StoredCredentials> = {}) {
  return createInMemoryCredentialStore(
    {
      clientId: CLIENT_ID,
      refreshToken: "rt-0",
      accessToken: "at-0",
      accessTokenExpiresAt: new Date(T0 + 3_600_000),
      ...overrides,
    },
    () => new Date(server.now()),
  );
}

function makeClient(
  fake: ReturnType<typeof fakePlanday>,
  store: CredentialStore,
  extra: Partial<PlandayClientOptions> = {},
) {
  const logs: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const log = (level: string) => (obj: Readonly<Record<string, unknown>>, msg: string) =>
    logs.push({ level, obj: { ...obj }, msg });
  const sleep: Sleep = async (ms, signal) => {
    if (signal?.aborted) throw abortErrorFor(signal);
    fake.server.advance(ms);
  };
  const client = createPlandayClient({
    transport: { fetch: fake.fetch },
    credentialStore: store,
    portalKey: "4100001",
    integrationId: "int-1",
    budget: new PlandayBudgets(),
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    now: () => new Date(fake.server.now()),
    sleep,
    random: () => 0,
    ...extra,
  });
  return { client, logs };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

const portalBody = {
  data: {
    id: 4100001,
    name: "Mock Bistro Group",
    companyName: "Ltd",
    country: "GB",
    timeZone: "Europe/London",
    portals: [],
  },
};

// ---------------------------------------------------------------------------------------------------------

describe("access tokens (§4.3)", () => {
  it("uses a stored token that is valid for more than 5 minutes without a token request", async () => {
    const fake = fakePlanday({ "/portal/v1.0/info": () => json(portalBody) });
    const { client } = makeClient(fake, storeWith(fake.server));
    await client.getPortalInfo();
    expect(fake.server.tokenRequests()).toBe(0);
    expect(fake.server.apiCalls()[0]?.headers.get("authorization")).toBe("Bearer at-0");
  });

  it("refreshes proactively when the token expires within 5 minutes, or is missing", async () => {
    const fake = fakePlanday({ "/portal/v1.0/info": () => json(portalBody) });
    const store = storeWith(fake.server, { accessTokenExpiresAt: new Date(T0 + 299_000) });
    const { client } = makeClient(fake, store);
    await client.getPortalInfo();
    expect(fake.server.tokenRequests()).toBe(1);
    expect(fake.server.apiCalls()[0]?.headers.get("authorization")).toBe("Bearer at-1");
    expect(store.current().accessTokenExpiresAt?.getTime()).toBe(T0 + 3_600_000);

    const fresh = fakePlanday({ "/portal/v1.0/info": () => json(portalBody) });
    const empty = storeWith(fresh.server, { accessToken: null, accessTokenExpiresAt: null });
    await makeClient(fresh, empty).client.getPortalInfo();
    expect(fresh.server.tokenRequests()).toBe(1);
  });

  it("always runs the refresh grant with force (PORTAL_CHECK), detecting a revoked refresh token", async () => {
    const fake = fakePlanday();
    const store = storeWith(fake.server);
    const { client } = makeClient(fake, store);
    await expect(client.accessToken({ force: true })).resolves.toMatchObject({
      accessToken: "at-1",
    });
    expect(fake.server.tokenRequests()).toBe(1);
    fake.server.revoked = true;
    expect(await rejection(client.accessToken({ force: true }))).toMatchObject({
      code: "PLANDAY_AUTH_FAILED",
      status: 400,
    });
  });

  it("persists a rotated refresh token before the new access token is used", async () => {
    const fake = fakePlanday({ "/portal/v1.0/info": () => json(portalBody) }, { rotate: true });
    const store = storeWith(fake.server, { accessToken: null, accessTokenExpiresAt: null });
    const writes: StoredCredentials[] = [];
    const watched: CredentialStore = {
      read: () => store.read(),
      knownVersion: () => store.knownVersion(),
      refreshAtomically: async (exchange, options) => {
        const next = await store.refreshAtomically(async (current) => {
          const result = await exchange(current);
          // No API request has used the new access token yet.
          expect(fake.server.apiCalls()).toHaveLength(0);
          return result;
        }, options);
        writes.push(next);
        return next;
      },
    };
    const { client, logs } = makeClient(fake, watched);
    await client.getPortalInfo();
    expect(writes).toEqual([
      {
        clientId: CLIENT_ID,
        refreshToken: "rt-1",
        accessToken: "at-1",
        accessTokenExpiresAt: new Date(T0 + 3_600_000),
      },
    ]);
    expect(store.current().refreshToken).toBe("rt-1");
    expect(logs.find((l) => l.msg === "planday.token.refreshed")?.obj).toEqual({
      integrationId: "int-1",
      rotated: true,
      expiresInS: 3600,
    });
  });

  it("answers a 401 with one forced refresh that names the rejected token, then retries", async () => {
    const fake = fakePlanday({ "/portal/v1.0/info": () => json(portalBody) });
    const store = storeWith(fake.server);
    const spy = vi.spyOn(store, "refreshAtomically");
    fake.server.expireAll(); // Planday no longer accepts at-0 although it has not expired by our clock.
    const { client } = makeClient(fake, store);
    await expect(client.getPortalInfo()).resolves.toMatchObject({ externalId: "4100001" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toEqual({
      minValidityMs: 300_000,
      rejectAccessTokenHash: accessTokenHash("at-0"),
    });
    expect(fake.server.apiCalls().map((c) => c.headers.get("authorization"))).toEqual([
      "Bearer at-0",
      "Bearer at-1",
    ]);
  });

  it("concurrent callers share one token request; a forced refresh never joins an ordinary one", async () => {
    const fake = fakePlanday();
    const store = storeWith(fake.server, { accessToken: null, accessTokenExpiresAt: null });
    const { client } = makeClient(fake, store);
    const release = fake.server.gateTokens();
    const ordinary = Promise.all([client.accessToken(), client.accessToken()]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const forced = client.accessToken({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.server.tokenRequests()).toBe(1);
    release();
    const [first, second] = await ordinary;
    expect(first?.accessToken).toBe("at-1");
    expect(second?.accessToken).toBe("at-1");
    // The forced refresh waited for the ordinary one, then ran its own grant.
    expect((await forced).accessToken).toBe("at-2");
    expect(fake.server.tokenRequests()).toBe(2);
  });

  it("an ordinary caller joins a forced refresh in flight", async () => {
    const fake = fakePlanday();
    const { client } = makeClient(
      fake,
      storeWith(fake.server, { accessToken: null, accessTokenExpiresAt: null }),
    );
    const results = await Promise.all([client.accessToken({ force: true }), client.accessToken()]);
    expect(results.map((r) => r.accessToken)).toEqual(["at-1", "at-1"]);
    expect(fake.server.tokenRequests()).toBe(1);
  });

  it("never hands one store's refreshed tokens to a client of another store", async () => {
    const fake = fakePlanday();
    const budget = new PlandayBudgets();
    const empty = { accessToken: null, accessTokenExpiresAt: null };

    // Two integrations on the same portal key (mock connections of two organisations): separate refreshes.
    const storeA = storeWith(fake.server, empty);
    const storeB = storeWith(fake.server, empty);
    const a = makeClient(fake, storeA, { budget, integrationId: "int-A" }).client;
    const b = makeClient(fake, storeB, { budget, integrationId: "int-B" }).client;
    let release = fake.server.gateTokens();
    const forcedA = a.accessToken({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const forcedB = b.accessToken({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.server.tokenRequests()).toBe(2);
    release();
    expect((await forcedA).accessToken).toBe("at-1");
    expect((await forcedB).accessToken).toBe("at-2");
    expect([storeA.current().accessToken, storeB.current().accessToken]).toEqual(["at-1", "at-2"]);

    // The same integration through another store (a second connect proof): it waits for the refresh in
    // flight, then runs its own grant against its own store.
    const storeC = storeWith(fake.server, empty);
    const c = makeClient(fake, storeC, { budget, integrationId: "int-A" }).client;
    release = fake.server.gateTokens();
    const againA = a.accessToken({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const forcedC = c.accessToken({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.server.tokenRequests()).toBe(3);
    release();
    expect((await againA).accessToken).toBe("at-3");
    expect((await forcedC).accessToken).toBe("at-4");
    expect(storeC.current().accessToken).toBe("at-4");
    expect(storeA.current().accessToken).toBe("at-3");
    expect(fake.server.tokenRequests()).toBe(4);
  });

  it("a persistence failure becomes CREDENTIAL_PERSIST_FAILED and the unpersisted token is never used", async () => {
    const fake = fakePlanday({ "/portal/v1.0/info": () => json(portalBody) }, { rotate: true });
    const failing: CredentialStore = {
      read: async () => ({
        clientId: CLIENT_ID,
        refreshToken: "rt-0",
        accessToken: null,
        accessTokenExpiresAt: null,
      }),
      knownVersion: () => 7,
      refreshAtomically: async (exchange) => {
        await exchange({
          clientId: CLIENT_ID,
          refreshToken: "rt-0",
          accessToken: null,
          accessTokenExpiresAt: null,
        });
        throw new CredentialPersistError();
      },
    };
    const { client, logs } = makeClient(fake, failing);
    const err = await rejection(client.getPortalInfo());
    expect(err).toBeInstanceOf(PlandayError);
    expect(err).toMatchObject({ code: "CREDENTIAL_PERSIST_FAILED", retryable: true });
    expect(fake.server.apiCalls()).toHaveLength(0);
    const line = logs.find((l) => l.msg === "planday.credentials.persist_failed");
    expect(line).toMatchObject({
      level: "error",
      obj: { integrationId: "int-1", credentialVersion: 7, rotated: true },
    });
    expect(Object.keys(line?.obj ?? {}).sort()).toEqual([
      "credentialVersion",
      "integrationId",
      "rotated",
    ]);
  });

  it("lets LeaseLostError and CredentialsWipedError through untouched", async () => {
    for (const error of [new LeaseLostError(), new CredentialsWipedError()]) {
      const fake = fakePlanday();
      const store: CredentialStore = {
        read: async () => {
          throw error;
        },
        knownVersion: () => 0,
        refreshAtomically: async () => {
          throw error;
        },
      };
      const { client } = makeClient(fake, store);
      expect(await rejection(client.accessToken())).toBe(error);
      expect(await rejection(client.accessToken({ force: true }))).toBe(error);
    }
  });

  it("a worker shutdown never cuts a token request in flight; the API request after it is aborted", async () => {
    const fake = fakePlanday({ "/portal/v1.0/info": () => json(portalBody) }, { rotate: true });
    const store = storeWith(fake.server, { accessToken: null, accessTokenExpiresAt: null });
    const controller = new AbortController();
    const { client } = makeClient(fake, store, { signal: controller.signal });
    const release = fake.server.gateTokens();
    const pending = client.getPortalInfo();
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    release();
    expect(await rejection(pending)).toMatchObject({ name: "AbortError" });
    // The rotated refresh token was persisted anyway.
    expect(store.current()).toMatchObject({ refreshToken: "rt-1", accessToken: "at-1" });
    expect(fake.server.apiCalls()).toHaveLength(0);
  });

  it("counts token requests in requestCount", async () => {
    const fake = fakePlanday({ "/portal/v1.0/info": () => json(portalBody) });
    const { client } = makeClient(
      fake,
      storeWith(fake.server, { accessToken: null, accessTokenExpiresAt: null }),
    );
    await client.getPortalInfo();
    expect(client.requestCount()).toBe(2);
  });
});

describe("endpoints (notes §9)", () => {
  it("portal info → PlandayPortal; a 403 names 'portal info'", async () => {
    const fake = fakePlanday({ "/portal/v1.0/info": () => json(portalBody) });
    const { client } = makeClient(fake, storeWith(fake.server));
    expect(await client.getPortalInfo()).toEqual({
      externalId: "4100001",
      name: "Mock Bistro Group",
      timezone: "Europe/London",
      reportedTimezone: "Europe/London",
      childPortalCount: 0,
    });
    const denied = fakePlanday({ "/portal/v1.0/info": () => json({}, 403) });
    expect(
      await rejection(makeClient(denied, storeWith(denied.server)).client.getPortalInfo()),
    ).toMatchObject({
      code: "PLANDAY_SCOPE_MISSING",
      missingScopes: ["portal info"],
    });
  });

  it("lists send explicit limits and the documented filters", async () => {
    const fake = fakePlanday({
      "/hr/v1.0/departments": () => list([{ id: 101, name: "Bar", number: null }]),
      "/hr/v1.0/employeegroups": () => list([{ id: 201, name: "Bartenders" }]),
      "/hr/v1.0/employees": () =>
        list([
          { id: 1001, firstName: "Aisha", lastName: "Khan", email: "a@x.test", departments: [101] },
        ]),
      "/hr/v1.0/employees/deactivated": () => list([{ id: 1011, deactivationDate: "2026-10-01" }]),
      "/scheduling/v1.0/shifts": () => list([]),
      "/scheduling/v1.0/shifts/deleted": () =>
        list([{ id: 5009, dateTimeDeleted: "2026-10-20T10:00:00Z" }]),
      "/scheduling/v1.0/scheduleDay": () =>
        list([{ date: "2026-11-05", departmentId: 102, isVisible: false }]),
      "/punchclock/v1.0/punchclockshifts": () => list([]),
      "/punchclock/v1.0/punchclockshifts/9001/breaks": () =>
        json({ data: [{ id: 1, startDateTime: "2026-10-21T12:00" }], paging: { total: 1 } }),
    });
    const { client } = makeClient(fake, storeWith(fake.server));
    const zone = { portalZone: "Europe/London" };
    expect((await client.listDepartments()).records).toEqual([
      { externalId: "101", name: "Bar", number: null },
    ]);
    expect((await client.listEmployeeGroups({ offset: 50 })).records).toHaveLength(1);
    expect((await client.listEmployees(zone)).records[0]).toMatchObject({
      externalId: "1001",
      externalLocationIds: ["101"],
    });
    expect(
      (
        await client.listDeactivatedEmployees({
          ...zone,
          deactivatedFrom: new Date("2026-10-19T10:00:00.500Z"),
        })
      ).records,
    ).toEqual([{ externalId: "1011", deactivationDate: new Date("2026-09-30T23:00:00Z") }]);
    await client.listShifts({ ...zone, from: "2026-10-19", to: "2026-11-18" });
    expect(
      (await client.listDeletedShifts({ deletedFrom: new Date("2026-10-06T00:00:00Z") })).records,
    ).toHaveLength(1);
    expect(
      (await client.listScheduleDays({ departmentId: "102", from: "2026-10-19", to: "2026-11-18" }))
        .records,
    ).toEqual([{ externalDepartmentId: "102", date: "2026-11-05", isVisible: false }]);
    await client.listPunchClockShifts({
      from: new Date("2026-10-21T07:30:00Z"),
      to: new Date("2026-10-21T11:30:00Z"),
      portalZone: "Europe/London",
    });
    expect(await client.listPunchClockBreaks("9001")).toEqual([
      { externalId: "1", startDateTime: "2026-10-21T12:00", endDateTime: null },
    ]);

    const queries = fake.server
      .apiCalls()
      .map((c) => `${c.url.pathname}?${c.url.searchParams.toString()}`);
    expect(queries).toEqual([
      "/hr/v1.0/departments?limit=50&offset=0",
      "/hr/v1.0/employeegroups?limit=50&offset=50",
      "/hr/v1.0/employees?limit=50&offset=0",
      "/hr/v1.0/employees/deactivated?deactivatedFrom=2026-10-19T10%3A00%3A00Z&limit=50&offset=0",
      "/scheduling/v1.0/shifts?from=2026-10-19&to=2026-11-18&limit=100&offset=0",
      "/scheduling/v1.0/shifts/deleted?deletedFrom=2026-10-06T00%3A00%3A00Z&limit=100&offset=0",
      "/scheduling/v1.0/scheduleDay?departmentId=102&from=2026-10-19&to=2026-11-18&limit=50&offset=0",
      "/punchclock/v1.0/punchclockshifts?from=2026-10-21T08%3A30&to=2026-10-21T12%3A30&limit=50&offset=0",
      "/punchclock/v1.0/punchclockshifts/9001/breaks?",
    ]);
    for (const call of fake.server.apiCalls()) {
      for (const name of FORBIDDEN_QUERY_PARAMS)
        expect(call.url.searchParams.has(name)).toBe(false);
      expect(call.method).toBe("GET");
    }
  });

  it("by-id reads: 404, a 400 for an employee and data: null are NOT_FOUND", async () => {
    const fake = fakePlanday({
      "/scheduling/v1.0/shifts/5001": () => json({ title: "Not Found", status: 404 }, 404),
      "/scheduling/v1.0/shifts/5002": () => json({ data: null }),
      "/hr/v1.0/employees/1011": () => json({}, 400),
      "/hr/v1.0/employees/1012": () =>
        json({
          data: {
            id: 1012,
            isDeactivated: true,
            deactivationDate: "2026-10-01",
            gender: "Female",
            custom_1: { value: "x" },
          },
        }),
    });
    const { client } = makeClient(fake, storeWith(fake.server));
    const zone = { portalZone: "Europe/London" };
    expect(await rejection(client.getShift("5001", zone))).toMatchObject({
      code: "PLANDAY_NOT_FOUND",
      status: 404,
    });
    expect(await rejection(client.getShift("5002", zone))).toMatchObject({
      code: "PLANDAY_NOT_FOUND",
    });
    expect(await rejection(client.getEmployeeStatus("1011", zone))).toMatchObject({
      code: "PLANDAY_NOT_FOUND",
      status: 400,
    });
    expect(await client.getEmployeeStatus("1012", zone)).toEqual({
      externalId: "1012",
      isDeactivated: true,
      deactivationDate: new Date("2026-09-30T23:00:00Z"),
    });
  });

  it("a shifts page whose date disagrees with the parsed start fails as a whole", async () => {
    const shift = (id: number, date: string, start: string, end: string) => ({
      id,
      departmentId: 101,
      employeeId: 1001,
      employeeGroupId: null,
      date,
      timeZone: "Europe/London",
      startDateTime: start,
      endDateTime: end,
      status: "Assigned",
    });
    const fake = fakePlanday({
      "/scheduling/v1.0/shifts": () =>
        list([
          shift(1, "2026-10-21", "2026-10-21T09:00:00", "2026-10-21T17:00:00"),
          // 00:30 BST on the 22nd served as UTC without Z.
          shift(2, "2026-10-22", "2026-10-21T23:30:00", "2026-10-22T07:30:00"),
        ]),
    });
    const { client } = makeClient(fake, storeWith(fake.server));
    expect(
      await rejection(
        client.listShifts({ portalZone: "Europe/London", from: "2026-10-19", to: "2026-10-23" }),
      ),
    ).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "TIME_ENCODING_MISMATCH",
      pathTemplate: "/scheduling/v1.0/shifts",
    });
  });
});

describe("probeScopes (§5.6 step 3)", () => {
  const ok = {
    "/hr/v1.0/departments": () => list([]),
    "/hr/v1.0/employeegroups": () => list([]),
    "/hr/v1.0/employees": () => list([]),
    "/scheduling/v1.0/shifts": () => list([]),
    "/punchclock/v1.0/punchclockshifts": () => list([]),
  };

  it("probes each required endpoint with limit=1 and reports the scopes proved", async () => {
    const fake = fakePlanday(ok);
    const { client } = makeClient(fake, storeWith(fake.server));
    expect(
      await client.probeScopes({
        clockMode: false,
        today: "2026-10-21",
        portalZone: "Europe/London",
      }),
    ).toEqual({
      grantedScopes: ["department:read", "employeegroup:read", "employee:read", "shift:read"],
    });
    expect(
      fake.server.apiCalls().map((c) => `${c.url.pathname}?${c.url.searchParams.toString()}`),
    ).toEqual([
      "/hr/v1.0/departments?limit=1&offset=0",
      "/hr/v1.0/employeegroups?limit=1&offset=0",
      "/hr/v1.0/employees?limit=1&offset=0",
      "/scheduling/v1.0/shifts?from=2026-10-21&to=2026-10-21&limit=1&offset=0",
    ]);
  });

  it("adds the punch clock probe (one-hour window) in clock mode", async () => {
    const fake = fakePlanday(ok);
    const { client } = makeClient(fake, storeWith(fake.server));
    const result = await client.probeScopes({
      clockMode: true,
      today: "2026-10-21",
      portalZone: "Europe/London",
    });
    expect(result.grantedScopes).toContain("punchclockshift:read");
    expect(fake.server.apiCalls().at(-1)?.url.search).toBe(
      "?from=2026-10-21T10%3A30&to=2026-10-21T11%3A30&limit=1&offset=0",
    );
  });

  it("collects every 403 into one SCOPE_MISSING naming the scopes", async () => {
    const fake = fakePlanday({
      ...ok,
      "/hr/v1.0/employees": () => json({}, 403),
      "/scheduling/v1.0/shifts": () => json({}, 403),
    });
    const { client } = makeClient(fake, storeWith(fake.server));
    expect(
      await rejection(
        client.probeScopes({ clockMode: false, today: "2026-10-21", portalZone: null }),
      ),
    ).toMatchObject({
      code: "PLANDAY_SCOPE_MISSING",
      missingScopes: ["employee:read", "shift:read"],
    });
  });

  it("fails on any other error and on an unreadable body", async () => {
    const down = fakePlanday({ ...ok, "/hr/v1.0/employeegroups": () => json({}, 500) });
    expect(
      await rejection(
        makeClient(down, storeWith(down.server)).client.probeScopes({
          clockMode: false,
          today: "2026-10-21",
          portalZone: null,
        }),
      ),
    ).toMatchObject({ code: "PLANDAY_UNAVAILABLE" });
    const garbled = fakePlanday({ ...ok, "/hr/v1.0/departments": () => json({ items: [] }) });
    expect(
      await rejection(
        makeClient(garbled, storeWith(garbled.server)).client.probeScopes({
          clockMode: false,
          today: "2026-10-21",
          portalZone: null,
        }),
      ),
    ).toMatchObject({ code: "PLANDAY_INVALID_RESPONSE" });
  });
});

describe("createInMemoryCredentialStore (the connect proof)", () => {
  const exchange = vi.fn(async (current: StoredCredentials) => ({
    ...current,
    accessToken: "next",
    accessTokenExpiresAt: new Date(T0 + 3_600_000),
  }));

  it("returns the held token while valid, refreshes when forced, expiring or rejected", async () => {
    const store = createInMemoryCredentialStore(
      {
        clientId: CLIENT_ID,
        refreshToken: "r",
        accessToken: "a",
        accessTokenExpiresAt: new Date(T0 + 600_000),
      },
      () => new Date(T0),
    );
    await expect(
      store.refreshAtomically(exchange, { minValidityMs: 300_000 }),
    ).resolves.toMatchObject({ accessToken: "a" });
    expect(exchange).not.toHaveBeenCalled();
    await store.refreshAtomically(exchange, { minValidityMs: 700_000 });
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(store.knownVersion()).toBe(1);
    await store.refreshAtomically(exchange, {
      minValidityMs: 0,
      rejectAccessTokenHash: accessTokenHash("next"),
    });
    expect(exchange).toHaveBeenCalledTimes(2);
    await store.refreshAtomically(exchange, {
      minValidityMs: 0,
      rejectAccessTokenHash: accessTokenHash("other"),
    });
    expect(exchange).toHaveBeenCalledTimes(2);
    await store.refreshAtomically(exchange, { minValidityMs: 0, force: true });
    expect(exchange).toHaveBeenCalledTimes(3);
    expect(store.current().accessToken).toBe("next");
  });
});

describe("no secrets or personal data in logs (§4.9)", () => {
  it("a full flow logs ids, codes and counts only", async () => {
    const fake = fakePlanday(
      {
        "/portal/v1.0/info": () => json(portalBody),
        "/hr/v1.0/employees": () =>
          list([
            {
              id: 1001,
              firstName: "Aisha",
              lastName: "Khan",
              email: "aisha@example.test",
              ssn: "SENTINEL-PII-ssn",
            },
          ]),
        "/hr/v1.0/departments": () => json({}, 429, { "x-ratelimit-reset": "1" }),
      },
      { rotate: true },
    );
    const { client, logs } = makeClient(
      fake,
      storeWith(fake.server, { accessToken: null, accessTokenExpiresAt: null }),
    );
    await client.getPortalInfo();
    await client.listEmployees({ portalZone: "Europe/London" });
    await rejection(client.listDepartments());
    const text = JSON.stringify(logs);
    for (const secret of [
      "at-1",
      "rt-0",
      "rt-1",
      CLIENT_ID,
      "Aisha",
      "Khan",
      "aisha@",
      "SENTINEL",
      "Bearer",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});
