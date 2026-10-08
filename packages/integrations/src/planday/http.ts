import { createHash } from "node:crypto";
import type { z } from "zod";
import { fullJitterBackoff } from "../core/backoff";
import { boundedTimeoutMs } from "../core/deadline";
import { KeyedSerialQueue, SlidingWindowBudget, TokenBucket } from "../core/rateLimiter";
import type { StoredCredentials } from "@clockoff/shared/providers/credentialStore";
import {
  API_REQUEST_TIMEOUT_MS,
  CLIENT_ID_BUDGET,
  CONNECT_MIN_REQUEST_MS,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  FORBIDDEN_QUERY_PARAMS,
  MAX_INLINE_RATE_LIMIT_WAITS,
  MAX_INLINE_WAIT_MS,
  MAX_RATE_LIMIT_WAIT_MS,
  PLANDAY_API_BASE_URL,
  PLANDAY_USER_AGENT,
  PORTAL_BUDGET,
  RATE_LIMIT_JITTER_MS,
  RATE_LIMIT_REMAINING_THRESHOLD,
  REQUEST_BACKOFF,
  REQUEST_MAX_ATTEMPTS,
  scopeForPath,
} from "./constants";
import {
  PlandayError,
  PlandayRateLimitedError,
  PlandayRequestBudgetExhaustedError,
  type PlandayErrorReason,
} from "./errors";
import {
  describeZodIssues,
  noopPlandayLogger,
  pathTemplate as toPathTemplate,
  PLANDAY_LOG_EVENTS,
  type PlandayLogger,
} from "./logging";

/**
 * The Planday HTTP layer (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.1, §4.2, §4.5, §4.6): headers,
 * one request stream per portal, client-side budgets, header feedback, 429 waits and parking, retries with
 * full-jitter backoff, timeouts bounded by the connect deadline, abort by the run's signal, status → typed
 * error mapping and redacted logging. It never sees a response body beyond handing the parsed JSON to the
 * caller's allow-list schema, and never logs one.
 */

// ---------------------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------------------

/** `fetch` restricted to what the client uses; `globalThis.fetch` and the mock's fetch both satisfy it. */
export type PlandayFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * How requests leave the process (§4.1): live, `globalThis.fetch`; mock mode, a fetch that rewrites the two
 * Planday hosts to the shared mock server; tests, the in-process mock. The client's URLs never change.
 */
export interface PlandayTransport {
  readonly fetch: PlandayFetch;
  /** Method A's authorize endpoint: Planday's live, the dev route in mock mode. Defaults to Planday's. */
  readonly authorizeBaseUrl?: string;
}

/** An abortable wait; injectable so tests run on a fake clock. Rejects with an AbortError when aborted. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Creates the per-request timeout signal (AbortSignal.timeout); injectable for tests. */
export type TimeoutSignalFactory = (ms: number) => AbortSignal;

// ---------------------------------------------------------------------------------------------------------
// Abort handling
// ---------------------------------------------------------------------------------------------------------

/** The error thrown when the caller's signal (worker shutdown, lost lease) aborts a request or a wait. */
export class PlandayAbortError extends Error {
  constructor(reason?: unknown) {
    super("The Planday request was aborted", reason !== undefined ? { cause: reason } : undefined);
    this.name = "AbortError";
  }
}

/** True for any AbortError: ours, a DOMException from fetch, or a signal's own reason. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function abortErrorFor(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new PlandayAbortError(reason);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortErrorFor(signal);
}

/** The default sleep: setTimeout, cut short by `signal`. */
export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortErrorFor(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortErrorFor(signal as AbortSignal));
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export const defaultTimeoutSignal: TimeoutSignalFactory = (ms) => AbortSignal.timeout(ms);

/**
 * Settles with `promise`, or rejects with `signal.reason` as soon as `signal` aborts. Guarantees the timeout and
 * the caller's signal apply even to a fetch implementation that ignores `init.signal`.
 */
export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason as Error);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err as Error);
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------------------
// Process-wide budgets
// ---------------------------------------------------------------------------------------------------------

interface KeyLimits {
  readonly bucket: TokenBucket;
  readonly window: SlidingWindowBudget;
  pauseUntilMs: number;
}

interface InFlightRefresh {
  readonly promise: Promise<StoredCredentials>;
  /** The credential store being refreshed: only a client of the same store may join (and take its tokens). */
  readonly store: object;
  readonly force: boolean;
  readonly rejectAccessTokenHash: string | undefined;
}

/**
 * Process-local rate state shared by every client in the process (§4.5): the per-portal serial queue, token
 * buckets and sliding windows per portal and per client id, header-feedback pauses, and the single in-flight
 * token refresh per integration. One instance per process (`sharedPlandayBudgets()`); tests create their own.
 */
export class PlandayBudgets {
  readonly queue = new KeyedSerialQueue();
  /** @internal one token refresh in flight per integration (§4.3). */
  readonly refreshes = new Map<string, InFlightRefresh>();
  private readonly portals = new Map<string, KeyLimits>();
  private readonly clients = new Map<string, KeyLimits>();

  private limits(kind: "portal" | "client", key: string): KeyLimits {
    const map = kind === "portal" ? this.portals : this.clients;
    let entry = map.get(key);
    if (!entry) {
      const budget = kind === "portal" ? PORTAL_BUDGET : CLIENT_ID_BUDGET;
      entry = {
        bucket: new TokenBucket({ capacity: budget.perSecond, refillPerSecond: budget.perSecond }),
        window: new SlidingWindowBudget({ limit: budget.perMinute, windowMs: 60_000 }),
        pauseUntilMs: 0,
      };
      map.set(key, entry);
    }
    return entry;
  }

  /** Milliseconds before one more request may start for this portal and client id. */
  delayMs(keys: { readonly portal: string; readonly client: string }, nowMs: number): number {
    const portal = this.limits("portal", keys.portal);
    const client = this.limits("client", keys.client);
    return Math.max(
      0,
      portal.bucket.delayMs(nowMs),
      portal.window.delayMs(nowMs),
      portal.pauseUntilMs - nowMs,
      client.bucket.delayMs(nowMs),
      client.window.delayMs(nowMs),
      client.pauseUntilMs - nowMs,
    );
  }

  /** Records one request for both keys. */
  take(keys: { readonly portal: string; readonly client: string }, nowMs: number): void {
    for (const entry of [this.limits("portal", keys.portal), this.limits("client", keys.client)]) {
      entry.bucket.take(nowMs);
      entry.window.take(nowMs);
    }
  }

  /** Holds every request on the key until `untilMs` (header feedback and 429 waits). */
  pause(kind: "portal" | "client", key: string, untilMs: number): void {
    const entry = this.limits(kind, key);
    entry.pauseUntilMs = Math.max(entry.pauseUntilMs, untilMs);
  }
}

let shared: PlandayBudgets | null = null;

/** The process-wide budgets every client uses unless given its own. */
export function sharedPlandayBudgets(): PlandayBudgets {
  shared ??= new PlandayBudgets();
  return shared;
}

/** A stable, non-reversible key for a client id: budgets are keyed by it, the id itself is never kept. */
export function clientIdKeyOf(clientId: string): string {
  return createHash("sha256").update(clientId).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------------------------------------
// Rate-limit headers (notes §6)
// ---------------------------------------------------------------------------------------------------------

function parseSeconds(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** A header-derived wait, or null when it exceeds MAX_RATE_LIMIT_WAIT_MS (not a Planday window, so ignored). */
function boundedHeaderWaitMs(ms: number | null): number | null {
  return ms !== null && ms <= MAX_RATE_LIMIT_WAIT_MS ? ms : null;
}

/** `x-ratelimit-reset` (seconds until the window resets, notes §6) as milliseconds, when usable. */
function parseResetMs(value: string | null): number | null {
  const seconds = parseSeconds(value);
  return boundedHeaderWaitMs(seconds === null ? null : seconds * 1000);
}

/** `Retry-After` as milliseconds from `nowMs`: delta-seconds or an HTTP date (undocumented by Planday, Q15). */
function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  const seconds = parseSeconds(value);
  if (seconds !== null) return boundedHeaderWaitMs(seconds * 1000);
  if (value === null) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : boundedHeaderWaitMs(Math.max(0, at - nowMs));
}

export type RateLimitWaitSource = "retry-after" | "x-ratelimit-reset" | "default";

/**
 * The wait after a 429 (§4.5): `x-ratelimit-reset` seconds; with an undocumented `Retry-After` too, the longer of
 * the two; neither, 60 s; plus 0–1 s of jitter. A header asking for more than MAX_RATE_LIMIT_WAIT_MS counts as
 * absent, so the wait (and a parked run's `retryAt`) is never longer than that plus the jitter.
 */
export function rateLimitWait(
  headers: Headers,
  nowMs: number,
  random: () => number,
): { readonly waitMs: number; readonly source: RateLimitWaitSource } {
  const resetMs = parseResetMs(headers.get("x-ratelimit-reset"));
  const retryAfterMs = parseRetryAfterMs(headers.get("retry-after"), nowMs);
  let base: number;
  let source: RateLimitWaitSource;
  if (resetMs === null && retryAfterMs === null) {
    base = DEFAULT_RATE_LIMIT_WAIT_MS;
    source = "default";
  } else if (retryAfterMs !== null && (resetMs === null || retryAfterMs > resetMs)) {
    base = retryAfterMs;
    source = "retry-after";
  } else {
    base = resetMs as number;
    source = "x-ratelimit-reset";
  }
  const jitter = Math.floor(Math.min(Math.max(random(), 0), 0.999_999) * RATE_LIMIT_JITTER_MS);
  return { waitMs: Math.ceil(base) + jitter, source };
}

/** `x-ratelimit-remaining`, when present. */
export function rateLimitRemaining(headers: Headers): number | null {
  const n = parseSeconds(headers.get("x-ratelimit-remaining"));
  return n === null ? null : Math.floor(n);
}

// ---------------------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------------------

/** Drops a body the caller will not read, so the connection can be reused. Never throws. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed or closed.
  }
}

/** Reads a body as JSON; a non-JSON body is PLANDAY_INVALID_RESPONSE (`NOT_JSON`). */
export async function readJsonBody(response: Response, template: string): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new PlandayError("PLANDAY_UNAVAILABLE", {
      reason: "NETWORK",
      status: response.status,
      pathTemplate: template,
      cause: err,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PlandayError("PLANDAY_INVALID_RESPONSE", {
      reason: "NOT_JSON",
      status: response.status,
      pathTemplate: template,
    });
  }
}

/**
 * Validates `body` with an allow-list schema. A failure logs `planday.invalid_response` with issue paths and codes
 * only (never values) and throws PLANDAY_INVALID_RESPONSE (`SCHEMA`).
 */
export function parseResponse<T extends z.ZodType>(
  schema: T,
  body: unknown,
  context: { readonly pathTemplate: string; readonly logger: PlandayLogger },
): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    context.logger.warn(
      { pathTemplate: context.pathTemplate, issues: describeZodIssues(result.error) },
      PLANDAY_LOG_EVENTS.invalidResponse,
    );
    throw new PlandayError("PLANDAY_INVALID_RESPONSE", {
      reason: "SCHEMA",
      pathTemplate: context.pathTemplate,
    });
  }
  return result.data as z.output<T>;
}

// ---------------------------------------------------------------------------------------------------------
// The API request loop
// ---------------------------------------------------------------------------------------------------------

/** Supplies the bearer token and the client id that issued it (§4.3). */
export interface PlandayAuth {
  /** A token valid for at least the refresh margin (refreshing it first when needed). */
  current(): Promise<{ readonly accessToken: string; readonly clientId: string }>;
  /** After a 401: one forced refresh that treats `rejectedAccessToken` as invalid. */
  refreshAfterUnauthorized(rejectedAccessToken: string): Promise<void>;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface PlandayHttpOptions {
  readonly transport: PlandayTransport;
  readonly auth: PlandayAuth;
  /** The serial-queue and budget key: the portal id, or the integration id before the portal is known. */
  readonly portalKey: string;
  /** Budget key for the client id; defaults to a hash of the client id the auth reports. */
  readonly clientIdKey?: string;
  readonly budgets?: PlandayBudgets;
  readonly logger?: PlandayLogger;
  readonly now?: () => Date;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly createTimeoutSignal?: TimeoutSignalFactory;
  /** Worker shutdown or lost lease: checked before every request, combined with each request's timeout. */
  readonly signal?: AbortSignal;
  /** The connect proof's bound (§4.1, §5.6). */
  readonly deadline?: { remainingMs(): number };
  /** Hard cap on requests this instance may send (the run budget is enforced by the executor, §4.5). */
  readonly maxRequests?: number;
  /** Log fields. */
  readonly integrationId?: string;
  readonly runId?: string;
}

export interface PlandayHttp {
  /** GET an API path (spec path, ids already substituted) and return its JSON body. */
  getJson(path: string, query?: Readonly<Record<string, QueryValue>>): Promise<unknown>;
  /** GET and validate with an allow-list schema. */
  getParsed<T extends z.ZodType>(
    path: string,
    query: Readonly<Record<string, QueryValue>> | undefined,
    schema: T,
  ): Promise<z.output<T>>;
  /** Requests sent so far, retries included (token requests are counted by the client). */
  requestCount(): number;
  /** Counts a request made outside `getJson` (token requests), for the run's budget. */
  countRequest(): void;
  readonly logger: PlandayLogger;
}

/** Builds an absolute API URL. Refuses the query parameters ClockOff never sends (notes §9.2, plan §4.2). */
export function buildApiUrl(path: string, query?: Readonly<Record<string, QueryValue>>): string {
  if (!path.startsWith("/")) throw new TypeError("Planday paths start with /");
  const url = new URL(path, PLANDAY_API_BASE_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    if ((FORBIDDEN_QUERY_PARAMS as readonly string[]).includes(key)) {
      throw new TypeError(`ClockOff never sends the Planday query parameter ${key}`);
    }
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

const EMPLOYEE_BY_ID_TEMPLATE = "/hr/v1.0/employees/{id}";

/**
 * A read addressed by a record id: `/hr/v1.0/employees/{id}`, `/scheduling/v1.0/shifts/{id}`,
 * `/punchclock/v1.0/punchclockshifts/{id}/breaks`. Only these turn a 404 into PLANDAY_NOT_FOUND.
 */
function isByIdTemplate(template: string): boolean {
  return template.split("/").includes("{id}");
}

export function createPlandayHttp(options: PlandayHttpOptions): PlandayHttp {
  const budgets = options.budgets ?? sharedPlandayBudgets();
  const logger = options.logger ?? noopPlandayLogger;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const createTimeoutSignal = options.createTimeoutSignal ?? defaultTimeoutSignal;
  const { signal, deadline } = options;
  let count = 0;

  const fail = (
    code: ConstructorParameters<typeof PlandayError>[0],
    template: string,
    extra: {
      status?: number;
      reason?: PlandayErrorReason;
      missingScopes?: string[];
      cause?: unknown;
    } = {},
  ) => new PlandayError(code, { pathTemplate: template, ...extra });

  /** Waits for the budgets of both keys; a wait too long for the slice (or the deadline) parks instead. */
  async function waitForBudget(
    keys: { portal: string; client: string },
    template: string,
  ): Promise<void> {
    for (let i = 0; ; i++) {
      const nowMs = now().getTime();
      const delay = budgets.delayMs(keys, nowMs);
      if (delay <= 0 || i >= 50) {
        budgets.take(keys, nowMs);
        return;
      }
      const tooLong =
        delay > MAX_INLINE_WAIT_MS ||
        (deadline !== undefined && delay + CONNECT_MIN_REQUEST_MS > deadline.remainingMs());
      if (tooLong) {
        throw new PlandayRateLimitedError(new Date(nowMs + delay), { pathTemplate: template });
      }
      await sleep(delay, signal);
      throwIfAborted(signal);
    }
  }

  /** A retry wait that the deadline can still afford; otherwise the request fails as `error`. */
  async function retryWait(ms: number, error: PlandayError): Promise<void> {
    if (deadline !== undefined && ms + CONNECT_MIN_REQUEST_MS > deadline.remainingMs()) throw error;
    await sleep(ms, signal);
    throwIfAborted(signal);
  }

  async function execute(url: string, template: string): Promise<unknown> {
    let failures = 0;
    let rateLimitWaits = 0;
    let authRetried = false;
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(signal);
      if (options.maxRequests !== undefined && count >= options.maxRequests) {
        throw new PlandayRequestBudgetExhaustedError(options.maxRequests);
      }
      const auth = await options.auth.current();
      throwIfAborted(signal);
      const keys = {
        portal: options.portalKey,
        client: options.clientIdKey ?? clientIdKeyOf(auth.clientId),
      };
      await waitForBudget(keys, template);
      const timeoutMs = boundedTimeoutMs(API_REQUEST_TIMEOUT_MS, deadline, CONNECT_MIN_REQUEST_MS);
      if (timeoutMs === null) throw fail("PLANDAY_UNAVAILABLE", template, { reason: "DEADLINE" });

      const timeoutSignal = createTimeoutSignal(timeoutMs);
      const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
      const startedMs = now().getTime();
      count++;
      let response: Response;
      try {
        response = await raceWithSignal(
          options.transport.fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${auth.accessToken}`,
              "X-ClientId": auth.clientId,
              Accept: "application/json",
              "User-Agent": PLANDAY_USER_AGENT,
            },
            redirect: "manual",
            signal: requestSignal,
          }),
          requestSignal,
        );
      } catch (err) {
        logRequest(template, null, startedMs, attempt, null);
        if (signal?.aborted) throw abortErrorFor(signal);
        failures++;
        const reason: PlandayErrorReason = timeoutSignal.aborted ? "TIMEOUT" : "NETWORK";
        const error = fail("PLANDAY_UNAVAILABLE", template, { reason, cause: err });
        if (failures >= REQUEST_MAX_ATTEMPTS) throw error;
        await retryWait(fullJitterBackoff(failures, REQUEST_BACKOFF, random), error);
        continue;
      }

      const status = response.status;
      const remaining = rateLimitRemaining(response.headers);
      logRequest(template, status, startedMs, attempt, remaining);
      applyHeaderFeedback(keys, response.headers, remaining);

      if (status >= 200 && status < 300) {
        try {
          return await raceWithSignal(readJsonBody(response, template), requestSignal);
        } catch (err) {
          if (signal?.aborted) throw abortErrorFor(signal);
          // A non-JSON body is deterministic. A read cut short (connection reset, timeout) is a network error
          // like any other: retried with backoff, at most REQUEST_MAX_ATTEMPTS per request (§4.5).
          if (err instanceof PlandayError && err.code !== "PLANDAY_UNAVAILABLE") throw err;
          failures++;
          const error = fail("PLANDAY_UNAVAILABLE", template, {
            reason: timeoutSignal.aborted ? "TIMEOUT" : "NETWORK",
            status,
            cause: err instanceof PlandayError ? err.cause : err,
          });
          if (failures >= REQUEST_MAX_ATTEMPTS) throw error;
          await retryWait(fullJitterBackoff(failures, REQUEST_BACKOFF, random), error);
          continue;
        }
      }

      await discardBody(response);
      if (status === 401) {
        if (authRetried) throw fail("PLANDAY_AUTH_FAILED", template, { status });
        authRetried = true;
        await options.auth.refreshAfterUnauthorized(auth.accessToken);
        continue;
      }
      if (status === 403) {
        throw fail("PLANDAY_SCOPE_MISSING", template, {
          status,
          missingScopes: [scopeForPath(template)],
        });
      }
      // Record level only (§4.6): a 404 on a by-id read means the record is gone. A 404 on a list path is not
      // "no such record"; it falls through to INVALID_RESPONSE (BAD_REQUEST) below with the status kept, which
      // the scheduleDay rule (Q35) reads.
      if (status === 404 && isByIdTemplate(template)) {
        throw fail("PLANDAY_NOT_FOUND", template, { status });
      }
      if (status === 400 && template === EMPLOYEE_BY_ID_TEMPLATE) {
        // Notes §8: an invalid or inactive employee id is a record-level skip.
        throw fail("PLANDAY_NOT_FOUND", template, { status });
      }
      if (status === 429) {
        const nowMs = now().getTime();
        const { waitMs, source } = rateLimitWait(response.headers, nowMs, random);
        logger.warn({ pathTemplate: template, waitMs, source }, PLANDAY_LOG_EVENTS.rateLimited);
        budgets.pause("portal", keys.portal, nowMs + waitMs);
        rateLimitWaits++;
        const retryAt = new Date(nowMs + waitMs);
        const parked = new PlandayRateLimitedError(retryAt, { status, pathTemplate: template });
        if (waitMs > MAX_INLINE_WAIT_MS || rateLimitWaits > MAX_INLINE_RATE_LIMIT_WAITS)
          throw parked;
        await retryWait(waitMs, parked);
        continue;
      }
      if (status === 409 || status >= 500) {
        failures++;
        const error = fail("PLANDAY_UNAVAILABLE", template, { status, reason: "SERVER_ERROR" });
        if (failures >= REQUEST_MAX_ATTEMPTS) throw error;
        await retryWait(fullJitterBackoff(failures, REQUEST_BACKOFF, random), error);
        continue;
      }
      // Any other status (another 4xx, a redirect): deterministic, so not retried.
      throw fail("PLANDAY_INVALID_RESPONSE", template, { status, reason: "BAD_REQUEST" });
    }
  }

  function applyHeaderFeedback(
    keys: { portal: string; client: string },
    headers: Headers,
    remaining: number | null,
  ): void {
    if (remaining === null || remaining > RATE_LIMIT_REMAINING_THRESHOLD) return;
    // A reset beyond MAX_RATE_LIMIT_WAIT_MS is ignored: it would hold every tenant on the shared client id.
    const resetMs = parseResetMs(headers.get("x-ratelimit-reset"));
    if (resetMs === null || resetMs <= 0) return;
    const until = now().getTime() + resetMs;
    budgets.pause("portal", keys.portal, until);
    budgets.pause("client", keys.client, until);
  }

  function logRequest(
    template: string,
    status: number | null,
    startedMs: number,
    attempt: number,
    remaining: number | null,
  ): void {
    logger.debug(
      {
        method: "GET",
        pathTemplate: template,
        status,
        durationMs: Math.max(0, now().getTime() - startedMs),
        attempt,
        rateLimitRemaining: remaining,
        integrationId: options.integrationId ?? null,
        runId: options.runId ?? null,
      },
      PLANDAY_LOG_EVENTS.request,
    );
  }

  async function getJson(
    path: string,
    query?: Readonly<Record<string, QueryValue>>,
  ): Promise<unknown> {
    const template = toPathTemplate(path);
    const url = buildApiUrl(path, query);
    throwIfAborted(signal);
    return budgets.queue.run(options.portalKey, async () => {
      try {
        return await execute(url, template);
      } catch (err) {
        if (err instanceof PlandayError) {
          logger.warn(
            {
              code: err.code,
              status: err.status ?? null,
              pathTemplate: err.pathTemplate ?? template,
            },
            PLANDAY_LOG_EVENTS.error,
          );
        }
        throw err;
      }
    });
  }

  return {
    getJson,
    async getParsed(path, query, schema) {
      const body = await getJson(path, query);
      return parseResponse(schema, body, { pathTemplate: toPathTemplate(path), logger });
    },
    requestCount: () => count,
    countRequest: () => {
      count++;
    },
    logger,
  };
}
