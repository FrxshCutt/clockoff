/**
 * Structured API error codes. Every API response that is not 2xx has the shape
 * `{ error: { code, message, details? } }` (§2). Codes are stable identifiers the web app maps to
 * human copy (apps/web/src/lib/errorMessages.ts) and the iOS app switches on.
 */
export const API_ERROR_CODES = [
  // generic
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "COMING_SOON",
  "INTERNAL_ERROR",
  "CSRF_FAILED",
  // auth
  "INVALID_CREDENTIALS",
  "EMAIL_ALREADY_REGISTERED",
  "EMAIL_NOT_VERIFIED",
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "TOKEN_REUSED",
  "WEAK_PASSWORD",
  "INVITE_INVALID",
  "INVITE_EXPIRED",
  "LAST_OWNER",
  // organisation / employees
  "NO_ORGANISATION",
  "ORGANISATION_SLUG_TAKEN",
  "EMPLOYEE_NOT_FOUND",
  "EMPLOYEE_INACTIVE",
  "EMPLOYEE_ALREADY_LINKED",
  "EMPLOYEE_NOT_LINKED",
  // mobile join
  "INVALID_COMPANY_CODE",
  "AMBIGUOUS_MATCH",
  "INVALID_INVITE_CODE",
  "DEVICE_INACTIVE",
  // policies
  "POLICY_ASSIGNED",
  "POLICY_NOT_PUBLISHED",
  "POLICY_ARCHIVED",
  // shifts
  "SHIFT_TOO_SHORT",
  "SHIFT_OVERLAP",
  "SHIFT_IN_PAST",
  "INVALID_RECURRENCE",
  "INVALID_TIMEZONE",
  // breaks
  "BREAKS_DISABLED",
  "BREAK_LIMIT_REACHED",
  "BREAK_TOO_SOON",
  "BREAK_TOO_LONG",
  "BREAK_ALREADY_ACTIVE",
  "BREAK_NOT_ACTIVE",
  "NOT_ON_SHIFT",
  "EMPLOYEE_BREAKS_NOT_ALLOWED",
  // imports
  "IMPORT_INVALID_STATE",
  "IMPORT_MAPPING_INCOMPLETE",
  "IMPORT_HAS_ERRORS",
  "INVALID_CSV",
  // overrides
  "OVERRIDE_TOO_LONG",
  "OVERRIDE_EXPIRED",
  // devices / sync
  "CLOCK_SKEW",
  "UNKNOWN_EVENT_TYPE",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

/** Default HTTP status for each error code. Handlers may override per call. */
export const ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  COMING_SOON: 501,
  INTERNAL_ERROR: 500,
  CSRF_FAILED: 403,
  INVALID_CREDENTIALS: 401,
  EMAIL_ALREADY_REGISTERED: 409,
  EMAIL_NOT_VERIFIED: 403,
  INVALID_TOKEN: 400,
  TOKEN_EXPIRED: 400,
  TOKEN_REUSED: 401,
  WEAK_PASSWORD: 400,
  INVITE_INVALID: 400,
  INVITE_EXPIRED: 400,
  LAST_OWNER: 409,
  NO_ORGANISATION: 403,
  ORGANISATION_SLUG_TAKEN: 409,
  EMPLOYEE_NOT_FOUND: 404,
  EMPLOYEE_INACTIVE: 409,
  EMPLOYEE_ALREADY_LINKED: 409,
  EMPLOYEE_NOT_LINKED: 409,
  INVALID_COMPANY_CODE: 404,
  AMBIGUOUS_MATCH: 409,
  INVALID_INVITE_CODE: 400,
  DEVICE_INACTIVE: 401,
  POLICY_ASSIGNED: 409,
  POLICY_NOT_PUBLISHED: 409,
  POLICY_ARCHIVED: 409,
  SHIFT_TOO_SHORT: 400,
  SHIFT_OVERLAP: 409,
  SHIFT_IN_PAST: 400,
  INVALID_RECURRENCE: 400,
  INVALID_TIMEZONE: 400,
  BREAKS_DISABLED: 409,
  BREAK_LIMIT_REACHED: 409,
  BREAK_TOO_SOON: 409,
  BREAK_TOO_LONG: 400,
  BREAK_ALREADY_ACTIVE: 409,
  BREAK_NOT_ACTIVE: 409,
  NOT_ON_SHIFT: 409,
  EMPLOYEE_BREAKS_NOT_ALLOWED: 409,
  IMPORT_INVALID_STATE: 409,
  IMPORT_MAPPING_INCOMPLETE: 400,
  IMPORT_HAS_ERRORS: 409,
  INVALID_CSV: 400,
  OVERRIDE_TOO_LONG: 400,
  OVERRIDE_EXPIRED: 409,
  CLOCK_SKEW: 400,
  UNKNOWN_EVENT_TYPE: 400,
};

/**
 * Thrown by services; converted to the HTTP envelope by the API handler wrapper. Framework-free so it
 * can be used from @clockoff/shared pure functions (e.g. break rules) as well.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: ApiErrorCode,
    message?: string,
    options?: { status?: number; details?: unknown },
  ) {
    super(message ?? code);
    this.name = "AppError";
    this.code = code;
    this.status = options?.status ?? ERROR_HTTP_STATUS[code];
    this.details = options?.details;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export function isAppError(err: unknown): err is AppError {
  return (
    err instanceof AppError ||
    (typeof err === "object" && err !== null && (err as AppError).name === "AppError")
  );
}
