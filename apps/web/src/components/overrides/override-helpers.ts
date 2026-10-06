import type {
  BreakRestrictionBehaviour,
  OverrideType,
  RestrictionCategory,
  Role,
} from "@workmode/shared/enums";
import type { StatusTone } from "@workmode/shared/status/statusMeta";
import {
  OVERRIDE_LIMITS,
  createOverrideSchema,
  overrideMaxDurationMinutes,
  resolveOverrideWindow,
  type CreateOverrideInput,
  type Override,
  type OverrideStatus,
} from "@workmode/validation/overrides";
import { formatDurationMinutes, toDate, type DateInput } from "@/lib/format";

/** Pure helpers for the override dialog and list (unit tested in node). */

export interface OverrideTypeMeta {
  readonly label: string;
  /** What it does to the employee's phone, in plain English. */
  readonly description: string;
  /** Typical use. */
  readonly example: string;
}

export const OVERRIDE_TYPE_META: Record<OverrideType, OverrideTypeMeta> = {
  EXEMPT_TEMPORARILY: {
    label: "Exempt temporarily",
    description:
      "Lifts every Work Mode restriction for this employee until the override expires, even during a shift.",
    example: "A family emergency, or the employee needs their phone for a task.",
  },
  END_WORK_MODE_EARLY: {
    label: "End Work Mode early",
    description:
      "Switches Work Mode off for the rest of the current shift. It comes back on at the next shift.",
    example: "The employee is leaving early or the shift finished ahead of the rota.",
  },
  TEMPORARY_EXCEPTION: {
    label: "Temporary exception",
    description:
      "Relaxes restrictions the way a break would (all of them, specific categories, or per a Break Rules preset) until it expires.",
    example: "Allow social media for a promotional post, or music while cleaning down.",
  },
  EMERGENCY_POLICY_OVERRIDE: {
    label: "Emergency override",
    description:
      "Lifts restrictions immediately for every connected phone in the organisation until it expires. Owners and admins only.",
    example: "A site incident where everyone needs full phone access.",
  },
};

/**
 * EMERGENCY_POLICY_OVERRIDE is always organisation-wide: `POST /api/overrides` rejects an `employeeId` on it
 * and requires `org:manage`. The dialog therefore never sends an employee for it, even when it was opened
 * from an employee's page.
 */
export function isOrganisationWideOverride(type: OverrideType): boolean {
  return type === "EMERGENCY_POLICY_OVERRIDE";
}

export const OVERRIDE_TYPE_ORDER: readonly OverrideType[] = [
  "EXEMPT_TEMPORARILY",
  "END_WORK_MODE_EARLY",
  "TEMPORARY_EXCEPTION",
  "EMERGENCY_POLICY_OVERRIDE",
];

export const OVERRIDE_STATUS_META: Record<
  OverrideStatus,
  { label: string; tone: StatusTone; description: string }
> = {
  SCHEDULED: { label: "Scheduled", tone: "info", description: "Starts in the future." },
  ACTIVE: { label: "Active", tone: "warning", description: "In force right now." },
  EXPIRED: { label: "Expired", tone: "neutral", description: "Ran its course." },
  REVOKED: { label: "Revoked", tone: "neutral", description: "Ended early by a manager." },
};

export const OVERRIDE_DURATION_PRESETS = [15, 30, 60, 120] as const;
export type OverrideDurationPreset = (typeof OVERRIDE_DURATION_PRESETS)[number];

export type OverrideExpiryChoice =
  | { readonly kind: "preset"; readonly minutes: number }
  | { readonly kind: "custom"; readonly until: string };

export type OverrideExpiryResult =
  | {
      readonly ok: true;
      readonly durationMinutes: number;
      readonly expiresAt: Date;
      /** The field(s) to send: a preset uses `durationMinutes`, a custom end uses `expiresAt`. */
      readonly body: { durationMinutes: number } | { expiresAt: string };
    }
  | { readonly ok: false; readonly message: string };

/** The cap for a role, in minutes (24 h for managers/admins; owners may go further). */
export function overrideMaxMinutes(role: Role | null): number {
  return role ? overrideMaxDurationMinutes(role) : OVERRIDE_LIMITS.maxDurationMinutes;
}

/**
 * Turns the dialog's expiry choice into an absolute window from `now`, applying the role cap. A custom
 * `until` is a `datetime-local` value (no offset) interpreted in the browser's zone, like the input shows it.
 */
export function computeOverrideExpiry(
  choice: OverrideExpiryChoice,
  now: DateInput,
  role: Role | null,
): OverrideExpiryResult {
  const reference = toDate(now);
  if (!reference) return { ok: false, message: "Invalid current time" };
  const maxMinutes = overrideMaxMinutes(role);
  const effectiveRole: Role = role ?? "MANAGER";

  if (choice.kind === "preset") {
    if (!Number.isInteger(choice.minutes) || choice.minutes < 1)
      return { ok: false, message: "Choose a duration" };
    if (choice.minutes > maxMinutes) {
      return {
        ok: false,
        message: `Overrides can last at most ${formatDurationMinutes(maxMinutes)}.`,
      };
    }
    const window = resolveOverrideWindow(
      { durationMinutes: choice.minutes },
      reference,
      effectiveRole,
    );
    if (!window.ok) return { ok: false, message: window.message };
    return {
      ok: true,
      durationMinutes: window.durationMinutes,
      expiresAt: window.expiresAt,
      body: { durationMinutes: choice.minutes },
    };
  }

  const until = toDate(choice.until);
  if (!choice.until || !until) return { ok: false, message: "Choose when the override should end" };
  if (until.getTime() <= reference.getTime())
    return { ok: false, message: "The end time must be in the future" };
  const window = resolveOverrideWindow(
    { expiresAt: until.toISOString() },
    reference,
    effectiveRole,
  );
  if (!window.ok) {
    return {
      ok: false,
      message:
        window.code === "OVERRIDE_TOO_LONG"
          ? `Overrides can last at most ${formatDurationMinutes(maxMinutes)}.`
          : window.message,
    };
  }
  return {
    ok: true,
    durationMinutes: window.durationMinutes,
    expiresAt: window.expiresAt,
    body: { expiresAt: until.toISOString() },
  };
}

export type OverrideBehaviourChoice =
  | { readonly kind: "RELAX_ALL" }
  | { readonly kind: "RELAX_CATEGORIES"; readonly categories: readonly RestrictionCategory[] }
  | { readonly kind: "BREAK_POLICY"; readonly breakPolicyId: string };

export interface OverrideDraft {
  readonly employeeId: string | null;
  readonly type: OverrideType;
  readonly reason: string;
  readonly expiry: OverrideExpiryChoice;
  /** Only read for TEMPORARY_EXCEPTION. */
  readonly behaviour: OverrideBehaviourChoice;
}

export type OverrideDraftResult =
  | { readonly ok: true; readonly input: CreateOverrideInput; readonly expiresAt: Date }
  | {
      readonly ok: false;
      readonly field: "reason" | "expiry" | "behaviour" | "employee";
      readonly message: string;
    };

/** Builds the `POST /api/overrides` body from the dialog state and validates it against the contract. */
export function buildCreateOverrideInput(
  draft: OverrideDraft,
  now: DateInput,
  role: Role | null,
): OverrideDraftResult {
  const reason = draft.reason.trim();
  if (reason.length < OVERRIDE_LIMITS.reasonMinLength) {
    return {
      ok: false,
      field: "reason",
      message: `Give a reason of at least ${OVERRIDE_LIMITS.reasonMinLength} characters.`,
    };
  }
  if (reason.length > OVERRIDE_LIMITS.reasonMaxLength) {
    return {
      ok: false,
      field: "reason",
      message: `Keep the reason under ${OVERRIDE_LIMITS.reasonMaxLength} characters.`,
    };
  }
  const orgWide = isOrganisationWideOverride(draft.type);
  if (draft.employeeId === null && !orgWide) {
    return { ok: false, field: "employee", message: "Choose an employee for this override type." };
  }
  const expiry = computeOverrideExpiry(draft.expiry, now, role);
  if (!expiry.ok) return { ok: false, field: "expiry", message: expiry.message };

  let payload: CreateOverrideInput["payload"];
  if (draft.type === "TEMPORARY_EXCEPTION") {
    switch (draft.behaviour.kind) {
      case "RELAX_ALL":
        payload = { restrictionBehaviour: "RELAX_ALL" };
        break;
      case "RELAX_CATEGORIES":
        if (draft.behaviour.categories.length === 0) {
          return {
            ok: false,
            field: "behaviour",
            message: "Choose at least one category to relax.",
          };
        }
        payload = {
          restrictionBehaviour: "RELAX_CATEGORIES",
          relaxedCategories: [...draft.behaviour.categories],
        };
        break;
      case "BREAK_POLICY":
        if (!draft.behaviour.breakPolicyId)
          return { ok: false, field: "behaviour", message: "Choose a Break Rules preset." };
        payload = { breakPolicyId: draft.behaviour.breakPolicyId };
        break;
    }
  }

  const body = {
    ...(draft.employeeId && !orgWide ? { employeeId: draft.employeeId } : {}),
    type: draft.type,
    reason,
    ...expiry.body,
    ...(payload ? { payload } : {}),
  };
  const parsed = createOverrideSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = String(first?.path[0] ?? "");
    const field =
      path === "reason"
        ? "reason"
        : path === "employeeId"
          ? "employee"
          : path === "payload"
            ? "behaviour"
            : "expiry";
    return { ok: false, field, message: first?.message ?? "Check the override details." };
  }
  return { ok: true, input: parsed.data, expiresAt: expiry.expiresAt };
}

/** "Expires in 45 min" / "Expired 2 h ago" style copy for list rows. */
export function describeOverrideRemaining(
  override: Pick<Override, "expiresAt" | "status">,
  now: DateInput = Date.now(),
): string {
  const expires = toDate(override.expiresAt);
  const reference = toDate(now);
  if (!expires || !reference) return "—";
  const minutes = Math.round((expires.getTime() - reference.getTime()) / 60_000);
  if (override.status === "REVOKED") return "Revoked";
  if (minutes <= 0) return "Expired";
  return `${formatDurationMinutes(minutes)} left`;
}

export const BEHAVIOUR_LABELS: Record<BreakRestrictionBehaviour, string> = {
  RELAX_ALL: "Relax all restrictions",
  RELAX_CATEGORIES: "Relax specific categories",
  KEEP_RESTRICTIONS: "Keep restrictions",
};
