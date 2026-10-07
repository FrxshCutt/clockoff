import type { ApiErrorCode } from "@clockoff/shared/errors";
import { isApiClientError, type ApiClientErrorCode, type ClientErrorCode } from "@/lib/api-client";

/**
 * Human copy for every API error code (and the client-only codes). Shown in toasts, inline alerts and form
 * errors; never shows raw server messages or stack traces. `errorMessages.test.ts` asserts completeness.
 */
export const API_ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  // generic
  VALIDATION_ERROR: "Some of the details aren't valid. Check the highlighted fields and try again.",
  UNAUTHENTICATED: "Your session has ended. Sign in to continue.",
  FORBIDDEN: "You don't have permission to do that. Ask an owner or admin for access.",
  NOT_FOUND: "We couldn't find what you were looking for. It may have been moved or deleted.",
  CONFLICT: "This changed while you were working on it. Refresh and try again.",
  RATE_LIMITED: "Too many attempts. Please wait a moment and try again.",
  PAYLOAD_TOO_LARGE: "That file or request is too large.",
  UNSUPPORTED_MEDIA_TYPE: "That file type isn't supported.",
  COMING_SOON: "This feature isn't available yet.",
  INTERNAL_ERROR: "Something went wrong on our side. Please try again.",
  CSRF_FAILED: "Your session security check failed. Refresh the page and try again.",
  // auth
  INVALID_CREDENTIALS: "That email and password combination is incorrect.",
  EMAIL_ALREADY_REGISTERED: "An account with this email already exists. Sign in instead.",
  EMAIL_NOT_VERIFIED: "Verify your email address to continue. Check your inbox for the link.",
  INVALID_TOKEN: "This link is invalid. Request a new one and try again.",
  TOKEN_EXPIRED: "This link has expired. Request a new one and try again.",
  TOKEN_REUSED: "This link has already been used. Request a new one if you still need it.",
  WEAK_PASSWORD: "Choose a stronger password: at least 10 characters with a letter and a number.",
  INVITE_INVALID: "This invitation is invalid or has been revoked.",
  INVITE_EXPIRED: "This invitation has expired. Ask the person who invited you to send a new one.",
  LAST_OWNER: "Every organisation needs at least one owner. Make someone else an owner first.",
  // organisation / employees
  NO_ORGANISATION: "Create or join an organisation to continue.",
  ORGANISATION_SLUG_TAKEN:
    "That organisation name is already in use. Try a slightly different name.",
  EMPLOYEE_NOT_FOUND: "We couldn't find that employee. They may have been removed.",
  EMPLOYEE_INACTIVE: "This employee is deactivated. Reactivate them first.",
  EMPLOYEE_ALREADY_LINKED: "This employee is already connected to a device.",
  EMPLOYEE_NOT_LINKED: "This employee hasn't connected a device yet.",
  // mobile join
  INVALID_COMPANY_CODE: "That company code isn't valid.",
  AMBIGUOUS_MATCH:
    "More than one employee matches. Use the employee's personal invite code instead.",
  INVALID_INVITE_CODE: "That invite code isn't valid.",
  DEVICE_INACTIVE: "This device has been deactivated.",
  // policies
  POLICY_ASSIGNED: "This policy is still assigned. Remove its assignments before continuing.",
  POLICY_NOT_PUBLISHED: "Publish this policy before assigning it.",
  POLICY_ARCHIVED: "This policy is archived and can't be changed.",
  // shifts
  SHIFT_TOO_SHORT: "This shift is shorter than the minimum shift length.",
  SHIFT_OVERLAP: "This shift overlaps another shift for the same employee.",
  SHIFT_IN_PAST: "Shifts can't start in the past.",
  INVALID_RECURRENCE: "That repeat pattern isn't valid.",
  INVALID_TIMEZONE: "Choose a valid time zone.",
  // breaks
  BREAKS_DISABLED: "Breaks are turned off for this policy.",
  BREAK_LIMIT_REACHED: "The break limit for this shift has been reached.",
  BREAK_TOO_SOON: "It's too soon for another break.",
  BREAK_TOO_LONG: "That break is longer than the Break Rules allow.",
  BREAK_ALREADY_ACTIVE: "A break is already in progress.",
  BREAK_NOT_ACTIVE: "There's no break in progress.",
  NOT_ON_SHIFT: "This employee isn't on shift right now.",
  EMPLOYEE_BREAKS_NOT_ALLOWED: "Employees can't start breaks themselves under these Break Rules.",
  // imports
  IMPORT_INVALID_STATE: "This import can't do that at its current step. Refresh and try again.",
  IMPORT_MAPPING_INCOMPLETE: "Map every required column before continuing.",
  IMPORT_HAS_ERRORS: "Fix or skip the rows with errors before importing.",
  INVALID_CSV: "We couldn't read that CSV file. Check it's comma-separated with a header row.",
  // overrides
  OVERRIDE_TOO_LONG: "Overrides can't last that long. Choose a shorter duration.",
  OVERRIDE_EXPIRED: "This override has already expired.",
  // devices / sync
  CLOCK_SKEW:
    "The device clock is out of sync. Ask the employee to enable automatic date and time.",
  UNKNOWN_EVENT_TYPE: "The device sent an event this version doesn't recognise.",
};

export const CLIENT_ERROR_MESSAGES: Record<ClientErrorCode, string> = {
  NETWORK_ERROR: "We couldn't reach ClockOff. Check your connection and try again.",
  INVALID_RESPONSE: "We received an unexpected response. Please try again.",
};

export const ERROR_MESSAGES: Record<ApiClientErrorCode, string> = {
  ...API_ERROR_MESSAGES,
  ...CLIENT_ERROR_MESSAGES,
};

export const DEFAULT_ERROR_MESSAGE = "Something went wrong. Please try again.";

function retryAfterSeconds(details: unknown): number | null {
  if (typeof details !== "object" || details === null) return null;
  const value = (details as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Human message for any thrown value. Unknown errors get the generic fallback (never `error.message`). */
export function getErrorMessage(error: unknown, fallback: string = DEFAULT_ERROR_MESSAGE): string {
  if (!isApiClientError(error)) return fallback;
  if (error.code === "RATE_LIMITED") {
    const wait = retryAfterSeconds(error.details);
    if (wait) return `Too many attempts. Try again in ${describeWait(wait)}.`;
  }
  return ERROR_MESSAGES[error.code] ?? fallback;
}

/**
 * Field-level messages from a `VALIDATION_ERROR` whose details are `z.flattenError` output
 * (`{ fieldErrors: { name: ["…"] }, formErrors: [] }`). Returns the first message per field.
 */
export function getFieldErrors(error: unknown): Record<string, string> {
  if (!isApiClientError(error) || error.code !== "VALIDATION_ERROR") return {};
  const details = error.details;
  if (typeof details !== "object" || details === null) return {};
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (typeof fieldErrors !== "object" || fieldErrors === null) return {};
  const out: Record<string, string> = {};
  for (const [field, messages] of Object.entries(fieldErrors as Record<string, unknown>)) {
    if (Array.isArray(messages)) {
      const first = messages.find((m): m is string => typeof m === "string" && m.length > 0);
      if (first) out[field] = first;
    }
  }
  return out;
}
