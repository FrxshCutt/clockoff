import { Prisma } from "@clockoff/db";
import { API_ERROR_CODES, AppError, isAppError, type ApiErrorCode } from "@clockoff/shared/errors";
import type { Permission } from "@clockoff/shared/permissions";
import { searchParamsToObject } from "@clockoff/validation/common";
import type { NextRequest } from "next/server";
import { z, type ZodType } from "zod";
import {
  CSRF_COOKIE,
  ORG_COOKIE,
  SESSION_COOKIE,
  appendSetCookies,
  csrfCookie,
  orgCookie,
  sessionCookie,
} from "@/lib/cookies";
import { constantTimeEqual, isValidCsrfToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { childLogger, errorSummary, stackFrames, type Logger } from "@/lib/logger";
import {
  CSRF_HEADER,
  REQUEST_ID_HEADER,
  getBearerToken,
  getClientIp,
  getCookie,
  getRequestId,
  isMutatingMethod,
} from "@/lib/request";
import { assertAllowedOrigin, assertCsrf } from "@/server/auth/csrf";
import { isOriginCheckExempt } from "@/server/http/originCheck";
import { enforceRateLimit } from "@/server/rateLimit";
import type { RateLimitRule } from "@/server/rateLimit";
import {
  elevateToManagerContext,
  getCurrentDeviceContext,
  getCurrentUserContext,
  getRequestMeta,
  requirePermission,
  type CronContext,
  type DeviceContext,
  type ManagerContext,
  type UserContext,
} from "@/server/tenancy/context";
import { errorResponse, json, noContent } from "./responses";

/**
 * `createHandler` turns a typed implementation into a Next.js App Router route handler and owns every
 * cross-cutting concern: request id, rate limiting, CSRF, authentication/tenancy, permission,
 * validation, error envelope, logging.
 *
 * ```ts
 * export const POST = createHandler(
 *   { auth: "manager", permission: "employees:write", body: createEmployeeSchema },
 *   async ({ ctx, body }) => json(await createEmployee(ctx, body), { status: 201 }),
 * );
 * ```
 *
 * Auth modes:
 * - `public`  — no authentication; `ctx` is `null`.
 * - `user`    — signed-in manager, organisation not required (auth routes, organisation creation).
 * - `manager` — signed-in manager scoped to their current organisation (`ctx.organisation` etc.).
 * - `mobile`  — employee device bearer JWT (`ctx.device`, `ctx.employee`, `ctx.organisation`).
 * - `cron`    — `Authorization: Bearer <CRON_SECRET>` (or `x-cron-secret`).
 *
 * CSRF: mutating `user` / `manager` requests ALWAYS pass the double-submit check plus an Origin re-check
 * (it cannot be switched off). Mutating `public` requests (login, register, invite accept…) reject a
 * foreign `Origin`; `csrf: true` additionally demands the double-submit token (logout). `mobile` and
 * `cron` are bearer-authenticated and never CSRF-checked.
 *
 * Input: only what a schema validated reaches the implementation. Without a `params` / `query` /
 * `body` schema the corresponding argument is `undefined` (declare a schema to read it).
 *
 * Implementations return either a `Response` (JSON, 204, SSE stream, redirect — passed through
 * untouched apart from the `x-request-id` header) or any JSON-serialisable value (sent as 200 JSON);
 * `undefined` becomes 204.
 */

export type AuthMode = "public" | "user" | "manager" | "mobile" | "cron";

export type EmailVerificationPolicy = "env" | "always" | "never";

export type ContextFor<A extends AuthMode> = A extends "manager"
  ? ManagerContext
  : A extends "user"
    ? UserContext
    : A extends "mobile"
      ? DeviceContext
      : A extends "cron"
        ? CronContext
        : null;

export type RawParams = Record<string, string | string[] | undefined>;
export type RawQuery = Record<string, string | string[]>;

/** What Next 15 passes as the second route-handler argument. */
export interface RouteContext {
  params: Promise<RawParams>;
}

/**
 * The exported route handler. The second argument is typed `unknown` on purpose: Next's build-time
 * route type check requires it to be assignable to `{ params: Promise<{ <segment>: string }> }` for the
 * route's own segments, which no single shared type satisfies. Params are read defensively and then
 * validated by the `params` schema.
 */
export type RouteHandler = (req: NextRequest, context: unknown) => Promise<Response>;

export interface HandlerArgs<A extends AuthMode, P, Q, B> {
  /** The raw request (headers, cookies). Read input through `params` / `query` / `body`, which are validated. */
  req: NextRequest;
  ctx: ContextFor<A>;
  /** Validated dynamic route segments (`undefined` without a `params` schema). */
  params: P;
  /** Validated query string (`undefined` without a `query` schema). */
  query: Q;
  /** Validated JSON body (`undefined` without a `body` schema). */
  body: B;
  requestId: string;
  /** Child logger bound to `requestId` (and the organisation id when known). */
  log: Logger;
}

export interface HandlerOptions<A extends AuthMode, P, Q, B> {
  auth: A;
  /** Required permission (manager mode only). */
  permission?: Permission;
  params?: ZodType<P>;
  query?: ZodType<Q>;
  body?: ZodType<B>;
  rateLimit?: RateLimitRule | readonly RateLimitRule[];
  /** Maximum accepted JSON body size (default 1 MiB). */
  maxBodyBytes?: number;
  /**
   * `public` mode only: `true` also requires the double-submit CSRF token on mutating requests (e.g.
   * logout). Always on for `user` / `manager` (`false` throws at definition); not applicable to the
   * bearer-authenticated `mobile` / `cron` modes (`true` throws at definition).
   */
  csrf?: boolean;
  /**
   * Email-verification gate for `user` / `manager` modes:
   * - `"env"` (default for `manager`): reject unverified users with `EMAIL_NOT_VERIFIED` (403) when
   *   `REQUIRE_EMAIL_VERIFICATION=true`.
   * - `"never"` (default for `user`): auth routes keep working for unverified users.
   * - `"always"`: require a verified email regardless of the environment.
   */
  emailVerification?: EmailVerificationPolicy;
}

export type HandlerImpl<A extends AuthMode, P, Q, B> = (
  args: HandlerArgs<A, P, Q, B>,
) => Promise<Response | unknown>;

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export function createHandler<A extends AuthMode, P = undefined, Q = undefined, B = undefined>(
  options: HandlerOptions<A, P, Q, B>,
  impl: HandlerImpl<A, P, Q, B>,
): RouteHandler {
  if (options.permission && options.auth !== "manager") {
    throw new Error("createHandler: `permission` is only valid with auth: 'manager'");
  }
  const cookieAuthenticated = options.auth === "user" || options.auth === "manager";
  if (cookieAuthenticated && options.csrf === false) {
    throw new Error(
      "createHandler: CSRF protection cannot be disabled for cookie-authenticated (user/manager) routes",
    );
  }
  if ((options.auth === "mobile" || options.auth === "cron") && options.csrf) {
    throw new Error(
      `createHandler: \`csrf\` does not apply to bearer-authenticated auth: '${options.auth}' routes`,
    );
  }
  const rules: readonly RateLimitRule[] = options.rateLimit
    ? Array.isArray(options.rateLimit)
      ? (options.rateLimit as readonly RateLimitRule[])
      : [options.rateLimit as RateLimitRule]
    : [];

  return async function routeHandler(req: NextRequest, context: unknown): Promise<Response> {
    const requestId = getRequestId(req);
    const pathname = req.nextUrl?.pathname ?? new URL(req.url).pathname;
    let log = childLogger({ requestId, method: req.method, path: redactPathForLog(pathname) });

    try {
      // 1. Body (raw JSON) — needed before rate limiting for `ip+body:<field>` rules.
      const rawBody = await readJsonBody(
        req,
        options,
        options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      );

      // 2. Rate limits (before authentication so credential stuffing is throttled).
      const ip = getClientIp(req);
      for (const rule of rules) {
        await enforceRateLimit(rule, rateLimitIdentity(rule, ip, rawBody));
      }

      // 3. Authentication / tenancy (401 takes precedence over CSRF so expired sessions read as such).
      const ctx = (await authenticate(req, options)) as ContextFor<A>;

      // 4. CSRF / Origin (mutating methods; never for the bearer-authenticated mobile and cron modes).
      if (isMutatingMethod(req.method)) {
        if (cookieAuthenticated || (options.auth === "public" && options.csrf === true)) {
          assertCsrf(req);
        } else if (options.auth === "public" && !isOriginCheckExempt(pathname)) {
          // Defence in depth behind the middleware: a browser on another origin cannot drive public
          // cookie-setting endpoints (login CSRF, register, invite accept).
          assertAllowedOrigin(req);
        }
      }

      // 5. Permission.
      if (ctx && ctx.kind === "manager") {
        log = log.child({ organisationId: ctx.organisation.id });
        if (options.permission) requirePermission(ctx, options.permission);
      }

      // 6. Validation.
      // Only validated input reaches the implementation: no schema → `undefined`.
      const params = (
        options.params
          ? parseWith(options.params, await readRouteParams(context), "params")
          : undefined
      ) as P;
      const query = (
        options.query
          ? parseWith(options.query, searchParamsToObject(new URL(req.url).searchParams), "query")
          : undefined
      ) as Q;
      const body = (options.body ? parseWith(options.body, rawBody ?? {}, "body") : undefined) as B;

      // 7. Implementation.
      const result = await impl({ req, ctx, params, query, body, requestId, log });
      const response =
        result instanceof Response ? result : result === undefined ? noContent() : json(result);
      if (ctx && (ctx.kind === "user" || ctx.kind === "manager") && ctx.sessionSlid)
        refreshSessionCookies(req, response);
      return withRequestId(response, requestId);
    } catch (err) {
      return handleError(err, requestId, log);
    }
  };
}

// ── internals ────────────────────────────────────────────────────────────────

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_LIKE_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;
/** Route names are lowercase kebab-case; random tokens contain uppercase, digits or underscores. */
const HAS_TOKEN_CHARS = /[A-Z0-9_]/;

/**
 * Path for log lines with secret-looking segments (e.g. `/api/invites/manager/<token>`) replaced by
 * `:redacted`. UUID ids are kept: they are identifiers, not credentials.
 */
export function redactPathForLog(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      SECRET_LIKE_SEGMENT.test(segment) &&
      HAS_TOKEN_CHARS.test(segment) &&
      !UUID_SEGMENT.test(segment)
        ? ":redacted"
        : segment,
    )
    .join("/");
}

async function readRouteParams(context: unknown): Promise<RawParams> {
  if (!context || typeof context !== "object" || !("params" in context)) return {};
  const params: unknown = await (context as { params: unknown }).params;
  return params && typeof params === "object" ? (params as RawParams) : {};
}

/**
 * After a sliding-expiry extension, re-issue the session (and CSRF / organisation-selection) cookies
 * with a fresh Max-Age so the browser keeps them as long as the server-side session lives. Skipped when
 * the implementation already set the session cookie (sign-in / sign-out flows).
 */
function refreshSessionCookies(req: NextRequest, response: Response): void {
  try {
    if (response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))) return;
    const token = getCookie(req, SESSION_COOKIE);
    if (!token) return;
    const cookies = [sessionCookie(token)];
    const csrf = getCookie(req, CSRF_COOKIE);
    if (
      csrf &&
      isValidCsrfToken(csrf) &&
      !response.headers.getSetCookie().some((c) => c.startsWith(`${CSRF_COOKIE}=`))
    ) {
      cookies.push(csrfCookie(csrf));
    }
    const org = getCookie(req, ORG_COOKIE);
    if (org && !response.headers.getSetCookie().some((c) => c.startsWith(`${ORG_COOKIE}=`)))
      cookies.push(orgCookie(org));
    appendSetCookies(response, cookies);
  } catch {
    // immutable headers (e.g. Response.redirect): the next request slides again
  }
}

/** Echo the request id. Some responses (e.g. `Response.redirect`) have immutable headers. */
function withRequestId(response: Response, requestId: string): Response {
  try {
    response.headers.set(REQUEST_ID_HEADER, requestId);
  } catch {
    // immutable headers: leave as-is
  }
  return response;
}

function parseWith<T>(schema: ZodType<T>, input: unknown, source: "params" | "query" | "body"): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError("VALIDATION_ERROR", `Invalid ${source}`, {
    details: { source, ...z.flattenError(result.error) },
  });
}

function rateLimitIdentity(rule: RateLimitRule, ip: string | null, rawBody: unknown): string {
  const by = rule.by ?? "ip";
  if (by === "ip") return ip ?? "unknown";
  const field = by.slice("ip+body:".length);
  const value =
    rawBody && typeof rawBody === "object" && field in rawBody
      ? (rawBody as Record<string, unknown>)[field]
      : undefined;
  const normalised = typeof value === "string" ? value.trim().toLowerCase().slice(0, 200) : "";
  return `${ip ?? "unknown"}|${normalised}`;
}

async function readJsonBody<A extends AuthMode, P, Q, B>(
  req: NextRequest,
  options: HandlerOptions<A, P, Q, B>,
  maxBytes: number,
): Promise<unknown> {
  if (!isMutatingMethod(req.method)) return undefined;
  const needsBody = options.body !== undefined || ruleNeedsBody(options.rateLimit);
  if (!needsBody) return undefined;

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", `Body exceeds ${maxBytes} bytes`);
  }

  const contentType = req.headers.get("content-type") ?? "";
  const text = await readTextWithLimit(req, maxBytes);
  if (text.trim() === "") return {};
  if (!/^application\/json\b/i.test(contentType)) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Expected application/json");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION_ERROR", "Body is not valid JSON");
  }
}

function ruleNeedsBody(rateLimit: RateLimitRule | readonly RateLimitRule[] | undefined): boolean {
  if (!rateLimit) return false;
  const list = Array.isArray(rateLimit)
    ? (rateLimit as readonly RateLimitRule[])
    : [rateLimit as RateLimitRule];
  return list.some((r) => r.by?.startsWith("ip+body:"));
}

async function readTextWithLimit(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError("PAYLOAD_TOO_LARGE", `Body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function authenticate<A extends AuthMode, P, Q, B>(
  req: NextRequest,
  options: HandlerOptions<A, P, Q, B>,
): Promise<UserContext | ManagerContext | DeviceContext | CronContext | null> {
  switch (options.auth) {
    case "public":
      return null;
    case "user": {
      const userCtx = await getCurrentUserContext(req);
      assertEmailVerification(userCtx, options.emailVerification ?? "never");
      return userCtx;
    }
    case "manager": {
      const userCtx = await getCurrentUserContext(req);
      return elevateToManagerContext(userCtx, getCookie(req, ORG_COOKIE), {
        requireVerifiedEmail: verificationRequired(options.emailVerification ?? "env"),
      });
    }
    case "mobile":
      return getCurrentDeviceContext(req);
    case "cron":
      return authenticateCron(req);
    default: {
      const exhaustive: never = options.auth;
      throw new Error(`Unknown auth mode ${String(exhaustive)}`);
    }
  }
}

function verificationRequired(policy: EmailVerificationPolicy): boolean {
  switch (policy) {
    case "env":
      return env().REQUIRE_EMAIL_VERIFICATION;
    case "always":
      return true;
    case "never":
      return false;
    default: {
      const exhaustive: never = policy;
      throw new Error(`Unknown email verification policy ${String(exhaustive)}`);
    }
  }
}

function assertEmailVerification(ctx: UserContext, policy: EmailVerificationPolicy): void {
  if (verificationRequired(policy) && !ctx.user.emailVerifiedAt) {
    throw new AppError("EMAIL_NOT_VERIFIED", "Verify your email address to continue");
  }
}

function authenticateCron(req: NextRequest): CronContext {
  const presented = getBearerToken(req) ?? req.headers.get("x-cron-secret");
  if (!presented || !constantTimeEqual(presented, env().CRON_SECRET)) {
    throw new AppError("UNAUTHENTICATED", "Invalid scheduler secret");
  }
  return { kind: "cron", ...getRequestMeta(req) };
}

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

/**
 * Normalise AppErrors that crossed a module boundary (duck-typed by `isAppError`, e.g. a second copy
 * of @clockoff/shared). Only a known code with a 4xx/5xx status is trusted; anything else that merely
 * calls itself "AppError" is treated as an unknown failure (500, nothing leaked).
 */
function asAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (!isAppError(err)) return null;
  const e = err as { code?: unknown; message?: unknown; status?: unknown; details?: unknown };
  if (typeof e.code !== "string" || !KNOWN_ERROR_CODES.has(e.code)) return null;
  const status =
    typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599
      ? e.status
      : undefined;
  return new AppError(
    e.code as ApiErrorCode,
    typeof e.message === "string" ? e.message : undefined,
    {
      ...(status !== undefined ? { status } : {}),
      details: e.details,
    },
  );
}

function handleError(err: unknown, requestId: string, log: Logger): Response {
  const appErr = asAppError(err);
  if (appErr) {
    if (appErr.status >= 500)
      log.error({ error: errorSummary(appErr), code: appErr.code }, "request failed");
    else log.debug({ code: appErr.code, status: appErr.status }, "request rejected");
    return errorResponse(appErr, requestId);
  }
  if (err instanceof z.ZodError) {
    return errorResponse(
      new AppError("VALIDATION_ERROR", "Invalid request", { details: z.flattenError(err) }),
      requestId,
    );
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002")
      return errorResponse(new AppError("CONFLICT", "Resource already exists"), requestId);
    if (err.code === "P2025")
      return errorResponse(new AppError("NOT_FOUND", "Resource not found"), requestId);
  }
  // Unknown failure: log server-side with the request id, leak nothing to the client.
  // `stackFrames` (not `err.stack`): the stack's first line repeats the message, which can carry data.
  log.error({ error: errorSummary(err), stack: stackFrames(err) }, "unhandled error");
  return errorResponse(
    new AppError("INTERNAL_ERROR", "Something went wrong", { details: { requestId } }),
    requestId,
  );
}

/** Header names clients must use (re-exported for API docs / the client library). */
export const API_HEADERS = { requestId: REQUEST_ID_HEADER, csrf: CSRF_HEADER } as const;

export { json, noContent, errorResponse, sseResponse } from "./responses";
export type { ResponseInitExtras } from "./responses";
