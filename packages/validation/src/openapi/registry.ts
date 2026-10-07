import { z } from "zod";
import type { ApiErrorCode } from "@clockoff/shared/errors";
import type { Permission } from "@clockoff/shared/permissions";

/**
 * In-house route registry for the OpenAPI document (D-008). `openapi/routes.ts` calls `defineRoute` once
 * per endpoint; `openapi/generate.ts` turns the registry into `docs/openapi.json`.
 *
 * Paths are written Express-style (`/api/employees/:id`) and always start with `/api`. Every `:param` in
 * the path must be a key of `request.params` (and vice versa) — `defineRoute` throws otherwise, so a typo
 * fails the test suite instead of producing a silently wrong contract.
 */

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Mirrors the `auth` option of `createHandler` in apps/web (`cron` routes are internal and not documented):
 * - `manager` — cookie session (`wm_session`) scoped to the current organisation; mutating requests also
 *   need the `x-csrf-token` header (double-submit of the `wm_csrf` cookie).
 * - `user`    — cookie session without an organisation (auth routes, creating / listing organisations);
 *   same CSRF rule as `manager`.
 * - `mobile`  — `Authorization: Bearer <access JWT>` issued by `/api/mobile/v1/join/confirm`.
 * - `public`  — no authentication (rate limited where abuse is possible).
 */
export const ROUTE_AUTH_MODES = ["manager", "user", "mobile", "public"] as const;
export type RouteAuth = (typeof ROUTE_AUTH_MODES)[number];

const MUTATING_METHODS: ReadonlySet<HttpMethod> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: HttpMethod): boolean {
  return MUTATING_METHODS.has(method);
}

/** A response with a non-JSON body (CSV download, SSE stream) or an explicit description. */
export interface RouteResponseContent {
  contentType: string;
  /** Schema of the body (for `text/event-stream`, the schema of each event's `data:` JSON). */
  schema?: z.ZodType;
  description?: string;
}

/** A domain error the handler raises with a non-default HTTP status (`new AppError(code, msg, { status })`). */
export interface RouteErrorWithStatus {
  code: ApiErrorCode;
  status: number;
}

/** `null` = no body (204). A bare schema = `application/json`. */
export type RouteResponse = z.ZodType | RouteResponseContent | null;

export type RequestBodyContentType = "application/json" | "multipart/form-data";

export interface RouteRequest {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Defaults to `application/json`. */
  bodyContentType?: RequestBodyContentType;
  /** False when the body may be omitted entirely (action endpoints with only optional fields). */
  bodyRequired?: boolean;
}

export interface RouteDefinition {
  method: HttpMethod;
  /** Express-style, e.g. `/api/employees/:id/invites`. */
  path: string;
  summary: string;
  description?: string;
  tags: readonly string[];
  auth: RouteAuth;
  /** Permission the handler requires (manager routes only). */
  permission?: Permission;
  /** Overrides the derived operationId (`<method><PathInPascalCase>`). */
  operationId?: string;
  request?: RouteRequest;
  /** Keyed by HTTP status. At least one 2xx entry is required. */
  responses: Readonly<Record<number, RouteResponse>>;
  /**
   * Domain error codes this route can return, in addition to the standard ones the generator adds. A code
   * is documented under its `ERROR_HTTP_STATUS` unless given as `{ code, status }`.
   */
  errors?: readonly (ApiErrorCode | RouteErrorWithStatus)[];
  /** Name of the rate-limit preset applied by the handler (documentation only). */
  rateLimit?: string;
  /**
   * Overrides the CSRF default, exactly like `createHandler`'s `csrf` option: mutating `manager` / `user`
   * routes require the `x-csrf-token` header unless this is `false`; a `public` route can opt in with `true`
   * (e.g. logout, so a third-party page cannot sign the manager out).
   */
  csrf?: boolean;
  deprecated?: boolean;
}

/** Whether the handler enforces the CSRF double-submit check for this route (same rule as `createHandler`). */
export function csrfRequired(route: Pick<RouteDefinition, "auth" | "method" | "csrf">): boolean {
  if (route.csrf !== undefined) return route.csrf;
  return (route.auth === "manager" || route.auth === "user") && isMutatingMethod(route.method);
}

const PATH_PARAM = /:([A-Za-z][A-Za-z0-9_]*)/g;

/** `:id` names in an Express-style path, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(PATH_PARAM)].map((m) => m[1] as string);
}

/** `/api/employees/:id` → `/api/employees/{id}` */
export function toOpenApiPath(path: string): string {
  return path.replace(PATH_PARAM, (_match, name: string) => `{${name}}`);
}

/** `GET /api/employees/:id/invites` → `getEmployeesByIdInvites`. */
export function deriveOperationId(method: HttpMethod, path: string): string {
  const segments = path
    .replace(/^\/api\/?/, "")
    .split("/")
    .filter((s) => s.length > 0)
    .map((segment) => {
      const param = /^:(.+)$/.exec(segment);
      const words = (param ? `by-${param[1]}` : segment)
        .split(/[^A-Za-z0-9]+/)
        .filter((w) => w.length > 0);
      return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
    });
  return method.toLowerCase() + segments.join("");
}

export function routeKey(route: Pick<RouteDefinition, "method" | "path">): string {
  return `${route.method} ${route.path}`;
}

function objectShapeKeys(schema: z.ZodType): string[] | null {
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : null;
}

/** Throws when the definition is internally inconsistent. Exported for tests. */
export function assertValidRoute(route: RouteDefinition): void {
  const where = routeKey(route);
  if (!route.path.startsWith("/api/")) throw new Error(`${where}: path must start with /api/`);
  if (route.path.length > 1 && route.path.endsWith("/"))
    throw new Error(`${where}: trailing slash`);
  if (route.summary.trim().length === 0) throw new Error(`${where}: summary is required`);
  if (route.tags.length === 0) throw new Error(`${where}: at least one tag is required`);
  if (route.permission !== undefined && route.auth !== "manager") {
    throw new Error(`${where}: permission is only valid for manager routes`);
  }
  const isMobilePath = route.path.startsWith("/api/mobile/");
  if (isMobilePath && (route.auth === "manager" || route.auth === "user"))
    throw new Error(`${where}: mobile paths cannot use ${route.auth} auth`);
  if (!isMobilePath && route.auth === "mobile")
    throw new Error(`${where}: mobile auth requires a /api/mobile/ path`);
  if (isMobilePath && route.csrf === true)
    throw new Error(`${where}: the mobile API is not cookie-authenticated and never uses CSRF`);
  if (route.csrf === true && !isMutatingMethod(route.method))
    throw new Error(`${where}: CSRF only applies to mutating methods`);

  const names = pathParamNames(route.path);
  const params = route.request?.params;
  if (names.length > 0 || params !== undefined) {
    if (params === undefined)
      throw new Error(`${where}: path has params ${names.join(", ")} but no params schema`);
    const keys = objectShapeKeys(params);
    if (keys === null) throw new Error(`${where}: params schema must be a z.object`);
    const missing = names.filter((n) => !keys.includes(n));
    const extra = keys.filter((k) => !names.includes(k));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `${where}: params schema keys [${keys.join(", ")}] do not match path params [${names.join(", ")}]`,
      );
    }
  }
  if (route.request?.query !== undefined && objectShapeKeys(route.request.query) === null) {
    throw new Error(`${where}: query schema must be a z.object`);
  }
  if (route.request?.body !== undefined && (route.method === "GET" || route.method === "DELETE")) {
    throw new Error(`${where}: ${route.method} routes cannot declare a body`);
  }
  const statuses = Object.keys(route.responses).map(Number);
  if (statuses.length === 0 || !statuses.some((s) => s >= 200 && s < 300)) {
    throw new Error(`${where}: at least one 2xx response is required`);
  }
  for (const status of statuses) {
    if (!Number.isInteger(status) || status < 100 || status > 599)
      throw new Error(`${where}: invalid status ${status}`);
  }
  for (const error of route.errors ?? []) {
    if (typeof error === "string") continue;
    if (!Number.isInteger(error.status) || error.status < 400 || error.status > 599)
      throw new Error(`${where}: error ${error.code} needs a 4xx/5xx status, got ${error.status}`);
  }
}

/** Every route registered so far, in registration order. */
export const registry: RouteDefinition[] = [];

const registeredKeys = new Set<string>();
const registeredOperationIds = new Set<string>();

/** Validates and registers a route. Returns the definition for convenience. */
export function defineRoute<const R extends RouteDefinition>(route: R): R {
  assertValidRoute(route);
  const key = routeKey(route);
  if (registeredKeys.has(key)) throw new Error(`${key}: registered twice`);
  const operationId = route.operationId ?? deriveOperationId(route.method, route.path);
  if (registeredOperationIds.has(operationId))
    throw new Error(`${key}: duplicate operationId ${operationId}`);
  registeredKeys.add(key);
  registeredOperationIds.add(operationId);
  registry.push(route);
  return route;
}

export function operationIdOf(route: RouteDefinition): string {
  return route.operationId ?? deriveOperationId(route.method, route.path);
}
