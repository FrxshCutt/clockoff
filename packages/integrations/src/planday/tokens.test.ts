import { describe, expect, it } from "vitest";
import { PlandayRateLimitedError } from "./errors";
import { abortErrorFor, type PlandayFetch, type Sleep } from "./http";
import { exchangeCode, refreshToken, revokeToken, type TokenRequestDeps } from "./tokens";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly form: URLSearchParams;
  readonly signal: AbortSignal | undefined;
}
type Reply = Response | ((call: Call) => Response | Promise<Response>);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const CLIENT_ID = "5f0c6a3e-0000-4000-8000-00000000c0de";

function deps(replies: Reply[], extra: Partial<TokenRequestDeps> = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const queue = [...replies];
  const fetch: PlandayFetch = async (url, init) => {
    const call = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      form: new URLSearchParams(String(init.body)),
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const reply = queue.shift();
    if (!reply) throw new Error("unexpected request");
    return typeof reply === "function" ? reply(call) : reply;
  };
  const sleep: Sleep = async (ms, signal) => {
    if (signal?.aborted) throw abortErrorFor(signal);
    sleeps.push(ms);
  };
  const log = (obj: Readonly<Record<string, unknown>>, msg: string) =>
    logs.push({ obj: { ...obj }, msg });
  let requests = 0;
  const d: TokenRequestDeps = {
    transport: { fetch },
    sleep,
    random: () => 0,
    now: () => new Date("2026-10-21T10:30:00Z"),
    logger: { debug: log, info: log, warn: log, error: log },
    onRequest: () => {
      requests++;
    },
    ...extra,
  };
  return { d, calls, sleeps, logs, requests: () => requests };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

const TOKEN_BODY = {
  id_token: "eyJ.ID-TOKEN-SECRET",
  access_token: "eyJ.ACCESS-SECRET",
  expires_in: 3600,
  token_type: "Bearer",
  refresh_token: "REFRESH-SECRET-2",
  scope: "openid offline_access department:read employeegroup:read employee:read shift:read",
};

describe("exchangeCode (method A)", () => {
  it("posts the four documented form fields to id.planday.com, without X-ClientId or a secret", async () => {
    const h = deps([json(TOKEN_BODY)]);
    const result = await exchangeCode(
      {
        clientId: CLIENT_ID,
        code: "CODE-SECRET",
        redirectUri: "https://app.clockoff.online/api/integrations/planday/callback",
      },
      h.d,
    );
    const [call] = h.calls;
    expect(call?.url).toBe("https://id.planday.com/connect/token");
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(call?.headers.has("x-clientid")).toBe(false);
    expect(call?.headers.has("authorization")).toBe(false);
    expect(Object.fromEntries(call?.form ?? [])).toEqual({
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      code: "CODE-SECRET",
      redirect_uri: "https://app.clockoff.online/api/integrations/planday/callback",
    });
    // id_token is dropped unparsed.
    expect(result).toEqual({
      accessToken: "eyJ.ACCESS-SECRET",
      refreshToken: "REFRESH-SECRET-2",
      expiresInS: 3600,
      scope: TOKEN_BODY.scope,
    });
    expect(h.requests()).toBe(1);
  });

  it("adds code_verifier only with PKCE", async () => {
    const h = deps([json(TOKEN_BODY)]);
    await exchangeCode(
      { clientId: CLIENT_ID, code: "c", redirectUri: "https://x/cb", codeVerifier: "VERIFIER" },
      h.d,
    );
    expect(h.calls[0]?.form.get("code_verifier")).toBe("VERIFIER");
  });

  it("checks the granted scope when asked", async () => {
    const h = deps([json({ ...TOKEN_BODY, scope: "openid offline_access employee:read" })]);
    expect(
      await rejection(
        exchangeCode(
          {
            clientId: CLIENT_ID,
            code: "c",
            redirectUri: "https://x/cb",
            requiredScopes: ["department:read", "employee:read", "shift:read"],
          },
          h.d,
        ),
      ),
    ).toMatchObject({
      code: "PLANDAY_SCOPE_MISSING",
      missingScopes: ["department:read", "shift:read"],
    });

    const noScope = deps([json({ ...TOKEN_BODY, scope: undefined })]);
    await expect(
      exchangeCode(
        {
          clientId: CLIENT_ID,
          code: "c",
          redirectUri: "https://x/cb",
          requiredScopes: ["shift:read"],
        },
        noScope.d,
      ),
    ).resolves.toMatchObject({ scope: null });
  });

  it("requires a refresh token in the exchange", async () => {
    const h = deps([json({ access_token: "a" })]);
    expect(
      await rejection(
        exchangeCode({ clientId: CLIENT_ID, code: "c", redirectUri: "https://x/cb" }, h.d),
      ),
    ).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
    });
  });
});

describe("refreshToken", () => {
  it("posts the refresh grant and reports rotation", async () => {
    const h = deps([json(TOKEN_BODY)]);
    const result = await refreshToken(
      { clientId: CLIENT_ID, refreshToken: "REFRESH-SECRET-1" },
      h.d,
    );
    expect(Object.fromEntries(h.calls[0]?.form ?? [])).toEqual({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "REFRESH-SECRET-1",
    });
    expect(result.refreshToken).toBe("REFRESH-SECRET-2");
  });

  it("defaults expires_in to 3600 and reports no rotation when no refresh_token comes back", async () => {
    const h = deps([json({ access_token: "a2" })]);
    expect(await refreshToken({ clientId: CLIENT_ID, refreshToken: "r1" }, h.d)).toEqual({
      accessToken: "a2",
      refreshToken: null,
      expiresInS: 3600,
      scope: null,
    });
  });

  it("maps 400 and 401 to AUTH_FAILED without reading the body", async () => {
    for (const status of [400, 401, 403]) {
      const h = deps([json({ error: "invalid_grant" }, status)]);
      expect(
        await rejection(refreshToken({ clientId: CLIENT_ID, refreshToken: "r" }, h.d)),
        String(status),
      ).toMatchObject({
        code: "PLANDAY_AUTH_FAILED",
        status,
        retryable: false,
      });
    }
  });

  it("maps 5xx, network failures and timeouts to UNAVAILABLE without retrying", async () => {
    const five = deps([json({}, 503)]);
    expect(
      await rejection(refreshToken({ clientId: CLIENT_ID, refreshToken: "r" }, five.d)),
    ).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      status: 503,
      retryable: true,
    });
    expect(five.calls).toHaveLength(1);

    const net = deps([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    expect(
      await rejection(refreshToken({ clientId: CLIENT_ID, refreshToken: "r" }, net.d)),
    ).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      reason: "NETWORK",
    });

    const slow = deps([() => new Promise<Response>(() => undefined)], {
      createTimeoutSignal: () => AbortSignal.timeout(1),
    });
    expect(
      await rejection(refreshToken({ clientId: CLIENT_ID, refreshToken: "r" }, slow.d)),
    ).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      reason: "TIMEOUT",
    });
  });

  it("maps a non-JSON or malformed 2xx to INVALID_RESPONSE", async () => {
    const html = deps([new Response("<html/>", { status: 200 })]);
    expect(
      await rejection(refreshToken({ clientId: CLIENT_ID, refreshToken: "r" }, html.d)),
    ).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "NOT_JSON",
    });
    const bad = deps([json({ token: "x" })]);
    expect(
      await rejection(refreshToken({ clientId: CLIENT_ID, refreshToken: "r" }, bad.d)),
    ).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "SCHEMA",
    });
  });

  it("follows the API's 429 rule: short waits inline, long ones as RATE_LIMITED", async () => {
    const short = deps([json({}, 429, { "x-ratelimit-reset": "2" }), json(TOKEN_BODY)]);
    await refreshToken({ clientId: CLIENT_ID, refreshToken: "r" }, short.d);
    expect(short.sleeps).toEqual([2_000]);
    expect(short.requests()).toBe(2);

    const long = deps([json({}, 429)]);
    expect(
      await rejection(refreshToken({ clientId: CLIENT_ID, refreshToken: "r" }, long.d)),
    ).toBeInstanceOf(PlandayRateLimitedError);
  });

  it("is never cut by the caller's signal once sent; it carries only its own timeout", async () => {
    const controller = new AbortController();
    let release!: (r: Response) => void;
    const h = deps([() => new Promise<Response>((resolve) => (release = resolve))], {
      signal: controller.signal,
    });
    const pending = refreshToken({ clientId: CLIENT_ID, refreshToken: "r" }, h.d);
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    expect(h.calls[0]?.signal).not.toBe(controller.signal);
    expect(h.calls[0]?.signal?.aborted).toBe(false);
    release(json(TOKEN_BODY));
    await expect(pending).resolves.toMatchObject({ refreshToken: "REFRESH-SECRET-2" });
  });

  it("respects the connect deadline: min(10 s, remaining), not below 3 s", async () => {
    const timeouts: number[] = [];
    const h = deps([json(TOKEN_BODY)], {
      deadline: { remainingMs: () => 4_000 },
      createTimeoutSignal: (ms) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
    });
    await refreshToken({ clientId: CLIENT_ID, refreshToken: "r" }, h.d);
    expect(timeouts).toEqual([4_000]);
    const late = deps([json(TOKEN_BODY)], { deadline: { remainingMs: () => 1_000 } });
    expect(
      await rejection(refreshToken({ clientId: CLIENT_ID, refreshToken: "r" }, late.d)),
    ).toMatchObject({
      code: "PLANDAY_UNAVAILABLE",
      reason: "DEADLINE",
    });
    expect(late.calls).toHaveLength(0);
  });

  it("never logs tokens, client ids or bodies", async () => {
    const h = deps([json({}, 429, { "x-ratelimit-reset": "1" }), json(TOKEN_BODY)]);
    await refreshToken({ clientId: CLIENT_ID, refreshToken: "REFRESH-SECRET-1" }, h.d);
    const text = JSON.stringify(h.logs);
    for (const secret of ["SECRET", CLIENT_ID, "Bearer"]) expect(text).not.toContain(secret);
    expect(h.logs.map((l) => l.msg)).toEqual([
      "planday.request",
      "planday.rate_limited",
      "planday.request",
    ]);
  });
});

describe("revokeToken", () => {
  it("posts client_id and token with a 5 s timeout; any 2xx is success", async () => {
    const timeouts: number[] = [];
    const h = deps([new Response(null, { status: 200 })], {
      deadline: { remainingMs: () => 100 },
      createTimeoutSignal: (ms) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
    });
    await revokeToken({ clientId: CLIENT_ID, refreshToken: "REFRESH-SECRET-1" }, h.d);
    expect(h.calls[0]?.url).toBe("https://id.planday.com/connect/revocation");
    expect(Object.fromEntries(h.calls[0]?.form ?? [])).toEqual({
      client_id: CLIENT_ID,
      token: "REFRESH-SECRET-1",
    });
    expect(timeouts).toEqual([5_000]);
  });

  it("does not wait on 429 (best effort)", async () => {
    const h = deps([json({}, 429, { "x-ratelimit-reset": "1" })]);
    expect(
      await rejection(revokeToken({ clientId: CLIENT_ID, refreshToken: "r" }, h.d)),
    ).toBeInstanceOf(PlandayRateLimitedError);
    expect(h.sleeps).toEqual([]);
  });
});
