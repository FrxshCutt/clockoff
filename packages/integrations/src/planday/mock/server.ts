/**
 * `createMockPlanday(options)` (plan §12.1): an in-process fake of `https://openapi.planday.com` and
 * `https://id.planday.com`. Its `fetch` has the `fetch` signature, so the client's real URLs, query strings,
 * headers and paging run against it unchanged (`setPlandayTransportForTesting(createMockPlanday(...))` in tests;
 * `httpServer.ts` serves the same handler over HTTP for development and Playwright). Any other host throws.
 *
 * Every request is recorded in `requestLog`. A request ClockOff must never make (an unknown path, a
 * non-GET API call, a request body on a GET, `X-OpenAPI-Region`, a forbidden or undocumented query parameter, a
 * paged list without an explicit `limit`, `X-ClientId` or a secret on an identity request) is also recorded in
 * `unexpectedRequests`; every suite asserts it stays empty.
 */
import { buildPlandayFixture, FROZEN_NOW, MOCK_PORTAL_ID, type PlandayFixture } from "./fixture";
import { createMockPlandayControls, type MockPlandayControls } from "./controls";
import { isoZ } from "./datetime";
import { assertMockPlandayAllowed } from "./guard";
import { authorizeEndpoint, revocationEndpoint, tokenEndpoint } from "./oauth";
import { jsonResponse, oauthErrorResponse, problemResponse } from "./respond";
import { matchApiRoute, runApiRoute, type ApiRoute } from "./routes";
import { MockPlandayState, type MockFault } from "./state";

export const PLANDAY_API_ORIGIN = "https://openapi.planday.com";
export const PLANDAY_IDENTITY_ORIGIN = "https://id.planday.com";
const API_HOST = "openapi.planday.com";
const ID_HOST = "id.planday.com";

/** `x-ratelimit-limit` as Planday sends it: the window closest to being used up, then the policy (notes §6). */
const RATE_LIMIT_POLICY = "750, 20;w=1, 750;w=60, 100;w=1, 2000;w=60";
const PORTAL_REQUESTS_PER_MINUTE = 750;

export interface MockPlandayRequestLogEntry {
  /** 1, 2, 3… in arrival order. */
  readonly seq: number;
  /** Mock clock, ISO. */
  readonly at: string;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  /** The endpoint's template (`/hr/v1.0/employees/{employeeId}`), or the path when unknown. */
  template: string;
  readonly query: Readonly<Record<string, string[]>>;
  /** Lower-cased request headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** Form body of an identity request (`client_id`, `grant_type`, `refresh_token`…). */
  form: Readonly<Record<string, string>> | null;
  /** The bearer token of an API request. */
  readonly accessToken: string | null;
  /** `X-ClientId` of an API request, `client_id` of an identity request. */
  clientId: string | null;
  /** The portal the bearer token belongs to. */
  portalId: number | null;
  /** Response status; null when the request was aborted before an answer. */
  status: number | null;
  aborted: boolean;
}

export interface MockPlandayUnexpectedRequest {
  readonly at: string;
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly reason: string;
}

export interface CreateMockPlandayOptions {
  /** Default: `buildPlandayFixture({ anchor })`. */
  fixture?: PlandayFixture;
  /** Anchor of the default fixture (default `FROZEN_NOW`). */
  anchor?: Date;
  /** The mock clock's base (default `Date.now`, so Vitest fake timers move it); `advanceClock` adds to it. */
  now?: () => Date | number;
  /**
   * ClockOff's App IDs (`PLANDAY_CLIENT_ID` for method A, `PLANDAY_APP_ID` for method B): the mock issues
   * tokens for them. Empty values are ignored.
   */
  partnerAppIds?: ReadonlyArray<string | null | undefined>;
  /** Registered Redirection URLs of the partner apps (default: any http(s) URL; the exchange still matches exactly). */
  redirectUris?: readonly string[];
  /** Portal the authorize endpoint and the data controls use when none is named (default 4100001). */
  defaultPortalId?: number;
  /** Extra environment the production guard also checks (tests); `process.env` is always checked. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface MockPlanday {
  /** `fetch` for `https://openapi.planday.com` and `https://id.planday.com`; any other host throws. */
  readonly fetch: typeof globalThis.fetch;
  /** Where the transport sends method A's browser (the mock's own authorize endpoint, auto-approving). */
  readonly authorizeBaseUrl: string;
  readonly state: MockPlandayState;
  readonly controls: MockPlandayControls;
  readonly requestLog: MockPlandayRequestLogEntry[];
  readonly unexpectedRequests: MockPlandayUnexpectedRequest[];
  /** The fixture the mock started from (a copy). */
  readonly fixture: PlandayFixture;
}

interface NormalisedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
  signal: AbortSignal | null;
}

async function bodyText(body: NonNullable<RequestInit["body"]>): Promise<string> {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return new Response(body).text();
}

async function normaliseRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<NormalisedRequest> {
  if (input instanceof Request) {
    const body =
      init?.body != null
        ? await bodyText(init.body)
        : input.body
          ? await input.clone().text()
          : null;
    return {
      method: (init?.method ?? input.method).toUpperCase(),
      url: new URL(input.url),
      headers: new Headers(init?.headers ?? input.headers),
      body: body === "" ? null : body,
      signal: init?.signal ?? input.signal,
    };
  }
  const body = init?.body != null ? await bodyText(init.body) : null;
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    url: new URL(String(input)),
    headers: new Headers(init?.headers),
    body: body === "" ? null : body,
    signal: init?.signal ?? null,
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const normaliseTemplate = (path: string) => path.replace(/\{[^}]+\}/g, "{id}");

/** Whether a fault or latency set for `faultPath` applies to this request (null: every API request). */
function pathMatches(
  faultPath: string | null,
  host: string,
  pathname: string,
  template: string,
): boolean {
  if (faultPath === null) return host === API_HOST;
  return faultPath === pathname || normaliseTemplate(faultPath) === normaliseTemplate(template);
}

function queryRecord(params: URLSearchParams): Record<string, string[]> {
  const record: Record<string, string[]> = {};
  for (const [key, value] of params) (record[key] ??= []).push(value);
  return record;
}

const TOKEN_FORM_FIELDS = [
  "client_id",
  "grant_type",
  "refresh_token",
  "code",
  "redirect_uri",
  "code_verifier",
];
const REVOCATION_FORM_FIELDS = ["client_id", "token"];
const AUTHORIZE_PARAMS = [
  "client_id",
  "response_type",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
];

/** Creates an in-process Mock Planday. Throws in production (`guard.ts`). */
export function createMockPlanday(options: CreateMockPlandayOptions = {}): MockPlanday {
  assertMockPlandayAllowed("createMockPlanday", options.env);
  const fixture = options.fixture ?? buildPlandayFixture({ anchor: options.anchor ?? FROZEN_NOW });
  const baseNow = options.now;
  const state = new MockPlandayState({
    fixture,
    now: baseNow
      ? () => {
          const value = baseNow();
          return typeof value === "number" ? value : value.getTime();
        }
      : () => Date.now(),
    partnerAppIds: (options.partnerAppIds ?? []).filter((id): id is string => Boolean(id?.trim())),
    defaultPortalId: options.defaultPortalId ?? MOCK_PORTAL_ID,
    redirectUris: options.redirectUris ?? null,
  });
  const requestLog: MockPlandayRequestLogEntry[] = [];
  const unexpectedRequests: MockPlandayUnexpectedRequest[] = [];
  let sequence = 0;
  const controls = createMockPlandayControls(state, {
    onReset() {
      requestLog.length = 0;
      unexpectedRequests.length = 0;
      sequence = 0;
    },
  });

  const unexpected = (req: NormalisedRequest, reason: string) => {
    unexpectedRequests.push({
      at: isoZ(state.now()),
      method: req.method,
      url: req.url.toString(),
      path: req.url.pathname,
      reason,
    });
  };

  const takeFault = <K extends MockFault["kind"]>(
    kinds: readonly K[],
    host: string,
    pathname: string,
    template: string,
  ): Extract<MockFault, { kind: K }> | null => {
    const index = state.faults.findIndex(
      (f) =>
        (kinds as readonly string[]).includes(f.kind) &&
        f.remaining > 0 &&
        pathMatches(f.path, host, pathname, template),
    );
    if (index < 0) return null;
    const fault = state.faults[index]!;
    fault.remaining -= 1;
    if (fault.remaining === 0) state.faults.splice(index, 1);
    return fault as Extract<MockFault, { kind: K }>;
  };

  const countRequest = (portalId: number | null): number => {
    if (portalId === null) return 0;
    const now = state.now();
    const window = (state.requestWindow.get(portalId) ?? []).filter((t) => t > now - 60_000);
    window.push(now);
    state.requestWindow.set(portalId, window);
    return window.length;
  };

  const rateLimitHeaders = (used: number): Record<string, string> => {
    const override = state.settings.rateLimitHeaders;
    const reset = 60 - (Math.floor(state.now() / 1000) % 60);
    return {
      "x-ratelimit-limit": RATE_LIMIT_POLICY,
      "x-ratelimit-remaining": String(
        override?.remaining ?? Math.max(0, PORTAL_REQUESTS_PER_MINUTE - used),
      ),
      "x-ratelimit-reset": String(override?.resetSeconds ?? reset),
    };
  };

  const rateLimitedResponse = (fault: Extract<MockFault, { kind: "RATE_LIMIT" }>): Response => {
    const headers: Record<string, string> = {
      "x-ratelimit-limit": RATE_LIMIT_POLICY,
      "x-ratelimit-remaining": "0",
    };
    if (fault.resetSeconds !== null) headers["x-ratelimit-reset"] = String(fault.resetSeconds);
    if (fault.retryAfterSeconds !== null) headers["retry-after"] = String(fault.retryAfterSeconds);
    // Planday documents no body for 429 (notes §8).
    return new Response(null, { status: 429, headers });
  };

  const errorResponse = (fault: Extract<MockFault, { kind: "ERROR" }>, identity: boolean) => {
    if (fault.body !== null) return jsonResponse(fault.status, fault.body);
    if (identity && fault.status < 500) return oauthErrorResponse(fault.status, "invalid_grant");
    return problemResponse(fault.status, null);
  };

  const malform = async (
    response: Response,
    fault: Extract<MockFault, { kind: "MALFORMED" }>,
    identity: boolean,
  ): Promise<Response> => {
    const headers = Object.fromEntries(response.headers);
    if (fault.mode === "not-json") {
      return new Response("<html><body>Service temporarily unavailable</body></html>", {
        status: response.status,
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      });
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (identity) {
      delete body[fault.field ?? "access_token"];
      return jsonResponse(response.status, body, headers);
    }
    const target = Array.isArray(body.data)
      ? (body.data[0] as Record<string, unknown> | undefined)
      : (body.data as Record<string, unknown> | null | undefined);
    if (!target || typeof target !== "object") {
      delete body.data;
    } else if (fault.mode === "unsafe-id") {
      target.id = 2 ** 53;
    } else {
      delete target[fault.field ?? "id"];
    }
    return jsonResponse(response.status, body, headers);
  };

  const checkApiQuery = (req: NormalisedRequest, route: ApiRoute) => {
    const seen = new Set<string>();
    for (const key of req.url.searchParams.keys()) {
      if (seen.has(key)) {
        unexpected(req, `query parameter "${key}" sent more than once`);
        continue;
      }
      seen.add(key);
      if (route.forbidden.includes(key)) {
        unexpected(req, `query parameter "${key}" is never sent (plan §4.2)`);
      } else if (!route.params.includes(key)) {
        unexpected(req, `query parameter "${key}" is not documented for ${route.template}`);
      }
    }
    if (route.paging && !req.url.searchParams.has("limit")) {
      unexpected(
        req,
        `paged list ${route.template} requested without an explicit limit (plan §4.4)`,
      );
    }
  };

  const handleApi = async (
    req: NormalisedRequest,
    entry: MockPlandayRequestLogEntry,
  ): Promise<Response> => {
    const pathname = req.url.pathname;
    const match = matchApiRoute(pathname);
    if (!match) {
      unexpected(req, "unknown path (ClockOff only calls the endpoints of notes §9)");
      return problemResponse(404, "Not found");
    }
    const { route, params } = match;
    entry.template = route.template;
    if (req.method !== "GET") {
      unexpected(req, `${req.method} ${route.template}: ClockOff only reads from Planday`);
      return problemResponse(405, "Method not allowed");
    }
    checkApiQuery(req, route);
    if (req.body !== null) unexpected(req, "request body on a GET");
    if (req.headers.has("x-openapi-region")) unexpected(req, "X-OpenAPI-Region header (retired)");

    const authorization = req.headers.get("authorization");
    const bearer = authorization?.match(/^Bearer (\S+)$/)?.[1] ?? null;
    const token = bearer ? state.accessTokens.get(bearer) : undefined;
    entry.portalId = token?.portalId ?? null;
    const used = countRequest(entry.portalId);

    const fault = takeFault(["RATE_LIMIT", "ERROR"], API_HOST, pathname, route.template);
    if (fault?.kind === "RATE_LIMIT") return rateLimitedResponse(fault);
    if (fault?.kind === "ERROR") return errorResponse(fault, false);

    const headers = rateLimitHeaders(used);
    const unauthorized = () =>
      new Response(null, {
        status: 401,
        headers: { ...headers, "www-authenticate": 'Bearer error="invalid_token"' },
      });
    const clientId = req.headers.get("x-clientid");
    if (!bearer || !token || !clientId) return unauthorized();
    const grant = state.grants.get(token.grantId);
    if (
      token.revoked ||
      token.expiresAtMs <= state.now() ||
      token.appId !== clientId ||
      !grant ||
      (grant.revoked && !grant.keepAccessTokens)
    ) {
      return unauthorized();
    }
    const app = state.apps.get(token.appId);
    if (route.scope !== null && !app?.scopes.includes(route.scope)) {
      return new Response(null, { status: 403, headers });
    }
    const portal = state.portals.get(token.portalId);
    if (!portal) return unauthorized();

    let response = runApiRoute(route, { state, portal, query: req.url.searchParams, params });
    if (response.ok) {
      const malformed = takeFault(["MALFORMED"], API_HOST, pathname, route.template);
      if (malformed) response = await malform(response, malformed, false);
    }
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  };

  const handleIdentity = async (
    req: NormalisedRequest,
    entry: MockPlandayRequestLogEntry,
  ): Promise<Response> => {
    const pathname = req.url.pathname;
    if (req.headers.has("x-clientid")) {
      unexpected(req, "X-ClientId on an identity request (notes §4: API requests only)");
    }
    if (req.headers.has("authorization")) {
      unexpected(
        req,
        "Authorization header on an identity request (API apps have no client secret)",
      );
    }
    if (req.headers.has("x-openapi-region")) unexpected(req, "X-OpenAPI-Region header (retired)");

    const isToken = pathname === "/connect/token";
    const isRevocation = pathname === "/connect/revocation";
    const isAuthorize = pathname === "/connect/authorize";
    if (!(isToken || isRevocation) || req.method !== "POST") {
      if (!(isAuthorize && req.method === "GET")) {
        unexpected(req, `unknown identity endpoint ${req.method} ${pathname}`);
        return jsonResponse(404, { error: "not_found" });
      }
    }

    let form: URLSearchParams | null = null;
    if (isToken || isRevocation) {
      const contentType = req.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
        unexpected(req, `${pathname} body must be application/x-www-form-urlencoded`);
        return oauthErrorResponse(400, "invalid_request");
      }
      form = new URLSearchParams(req.body ?? "");
      entry.form = Object.fromEntries(form);
      entry.clientId = form.get("client_id");
      const allowed = isToken ? TOKEN_FORM_FIELDS : REVOCATION_FORM_FIELDS;
      for (const key of form.keys()) {
        if (key === "client_secret")
          unexpected(req, "client_secret sent (notes §3.4: none exists)");
        else if (!allowed.includes(key)) unexpected(req, `undocumented form field "${key}"`);
      }
    } else {
      entry.clientId = req.url.searchParams.get("client_id");
      for (const key of req.url.searchParams.keys()) {
        if (!AUTHORIZE_PARAMS.includes(key))
          unexpected(req, `undocumented authorize parameter "${key}"`);
      }
    }

    const fault = takeFault(["RATE_LIMIT", "ERROR"], ID_HOST, pathname, pathname);
    if (fault?.kind === "RATE_LIMIT") return rateLimitedResponse(fault);
    if (fault?.kind === "ERROR") return errorResponse(fault, true);

    if (isAuthorize) return authorizeEndpoint(state, req.url.searchParams);
    let response = isToken ? tokenEndpoint(state, form!) : revocationEndpoint(state, form!);
    if (isToken && response.ok) {
      const malformed = takeFault(["MALFORMED"], ID_HOST, pathname, pathname);
      if (malformed) response = await malform(response, malformed, true);
    }
    return response;
  };

  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = await normaliseRequest(input, init);
    if (req.signal?.aborted) throw abortReason(req.signal);
    const host = req.url.host;
    if (req.url.protocol !== "https:" || (host !== API_HOST && host !== ID_HOST)) {
      unexpected(
        req,
        `request to ${req.url.origin}: Mock Planday only answers ${PLANDAY_API_ORIGIN} and ${PLANDAY_IDENTITY_ORIGIN}`,
      );
      throw new TypeError(`Mock Planday: no route to ${req.url.origin}`);
    }
    const authorization = req.headers.get("authorization");
    const entry: MockPlandayRequestLogEntry = {
      seq: ++sequence,
      at: isoZ(state.now()),
      method: req.method,
      host,
      path: req.url.pathname,
      template: req.url.pathname,
      query: queryRecord(req.url.searchParams),
      headers: Object.fromEntries(req.headers),
      form: null,
      accessToken: authorization?.match(/^Bearer (\S+)$/)?.[1] ?? null,
      clientId: host === API_HOST ? req.headers.get("x-clientid") : null,
      portalId: null,
      status: null,
      aborted: false,
    };
    requestLog.push(entry);
    const latency = state.settings.latency;
    try {
      if (latency) {
        const template =
          host === API_HOST
            ? (matchApiRoute(req.url.pathname)?.route.template ?? req.url.pathname)
            : req.url.pathname;
        if (latency.path === null || pathMatches(latency.path, host, req.url.pathname, template)) {
          await sleep(latency.ms, req.signal);
        }
      }
      if (req.signal?.aborted) throw abortReason(req.signal);
    } catch (error) {
      entry.aborted = true;
      throw error;
    }
    const response =
      host === API_HOST ? await handleApi(req, entry) : await handleIdentity(req, entry);
    entry.status = response.status;
    return response;
  };

  return {
    fetch: mockFetch as typeof globalThis.fetch,
    authorizeBaseUrl: `${PLANDAY_IDENTITY_ORIGIN}/connect/authorize`,
    state,
    controls,
    requestLog,
    unexpectedRequests,
    fixture: structuredClone(fixture),
  };
}
