import type {
  BreakPolicy,
  BreakSession,
  ManagerOverride,
  ScheduledBreak,
  Shift,
} from "@clockoff/db";
import {
  breakPolicyFromRecord,
  parseRelaxedCategories,
  resolveBreakBehaviour,
  type BreakAllowance,
} from "@clockoff/shared/breaks/breakRules";
import { toExpectedStateJson, type ExpectedState } from "@clockoff/shared/workMode/workModeMachine";
import type {
  MobileActiveOverride,
  MobileBreakPolicy,
  MobileResolvedPolicy,
  MobileShift,
} from "@clockoff/validation/mobile";
import type {
  BreakAllowanceResponse,
  BreakSessionResponse,
  ExpectedStateResponse,
} from "@clockoff/validation/workState";
import type { EmployeePolicyResolution } from "./policyResolution";

/** DTO mappers for the mobile API (`@clockoff/validation/mobile`). Operational fields only (§12). */

export type ShiftWithScheduledBreaks = Shift & {
  scheduledBreaks: ScheduledBreak[];
  location: { id: string; name: string } | null;
};

export function scheduledBreakWindow(
  shift: Pick<Shift, "startsAt" | "endsAt">,
  scheduled: Pick<ScheduledBreak, "offsetMinutesFromStart" | "durationMinutes">,
): { startsAt: Date; endsAt: Date } {
  const startsAt = new Date(shift.startsAt.getTime() + scheduled.offsetMinutesFromStart * 60_000);
  const endsAt = new Date(
    Math.min(startsAt.getTime() + scheduled.durationMinutes * 60_000, shift.endsAt.getTime()),
  );
  return { startsAt, endsAt };
}

export function toMobileShift(shift: ShiftWithScheduledBreaks): MobileShift {
  return {
    id: shift.id,
    startsAt: shift.startsAt.toISOString(),
    endsAt: shift.endsAt.toISOString(),
    timezone: shift.timezone,
    status: shift.status,
    location: shift.location ? { id: shift.location.id, name: shift.location.name } : null,
    notes: shift.notes,
    version: shift.version,
    scheduledBreaks: shift.scheduledBreaks
      .slice()
      .sort((a, b) => a.offsetMinutesFromStart - b.offsetMinutesFromStart)
      .map((sb) => {
        const window = scheduledBreakWindow(shift, sb);
        return {
          id: sb.id,
          offsetMinutesFromStart: sb.offsetMinutesFromStart,
          durationMinutes: sb.durationMinutes,
          startsAt: window.startsAt.toISOString(),
          endsAt: window.endsAt.toISOString(),
        };
      }),
  };
}

/** Null unless a published version with a valid restriction config resolves (`policy.currentVersion`). */
export function toMobileResolvedPolicy(
  resolution: EmployeePolicyResolution | null,
): MobileResolvedPolicy | null {
  const policy = resolution?.policy ?? null;
  if (!policy?.currentVersion) return null;
  const { currentVersion } = policy;
  return {
    policy: { id: policy.id, name: policy.name },
    version: { id: currentVersion.id, versionNumber: currentVersion.versionNumber },
    restrictionConfig: currentVersion.restrictionConfig,
    breakBehaviourDefault: currentVersion.breakBehaviourDefault,
  };
}

export function toMobileBreakPolicy(policy: BreakPolicy | null): MobileBreakPolicy | null {
  if (!policy) return null;
  const rules = breakPolicyFromRecord(policy);
  return {
    id: policy.id,
    name: policy.name,
    rules: { ...rules, relaxedCategories: [...rules.relaxedCategories] },
  };
}

export function toBreakSessionDto(session: BreakSession): BreakSessionResponse {
  return {
    id: session.id,
    clientBreakId: session.clientBreakId,
    shiftId: session.shiftId,
    startedAt: session.startedAt.toISOString(),
    plannedEndsAt: session.plannedEndsAt.toISOString(),
    endedAt: session.endedAt ? session.endedAt.toISOString() : null,
    status: session.status,
    endReason: session.endReason,
    restrictionBehaviour: session.restrictionBehaviour,
    relaxedCategories: parseRelaxedCategories(session.relaxedCategories),
  };
}

export function toBreakAllowanceDto(allowance: BreakAllowance): BreakAllowanceResponse {
  return {
    breaksTaken: allowance.breaksTaken,
    breaksRemaining: allowance.breaksRemaining,
    minutesUsed: allowance.minutesUsed,
    minutesRemaining: allowance.minutesRemaining,
    nextEligibleAt: allowance.nextEligibleAt ? allowance.nextEligibleAt.toISOString() : null,
    canStartNow: allowance.canStartNow,
  };
}

/** Relaxation carried by a TEMPORARY_EXCEPTION payload (`OverridePayloadLike`); null for lifting overrides. */
export function overrideBreakBehaviour(
  override: Pick<ManagerOverride, "type" | "payload">,
): MobileActiveOverride["breakBehaviour"] {
  if (override.type !== "TEMPORARY_EXCEPTION") return null;
  const payload =
    typeof override.payload === "object" &&
    override.payload !== null &&
    !Array.isArray(override.payload)
      ? (override.payload as Record<string, unknown>)
      : {};
  const behaviour = payload.restrictionBehaviour;
  const restrictionBehaviour =
    behaviour === "RELAX_ALL" ||
    behaviour === "RELAX_CATEGORIES" ||
    behaviour === "KEEP_RESTRICTIONS"
      ? behaviour
      : "RELAX_ALL";
  return resolveBreakBehaviour({
    restrictionBehaviour,
    relaxedCategories: payload.relaxedCategories,
  });
}

export function toMobileActiveOverride(override: ManagerOverride): MobileActiveOverride {
  return {
    id: override.id,
    type: override.type,
    startsAt: override.startsAt.toISOString(),
    expiresAt: override.expiresAt.toISOString(),
    breakBehaviour: overrideBreakBehaviour(override),
  };
}

export function toExpectedStateDto(state: ExpectedState): ExpectedStateResponse {
  return toExpectedStateJson(state);
}
