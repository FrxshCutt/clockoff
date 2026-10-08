/**
 * Planday Open API constants (docs/integrations/PLANDAY_API_NOTES.md, docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md
 * §4). Every URL, path, scope, limit and threshold the client uses lives here; nothing else spells them.
 */

// ---------------------------------------------------------------------------------------------------------
// Hosts and paths (notes §2, §3, §9). The base URLs never change; mock mode rewrites hosts in the transport.
// ---------------------------------------------------------------------------------------------------------

export const PLANDAY_API_BASE_URL = "https://openapi.planday.com";
export const PLANDAY_ID_BASE_URL = "https://id.planday.com";
export const PLANDAY_AUTHORIZE_URL = `${PLANDAY_ID_BASE_URL}/connect/authorize`;
export const PLANDAY_TOKEN_PATH = "/connect/token";
export const PLANDAY_REVOCATION_PATH = "/connect/revocation";

/** API paths exactly as the specs spell them (`v1.0`, spec casing; never the getting-started `v1/Departments`). */
export const PLANDAY_PATHS = {
  portalInfo: "/portal/v1.0/info",
  departments: "/hr/v1.0/departments",
  employeeGroups: "/hr/v1.0/employeegroups",
  employees: "/hr/v1.0/employees",
  deactivatedEmployees: "/hr/v1.0/employees/deactivated",
  employeeById: (employeeId: string) => `/hr/v1.0/employees/${encodeId(employeeId)}`,
  shifts: "/scheduling/v1.0/shifts",
  shiftById: (shiftId: string) => `/scheduling/v1.0/shifts/${encodeId(shiftId)}`,
  deletedShifts: "/scheduling/v1.0/shifts/deleted",
  scheduleDay: "/scheduling/v1.0/scheduleDay",
  punchClockShifts: "/punchclock/v1.0/punchclockshifts",
  punchClockBreaks: (punchClockShiftId: string) =>
    `/punchclock/v1.0/punchclockshifts/${encodeId(punchClockShiftId)}/breaks`,
} as const;

/** Path segments are Planday int64 ids as decimal strings; anything else is a programming error. */
function encodeId(id: string): string {
  if (!/^[0-9]{1,16}$/.test(id)) throw new TypeError("Planday ids are decimal strings");
  return id;
}

// ---------------------------------------------------------------------------------------------------------
// Scopes (notes §5.2). Read scopes only; never Pay, Payroll, Contract rules, Absence, Revenue or Data center.
// ---------------------------------------------------------------------------------------------------------

/** The scopes the sync needs in every activation mode. */
export const REQUIRED_SCOPES = [
  "department:read",
  "employeegroup:read",
  "employee:read",
  "shift:read",
] as const;
/** Needed only when clock-in mode is enabled (`PLANDAY_CLOCK_MODE_ENABLED`). */
export const CLOCK_MODE_SCOPES = ["punchclockshift:read"] as const;
export type PlandayScope = (typeof REQUIRED_SCOPES)[number] | (typeof CLOCK_MODE_SCOPES)[number];

/**
 * The authorize request's `scope` (method A): every scope of ClockOff's production app plus `openid
 * offline_access` (notes §5.2: "Derived authorize scope value for method A").
 */
export const PLANDAY_OAUTH_SCOPES = [
  "openid",
  "offline_access",
  ...REQUIRED_SCOPES,
  ...CLOCK_MODE_SCOPES,
] as const;

/** The scopes a connection must hold for the given activation options. */
export function requiredScopes(options: { clockMode: boolean }): readonly PlandayScope[] {
  return options.clockMode ? [...REQUIRED_SCOPES, ...CLOCK_MODE_SCOPES] : [...REQUIRED_SCOPES];
}

/**
 * Required scopes missing from an OAuth `scope` string (space-separated, notes §3.2 A). Returns `null` when no
 * scope string was returned: the connect proof's probes then decide (5.6).
 */
export function missingScopes(
  granted: string | null | undefined,
  required: readonly string[],
): string[] | null {
  if (granted === null || granted === undefined) return null;
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return required.filter((scope) => !have.has(scope));
}

/**
 * The scope behind each API path, for naming a 403 (notes §8: a 403 means the app lacks the scope). The portal
 * endpoint's scope is undocumented (notes §12 Q11), so it is named "portal info".
 */
export function scopeForPath(path: string): string {
  if (path.startsWith("/portal/")) return "portal info";
  if (path.startsWith("/hr/v1.0/departments")) return "department:read";
  if (path.startsWith("/hr/v1.0/employeegroups")) return "employeegroup:read";
  if (path.startsWith("/hr/")) return "employee:read";
  if (path.startsWith("/scheduling/")) return "shift:read";
  if (path.startsWith("/punchclock/")) return "punchclockshift:read";
  return "unknown";
}

// ---------------------------------------------------------------------------------------------------------
// Headers and query parameters (notes §4, §9.2)
// ---------------------------------------------------------------------------------------------------------

export const PLANDAY_USER_AGENT = "ClockOff/1.0 (+https://clockoff.online)";

/**
 * Query parameters ClockOff never sends: `special` opts SSN, bank account and birth date in; `searchQuery`
 * matches personal fields; `includeSecurityGroups` and `managedEmployeesOnly` are unused; the array filters'
 * serialisation is undocumented (filtering is client-side). The HTTP layer refuses a request carrying any of them.
 */
export const FORBIDDEN_QUERY_PARAMS = [
  "special",
  "searchQuery",
  "includeSecurityGroups",
  "managedEmployeesOnly",
  "departmentId[]",
  "employeeId[]",
  "shiftStatus",
] as const;

// ---------------------------------------------------------------------------------------------------------
// Pagination (notes §7, plan §4.4). Always an explicit limit.
// ---------------------------------------------------------------------------------------------------------

export const PAGE_LIMITS = {
  /** `/hr/v1.0/*` lists: documented default and maximum 50. */
  hr: 50,
  /** `/scheduling/v1.0/scheduleDay`: documented maximum 50. */
  scheduleDay: 50,
  /** `/scheduling/v1.0/shifts` (max 5000) and `/shifts/deleted` (max 1000): 100 keeps a step ≤ 100 records. */
  shifts: 100,
  deletedShifts: 100,
  /** `/punchclock/v1.0/punchclockshifts`: default 0 and maximum undocumented, so always 50. */
  punchClock: 50,
} as const;

/** Safety stop for one pagination loop: no Planday list ClockOff reads has anywhere near this many pages. */
export const MAX_PAGES_PER_LIST = 10_000;

// ---------------------------------------------------------------------------------------------------------
// Timeouts, tokens and retries (plan §4.1, §4.3, §4.5)
// ---------------------------------------------------------------------------------------------------------

export const API_REQUEST_TIMEOUT_MS = 10_000;
export const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
export const REVOCATION_TIMEOUT_MS = 5_000;
/** Under the connect proof's deadline a request starts only while its timeout would be at least this long. */
export const CONNECT_MIN_REQUEST_MS = 3_000;
/** Refresh the access token when it expires within this margin. */
export const REFRESH_MARGIN_MS = 300_000;
/** `expires_in` when the token response omits it (notes §3.3: the documented lifetime is one hour). */
export const DEFAULT_ACCESS_TOKEN_LIFETIME_S = 3_600;

/** Attempts per request for 5xx, 409 on GET, network errors and timeouts. */
export const REQUEST_MAX_ATTEMPTS = 3;
export const REQUEST_BACKOFF = { baseMs: 500, capMs: 8_000 } as const;

/** 429: waits up to this long are slept inside the slice; longer ones park the run. */
export const MAX_INLINE_WAIT_MS = 30_000;
/** 429: at most this many inline waits per request, then the run is parked. */
export const MAX_INLINE_RATE_LIMIT_WAITS = 3;
/** 429 without `x-ratelimit-reset` or `Retry-After`: the longest documented window. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
/**
 * The longest wait a rate-limit header may ask for: twice the longest documented window (notes §6). A larger
 * `x-ratelimit-reset` or `Retry-After` (an epoch timestamp, a far-future date) is treated as absent, so one bogus
 * header can never hold the shared client-id key, or park a run, for longer than this.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 120_000;
/** 0–1 s of jitter added to every 429 wait. */
export const RATE_LIMIT_JITTER_MS = 1_000;
/** Header feedback: when `x-ratelimit-remaining` drops to this, wait `x-ratelimit-reset` before the next request. */
export const RATE_LIMIT_REMAINING_THRESHOLD = 2;

/** Client-side budgets (notes §6, D-046): the lower documented figures, below Planday's limits. */
export const PORTAL_BUDGET = { perSecond: 10, perMinute: 600 } as const;
export const CLIENT_ID_BUDGET = { perSecond: 50, perMinute: 1_500 } as const;

/** Planday requests one run may make before it ends PARTIAL with REQUEST_BUDGET_EXHAUSTED (§4.5). */
export const RUN_REQUEST_BUDGET = 2_000;

// ---------------------------------------------------------------------------------------------------------
// Shifts (notes §10, plan §4.8, §6.6)
// ---------------------------------------------------------------------------------------------------------

/** Every documented non-draft `ShiftStatusExtended` value: imported when the shift has an employee. */
export const KNOWN_PUBLISHED_STATUSES = [
  "Open",
  "Assigned",
  "Approved",
  "ForSale",
  "OnDuty",
  "PendingSwapAcceptance",
  "PendingApproval",
  "PunchclockStarted",
  "PunchclockFinished",
  "PunchclockApproved",
] as const;
/** Never imported (notes §10.1 rule 1). */
export const EXCLUDED_STATUSES = ["Draft"] as const;

/** Shorter shifts are skipped with INVALID_TIME (the existing integration rule). */
export const MIN_SHIFT_DURATION_MS = 15 * 60_000;
/** 24 h of wall clock plus one DST hour (notes §10.3 rule 4, D-049). */
export const MAX_SHIFT_DURATION_MS = 25 * 3_600_000;
/** Slice length when Planday answers 400 for the whole `/shifts` range (§6.6, Q37). */
export const SHIFT_RANGE_SLICE_DAYS = 14;

// ---------------------------------------------------------------------------------------------------------
// Portal-qualified external ids (plan §2.6, D-050). Nothing else formats these strings.
// ---------------------------------------------------------------------------------------------------------

/** `Employee.externalEmployeeId` written by the sync: `PLANDAY:<portalId>:<employeeId>`. */
export function plandayEmployeeExternalId(portalId: string, employeeId: string): string {
  return `PLANDAY:${portalId}:${employeeId}`;
}

/** `Shift.externalShiftId` written by the sync: `PLANDAY:<portalId>:<shiftId>`. */
export function plandayShiftExternalId(portalId: string, shiftId: string): string {
  return `PLANDAY:${portalId}:${shiftId}`;
}

export type PlandayClockEventSuffix = "in" | "out" | "start" | "end";

/**
 * `ClockEvent.externalId` (source `PLANDAY`): `<portalId>:<punchClockShiftId>:in|out` for punches and
 * `<portalId>:<breakId>:start|end` for breaks.
 */
export function plandayClockEventExternalId(
  portalId: string,
  id: string,
  suffix: PlandayClockEventSuffix,
): string {
  return `${portalId}:${id}:${suffix}`;
}
