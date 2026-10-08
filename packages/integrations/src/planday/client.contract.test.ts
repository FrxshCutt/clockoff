import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  CredentialStore,
  StoredCredentials,
} from "@clockoff/shared/providers/credentialStore";
import { buildAuthorizeUrl, pkceCodeChallenge } from "./authorizeUrl";
import {
  createInMemoryCredentialStore,
  createPlandayClient,
  type InMemoryCredentialStore,
  type PlandayClient,
  type PlandayClientOptions,
} from "./client";
import {
  PAGE_LIMITS,
  PLANDAY_PATHS,
  PLANDAY_USER_AGENT,
  REQUIRED_SCOPES,
  requiredScopes,
} from "./constants";
import {
  PlandayError,
  PlandayRateLimitedError,
  PlandayRequestBudgetExhaustedError,
} from "./errors";
import {
  abortErrorFor,
  isAbortError,
  PlandayBudgets,
  type PlandayTransport,
  type Sleep,
} from "./http";
import { PLANDAY_LOG_EVENTS } from "./logging";
import type { PlandayShift } from "./mappers";
import { fetchAllPages, paginate } from "./pagination";
import { exchangeCode, refreshToken, revokeToken, type TokenRequestDeps } from "./tokens";
import {
  createMockPlanday,
  FROZEN_NOW,
  MOCK_CUSTOMER_APP_ID,
  MOCK_DEPARTMENT_IDS,
  MOCK_EMPLOYEE_IDS,
  MOCK_NO_DEPARTMENTS_PORTAL_ID,
  MOCK_PORTAL_CREDENTIALS,
  MOCK_PORTAL_ID,
  MOCK_REFRESH_TOKEN,
  MOCK_SECOND_PORTAL_ID,
  startMockPlandayHttpServer,
  type MockPlanday,
  type MockPlandayHttpServer,
  type MockPlandayRequestLogEntry,
} from "./mock";

/**
 * The client × mock contract (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §15 stage 2C): the real Planday
 * client (§4) against Mock Planday (§12), which was written from the notes' raw shapes rather than from the
 * client's schemas, so a disagreement between the two shows up here instead of being mirrored. Covers tokens,
 * rotation, revocation, the 401 retry, pagination with server-lowered pages, the 429 variants with the inline-wait
 * and park thresholds, 5xx, malformed answers, abort by signal (API requests yes, token requests never), and ends
 * every test by asserting the mock saw no request ClockOff must never make. The last suite repeats the main flow
 * over HTTP through `httpServer.ts`, the way mock mode's transport reaches it (§4.1, §12.1).
 */

const PARTNER_APP_ID = "0b8a3f1e-1111-4222-8333-444455556666";
const CALLBACK = "https://app.clockoff.test/api/integrations/planday/callback";
const PORTAL_ZONE = "Europe/London";
/** The fixture's four weeks (Monday 19 Oct to Sunday 15 Nov 2026). */
const FROM = "2026-10-19";
const TO = "2026-11-15";
const API_HOST = "openapi.planday.com";
const ID_HOST = "id.planday.com";
const DEPARTMENTS = PLANDAY_PATHS.departments;
const EMPLOYEE_GROUPS = PLANDAY_PATHS.employeeGroups;
const EMPLOYEES = PLANDAY_PATHS.employees;
const SHIFTS = PLANDAY_PATHS.shifts;
/** Active employees of the main portal: everyone but 1011 (deactivated). */
const ACTIVE_EMPLOYEE_IDS = Object.values(MOCK_EMPLOYEE_IDS)
  .filter((id) => id !== MOCK_EMPLOYEE_IDS.HANNAH_WRIGHT)
  .map(String);

let clock: number;
let mock: MockPlanday;

beforeEach(() => {
  clock = FROZEN_NOW.getTime();
  mock = createMockPlanday({ now: () => clock, partnerAppIds: [PARTNER_APP_ID] });
});

afterEach(() => {
  // Every request the client made is one ClockOff may make (plan §12.2).
  expect(mock.unexpectedRequests).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------

interface LogLine {
  readonly level: string;
  readonly msg: string;
  readonly obj: Record<string, unknown>;
}

interface Harness {
  readonly client: PlandayClient;
  /** The in-memory store behind the client (the connect proof's store). */
  readonly store: InMemoryCredentialStore;
  /** Aborts the client's signal (a worker shutdown or a lost lease). */
  readonly controller: AbortController;
  /** Every wait the client slept (fake sleep only). */
  readonly sleeps: number[];
  readonly logs: LogLine[];
  /** Every per-request timeout the client set. */
  readonly timeouts: number[];
}

interface HarnessOptions {
  readonly credentials?: Partial<StoredCredentials>;
  readonly transport?: PlandayTransport;
  /** The clock the client reads (default: the in-process mock's). */
  readonly now?: () => Date;
  /** Moves the clock the fake sleep advances (default: the in-process mock's base clock). */
  readonly advance?: (ms: number) => void;
  /** The real, timer-based sleep (abort tests). */
  readonly realSleep?: boolean;
  /** Wraps the in-memory store (to observe what is persisted when). */
  readonly wrapStore?: (store: InMemoryCredentialStore) => CredentialStore;
  readonly options?: Partial<PlandayClientOptions>;
}

/** A client on method C's fixture credentials (nothing cached yet), as after a paste. */
function connect(options: HarnessOptions = {}): Harness {
  const now = options.now ?? (() => new Date(mock.state.now()));
  const advance =
    options.advance ??
    ((ms: number) => {
      clock += ms;
    });
  const sleeps: number[] = [];
  const logs: LogLine[] = [];
  const timeouts: number[] = [];
  const controller = new AbortController();
  const store = createInMemoryCredentialStore(
    {
      clientId: MOCK_CUSTOMER_APP_ID,
      refreshToken: MOCK_REFRESH_TOKEN,
      accessToken: null,
      accessTokenExpiresAt: null,
      ...options.credentials,
    },
    now,
  );
  const log = (level: string) => (obj: Readonly<Record<string, unknown>>, msg: string) => {
    logs.push({ level, msg, obj: { ...obj } });
  };
  const fakeSleep: Sleep = async (ms, signal) => {
    if (signal?.aborted) throw abortErrorFor(signal);
    sleeps.push(ms);
    advance(ms);
  };
  const client = createPlandayClient({
    transport: options.transport ?? { fetch: mock.fetch, authorizeBaseUrl: mock.authorizeBaseUrl },
    credentialStore: options.wrapStore ? options.wrapStore(store) : store,
    portalKey: String(MOCK_PORTAL_ID),
    integrationId: "integration-contract",
    runId: "run-contract",
    budget: new PlandayBudgets(),
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    now,
    signal: controller.signal,
    random: () => 0,
    createTimeoutSignal: (ms) => {
      timeouts.push(ms);
      return AbortSignal.timeout(ms);
    },
    ...(options.realSleep ? {} : { sleep: fakeSleep }),
    ...options.options,
  });
  return { client, store, controller, sleeps, logs, timeouts };
}

/** Dependencies for the token functions called directly (code exchange, revocation). */
function tokenDeps(extra: Partial<TokenRequestDeps> = {}): TokenRequestDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    transport: { fetch: mock.fetch },
    now: () => new Date(mock.state.now()),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0,
    sleeps,
    ...extra,
  };
}

function apiRequests(log: readonly MockPlandayRequestLogEntry[] = mock.requestLog, path?: string) {
  return log.filter((e) => e.host === API_HOST && (path === undefined || e.path === path));
}

function requestsTo(path: string, log: readonly MockPlandayRequestLogEntry[] = mock.requestLog) {
  return apiRequests(log, path);
}

function tokenRequests(log: readonly MockPlandayRequestLogEntry[] = mock.requestLog) {
  return log.filter((e) => e.host === ID_HOST && e.path === "/connect/token");
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

/** Lets timers and I/O run until `condition` holds (at most 5 s). */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

const listAllShifts = (client: PlandayClient) =>
  fetchAllPages(
    (offset) => client.listShifts({ offset, from: FROM, to: TO, portalZone: PORTAL_ZONE }),
    { key: (shift) => shift.externalId, path: SHIFTS },
  );

/** What the sync reads from a shift, with instants as ISO strings (DST warnings left out). */
function shiftFacts(shift: PlandayShift) {
  return {
    id: shift.externalId,
    employee: shift.externalEmployeeId,
    department: shift.externalDepartmentId,
    status: shift.status,
    date: shift.date,
    ...(shift.times.ok
      ? {
          startsAt: shift.times.startsAt.toISOString(),
          endsAt: shift.times.endsAt.toISOString(),
          timezone: shift.times.timezone,
          isOvernight: shift.times.isOvernight,
        }
      : { invalid: shift.times.reason }),
  };
}

function mainPortalFixture() {
  return mock.fixture.portals.find((p) => p.info.id === MOCK_PORTAL_ID)!;
}

// ---------------------------------------------------------------------------------------------------------
// Tokens (notes §3, plan §4.3)
// ---------------------------------------------------------------------------------------------------------

describe("tokens", () => {
  it("method C: refreshes the pasted token, then reads with the App ID that issued it", async () => {
    const h = connect();
    await expect(h.client.getPortalInfo()).resolves.toEqual({
      externalId: String(MOCK_PORTAL_ID),
      name: "Mock Bistro Group",
      timezone: PORTAL_ZONE,
      reportedTimezone: PORTAL_ZONE,
      childPortalCount: 0,
    });

    const [token, api] = mock.requestLog;
    expect(mock.requestLog).toHaveLength(2);
    expect(token).toMatchObject({
      method: "POST",
      host: ID_HOST,
      path: "/connect/token",
      status: 200,
      form: {
        client_id: MOCK_CUSTOMER_APP_ID,
        grant_type: "refresh_token",
        refresh_token: MOCK_REFRESH_TOKEN,
      },
    });
    expect(token!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(token!.headers).not.toHaveProperty("x-clientid");
    expect(token!.headers).not.toHaveProperty("authorization");

    const held = h.store.current();
    expect(api).toMatchObject({
      method: "GET",
      host: API_HOST,
      path: "/portal/v1.0/info",
      status: 200,
      clientId: MOCK_CUSTOMER_APP_ID,
      portalId: MOCK_PORTAL_ID,
      accessToken: held.accessToken,
    });
    expect(api!.headers.accept).toBe("application/json");
    expect(api!.headers["user-agent"]).toBe(PLANDAY_USER_AGENT);
    expect(api!.headers).not.toHaveProperty("x-openapi-region");
    // The mock does not rotate by default (notes §3.3): the pasted token stays the credential.
    expect(held).toMatchObject({
      clientId: MOCK_CUSTOMER_APP_ID,
      refreshToken: MOCK_REFRESH_TOKEN,
      accessTokenExpiresAt: new Date(FROZEN_NOW.getTime() + 3_600_000),
    });
    expect(h.client.requestCount()).toBe(2);
  });

  it("reuses the access token until 5 minutes before its hour is up, then refreshes first", async () => {
    const h = connect();
    await Promise.all([h.client.getPortalInfo(), h.client.listDepartments()]);
    await h.client.listEmployeeGroups();
    expect(tokenRequests()).toHaveLength(1);

    clock += 3_600_000 - 301_000;
    await h.client.listDepartments();
    expect(tokenRequests()).toHaveLength(1);

    clock += 2_000;
    await h.client.listDepartments();
    expect(tokenRequests()).toHaveLength(2);
    const [first, , , , second] = apiRequests().map((e) => e.accessToken);
    expect(second).not.toBe(first);
    expect(apiRequests().map((e) => e.status)).toEqual([200, 200, 200, 200, 200]);
  });

  it("method A: authorize URL, PKCE code exchange; the exchanged tokens read the portal", async () => {
    const verifier = "contract-test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
    const authorizeUrl = buildAuthorizeUrl({
      clientId: PARTNER_APP_ID,
      redirectUri: CALLBACK,
      state: "signed-state",
      codeChallenge: pkceCodeChallenge(verifier),
      authorizeBaseUrl: mock.authorizeBaseUrl,
    });
    // The browser's visit: the mock approves at once and redirects to the exact callback.
    const consent = await mock.fetch(authorizeUrl, { redirect: "manual" });
    expect(consent.status).toBe(302);
    const location = new URL(consent.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("state")).toBe("signed-state");
    const code = location.searchParams.get("code")!;

    const deps = tokenDeps();
    const exchanged = await exchangeCode(
      {
        clientId: PARTNER_APP_ID,
        code,
        redirectUri: CALLBACK,
        codeVerifier: verifier,
        requiredScopes: requiredScopes({ clockMode: true }),
      },
      deps,
    );
    // id_token is never parsed, so it cannot be stored or logged.
    expect(Object.keys(exchanged).sort()).toEqual([
      "accessToken",
      "expiresInS",
      "refreshToken",
      "scope",
    ]);
    expect(exchanged.expiresInS).toBe(3600);
    expect(exchanged.scope?.split(" ")).toEqual(
      expect.arrayContaining(["offline_access", ...REQUIRED_SCOPES]),
    );
    const exchange = tokenRequests().at(-1)!;
    expect(exchange.form).toEqual({
      client_id: PARTNER_APP_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });

    // A code is single-use.
    expect(
      await rejection(
        exchangeCode(
          { clientId: PARTNER_APP_ID, code, redirectUri: CALLBACK, codeVerifier: verifier },
          deps,
        ),
      ),
    ).toMatchObject({ code: "PLANDAY_AUTH_FAILED", status: 400 });

    const h = connect({
      credentials: {
        clientId: PARTNER_APP_ID,
        refreshToken: exchanged.refreshToken,
        accessToken: exchanged.accessToken,
        accessTokenExpiresAt: new Date(mock.state.now() + exchanged.expiresInS * 1000),
      },
    });
    await expect(h.client.getPortalInfo()).resolves.toMatchObject({ externalId: "4100001" });
    expect(apiRequests().at(-1)).toMatchObject({
      status: 200,
      clientId: PARTNER_APP_ID,
      accessToken: exchanged.accessToken,
    });
    expect(tokenRequests()).toHaveLength(2);
  });

  it("method A: no verifier without PKCE, a wrong verifier fails, a narrower consent names the scopes", async () => {
    const deps = tokenDeps();
    const plain = mock.controls.issueAuthorizationCode({
      clientId: PARTNER_APP_ID,
      redirectUri: CALLBACK,
      scope: "openid offline_access department:read employeegroup:read employee:read shift:read",
    });
    await expect(
      exchangeCode(
        {
          clientId: PARTNER_APP_ID,
          code: plain.code,
          redirectUri: CALLBACK,
          requiredScopes: REQUIRED_SCOPES,
        },
        deps,
      ),
    ).resolves.toMatchObject({ refreshToken: expect.stringMatching(/^mock-rt-/) });
    expect(tokenRequests().at(-1)!.form).not.toHaveProperty("code_verifier");

    const withPkce = mock.controls.issueAuthorizationCode({
      clientId: PARTNER_APP_ID,
      redirectUri: CALLBACK,
      scope: "openid offline_access department:read employeegroup:read employee:read shift:read",
      codeChallenge: pkceCodeChallenge("the-right-verifier-0123456789-0123456789-abcdef"),
      codeChallengeMethod: "S256",
    });
    expect(
      await rejection(
        exchangeCode(
          {
            clientId: PARTNER_APP_ID,
            code: withPkce.code,
            redirectUri: CALLBACK,
            codeVerifier: "a-wrong-verifier-0123456789-0123456789-abcdefgh",
          },
          deps,
        ),
      ),
    ).toMatchObject({ code: "PLANDAY_AUTH_FAILED", status: 400 });

    const narrow = mock.controls.issueAuthorizationCode({
      clientId: PARTNER_APP_ID,
      redirectUri: CALLBACK,
      scope: "openid offline_access department:read employeegroup:read employee:read",
    });
    expect(
      await rejection(
        exchangeCode(
          {
            clientId: PARTNER_APP_ID,
            code: narrow.code,
            redirectUri: CALLBACK,
            requiredScopes: REQUIRED_SCOPES,
          },
          deps,
        ),
      ),
    ).toMatchObject({ code: "PLANDAY_SCOPE_MISSING", missingScopes: ["shift:read"] });
  });

  it("method B: a token issued for ClockOff's App ID works only with that App ID", async () => {
    const { refreshToken: issued } = mock.controls.issueTokenForApp(PARTNER_APP_ID);
    const ok = connect({ credentials: { clientId: PARTNER_APP_ID, refreshToken: issued } });
    await ok.client.getPortalInfo();
    expect(apiRequests().at(-1)).toMatchObject({ status: 200, clientId: PARTNER_APP_ID });

    // "client_id must own the token": the customer's App ID with ClockOff's token is refused.
    const wrong = connect({
      credentials: { clientId: MOCK_CUSTOMER_APP_ID, refreshToken: issued },
    });
    expect(await rejection(wrong.client.getPortalInfo())).toMatchObject({
      code: "PLANDAY_AUTH_FAILED",
      status: 400,
      pathTemplate: "/connect/token",
    });
    expect(apiRequests()).toHaveLength(1);
  });

  it("rotation: the new refresh token is persisted before its access token is used; the old one is dead", async () => {
    mock.controls.setRotateRefreshTokens(true);
    const persisted: StoredCredentials[] = [];
    const h = connect({
      wrapStore: (inner) => ({
        read: () => inner.read(),
        knownVersion: () => inner.knownVersion(),
        refreshAtomically: (exchange, options) =>
          inner.refreshAtomically(async (current) => {
            const next = await exchange(current);
            // Not one API request has carried the new access token before it was persisted.
            expect(apiRequests().some((e) => e.accessToken === next.accessToken)).toBe(false);
            persisted.push(next);
            return next;
          }, options),
      }),
    });
    await h.client.getPortalInfo();
    const first = h.store.current();
    expect(first.refreshToken).not.toBe(MOCK_REFRESH_TOKEN);
    expect(persisted).toEqual([first]);
    expect(mock.state.grantByRefreshToken(first.refreshToken)).toMatchObject({ retired: false });
    expect(apiRequests()[0]!.accessToken).toBe(first.accessToken);

    // The pasted token was retired by the rotation.
    expect(
      await rejection(
        refreshToken(
          { clientId: MOCK_CUSTOMER_APP_ID, refreshToken: MOCK_REFRESH_TOKEN },
          tokenDeps(),
        ),
      ),
    ).toMatchObject({ code: "PLANDAY_AUTH_FAILED", status: 400 });

    // PORTAL_CHECK's forced refresh rotates again from the persisted token.
    await h.client.accessToken({ force: true });
    const second = h.store.current();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(persisted).toEqual([first, second]);
    expect(tokenRequests().map((e) => [e.form?.refresh_token, e.status])).toEqual([
      [MOCK_REFRESH_TOKEN, 200],
      [MOCK_REFRESH_TOKEN, 400],
      [first.refreshToken, 200],
    ]);
    expect(
      h.logs.filter((l) => l.msg === PLANDAY_LOG_EVENTS.tokenRefreshed).map((l) => l.obj),
    ).toEqual([
      { integrationId: "integration-contract", rotated: true, expiresInS: 3600 },
      { integrationId: "integration-contract", rotated: true, expiresInS: 3600 },
    ]);
  });

  it("revocation sends client_id and token only (5 s); by default it ends the access tokens too", async () => {
    const h = connect();
    await h.client.getPortalInfo();
    const revocationTimeouts: number[] = [];
    await revokeToken(
      { clientId: MOCK_CUSTOMER_APP_ID, refreshToken: h.store.current().refreshToken },
      tokenDeps({
        createTimeoutSignal: (ms) => {
          revocationTimeouts.push(ms);
          return AbortSignal.timeout(ms);
        },
      }),
    );
    const revocation = mock.requestLog.at(-1)!;
    expect(revocation).toMatchObject({ method: "POST", path: "/connect/revocation", status: 200 });
    expect(revocation.form).toEqual({ client_id: MOCK_CUSTOMER_APP_ID, token: MOCK_REFRESH_TOKEN });
    expect(revocation.headers).not.toHaveProperty("x-clientid");
    expect(revocationTimeouts).toEqual([5_000]);

    // The live access token is dead: 401, one forced refresh, which the identity server refuses.
    expect(await rejection(h.client.listDepartments())).toMatchObject({
      code: "PLANDAY_AUTH_FAILED",
    });
    expect(mock.requestLog.slice(-2).map((e) => [e.path, e.status])).toEqual([
      [DEPARTMENTS, 401],
      ["/connect/token", 400],
    ]);
  });

  const silentRevocations: Array<{
    readonly name: string;
    readonly revoke: (refreshToken: string) => Promise<void>;
  }> = [
    {
      name: "the revocation endpoint with setRevocationKillsAccessTokens(false)",
      revoke: async (refresh: string) => {
        mock.controls.setRevocationKillsAccessTokens(false);
        await revokeToken({ clientId: MOCK_CUSTOMER_APP_ID, refreshToken: refresh }, tokenDeps());
      },
    },
    {
      name: "Planday's Revoke button with keepAccessTokens",
      revoke: async () => {
        mock.controls.revokeRefreshToken("all", { keepAccessTokens: true });
      },
    },
  ];

  it.each(silentRevocations)(
    "a revocation that leaves live access tokens valid is caught by the next forced refresh: $name",
    async ({ revoke }) => {
      const h = connect();
      await h.client.getPortalInfo();
      await revoke(h.store.current().refreshToken);
      // Notes §12 Q5: the old access token still reads…
      await expect(h.client.listDepartments()).resolves.toMatchObject({ done: true });
      expect(requestsTo(DEPARTMENTS).map((e) => e.status)).toEqual([200]);
      // …so every SYNC's PORTAL_CHECK forces a refresh, which detects the revocation.
      expect(await rejection(h.client.accessToken({ force: true }))).toMatchObject({
        code: "PLANDAY_AUTH_FAILED",
        status: 400,
      });
    },
  );

  it("revocation is best effort: no wait on 429, no retry on 5xx", async () => {
    const deps = tokenDeps();
    mock.controls.queueRateLimit({ path: "/connect/revocation", resetSeconds: 1 });
    const limited = await rejection(
      revokeToken({ clientId: MOCK_CUSTOMER_APP_ID, refreshToken: MOCK_REFRESH_TOKEN }, deps),
    );
    expect(limited).toBeInstanceOf(PlandayRateLimitedError);
    mock.controls.queue5xx({ path: "/connect/revocation" });
    expect(
      await rejection(
        revokeToken({ clientId: MOCK_CUSTOMER_APP_ID, refreshToken: MOCK_REFRESH_TOKEN }, deps),
      ),
    ).toMatchObject({ code: "PLANDAY_UNAVAILABLE", status: 500 });
    expect(deps.sleeps).toEqual([]);
    expect(mock.requestLog.map((e) => [e.path, e.status])).toEqual([
      ["/connect/revocation", 429],
      ["/connect/revocation", 500],
    ]);
    // Neither attempt reached the grant.
    expect(mock.state.grantByRefreshToken(MOCK_REFRESH_TOKEN)?.grant.revoked).toBe(false);
  });

  it("a transient 400 or a 5xx from the token endpoint is not retried, and nothing is stored", async () => {
    const h = connect();
    mock.controls.queueError({ path: "/connect/token", status: 400 });
    expect(await rejection(h.client.getPortalInfo())).toMatchObject({
      code: "PLANDAY_AUTH_FAILED",
      status: 400,
    });
    mock.controls.queue5xx({ path: "/connect/token", status: 503 });
    expect(await rejection(h.client.getPortalInfo())).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      status: 503,
      retryable: true,
    });
    expect(tokenRequests().map((e) => e.status)).toEqual([400, 503]);
    expect(apiRequests()).toEqual([]);
    expect(h.store.current()).toMatchObject({
      accessToken: null,
      refreshToken: MOCK_REFRESH_TOKEN,
    });
    expect(h.store.knownVersion()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 401 (notes §8, plan §4.3)
// ---------------------------------------------------------------------------------------------------------

describe("401", () => {
  it("an expired token answers 401: exactly one forced refresh, then one retry", async () => {
    const h = connect();
    await h.client.getPortalInfo();
    const rejected = h.store.current().accessToken;
    // The store still believes the token valid for most of an hour.
    mock.controls.expireAccessTokens();

    const page = await h.client.listDepartments();
    expect(page.records.map((d) => d.name)).toEqual(["Bar", "Kitchen", "Head Office"]);
    const reads = requestsTo(DEPARTMENTS);
    expect(reads.map((e) => [e.status, e.accessToken])).toEqual([
      [401, rejected],
      [200, h.store.current().accessToken],
    ]);
    expect(h.store.current().accessToken).not.toBe(rejected);
    expect(tokenRequests()).toHaveLength(2);
  });

  it("a second 401 after the forced refresh is PLANDAY_AUTH_FAILED", async () => {
    const h = connect();
    await h.client.getPortalInfo();
    mock.controls.queueError({ path: DEPARTMENTS, status: 401, count: 2 });
    expect(await rejection(h.client.listDepartments())).toMatchObject({
      code: "PLANDAY_AUTH_FAILED",
      status: 401,
      pathTemplate: DEPARTMENTS,
      retryable: false,
    });
    expect(requestsTo(DEPARTMENTS).map((e) => e.status)).toEqual([401, 401]);
    expect(tokenRequests()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Pagination (notes §7, plan §4.4)
// ---------------------------------------------------------------------------------------------------------

describe("pagination", () => {
  async function employeePages(h: Harness) {
    const pages: Array<[number, number, number | null, boolean]> = [];
    const ids: string[] = [];
    for await (const page of paginate(
      (offset) => h.client.listEmployees({ offset, portalZone: PORTAL_ZONE }),
      { key: (e) => e.externalId, path: EMPLOYEES },
    )) {
      pages.push([page.offset, page.records.length, page.total, page.done]);
      ids.push(...page.records.map((e) => e.externalId));
    }
    return { pages, ids };
  }

  it("follows a server-lowered page size with offset += data.length and stops at paging.total", async () => {
    mock.controls.capPageSize(3);
    const h = connect();
    const { pages, ids } = await employeePages(h);
    expect(pages).toEqual([
      [0, 3, 11, false],
      [3, 3, 11, false],
      [6, 3, 11, false],
      [9, 2, 11, true],
    ]);
    expect(ids).toEqual(ACTIVE_EMPLOYEE_IDS);
    expect(requestsTo(EMPLOYEES).map((e) => e.query)).toEqual(
      [0, 3, 6, 9].map((offset) => ({ limit: ["50"], offset: [String(offset)] })),
    );
  });

  it("with paging: null it reads on to an empty page", async () => {
    mock.controls.capPageSize(3);
    mock.controls.setPagingNull(true);
    const h = connect();
    const { pages, ids } = await employeePages(h);
    expect(pages).toEqual([
      [0, 3, null, false],
      [3, 3, null, false],
      [6, 3, null, false],
      [9, 2, null, false],
      [11, 0, null, true],
    ]);
    expect(ids).toEqual(ACTIVE_EMPLOYEE_IDS);
  });

  it("reads every shift of the four weeks exactly once, 100 per request, whatever the server does", async () => {
    const inRange = mainPortalFixture()
      .shifts.filter((s) => s.start.slice(0, 10) >= FROM && s.start.slice(0, 10) <= TO)
      .map((s) => String(s.id))
      .sort();
    expect(inRange).toHaveLength(60);

    const plain = await listAllShifts(connect().client);
    expect(plain.map((s) => s.externalId).sort()).toEqual(inRange);
    expect(requestsTo(SHIFTS)).toHaveLength(1);

    mock.controls.capPageSize(7);
    mock.controls.setPagingNull(true);
    const capped = await listAllShifts(connect().client);
    expect(capped).toEqual(plain);
    const cappedRequests = requestsTo(SHIFTS).slice(1);
    // 60 shifts in pages of 7, then the empty page that ends a list without paging.
    expect(cappedRequests).toHaveLength(10);
    for (const request of cappedRequests) {
      expect(request.query).toMatchObject({
        limit: [String(PAGE_LIMITS.shifts)],
        from: [FROM],
        to: [TO],
      });
    }
  });

  it("a request cap counts token requests and stops the walk with PlandayRequestBudgetExhaustedError", async () => {
    mock.controls.capPageSize(1);
    const h = connect({ options: { maxRequests: 3 } });
    const err = await rejection(
      fetchAllPages((offset) => h.client.listDepartments({ offset }), { key: (d) => d.externalId }),
    );
    expect(err).toBeInstanceOf(PlandayRequestBudgetExhaustedError);
    expect(h.client.requestCount()).toBe(3);
    expect(requestsTo(DEPARTMENTS)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 429 (notes §6, plan §4.5, §7.10)
// ---------------------------------------------------------------------------------------------------------

describe("429", () => {
  it.each([
    {
      name: "x-ratelimit-reset",
      fault: { resetSeconds: 5 },
      waitMs: 5_000,
      source: "x-ratelimit-reset",
    },
    {
      name: "Retry-After only",
      fault: { retryAfterSeconds: 3 },
      waitMs: 3_000,
      source: "retry-after",
    },
    {
      name: "both, Retry-After longer",
      fault: { resetSeconds: 2, retryAfterSeconds: 7 },
      waitMs: 7_000,
      source: "retry-after",
    },
    {
      name: "both, x-ratelimit-reset longer",
      fault: { resetSeconds: 9, retryAfterSeconds: 4 },
      waitMs: 9_000,
      source: "x-ratelimit-reset",
    },
    {
      name: "exactly 30 s",
      fault: { resetSeconds: 30 },
      waitMs: 30_000,
      source: "x-ratelimit-reset",
    },
  ])("waits inline and retries: $name", async ({ fault, waitMs, source }) => {
    const h = connect();
    await h.client.getPortalInfo();
    mock.controls.queueRateLimit({ path: DEPARTMENTS, ...fault });
    await expect(h.client.listDepartments()).resolves.toMatchObject({ done: true });
    expect(requestsTo(DEPARTMENTS).map((e) => e.status)).toEqual([429, 200]);
    expect(h.sleeps).toEqual([waitMs]);
    expect(h.logs.find((l) => l.msg === PLANDAY_LOG_EVENTS.rateLimited)?.obj).toEqual({
      pathTemplate: DEPARTMENTS,
      waitMs,
      source,
    });
  });

  it.each([
    { name: "x-ratelimit-reset over 30 s", fault: { resetSeconds: 31 }, waitMs: 31_000, random: 0 },
    {
      name: "Retry-After over 30 s",
      fault: { resetSeconds: 1, retryAfterSeconds: 120 },
      waitMs: 120_000,
      random: 0,
    },
    { name: "neither header (60 s)", fault: {}, waitMs: 60_000, random: 0 },
    { name: "30 s plus jitter", fault: { resetSeconds: 30 }, waitMs: 30_500, random: 0.5 },
  ])("parks the run with retryAt instead of waiting: $name", async ({ fault, waitMs, random }) => {
    const h = connect({ options: { random: () => random } });
    await h.client.getPortalInfo();
    mock.controls.queueRateLimit({ path: DEPARTMENTS, ...fault });
    const err = await rejection(h.client.listDepartments());
    expect(err).toBeInstanceOf(PlandayRateLimitedError);
    expect(err).toMatchObject({
      code: "PLANDAY_RATE_LIMITED",
      status: 429,
      retryable: true,
      retryAt: new Date(FROZEN_NOW.getTime() + waitMs),
    });
    expect(h.sleeps).toEqual([]);
    expect(requestsTo(DEPARTMENTS)).toHaveLength(1);
  });

  it("waits inline at most 3 times per request, then parks", async () => {
    const h = connect();
    await h.client.getPortalInfo();
    mock.controls.queueRateLimit({ path: DEPARTMENTS, count: 3, resetSeconds: 1 });
    await expect(h.client.listDepartments()).resolves.toMatchObject({ done: true });
    expect(h.sleeps).toEqual([1_000, 1_000, 1_000]);

    mock.controls.queueRateLimit({ path: DEPARTMENTS, count: 4, resetSeconds: 1 });
    expect(await rejection(h.client.listDepartments())).toBeInstanceOf(PlandayRateLimitedError);
    expect(h.sleeps).toHaveLength(6);
    expect(requestsTo(DEPARTMENTS).map((e) => e.status)).toEqual([
      429, 429, 429, 200, 429, 429, 429, 429,
    ]);
  });

  it("applies the same thresholds to the token endpoint", async () => {
    mock.controls.queueRateLimit({ path: "/connect/token", resetSeconds: 2 });
    const h = connect();
    await h.client.getPortalInfo();
    expect(h.sleeps).toEqual([2_000]);
    expect(tokenRequests().map((e) => e.status)).toEqual([429, 200]);

    mock.controls.queueRateLimit({ path: "/connect/token", retryAfterSeconds: 90 });
    const err = await rejection(h.client.accessToken({ force: true }));
    expect(err).toBeInstanceOf(PlandayRateLimitedError);
    expect((err as PlandayRateLimitedError).retryAt).toEqual(new Date(mock.state.now() + 90_000));
    expect(apiRequests()).toHaveLength(1);
  });

  it("x-ratelimit-remaining ≤ 2 holds the next request for x-ratelimit-reset; a hold over 30 s parks", async () => {
    const h = connect();
    await h.client.getPortalInfo();
    mock.controls.setRateLimitHeaders({ remaining: 2, resetSeconds: 4 });
    await h.client.listDepartments();
    expect(h.sleeps).toEqual([]);
    await h.client.listEmployeeGroups();
    expect(h.sleeps).toEqual([4_000]);

    mock.controls.setRateLimitHeaders({ remaining: 0, resetSeconds: 45 });
    await h.client.listDepartments();
    expect(h.sleeps).toEqual([4_000, 4_000]);
    const err = await rejection(h.client.listEmployeeGroups());
    expect(err).toBeInstanceOf(PlandayRateLimitedError);
    expect((err as PlandayRateLimitedError).retryAt).toEqual(new Date(mock.state.now() + 45_000));
    // The parked request was never sent.
    expect(requestsTo(EMPLOYEE_GROUPS)).toHaveLength(1);
  });

  it("under the connect deadline: timeouts shrink to the time left, nothing starts below 3 s, a wait it cannot afford parks", async () => {
    let remaining = 8_000;
    const h = connect({ options: { deadline: { remainingMs: () => remaining } } });
    await h.client.getPortalInfo();
    expect(h.timeouts).toEqual([8_000, 8_000]);

    remaining = 2_999;
    expect(await rejection(h.client.listDepartments())).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      reason: "DEADLINE",
    });
    expect(requestsTo(DEPARTMENTS)).toEqual([]);

    remaining = 6_000;
    mock.controls.queueRateLimit({ path: DEPARTMENTS, resetSeconds: 5 });
    expect(await rejection(h.client.listDepartments())).toBeInstanceOf(PlandayRateLimitedError);
    expect(h.sleeps).toEqual([]);
    expect(requestsTo(DEPARTMENTS).map((e) => e.status)).toEqual([429]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 5xx and other statuses (plan §4.5, §4.6)
// ---------------------------------------------------------------------------------------------------------

describe("5xx and other statuses", () => {
  it("retries 5xx and 409 with full-jitter backoff, at most 3 attempts per request", async () => {
    const h = connect({ options: { random: () => 0.5 } });
    await h.client.getPortalInfo();
    mock.controls.queue5xx({ path: DEPARTMENTS, count: 2, status: 503 });
    await expect(h.client.listDepartments()).resolves.toMatchObject({ done: true });
    expect(requestsTo(DEPARTMENTS).map((e) => e.status)).toEqual([503, 503, 200]);
    // Half of the 500 ms and 1 s ceilings.
    expect(h.sleeps).toEqual([250, 500]);

    mock.controls.queueError({ path: EMPLOYEE_GROUPS, status: 409 });
    await expect(h.client.listEmployeeGroups()).resolves.toMatchObject({ done: true });
    expect(requestsTo(EMPLOYEE_GROUPS).map((e) => e.status)).toEqual([409, 200]);
  });

  it("the third 5xx is PLANDAY_UNAVAILABLE (retryable at run level)", async () => {
    const h = connect();
    await h.client.getPortalInfo();
    mock.controls.queue5xx({ path: DEPARTMENTS, count: 3 });
    expect(await rejection(h.client.listDepartments())).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      status: 500,
      reason: "SERVER_ERROR",
      retryable: true,
      pathTemplate: DEPARTMENTS,
    });
    expect(requestsTo(DEPARTMENTS)).toHaveLength(3);
  });

  it("a 400 for a long /shifts range is BAD_REQUEST, not retried (the 14-day slicing trigger)", async () => {
    mock.controls.setMaxShiftRangeDays(14);
    const h = connect();
    expect(
      await rejection(h.client.listShifts({ from: FROM, to: TO, portalZone: PORTAL_ZONE })),
    ).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "BAD_REQUEST",
      status: 400,
      retryable: false,
    });
    expect(requestsTo(SHIFTS)).toHaveLength(1);
    await expect(
      h.client.listShifts({ from: FROM, to: "2026-11-01", portalZone: PORTAL_ZONE }),
    ).resolves.toMatchObject({ done: true });
  });

  it("a scheduleDay 400 for a department Planday no longer has keeps its status (HIDDEN_DAYS_UNAVAILABLE, Q35)", async () => {
    const h = connect();
    const err = await rejection(
      h.client.listScheduleDays({ departmentId: "199", from: FROM, to: TO }),
    );
    // The hidden-day phase skips the filter on status 400 or 404 rather than failing the run.
    expect(err).toBeInstanceOf(PlandayError);
    expect(err).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "BAD_REQUEST",
      status: 400,
      pathTemplate: PLANDAY_PATHS.scheduleDay,
    });
    expect(requestsTo(PLANDAY_PATHS.scheduleDay)).toHaveLength(1);
  });

  it("a missing scope is a 403 naming the scope; probeScopes collects every one", async () => {
    const h = connect();
    await expect(
      h.client.probeScopes({ clockMode: true, today: "2026-10-21", portalZone: PORTAL_ZONE }),
    ).resolves.toEqual({ grantedScopes: [...requiredScopes({ clockMode: true })] });
    const probes = apiRequests().filter((e) => e.path !== "/portal/v1.0/info");
    expect(probes.map((e) => [e.path, e.query.limit])).toEqual([
      [DEPARTMENTS, ["1"]],
      [EMPLOYEE_GROUPS, ["1"]],
      [EMPLOYEES, ["1"]],
      [SHIFTS, ["1"]],
      [PLANDAY_PATHS.punchClockShifts, ["1"]],
    ]);
    expect(probes[3]!.query).toMatchObject({ from: ["2026-10-21"], to: ["2026-10-21"] });
    expect(probes[4]!.query).toMatchObject({
      from: ["2026-10-21T10:30"],
      to: ["2026-10-21T11:30"],
    });

    mock.controls.setScopes(MOCK_CUSTOMER_APP_ID, ["department:read", "employee:read"]);
    expect(
      await rejection(
        h.client.probeScopes({ clockMode: false, today: "2026-10-21", portalZone: PORTAL_ZONE }),
      ),
    ).toMatchObject({
      code: "PLANDAY_SCOPE_MISSING",
      missingScopes: ["employeegroup:read", "shift:read"],
    });
    expect(await rejection(h.client.listEmployeeGroups())).toMatchObject({
      code: "PLANDAY_SCOPE_MISSING",
      status: 403,
      missingScopes: ["employeegroup:read"],
    });
  });
});

// ---------------------------------------------------------------------------------------------------------
// Malformed answers (plan §4.6, §4.7, §4.8)
// ---------------------------------------------------------------------------------------------------------

describe("malformed answers", () => {
  it.each([
    { mode: "missing-field", reason: "SCHEMA" },
    { mode: "unsafe-id", reason: "SCHEMA" },
    { mode: "not-json", reason: "NOT_JSON" },
  ] as const)("a page with $mode fails as a whole, unretried", async ({ mode, reason }) => {
    const h = connect();
    await h.client.getPortalInfo();
    mock.controls.queueMalformed({ path: DEPARTMENTS, mode });
    expect(await rejection(h.client.listDepartments())).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason,
      retryable: false,
      pathTemplate: DEPARTMENTS,
    });
    expect(requestsTo(DEPARTMENTS)).toHaveLength(1);
    // The next read is whole again.
    await expect(h.client.listDepartments()).resolves.toMatchObject({ total: 3 });
    if (reason === "SCHEMA") {
      const logged = h.logs.find((l) => l.msg === PLANDAY_LOG_EVENTS.invalidResponse)!;
      expect(logged.obj).toEqual({
        pathTemplate: DEPARTMENTS,
        issues: [{ path: "data.0.id", code: mode === "missing-field" ? "invalid_type" : "custom" }],
      });
    }
  });

  it("malformed portal info, by-id reads and empty lists are INVALID_RESPONSE", async () => {
    const h = connect();
    mock.controls.queueMalformed({ path: "/portal/v1.0/info" });
    expect(await rejection(h.client.getPortalInfo())).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "SCHEMA",
    });
    const shiftId = String(mock.fixture.specials.forSaleShiftId);
    mock.controls.queueMalformed({ path: "/scheduling/v1.0/shifts/{shiftId}" });
    expect(await rejection(h.client.getShift(shiftId, { portalZone: PORTAL_ZONE }))).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "SCHEMA",
      pathTemplate: "/scheduling/v1.0/shifts/{id}",
    });
    // An empty list loses `data` itself.
    mock.controls.queueMalformed({ path: PLANDAY_PATHS.deletedShifts });
    expect(await rejection(h.client.listDeletedShifts({ deletedFrom: FROZEN_NOW }))).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "SCHEMA",
    });
  });

  it("a token answer without access_token is INVALID_RESPONSE and nothing is stored or used", async () => {
    const h = connect();
    mock.controls.queueMalformed({ path: "/connect/token" });
    expect(await rejection(h.client.getPortalInfo())).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      pathTemplate: "/connect/token",
    });
    expect(h.store.current()).toMatchObject({
      accessToken: null,
      refreshToken: MOCK_REFRESH_TOKEN,
    });
    expect(apiRequests()).toEqual([]);
  });

  it("every encoding resolves to the same instants; UTC without Z fails the page as TIME_ENCODING_MISMATCH", async () => {
    // Starts 00:30 BST, inside the UTC offset of midnight: the only kind of shift the date cross-check can catch.
    const nearMidnight = mock.controls.addShift({
      startDateTime: "2026-10-22T00:30:00",
      endDateTime: "2026-10-22T06:00:00",
      departmentId: MOCK_DEPARTMENT_IDS.BAR,
      employeeId: MOCK_EMPLOYEE_IDS.AISHA_KHAN,
    });
    const h = connect();
    const local = (await listAllShifts(h.client)).map(shiftFacts);
    expect(local).toHaveLength(61);
    expect(local.find((s) => s.id === String(nearMidnight.id))).toMatchObject({
      date: "2026-10-22",
      startsAt: "2026-10-21T23:30:00.000Z",
      endsAt: "2026-10-22T05:00:00.000Z",
    });
    for (const format of ["utc", "offset"] as const) {
      mock.controls.setDateTimeFormat(format);
      expect((await listAllShifts(h.client)).map(shiftFacts), format).toEqual(local);
    }

    mock.controls.setDateTimeFormat("utc-without-z");
    expect(await rejection(listAllShifts(h.client))).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "TIME_ENCODING_MISMATCH",
      pathTemplate: SHIFTS,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------
// Abort (plan §4.1, §7.7)
// ---------------------------------------------------------------------------------------------------------

describe("abort by signal", () => {
  it("aborts an API request in flight: AbortError, no retry, and nothing more is sent", async () => {
    const h = connect();
    await h.client.getPortalInfo();
    mock.controls.setLatency(60_000, { path: DEPARTMENTS });
    const pending = h.client.listDepartments();
    await until(() => requestsTo(DEPARTMENTS).length === 1);
    h.controller.abort();
    const err = await rejection(pending);
    expect(isAbortError(err)).toBe(true);
    expect(err).not.toBeInstanceOf(PlandayError);
    expect(requestsTo(DEPARTMENTS)).toEqual([
      expect.objectContaining({ aborted: true, status: null }),
    ]);

    const before = mock.requestLog.length;
    expect(isAbortError(await rejection(h.client.listEmployeeGroups()))).toBe(true);
    expect(mock.requestLog).toHaveLength(before);
  });

  it.each([
    { name: "a 429 wait", path: DEPARTMENTS },
    { name: "a 429 wait before a token request", path: "/connect/token" },
  ])("ends $name at once", async ({ path }) => {
    const h = connect({ realSleep: true });
    if (path === DEPARTMENTS) await h.client.getPortalInfo();
    mock.controls.queueRateLimit({ path, resetSeconds: 25 });
    const pending = path === DEPARTMENTS ? h.client.listDepartments() : h.client.getPortalInfo();
    await until(() => mock.requestLog.some((e) => e.path === path && e.status === 429));
    h.controller.abort();
    expect(isAbortError(await rejection(pending))).toBe(true);
    expect(mock.requestLog.filter((e) => e.path === path).map((e) => e.status)).toEqual([429]);
  });

  it("never cuts a token request: the rotated token is persisted, then the API request is not sent", async () => {
    mock.controls.setRotateRefreshTokens(true);
    mock.controls.setLatency(200, { path: "/connect/token" });
    const tokenSignals: AbortSignal[] = [];
    const h = connect({
      transport: {
        fetch: (url, init) => {
          if (url.endsWith("/connect/token") && init.signal) tokenSignals.push(init.signal);
          return mock.fetch(url, init);
        },
      },
    });
    const pending = h.client.getPortalInfo();
    await until(() => tokenRequests().length === 1);
    h.controller.abort();
    // The token request carries only its own timeout, never the run's signal.
    expect(tokenSignals.map((s) => s.aborted)).toEqual([false]);

    expect(isAbortError(await rejection(pending))).toBe(true);
    expect(tokenRequests()).toEqual([expect.objectContaining({ status: 200, aborted: false })]);
    const held = h.store.current();
    expect(held.refreshToken).not.toBe(MOCK_REFRESH_TOKEN);
    expect(mock.state.grantByRefreshToken(held.refreshToken)).toMatchObject({ retired: false });
    expect(apiRequests()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Every endpoint, unexpected requests and data minimisation (notes §9, plan §4.2, §4.7, §4.9, §12.2)
// ---------------------------------------------------------------------------------------------------------

describe("every endpoint", () => {
  it("reads every endpoint the sync calls, allow-list mapped, with nothing unexpected and no personal data leaking", async () => {
    const h = connect();
    const { specials } = mock.fixture;
    const results: unknown[] = [];
    const keep = <T>(value: T): T => {
      results.push(value);
      return value;
    };

    keep(await h.client.getPortalInfo());
    expect(keep(await h.client.listDepartments()).records).toEqual([
      { externalId: "101", name: "Bar", number: "BAR-01" },
      { externalId: "102", name: "Kitchen", number: "KIT-01" },
      { externalId: "103", name: "Head Office", number: "HO-01" },
    ]);
    expect(keep(await h.client.listEmployeeGroups()).records.map((g) => g.name)).toEqual([
      "Bartenders",
      "Chefs",
      "Floor Staff",
      "Supervisors",
    ]);

    const employees = keep(await h.client.listEmployees({ portalZone: PORTAL_ZONE })).records;
    expect(employees.map((e) => e.externalId)).toEqual(ACTIVE_EMPLOYEE_IDS);
    const priya = employees.find((e) => e.externalId === String(MOCK_EMPLOYEE_IDS.PRIYA_PATEL))!;
    expect(Object.keys(priya).sort()).toEqual([
      "active",
      "deactivationDate",
      "email",
      "externalId",
      "externalLocationIds",
      "externalTeamIds",
      "firstName",
      "lastName",
      "primaryExternalLocationId",
    ]);
    expect(priya).toMatchObject({
      firstName: "Priya",
      lastName: "Patel",
      externalLocationIds: ["101", "102"],
      primaryExternalLocationId: "101",
      active: true,
      deactivationDate: null,
    });
    expect(
      employees.find((e) => e.externalId === String(MOCK_EMPLOYEE_IDS.DANIEL_EVANS))?.email,
    ).toBeNull();

    const deactivated = keep(
      await h.client.listDeactivatedEmployees({
        portalZone: PORTAL_ZONE,
        deactivatedFrom: new Date(FROZEN_NOW.getTime() - 30 * 86_400_000),
      }),
    ).records;
    expect(deactivated).toEqual([{ externalId: "1011", deactivationDate: expect.any(Date) }]);
    expect(
      (
        await h.client.listDeactivatedEmployees({
          portalZone: PORTAL_ZONE,
          deactivatedFrom: FROZEN_NOW,
        })
      ).records,
    ).toEqual([]);

    expect(
      keep(await h.client.getEmployeeStatus("1011", { portalZone: PORTAL_ZONE })),
    ).toMatchObject({
      externalId: "1011",
      isDeactivated: true,
    });
    expect(
      keep(await h.client.getEmployeeStatus("1001", { portalZone: PORTAL_ZONE })),
    ).toMatchObject({
      isDeactivated: false,
    });
    mock.controls.removeEmployee(MOCK_EMPLOYEE_IDS.LEO_TURNER);
    expect(
      await rejection(h.client.getEmployeeStatus("1012", { portalZone: PORTAL_ZONE })),
    ).toMatchObject({
      code: "PLANDAY_NOT_FOUND",
      status: 400,
      pathTemplate: "/hr/v1.0/employees/{id}",
    });

    const shifts = keep(await listAllShifts(h.client));
    const byId = new Map(shifts.map((s) => [s.externalId, s]));
    expect(byId.get(String(specials.inProgressShiftId))).toMatchObject({
      externalEmployeeId: "1001",
      externalDepartmentId: "101",
      date: "2026-10-21",
      times: {
        ok: true,
        startsAt: new Date("2026-10-21T08:00:00Z"),
        endsAt: new Date("2026-10-21T16:00:00Z"),
        timezone: PORTAL_ZONE,
        isOvernight: false,
      },
    });
    expect(byId.get(String(specials.dstShiftId))).toMatchObject({
      times: {
        ok: true,
        startsAt: new Date("2026-10-24T21:00:00Z"),
        endsAt: new Date("2026-10-25T06:00:00Z"),
        isOvernight: true,
      },
    });
    for (const id of specials.overnightShiftIds) {
      expect(byId.get(String(id))?.times).toMatchObject({ ok: true, isOvernight: true });
    }
    expect(byId.get(String(specials.openShiftId))).toMatchObject({
      externalEmployeeId: null,
      status: "Open",
    });
    expect(byId.get(String(specials.draftShiftId))).toMatchObject({ status: "Draft" });

    const forSale = String(specials.forSaleShiftId);
    expect(keep(await h.client.getShift(forSale, { portalZone: PORTAL_ZONE }))).toEqual(
      byId.get(forSale),
    );
    // Budget waits may have moved the clock; Planday stamps whole seconds.
    const deletedAt = new Date(Math.floor(mock.state.now() / 1000) * 1000);
    mock.controls.deleteShift(specials.forSaleShiftId);
    expect(await rejection(h.client.getShift(forSale, { portalZone: PORTAL_ZONE }))).toMatchObject({
      code: "PLANDAY_NOT_FOUND",
      status: 404,
      pathTemplate: "/scheduling/v1.0/shifts/{id}",
    });
    expect(
      keep(
        await h.client.listDeletedShifts({
          deletedFrom: new Date(FROZEN_NOW.getTime() - 86_400_000),
        }),
      ).records,
    ).toEqual([{ externalId: forSale, deletedAt }]);

    const kitchen = String(specials.hiddenDay.departmentId);
    const days = keep(
      await h.client.listScheduleDays({ departmentId: kitchen, from: FROM, to: TO }),
    ).records;
    expect(days).toHaveLength(28);
    expect(days.filter((d) => !d.isVisible)).toEqual([
      { externalDepartmentId: kitchen, date: specials.hiddenDay.date, isVisible: false },
    ]);

    const punches = keep(
      await h.client.listPunchClockShifts({
        from: new Date("2026-10-18T23:00:00Z"),
        to: new Date("2026-11-16T00:00:00Z"),
        portalZone: PORTAL_ZONE,
      }),
    ).records;
    expect(punches.map((p) => p.externalId)).toEqual(["800001", "800002", "800003"]);
    expect(punches[0]).toEqual({
      externalId: "800001",
      externalShiftId: String(specials.inProgressShiftId),
      externalDepartmentId: "101",
      externalEmployeeId: "1001",
      startDateTime: "2026-10-21T08:58",
      endDateTime: null,
      isApproved: false,
    });
    expect(keep(await h.client.listPunchClockBreaks("800002"))).toEqual([
      { externalId: "810001", startDateTime: expect.any(String), endDateTime: expect.any(String) },
    ]);

    // Only the documented endpoints, every paged list with an explicit limit (the afterEach checks the rest).
    expect(mock.unexpectedRequests).toEqual([]);
    for (const request of apiRequests()) {
      expect(request.headers).not.toHaveProperty("x-openapi-region");
      expect(request.clientId).toBe(MOCK_CUSTOMER_APP_ID);
    }

    // Nothing from the strip sets survives the allow-list mapping (notes §9.2).
    const mapped = JSON.stringify(results);
    for (const pii of [
      "SENTINEL-PII",
      "pii.invalid",
      "1901-02-03",
      "+4470090",
      "Mock Bistro Group Ltd",
    ]) {
      expect(mapped).not.toContain(pii);
    }
    // Logs carry ids, codes and counts only (plan §4.9).
    const logged = JSON.stringify(h.logs);
    const held = h.store.current();
    for (const secret of [
      held.accessToken!,
      held.refreshToken,
      MOCK_CUSTOMER_APP_ID,
      "SENTINEL-PII",
      "Priya",
      "Patel",
      "@",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("each portal's token reads only that portal; no departments and an empty email map to null", async () => {
    const cafe = MOCK_PORTAL_CREDENTIALS[MOCK_SECOND_PORTAL_ID]!;
    const second = connect({
      credentials: { clientId: cafe.appId, refreshToken: cafe.refreshToken },
      options: { portalKey: String(MOCK_SECOND_PORTAL_ID) },
    });
    await expect(second.client.getPortalInfo()).resolves.toMatchObject({
      externalId: String(MOCK_SECOND_PORTAL_ID),
      name: "Mock Cafe Co",
    });
    // Overlapping ids with the main portal (101, 1001…), other people.
    const cafeEmployees = (await second.client.listEmployees({ portalZone: PORTAL_ZONE })).records;
    expect(cafeEmployees.map((e) => [e.externalId, e.firstName, e.email])).toEqual([
      ["1001", "Maya", "maya.brooks@mockcafe.test"],
      ["1002", "Noah", "noah.price@mockcafe.test"],
      ["1003", "Zara", null],
    ]);

    const kiosk = MOCK_PORTAL_CREDENTIALS[MOCK_NO_DEPARTMENTS_PORTAL_ID]!;
    const third = connect({
      credentials: { clientId: kiosk.appId, refreshToken: kiosk.refreshToken },
      options: { portalKey: String(MOCK_NO_DEPARTMENTS_PORTAL_ID) },
    });
    await expect(third.client.listDepartments()).resolves.toMatchObject({
      records: [],
      total: 0,
      done: true,
    });
    const kioskEmployees = (await third.client.listEmployees({ portalZone: PORTAL_ZONE })).records;
    expect(kioskEmployees).toHaveLength(3);
    for (const employee of kioskEmployees) {
      expect(employee).toMatchObject({ externalLocationIds: [], primaryExternalLocationId: null });
    }
    const kioskShifts = await listAllShifts(third.client);
    expect(kioskShifts.length).toBeGreaterThan(0);
    for (const shift of kioskShifts) {
      expect(shift).toMatchObject({ externalDepartmentId: null, times: { ok: true } });
    }
    // The kiosk's token is no key to the main portal's data.
    expect(new Set(apiRequests().map((e) => e.portalId))).toEqual(
      new Set([MOCK_SECOND_PORTAL_ID, MOCK_NO_DEPARTMENTS_PORTAL_ID]),
    );
  });

  it("the unexpected-request guard is live: a forbidden parameter would be recorded", async () => {
    const token = await connect().client.accessToken();
    await mock.fetch(`https://${API_HOST}${EMPLOYEES}?limit=50&offset=0&special=BankAccount`, {
      headers: { Authorization: `Bearer ${token.accessToken}`, "X-ClientId": token.clientId },
    });
    expect(mock.unexpectedRequests).toEqual([
      expect.objectContaining({ path: EMPLOYEES, reason: expect.stringContaining("special") }),
    ]);
    mock.unexpectedRequests.length = 0;
  });
});

// ---------------------------------------------------------------------------------------------------------
// Over HTTP (plan §4.1, §12.1)
// ---------------------------------------------------------------------------------------------------------

/**
 * Mock mode's transport (§4.1): the client's Planday URLs are unchanged; the two hosts are rewritten to the
 * shared mock server's `/openapi/*` and `/id/*`, and any other host is refused. `apps/web`'s `transport.ts`
 * does the same with `PLANDAY_MOCK_URL`.
 */
function mockModeTransport(baseUrl: string): PlandayTransport {
  return {
    fetch: (url, init) => {
      const target = new URL(url);
      const prefix =
        target.protocol !== "https:"
          ? null
          : target.host === API_HOST
            ? "/openapi"
            : target.host === ID_HOST
              ? "/id"
              : null;
      if (prefix === null) {
        return Promise.reject(new TypeError(`Mock mode reaches only Planday's hosts`));
      }
      return fetch(`${baseUrl}${prefix}${target.pathname}${target.search}`, init);
    },
  };
}

describe("over HTTP through httpServer.ts", () => {
  let server: MockPlandayHttpServer;
  let httpClock = FROZEN_NOW.getTime();

  beforeAll(async () => {
    server = await startMockPlandayHttpServer({
      port: 0,
      now: () => httpClock,
      partnerAppIds: [PARTNER_APP_ID],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    httpClock = FROZEN_NOW.getTime();
    await control({ action: "reset" });
  });

  afterEach(async () => {
    expect(await control({ action: "unexpectedRequests" })).toEqual([]);
  });

  async function control(body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${server.url}/__control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer = (await response.json()) as { ok: boolean; result?: unknown; error?: string };
    expect(answer, JSON.stringify(body)).toMatchObject({ ok: true });
    return answer.result;
  }

  function overHttp(options: HarnessOptions = {}): Harness {
    return connect({
      transport: mockModeTransport(server.url),
      now: () => new Date(server.mock.state.now()),
      advance: (ms) => {
        httpClock += ms;
      },
      ...options,
    });
  }

  const served = () => server.mock.requestLog;

  it("tokens, rotation, pagination, 429, 5xx, 401, malformed and revocation behave as in process", async () => {
    await control({ action: "setRotateRefreshTokens", enabled: true });
    await control({ action: "capPageSize", size: 4 });
    const h = overHttp();

    await expect(h.client.getPortalInfo()).resolves.toMatchObject({
      externalId: "4100001",
      name: "Mock Bistro Group",
      timezone: PORTAL_ZONE,
    });
    const rotated = h.store.current().refreshToken;
    expect(rotated).not.toBe(MOCK_REFRESH_TOKEN);
    expect(server.mock.state.grantByRefreshToken(rotated)).toMatchObject({ retired: false });
    expect(served()[1]).toMatchObject({
      path: "/portal/v1.0/info",
      clientId: MOCK_CUSTOMER_APP_ID,
      accessToken: h.store.current().accessToken,
    });
    expect(served()[1]!.headers["user-agent"]).toBe(PLANDAY_USER_AGENT);

    const employees = await fetchAllPages(
      (offset) => h.client.listEmployees({ offset, portalZone: PORTAL_ZONE }),
      { key: (e) => e.externalId },
    );
    expect(employees.map((e) => e.externalId)).toEqual(ACTIVE_EMPLOYEE_IDS);
    expect(requestsTo(EMPLOYEES, served()).map((e) => e.query.offset)).toEqual([
      ["0"],
      ["4"],
      ["8"],
    ]);

    await control({ action: "queueRateLimit", path: DEPARTMENTS, resetSeconds: 2 });
    expect((await h.client.listDepartments()).records).toHaveLength(3);
    expect(h.sleeps).toEqual([2_000]);

    await control({ action: "queue5xx", path: EMPLOYEE_GROUPS, status: 502 });
    expect((await h.client.listEmployeeGroups()).records).toHaveLength(4);
    expect(requestsTo(EMPLOYEE_GROUPS, served()).map((e) => e.status)).toEqual([502, 200]);

    // 401 → one forced refresh (rotating again) → the same shifts as the in-process mock reads.
    await control({ action: "expireAccessTokens" });
    const shifts = await listAllShifts(h.client);
    expect(h.store.current().refreshToken).not.toBe(rotated);
    expect(requestsTo(SHIFTS, served())[0]!.status).toBe(401);
    expect(shifts).toEqual(await listAllShifts(connect().client));

    await control({ action: "queueMalformed", path: "/portal/v1.0/info" });
    expect(await rejection(h.client.getPortalInfo())).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "SCHEMA",
    });

    await revokeToken(
      { clientId: MOCK_CUSTOMER_APP_ID, refreshToken: h.store.current().refreshToken },
      { transport: mockModeTransport(server.url) },
    );
    expect(served().at(-1)).toMatchObject({ path: "/connect/revocation", status: 200 });
    expect(await rejection(h.client.accessToken({ force: true }))).toMatchObject({
      code: "PLANDAY_AUTH_FAILED",
      status: 400,
    });
    expect(server.mock.unexpectedRequests).toEqual([]);
  });

  it("a signal aborts an API request over HTTP but never a token request", async () => {
    await control({ action: "setRotateRefreshTokens", enabled: true });
    await control({ action: "setLatency", ms: 200, path: "/connect/token" });
    const h = overHttp();
    const pending = h.client.getPortalInfo();
    await until(() => tokenRequests(served()).length === 1);
    h.controller.abort();
    expect(isAbortError(await rejection(pending))).toBe(true);
    expect(tokenRequests(served())).toEqual([expect.objectContaining({ status: 200 })]);
    expect(h.store.current().refreshToken).not.toBe(MOCK_REFRESH_TOKEN);
    expect(apiRequests(served())).toEqual([]);

    await control({ action: "setLatency", ms: 0 });
    const next = overHttp({ credentials: h.store.current() });
    await next.client.getPortalInfo();
    await control({ action: "setLatency", ms: 200, path: DEPARTMENTS });
    const read = next.client.listDepartments();
    await until(() => requestsTo(DEPARTMENTS, served()).length === 1);
    next.controller.abort();
    expect(isAbortError(await rejection(read))).toBe(true);
    // Let the server finish the abandoned answer; it was not retried.
    await until(() => requestsTo(DEPARTMENTS, served())[0]!.status !== null);
    expect(requestsTo(DEPARTMENTS, served())).toHaveLength(1);
  });
});
