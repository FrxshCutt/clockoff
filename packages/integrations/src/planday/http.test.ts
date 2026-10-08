import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  abortErrorFor,
  buildApiUrl,
  createPlandayHttp,
  defaultSleep,
  PlandayBudgets,
  type PlandayFetch,
  type PlandayHttpOptions,
  type Sleep,
} from "./http";
import {
  PlandayError,
  PlandayRateLimitedError,
  PlandayRequestBudgetExhaustedError,
} from "./errors";

// ---------------------------------------------------------------------------------------------------------
// Harness: a scripted fetch, a fake clock whose sleeps advance it, and a capturing logger.
// ---------------------------------------------------------------------------------------------------------

interface Call {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly signal: AbortSignal | undefined;
}
type Reply = Response | ((call: Call) => Response | Promise<Response>);

const T0 = Date.parse("2026-10-21T10:30:00Z");
const ACCESS_TOKEN = "at-SECRET-1";
const CLIENT_ID = "5f0c6a3e-0000-4000-8000-00000000c0de";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const page = (data: unknown[] = [], total = data.length) =>
  json({ data, paging: { offset: 0, limit: 50, total } });

function setup(
  replies: Reply[],
  options: Partial<PlandayHttpOptions> & { random?: () => number } = {},
) {
  let clock = T0;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const logs: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const queue = [...replies];
  const fetch: PlandayFetch = async (url, init) => {
    const call: Call = {
      url: new URL(url),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const reply = queue.shift();
    if (!reply) throw new Error(`unexpected request ${url}`);
    return typeof reply === "function" ? reply(call) : reply;
  };
  const sleep: Sleep = async (ms, signal) => {
    if (signal?.aborted) throw abortErrorFor(signal);
    sleeps.push(ms);
    clock += ms;
  };
  const log = (level: string) => (obj: Readonly<Record<string, unknown>>, msg: string) =>
    logs.push({ level, obj: { ...obj }, msg });
  let token = ACCESS_TOKEN;
  const auth = {
    current: vi.fn(async () => ({ accessToken: token, clientId: CLIENT_ID })),
    refreshAfterUnauthorized: vi.fn(async (_rejected: string) => {
      token = "at-SECRET-2";
    }),
  };
  const http = createPlandayHttp({
    transport: { fetch },
    auth,
    portalKey: "4100001",
    budgets: new PlandayBudgets(),
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    now: () => new Date(clock),
    sleep,
    random: () => 0,
    integrationId: "int-1",
    runId: "run-1",
    ...options,
  });
  return {
    http,
    calls,
    sleeps,
    logs,
    auth,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

// ---------------------------------------------------------------------------------------------------------

describe("headers and URLs (notes §4)", () => {
  it("sends Bearer, X-ClientId, Accept and User-Agent; no X-OpenAPI-Region, no body", async () => {
    const h = setup([page()]);
    await h.http.getJson("/hr/v1.0/employees", { limit: 50, offset: 0 });
    const [call] = h.calls;
    expect(call?.url.toString()).toBe(
      "https://openapi.planday.com/hr/v1.0/employees?limit=50&offset=0",
    );
    expect(call?.method).toBe("GET");
    expect(call?.body).toBeUndefined();
    expect(call?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call?.headers.get("x-clientid")).toBe(CLIENT_ID);
    expect(call?.headers.get("accept")).toBe("application/json");
    expect(call?.headers.get("user-agent")).toBe("ClockOff/1.0 (+https://clockoff.online)");
    expect(call?.headers.has("x-openapi-region")).toBe(false);
    expect([...(call?.headers.keys() ?? [])].sort()).toEqual([
      "accept",
      "authorization",
      "user-agent",
      "x-clientid",
    ]);
  });

  it("refuses the query parameters ClockOff never sends", () => {
    for (const name of [
      "special",
      "searchQuery",
      "includeSecurityGroups",
      "managedEmployeesOnly",
      "shiftStatus",
    ]) {
      expect(() => buildApiUrl("/hr/v1.0/employees", { [name]: "x" }), name).toThrow(TypeError);
    }
    expect(
      buildApiUrl("/scheduling/v1.0/shifts", { from: "2026-10-19", to: undefined, limit: 100 }),
    ).toBe("https://openapi.planday.com/scheduling/v1.0/shifts?from=2026-10-19&limit=100");
  });
});

describe("status mapping (§4.6)", () => {
  it("401 → one forced refresh and one retry with the new token; a second 401 → AUTH_FAILED", async () => {
    const ok = setup([json({}, 401), page()]);
    await ok.http.getJson("/hr/v1.0/departments", { limit: 50, offset: 0 });
    expect(ok.auth.refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
    expect(ok.auth.refreshAfterUnauthorized).toHaveBeenCalledWith(ACCESS_TOKEN);
    expect(ok.calls[1]?.headers.get("authorization")).toBe("Bearer at-SECRET-2");

    const bad = setup([json({}, 401), json({}, 401)]);
    const err = await rejection(bad.http.getJson("/hr/v1.0/departments"));
    expect(err).toMatchObject({ code: "PLANDAY_AUTH_FAILED", status: 401, retryable: false });
    expect(bad.auth.refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
    expect(bad.calls).toHaveLength(2);
  });

  it("403 → SCOPE_MISSING naming the endpoint's scope", async () => {
    const cases: Array<[string, string]> = [
      ["/portal/v1.0/info", "portal info"],
      ["/hr/v1.0/departments", "department:read"],
      ["/hr/v1.0/employeegroups", "employeegroup:read"],
      ["/hr/v1.0/employees", "employee:read"],
      ["/scheduling/v1.0/shifts", "shift:read"],
      ["/punchclock/v1.0/punchclockshifts", "punchclockshift:read"],
    ];
    for (const [path, scope] of cases) {
      const h = setup([json({}, 403)]);
      expect(await rejection(h.http.getJson(path)), path).toMatchObject({
        code: "PLANDAY_SCOPE_MISSING",
        missingScopes: [scope],
        status: 403,
      });
    }
  });

  it("404 → NOT_FOUND; 400 on an employee by id → NOT_FOUND; other 400s → INVALID_RESPONSE", async () => {
    expect(
      await rejection(
        setup([json({ title: "Not Found" }, 404)]).http.getJson("/scheduling/v1.0/shifts/5001"),
      ),
    ).toMatchObject({
      code: "PLANDAY_NOT_FOUND",
      status: 404,
      pathTemplate: "/scheduling/v1.0/shifts/{id}",
    });
    expect(
      await rejection(setup([json({}, 400)]).http.getJson("/hr/v1.0/employees/1011")),
    ).toMatchObject({
      code: "PLANDAY_NOT_FOUND",
      status: 400,
    });
    const h = setup([json({}, 400)]);
    expect(
      await rejection(
        h.http.getJson("/scheduling/v1.0/shifts", { from: "2026-01-01", to: "2026-12-31" }),
      ),
    ).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "BAD_REQUEST",
      status: 400,
    });
    expect(h.calls).toHaveLength(1);
  });

  it("404 is record level only: a by-id read → NOT_FOUND, a list path → INVALID_RESPONSE with the status", async () => {
    expect(
      await rejection(
        setup([json({}, 404)]).http.getJson("/punchclock/v1.0/punchclockshifts/7/breaks"),
      ),
    ).toMatchObject({
      code: "PLANDAY_NOT_FOUND",
      status: 404,
      pathTemplate: "/punchclock/v1.0/punchclockshifts/{id}/breaks",
    });
    for (const [path, query] of [
      [
        "/scheduling/v1.0/scheduleDay",
        { departmentId: "101", from: "2026-10-21", to: "2026-10-21" },
      ],
      ["/hr/v1.0/departments", { limit: 1 }],
      ["/punchclock/v1.0/punchclockshifts", undefined],
      ["/hr/v1.0/employees/deactivated", undefined],
    ] as const) {
      const h = setup([json({ title: "Not Found" }, 404)]);
      const err = await rejection(h.http.getJson(path, query));
      expect(err, path).toMatchObject({
        code: "PLANDAY_INVALID_RESPONSE",
        reason: "BAD_REQUEST",
        status: 404,
        pathTemplate: path,
        retryable: false,
      });
      expect(h.calls, path).toHaveLength(1);
    }
  });

  it("a non-JSON 2xx → INVALID_RESPONSE; a schema failure logs issue paths and codes only", async () => {
    expect(
      await rejection(
        setup([new Response("<html>", { status: 200 })]).http.getJson("/portal/v1.0/info"),
      ),
    ).toMatchObject({ code: "PLANDAY_INVALID_RESPONSE", reason: "NOT_JSON" });

    const h = setup([
      json({ data: [{ id: 1, name: "SENTINEL-PII-name" }, { name: "x" }], paging: null }),
    ]);
    const schema = z.object({ data: z.array(z.object({ id: z.number(), name: z.string() })) });
    expect(
      await rejection(h.http.getParsed("/hr/v1.0/departments", undefined, schema)),
    ).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "SCHEMA",
    });
    const line = h.logs.find((l) => l.msg === "planday.invalid_response");
    expect(line?.obj).toEqual({
      pathTemplate: "/hr/v1.0/departments",
      issues: [{ path: "data.1.id", code: "invalid_type" }],
    });
    expect(JSON.stringify(h.logs)).not.toContain("SENTINEL");
  });
});

describe("429 (§4.5, notes §6)", () => {
  it("waits x-ratelimit-reset seconds inside the slice, then succeeds", async () => {
    const h = setup([
      json({}, 429, { "x-ratelimit-reset": "5", "x-ratelimit-remaining": "0" }),
      page(),
    ]);
    await h.http.getJson("/hr/v1.0/departments");
    expect(h.sleeps).toEqual([5_000]);
    expect(h.calls).toHaveLength(2);
    expect(h.logs.find((l) => l.msg === "planday.rate_limited")?.obj).toEqual({
      pathTemplate: "/hr/v1.0/departments",
      waitMs: 5_000,
      source: "x-ratelimit-reset",
    });
  });

  it("takes the longer of Retry-After and x-ratelimit-reset", async () => {
    const h = setup([json({}, 429, { "x-ratelimit-reset": "5", "retry-after": "12" }), page()]);
    await h.http.getJson("/hr/v1.0/departments");
    expect(h.sleeps).toEqual([12_000]);
    expect(h.logs.find((l) => l.msg === "planday.rate_limited")?.obj.source).toBe("retry-after");

    const h2 = setup([json({}, 429, { "x-ratelimit-reset": "9", "retry-after": "2" }), page()]);
    await h2.http.getJson("/hr/v1.0/departments");
    expect(h2.sleeps).toEqual([9_000]);
  });

  it("parks with retryAt when neither header is present (60 s default)", async () => {
    const h = setup([json({}, 429)]);
    const err = await rejection(h.http.getJson("/hr/v1.0/departments"));
    expect(err).toBeInstanceOf(PlandayRateLimitedError);
    expect(err).toMatchObject({ code: "PLANDAY_RATE_LIMITED", retryable: true });
    expect((err as PlandayRateLimitedError).retryAt.getTime()).toBe(T0 + 60_000);
    expect(h.sleeps).toEqual([]);
    expect(h.logs.find((l) => l.msg === "planday.rate_limited")?.obj.source).toBe("default");
  });

  it("sleeps waits up to 30 s inline and parks longer ones", async () => {
    const inline = setup([json({}, 429, { "x-ratelimit-reset": "30" }), page()]);
    await inline.http.getJson("/hr/v1.0/departments");
    expect(inline.sleeps).toEqual([30_000]);

    const parked = setup([json({}, 429, { "x-ratelimit-reset": "31" })]);
    const err = await rejection(parked.http.getJson("/hr/v1.0/departments"));
    expect((err as PlandayRateLimitedError).retryAt.getTime()).toBe(T0 + 31_000);
    expect(parked.sleeps).toEqual([]);
  });

  it("ignores a header asking for more than 120 s (an epoch timestamp, a far-future date)", async () => {
    // An epoch-style x-ratelimit-reset alone: treated as absent, so the 60 s default (parked), not 2026 years.
    const epoch = setup([json({}, 429, { "x-ratelimit-reset": "1791000000" })]);
    const err = await rejection(epoch.http.getJson("/hr/v1.0/departments"));
    expect((err as PlandayRateLimitedError).retryAt.getTime()).toBe(T0 + 60_000);
    expect(epoch.logs.find((l) => l.msg === "planday.rate_limited")?.obj).toMatchObject({
      waitMs: 60_000,
      source: "default",
    });

    // A far-future Retry-After date beside a usable reset: the reset wins and is slept inline.
    const future = setup([
      json({}, 429, {
        "x-ratelimit-reset": "5",
        "retry-after": new Date(T0 + 86_400_000).toUTCString(),
      }),
      page(),
    ]);
    await future.http.getJson("/hr/v1.0/departments");
    expect(future.sleeps).toEqual([5_000]);
    expect(future.logs.find((l) => l.msg === "planday.rate_limited")?.obj.source).toBe(
      "x-ratelimit-reset",
    );

    // Delta-seconds over the bound are ignored too; exactly 120 s is still honoured (parked).
    const longRetry = setup([json({}, 429, { "retry-after": "121" })]);
    expect(
      ((await rejection(longRetry.http.getJson("/hr/v1.0/departments"))) as PlandayRateLimitedError)
        .retryAt,
    ).toEqual(new Date(T0 + 60_000));
    const bound = setup([json({}, 429, { "retry-after": "120" })]);
    expect(
      ((await rejection(bound.http.getJson("/hr/v1.0/departments"))) as PlandayRateLimitedError)
        .retryAt,
    ).toEqual(new Date(T0 + 120_000));
  });

  it("adds 0–1 s of jitter", async () => {
    const h = setup([json({}, 429, { "x-ratelimit-reset": "5" }), page()], {
      random: () => 0.999_999,
    });
    await h.http.getJson("/hr/v1.0/departments");
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(5_000);
    expect(h.sleeps[0]).toBeLessThan(6_000);
  });

  it("allows at most three inline waits per request, then parks", async () => {
    const limited = () => json({}, 429, { "x-ratelimit-reset": "1" });
    const h = setup([limited(), limited(), limited(), limited()]);
    const err = await rejection(h.http.getJson("/hr/v1.0/departments"));
    expect(err).toBeInstanceOf(PlandayRateLimitedError);
    expect(h.sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(h.calls).toHaveLength(4);
  });
});

describe("5xx, network errors and timeouts", () => {
  it("retries 5xx and 409 with full-jitter backoff (base 500 ms, factor 2)", async () => {
    const h = setup([json({}, 503), json({}, 409), page()], { random: () => 0.5 });
    await h.http.getJson("/hr/v1.0/departments");
    expect(h.sleeps).toEqual([250, 500]);
    expect(h.calls).toHaveLength(3);
  });

  it("gives up after three attempts with UNAVAILABLE", async () => {
    const h = setup([json({}, 500), json({}, 502), json({}, 500)]);
    expect(await rejection(h.http.getJson("/hr/v1.0/departments"))).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      reason: "SERVER_ERROR",
      status: 500,
      retryable: true,
    });
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
  });

  it("treats network failures the same way", async () => {
    const boom = () => {
      throw new TypeError("fetch failed");
    };
    const h = setup([boom, boom, boom]);
    expect(await rejection(h.http.getJson("/hr/v1.0/departments"))).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      reason: "NETWORK",
    });
    expect(h.calls).toHaveLength(3);
  });

  it("retries a 2xx whose body breaks off mid-read like a network error (3 attempts)", async () => {
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":['));
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const h = setup([broken, broken, broken], { random: () => 0.5 });
    expect(await rejection(h.http.getJson("/hr/v1.0/departments"))).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      reason: "NETWORK",
      status: 200,
      retryable: true,
    });
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([250, 500]);

    const recovered = setup([broken, page()]);
    await expect(recovered.http.getJson("/hr/v1.0/departments")).resolves.toMatchObject({
      data: [],
    });
    expect(recovered.calls).toHaveLength(2);
  });

  it("times requests out after 10 s (TIMEOUT), retrying like a network error", async () => {
    const timeouts: number[] = [];
    const hang = () => new Promise<Response>(() => undefined);
    const h = setup([hang, hang, hang], {
      createTimeoutSignal: (ms) => {
        timeouts.push(ms);
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 1);
        return controller.signal;
      },
    });
    expect(await rejection(h.http.getJson("/hr/v1.0/departments"))).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      reason: "TIMEOUT",
    });
    expect(timeouts).toEqual([10_000, 10_000, 10_000]);
  });
});

describe("the connect deadline (§4.1, §5.6)", () => {
  it("bounds each request's timeout by the time left", async () => {
    const timeouts: number[] = [];
    const h = setup([page()], {
      deadline: { remainingMs: () => 5_000 },
      createTimeoutSignal: (ms) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
    });
    await h.http.getJson("/portal/v1.0/info");
    expect(timeouts).toEqual([5_000]);
  });

  it("does not start a request with less than 3 s left", async () => {
    const h = setup([page()], { deadline: { remainingMs: () => 2_999 } });
    expect(await rejection(h.http.getJson("/portal/v1.0/info"))).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      reason: "DEADLINE",
    });
    expect(h.calls).toHaveLength(0);
  });

  it("does not sleep a retry wait the deadline cannot afford", async () => {
    const h = setup([json({}, 503)], { deadline: { remainingMs: () => 3_200 }, random: () => 0.5 });
    expect(await rejection(h.http.getJson("/portal/v1.0/info"))).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
    });
    expect(h.sleeps).toEqual([]);
    const r = setup([json({}, 429, { "x-ratelimit-reset": "5" })], {
      deadline: { remainingMs: () => 7_000 },
    });
    expect(await rejection(r.http.getJson("/portal/v1.0/info"))).toBeInstanceOf(
      PlandayRateLimitedError,
    );
    expect(r.sleeps).toEqual([]);
  });
});

describe("abort by the caller's signal (§7.7)", () => {
  it("aborts an API request in flight and does not retry it", async () => {
    const controller = new AbortController();
    const h = setup([() => new Promise<Response>(() => undefined)], { signal: controller.signal });
    const pending = h.http.getJson("/hr/v1.0/employees");
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(new Error("worker shutting down"));
    const err = await rejection(pending);
    expect(err).toMatchObject({ name: "AbortError" });
    expect(err).not.toBeInstanceOf(PlandayError);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.signal?.aborted).toBe(true);
  });

  it("starts nothing once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = setup([page()], { signal: controller.signal });
    expect(await rejection(h.http.getJson("/hr/v1.0/employees"))).toMatchObject({
      name: "AbortError",
    });
    expect(h.calls).toHaveLength(0);
  });

  it("cuts a rate-limit wait short", async () => {
    const controller = new AbortController();
    const h = setup([json({}, 429, { "x-ratelimit-reset": "20" })], {
      signal: controller.signal,
      sleep: defaultSleep,
    });
    const pending = h.http.getJson("/hr/v1.0/employees");
    setTimeout(() => controller.abort(), 5);
    const started = Date.now();
    expect(await rejection(pending)).toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("budgets and serialisation (§4.5)", () => {
  it("runs one request at a time per portal", async () => {
    let release!: (r: Response) => void;
    const h = setup([() => new Promise<Response>((resolve) => (release = resolve)), page()]);
    const first = h.http.getJson("/hr/v1.0/departments");
    const second = h.http.getJson("/hr/v1.0/employeegroups");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.calls).toHaveLength(1);
    release(page());
    await first;
    await second;
    expect(h.calls.map((c) => c.url.pathname)).toEqual([
      "/hr/v1.0/departments",
      "/hr/v1.0/employeegroups",
    ]);
  });

  it("keeps 10 requests per second per portal", async () => {
    const h = setup(Array.from({ length: 11 }, () => page()));
    for (let i = 0; i < 11; i++) await h.http.getJson("/hr/v1.0/departments");
    expect(h.sleeps).toEqual([100]);
  });

  it("parks instead of sleeping a budget wait longer than 30 s", async () => {
    const budgets = new PlandayBudgets();
    budgets.pause("portal", "4100001", T0 + 45_000);
    const h = setup([page()], { budgets });
    const err = await rejection(h.http.getJson("/hr/v1.0/departments"));
    expect((err as PlandayRateLimitedError).retryAt.getTime()).toBe(T0 + 45_000);
    expect(h.calls).toHaveLength(0);
  });

  it("slows down when x-ratelimit-remaining drops to 2 (header feedback)", async () => {
    const h = setup([
      json({ data: [] }, 200, { "x-ratelimit-remaining": "2", "x-ratelimit-reset": "4" }),
      page(),
    ]);
    await h.http.getJson("/hr/v1.0/departments");
    expect(h.sleeps).toEqual([]);
    await h.http.getJson("/hr/v1.0/departments");
    expect(h.sleeps).toEqual([4_000]);
  });

  it("ignores header feedback whose reset exceeds 120 s, so no tenant on the client id is held", async () => {
    const budgets = new PlandayBudgets();
    const a = setup(
      [
        json({ data: [] }, 200, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1791000000",
        }),
      ],
      { budgets },
    );
    await a.http.getJson("/hr/v1.0/departments");
    const b = setup([page()], { budgets, portalKey: "4100002" });
    await b.http.getJson("/hr/v1.0/departments");
    expect(b.sleeps).toEqual([]);
    expect(b.calls).toHaveLength(1);
  });

  it("shares the client-id budget across portals", async () => {
    const budgets = new PlandayBudgets();
    const shared = { budgets };
    const a = setup(
      [json({ data: [] }, 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3" })],
      shared,
    );
    await a.http.getJson("/hr/v1.0/departments");
    const b = setup([page()], { ...shared, portalKey: "4100002" });
    await b.http.getJson("/hr/v1.0/departments");
    expect(b.sleeps).toEqual([3_000]);
  });

  it("counts every request sent, retries included, and honours a hard cap", async () => {
    const h = setup([json({}, 500), page(), page()], { maxRequests: 3 });
    await h.http.getJson("/hr/v1.0/departments");
    expect(h.http.requestCount()).toBe(2);
    await h.http.getJson("/hr/v1.0/departments");
    expect(h.http.requestCount()).toBe(3);
    expect(await rejection(h.http.getJson("/hr/v1.0/departments"))).toBeInstanceOf(
      PlandayRequestBudgetExhaustedError,
    );
  });
});

describe("logging (§4.9)", () => {
  it("logs each request with the allowed fields only: no token, client id, query or body", async () => {
    const h = setup([
      json({}, 503),
      json({ data: [{ id: 1, name: "SENTINEL-PII-x" }] }, 200, { "x-ratelimit-remaining": "40" }),
    ]);
    await h.http.getJson("/hr/v1.0/employees/1001", { limit: 1 });
    const requests = h.logs.filter((l) => l.msg === "planday.request");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.obj).toEqual({
      method: "GET",
      pathTemplate: "/hr/v1.0/employees/{id}",
      status: 200,
      durationMs: 0,
      attempt: 2,
      rateLimitRemaining: 40,
      integrationId: "int-1",
      runId: "run-1",
    });
    const text = JSON.stringify(h.logs);
    for (const secret of [ACCESS_TOKEN, CLIENT_ID, "SENTINEL", "1001", "limit="]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("logs planday.error with code, status and path template", async () => {
    const h = setup([json({}, 403)]);
    await rejection(h.http.getJson("/scheduling/v1.0/shifts/77"));
    expect(h.logs.find((l) => l.msg === "planday.error")?.obj).toEqual({
      code: "PLANDAY_SCOPE_MISSING",
      status: 403,
      pathTemplate: "/scheduling/v1.0/shifts/{id}",
    });
  });
});
