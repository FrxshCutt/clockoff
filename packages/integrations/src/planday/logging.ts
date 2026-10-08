import type { ProviderLogger } from "@clockoff/shared/providers/workforceProvider";

/**
 * Planday logging (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.9). The web layer passes a pino child
 * logger; the package only ever logs these events, each with exactly the listed fields:
 *
 * | Event                      | Fields                                                                                    |
 * | -------------------------- | ----------------------------------------------------------------------------------------- |
 * | `planday.request`          | method, pathTemplate, status, durationMs, attempt, rateLimitRemaining, integrationId, runId |
 * | `planday.rate_limited`     | pathTemplate, waitMs, source (`retry-after` / `x-ratelimit-reset` / `default`)             |
 * | `planday.token.refreshed`  | integrationId, rotated, expiresInS                                                        |
 * | `planday.invalid_response` | pathTemplate, issues: [{ path, code }] (schema paths and codes, never values)             |
 * | `planday.error`            | code, status, pathTemplate                                                                |
 *
 * plus the §4.3 failure line (`planday.credentials.persist_failed`: integrationId, credentialVersion, rotated).
 * Never logged: bodies, headers, query strings, tokens, client ids, codes, state values, names, emails.
 */
export type PlandayLogger = ProviderLogger;

export const PLANDAY_LOG_EVENTS = {
  request: "planday.request",
  rateLimited: "planday.rate_limited",
  tokenRefreshed: "planday.token.refreshed",
  invalidResponse: "planday.invalid_response",
  error: "planday.error",
  persistFailed: "planday.credentials.persist_failed",
} as const;

/** Discards everything (the default when no logger is passed). */
export const noopPlandayLogger: PlandayLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * The path with every id segment replaced by `{id}` and no query string or host: `/hr/v1.0/employees/1001` →
 * `/hr/v1.0/employees/{id}`, `/punchclock/v1.0/punchclockshifts/7/breaks` →
 * `/punchclock/v1.0/punchclockshifts/{id}/breaks`. Accepts absolute URLs.
 */
export function pathTemplate(pathOrUrl: string): string {
  let path = pathOrUrl;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);
  if (scheme) path = path.slice(scheme[0].length) || "/";
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  return path
    .split("/")
    .map((segment) => (/^[0-9]+$/.test(segment) ? "{id}" : segment))
    .join("/");
}

/** A Zod issue as it may be logged: its path (keys and array indexes of the schema) and its code. */
export interface LoggableIssue {
  readonly path: string;
  readonly code: string;
}

interface IssueLike {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly code: string;
}

/**
 * Zod issues reduced to `{ path, code }`: no message (Zod messages may quote received values), no input. Paths are
 * built from the allow-list schema's own keys and array indexes, so they carry no Planday data. At most `max`.
 */
export function describeZodIssues(
  error: { readonly issues: ReadonlyArray<IssueLike> },
  max = 20,
): LoggableIssue[] {
  return error.issues.slice(0, max).map((issue) => ({
    path: issue.path.map((key) => (typeof key === "symbol" ? "?" : String(key))).join("."),
    code: issue.code,
  }));
}
