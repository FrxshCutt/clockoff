import { boundedTimeoutMs } from "../core/deadline";
import {
  CONNECT_MIN_REQUEST_MS,
  DEFAULT_ACCESS_TOKEN_LIFETIME_S,
  MAX_INLINE_RATE_LIMIT_WAITS,
  MAX_INLINE_WAIT_MS,
  missingScopes,
  PLANDAY_ID_BASE_URL,
  PLANDAY_REVOCATION_PATH,
  PLANDAY_TOKEN_PATH,
  PLANDAY_USER_AGENT,
  REVOCATION_TIMEOUT_MS,
  TOKEN_REQUEST_TIMEOUT_MS,
} from "./constants";
import { PlandayError, PlandayRateLimitedError } from "./errors";
import {
  defaultSleep,
  defaultTimeoutSignal,
  discardBody,
  parseResponse,
  raceWithSignal,
  rateLimitRemaining,
  rateLimitWait,
  readJsonBody,
  throwIfAborted,
  type PlandayTransport,
  type Sleep,
  type TimeoutSignalFactory,
} from "./http";
import { noopPlandayLogger, PLANDAY_LOG_EVENTS, type PlandayLogger } from "./logging";
import { codeExchangeResponseSchema, tokenResponseSchema } from "./schemas";

/**
 * Identity-server calls on `id.planday.com` (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.3, notes §3):
 * the authorization-code exchange, the refresh grant and revocation. Form-encoded `POST`s with no `X-ClientId`
 * and no `client_secret`. Errors are keyed on status only (bodies are undocumented and never read on failure):
 * 400/401/403 → PLANDAY_AUTH_FAILED; 429 → the API's wait rule; 5xx, network failure or timeout →
 * PLANDAY_UNAVAILABLE; 2xx with an unreadable body → PLANDAY_INVALID_RESPONSE.
 *
 * A token request is never aborted by the caller's signal once sent (its answer may carry a rotated refresh token
 * that must be persisted, §7.7) and is never retried on 5xx or a timeout here: whether Planday processed it is
 * unknown, and the run-level retry refreshes again with whatever the store holds. Only waits before sending are
 * abortable.
 */

export interface TokenRequestDeps {
  readonly transport: PlandayTransport;
  /** The connect proof's bound: timeout `min(10 s, remaining)`, not started below 3 s. Not used for revocation. */
  readonly deadline?: { remainingMs(): number };
  readonly logger?: PlandayLogger;
  readonly now?: () => Date;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly createTimeoutSignal?: TimeoutSignalFactory;
  /** Aborts 429 waits before a token request is (re)sent; never a request in flight. */
  readonly signal?: AbortSignal;
  /** Called once per request sent (the run's request count). */
  readonly onRequest?: () => void;
  readonly integrationId?: string;
  readonly runId?: string;
}

/** A parsed token response. Nothing else from it (notably `id_token`) is ever kept. */
export interface PlandayTokenSet {
  readonly accessToken: string;
  /** The refresh token Planday returned, or null when it returned none (no rotation). */
  readonly refreshToken: string | null;
  /** `expires_in`, 3600 when absent (notes §3.3). */
  readonly expiresInS: number;
  /** Space-separated granted scopes, when returned. */
  readonly scope: string | null;
}

type Kind = "token" | "revocation";

async function postForm(
  path: string,
  body: URLSearchParams,
  kind: Kind,
  deps: TokenRequestDeps,
): Promise<Response> {
  const logger = deps.logger ?? noopPlandayLogger;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const createTimeoutSignal = deps.createTimeoutSignal ?? defaultTimeoutSignal;
  const url = `${PLANDAY_ID_BASE_URL}${path}`;
  let rateLimitWaits = 0;

  for (let attempt = 1; ; attempt++) {
    const timeoutMs =
      kind === "revocation"
        ? REVOCATION_TIMEOUT_MS
        : boundedTimeoutMs(TOKEN_REQUEST_TIMEOUT_MS, deps.deadline, CONNECT_MIN_REQUEST_MS);
    if (timeoutMs === null) {
      throw new PlandayError("PLANDAY_UNAVAILABLE", { reason: "DEADLINE", pathTemplate: path });
    }
    const timeoutSignal = createTimeoutSignal(timeoutMs);
    const startedMs = now().getTime();
    const log = (status: number | null, remaining: number | null): void => {
      logger.debug(
        {
          method: "POST",
          pathTemplate: path,
          status,
          durationMs: Math.max(0, now().getTime() - startedMs),
          attempt,
          rateLimitRemaining: remaining,
          integrationId: deps.integrationId ?? null,
          runId: deps.runId ?? null,
        },
        PLANDAY_LOG_EVENTS.request,
      );
    };
    deps.onRequest?.();
    let response: Response;
    try {
      response = await raceWithSignal(
        deps.transport.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": PLANDAY_USER_AGENT,
          },
          body: body.toString(),
          redirect: "manual",
          signal: timeoutSignal,
        }),
        timeoutSignal,
      );
    } catch (err) {
      log(null, null);
      throw new PlandayError("PLANDAY_UNAVAILABLE", {
        reason: timeoutSignal.aborted ? "TIMEOUT" : "NETWORK",
        pathTemplate: path,
        cause: err,
      });
    }
    log(response.status, rateLimitRemaining(response.headers));

    if (response.status !== 429) {
      if (response.status < 200 || response.status >= 300) await discardBody(response);
      if (response.status >= 200 && response.status < 300) return response;
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new PlandayError("PLANDAY_AUTH_FAILED", {
          status: response.status,
          pathTemplate: path,
        });
      }
      throw new PlandayError("PLANDAY_UNAVAILABLE", {
        status: response.status,
        reason: response.status >= 500 ? "SERVER_ERROR" : "BAD_REQUEST",
        pathTemplate: path,
      });
    }

    await discardBody(response);
    const nowMs = now().getTime();
    const { waitMs, source } = rateLimitWait(response.headers, nowMs, random);
    logger.warn({ pathTemplate: path, waitMs, source }, PLANDAY_LOG_EVENTS.rateLimited);
    rateLimitWaits++;
    const parked = new PlandayRateLimitedError(new Date(nowMs + waitMs), {
      status: 429,
      pathTemplate: path,
    });
    const inline =
      kind === "token" &&
      waitMs <= MAX_INLINE_WAIT_MS &&
      rateLimitWaits <= MAX_INLINE_RATE_LIMIT_WAITS &&
      (deps.deadline === undefined ||
        waitMs + CONNECT_MIN_REQUEST_MS <= deps.deadline.remainingMs());
    if (!inline) throw parked;
    await sleep(waitMs, deps.signal);
    throwIfAborted(deps.signal);
  }
}

/**
 * Method A: exchanges an authorization code (notes §3.2 A step 4). The response must carry a refresh token. With
 * `requiredScopes`, a returned `scope` that lacks one fails with PLANDAY_SCOPE_MISSING naming them (§5.2 step 4);
 * without a `scope` in the response the connect proof's probes decide. `codeVerifier` is sent only with PKCE.
 */
export async function exchangeCode(
  params: {
    readonly clientId: string;
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier?: string;
    readonly requiredScopes?: readonly string[];
  },
  deps: TokenRequestDeps,
): Promise<PlandayTokenSet & { readonly refreshToken: string }> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
  });
  if (params.codeVerifier) body.set("code_verifier", params.codeVerifier);
  const response = await postForm(PLANDAY_TOKEN_PATH, body, "token", deps);
  const json = await readJsonBody(response, PLANDAY_TOKEN_PATH);
  const parsed = parseResponse(codeExchangeResponseSchema, json, {
    pathTemplate: PLANDAY_TOKEN_PATH,
    logger: deps.logger ?? noopPlandayLogger,
  });
  const scope = parsed.scope ?? null;
  if (params.requiredScopes) {
    const missing = missingScopes(scope, params.requiredScopes);
    if (missing && missing.length > 0) {
      throw new PlandayError("PLANDAY_SCOPE_MISSING", {
        missingScopes: missing,
        pathTemplate: PLANDAY_TOKEN_PATH,
      });
    }
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresInS: parsed.expires_in ?? DEFAULT_ACCESS_TOKEN_LIFETIME_S,
    scope,
  };
}

/** The refresh grant (notes §3.3). `refreshToken` in the result is null when Planday did not rotate it. */
export async function refreshToken(
  params: { readonly clientId: string; readonly refreshToken: string },
  deps: TokenRequestDeps,
): Promise<PlandayTokenSet> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
  });
  const response = await postForm(PLANDAY_TOKEN_PATH, body, "token", deps);
  const json = await readJsonBody(response, PLANDAY_TOKEN_PATH);
  const parsed = parseResponse(tokenResponseSchema, json, {
    pathTemplate: PLANDAY_TOKEN_PATH,
    logger: deps.logger ?? noopPlandayLogger,
  });
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresInS: parsed.expires_in ?? DEFAULT_ACCESS_TOKEN_LIFETIME_S,
    scope: parsed.scope ?? null,
  };
}

/**
 * Revokes a refresh token (notes §3.6): `client_id` and `token`, 5 s timeout, no waits on 429. Any 2xx is
 * success and the body (undocumented) is ignored. Best effort: callers log the outcome and never block on it.
 */
export async function revokeToken(
  params: { readonly clientId: string; readonly refreshToken: string },
  deps: TokenRequestDeps,
): Promise<void> {
  const body = new URLSearchParams({ client_id: params.clientId, token: params.refreshToken });
  const response = await postForm(PLANDAY_REVOCATION_PATH, body, "revocation", deps);
  await discardBody(response);
}
