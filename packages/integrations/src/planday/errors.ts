import { ProviderError, type SyncErrorCode } from "@clockoff/shared/providers/workforceProvider";

/**
 * Typed Planday errors (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.6). Messages are fixed per code and
 * carry at most a path template, a status and scope names: never a token, client id, code, body, name or email,
 * so an error can be logged or stored (`lastErrorMessage`) as it is.
 */
export const PLANDAY_ERROR_CODES = [
  /** Token endpoint 400/401/403; API 401 after one forced refresh. Connection → AUTH_ERROR. */
  "PLANDAY_AUTH_FAILED",
  /** API 403, or the OAuth `scope` lacks a required scope; `missingScopes` names them. */
  "PLANDAY_SCOPE_MISSING",
  /** 429 after the inline waits, or a wait longer than MAX_INLINE_WAIT_MS; `retryAt` says when to resume. */
  "PLANDAY_RATE_LIMITED",
  /** 5xx, 409 on GET, network failure, timeout (after the request's retries); a too-short connect deadline. */
  "PLANDAY_UNAVAILABLE",
  /** 404 on a by-id read, 400 on `GET /hr/v1.0/employees/{id}`, or a by-id body with `data: null`. */
  "PLANDAY_NOT_FOUND",
  /** A 2xx body that fails validation, a non-JSON body, an unsafe integer id; also an unexpected 4xx. */
  "PLANDAY_INVALID_RESPONSE",
  /**
   * Internal (§4.3 failure path): refreshed credentials could not be persisted. The unpersisted access token was
   * never used. Retryable at run level; recorded as the run's errorCode.
   */
  "CREDENTIAL_PERSIST_FAILED",
] as const;
export type PlandayErrorCode = (typeof PLANDAY_ERROR_CODES)[number];

/** Machine-readable detail for some codes; never personal data. */
export type PlandayErrorReason =
  /** INVALID_RESPONSE: a shift's `date` disagrees with the local date of its parsed start (§4.8). */
  | "TIME_ENCODING_MISMATCH"
  /**
   * INVALID_RESPONSE: Planday answered a 4xx that no rule maps (e.g. a 400 for a `/shifts` range, Q37, or a 404 on
   * a list path such as `scheduleDay`, Q35); `status` says which.
   */
  | "BAD_REQUEST"
  /** INVALID_RESPONSE: the body was not JSON. */
  | "NOT_JSON"
  /** INVALID_RESPONSE: the body failed the response schema (unsafe integer ids included). */
  | "SCHEMA"
  /** INVALID_RESPONSE: a list kept returning pages past MAX_PAGES_PER_LIST. */
  | "PAGINATION_RUNAWAY"
  /** UNAVAILABLE: the connect deadline left too little time to start the request (§4.1). */
  | "DEADLINE"
  /** UNAVAILABLE: the request timed out. */
  | "TIMEOUT"
  /** UNAVAILABLE: the network request failed. */
  | "NETWORK"
  /** UNAVAILABLE: Planday answered 5xx (or 409 on a GET). */
  | "SERVER_ERROR";

const RETRYABLE: ReadonlySet<PlandayErrorCode> = new Set([
  "PLANDAY_RATE_LIMITED",
  "PLANDAY_UNAVAILABLE",
  "CREDENTIAL_PERSIST_FAILED",
]);

const MESSAGES: Readonly<Record<PlandayErrorCode, string>> = {
  PLANDAY_AUTH_FAILED: "Planday refused ClockOff's credentials",
  PLANDAY_SCOPE_MISSING: "The Planday app is missing a required scope",
  PLANDAY_RATE_LIMITED: "Planday's rate limit was reached",
  PLANDAY_UNAVAILABLE: "Planday could not be reached",
  PLANDAY_NOT_FOUND: "Planday has no such record",
  PLANDAY_INVALID_RESPONSE: "Planday sent a response ClockOff could not read",
  CREDENTIAL_PERSIST_FAILED: "Refreshed Planday credentials could not be saved",
};

export interface PlandayErrorOptions {
  readonly status?: number;
  readonly retryAt?: Date;
  readonly missingScopes?: readonly string[];
  /** The request path with ids replaced (`/hr/v1.0/employees/{id}`); never a query string. */
  readonly pathTemplate?: string;
  readonly reason?: PlandayErrorReason;
  readonly cause?: unknown;
}

export class PlandayError extends Error {
  readonly code: PlandayErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAt?: Date;
  readonly missingScopes?: readonly string[];
  readonly pathTemplate?: string;
  readonly reason?: PlandayErrorReason;

  constructor(code: PlandayErrorCode, options: PlandayErrorOptions = {}) {
    super(
      describe(code, options),
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "PlandayError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAt !== undefined) this.retryAt = options.retryAt;
    if (options.missingScopes !== undefined) this.missingScopes = [...options.missingScopes];
    if (options.pathTemplate !== undefined) this.pathTemplate = options.pathTemplate;
    if (options.reason !== undefined) this.reason = options.reason;
  }
}

/**
 * A 429 whose wait is longer than MAX_INLINE_WAIT_MS, or one more 429 after the inline waits: the run executor
 * parks the run until `retryAt` with its lease released (§7.6, §7.10).
 */
export class PlandayRateLimitedError extends PlandayError {
  declare readonly retryAt: Date;

  constructor(retryAt: Date, options: Omit<PlandayErrorOptions, "retryAt"> = {}) {
    super("PLANDAY_RATE_LIMITED", { ...options, retryAt });
    this.name = "PlandayRateLimitedError";
  }
}

/**
 * The client was given a hard request cap (`maxRequests`) and reached it. Not a Planday answer: the run executor
 * ends the run PARTIAL with warning REQUEST_BUDGET_EXHAUSTED (§4.5), exactly as when its own count reaches
 * RUN_REQUEST_BUDGET between steps.
 */
export class PlandayRequestBudgetExhaustedError extends Error {
  readonly maxRequests: number;

  constructor(maxRequests: number) {
    super(`The Planday request budget of ${maxRequests} requests is exhausted`);
    this.name = "PlandayRequestBudgetExhaustedError";
    this.maxRequests = maxRequests;
  }
}

function describe(code: PlandayErrorCode, options: PlandayErrorOptions): string {
  const parts = [MESSAGES[code]];
  if (options.missingScopes && options.missingScopes.length > 0) {
    parts.push(`(missing: ${options.missingScopes.join(", ")})`);
  }
  if (options.reason) parts.push(`[${options.reason}]`);
  if (options.pathTemplate) parts.push(`on ${options.pathTemplate}`);
  if (options.status !== undefined) parts.push(`(HTTP ${options.status})`);
  return parts.join(" ");
}

export function isPlandayError(err: unknown): err is PlandayError {
  return err instanceof PlandayError;
}

export function isPlandayRateLimitedError(err: unknown): err is PlandayRateLimitedError {
  return err instanceof PlandayRateLimitedError;
}

export function isPlandayNotFound(err: unknown): err is PlandayError {
  return err instanceof PlandayError && err.code === "PLANDAY_NOT_FOUND";
}

/** Auth-class failures that move the connection to AUTH_ERROR (§4.6, §7.6). */
export function isPlandayAuthError(err: unknown): err is PlandayError {
  return (
    err instanceof PlandayError &&
    (err.code === "PLANDAY_AUTH_FAILED" || err.code === "PLANDAY_SCOPE_MISSING")
  );
}

const PROVIDER_CODES: Readonly<Record<PlandayErrorCode, SyncErrorCode>> = {
  PLANDAY_AUTH_FAILED: "AUTH_EXPIRED",
  PLANDAY_SCOPE_MISSING: "AUTH_EXPIRED",
  PLANDAY_RATE_LIMITED: "RATE_LIMITED",
  PLANDAY_UNAVAILABLE: "PROVIDER_ERROR",
  // Record level by design (a by-id read): one that escapes to provider level is unexpected and deterministic,
  // so it fails the call without automatic retries, like an unreadable response.
  PLANDAY_NOT_FOUND: "INVALID_RESPONSE",
  PLANDAY_INVALID_RESPONSE: "INVALID_RESPONSE",
  CREDENTIAL_PERSIST_FAILED: "PROVIDER_ERROR",
};

/** The generic provider error for a Planday error (the classic WorkforceProvider surface, §4.6 table). */
export function toProviderError(err: PlandayError): ProviderError {
  return new ProviderError("PLANDAY", PROVIDER_CODES[err.code], err.message, { cause: err });
}
