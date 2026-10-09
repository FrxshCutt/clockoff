import type { ShiftStatus } from "@clockoff/shared/enums";
import type { ExternalShift, ShiftRemovalReason } from "@clockoff/shared/providers/syncSink";
import type { SyncRange } from "@clockoff/shared/providers/workforceProvider";
import { localDateOf } from "@clockoff/shared/time/zone";
import { EXCLUDED_STATUSES, KNOWN_PUBLISHED_STATUSES } from "../planday/constants";
import { departmentKeyOf } from "./locationDecisions";
import { overlapsWindow } from "./window";

/**
 * Shifts (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.6): the classification filter and the 17-row
 * decision table, as pure functions. The provider classifies what it can from Planday's record alone (draft,
 * unassigned, unknown status, unreadable times, and the department scope when it is given); the apply sink adds the
 * employee mapping and hidden days (`incomingShift`), resolves the target, hashes the decision inputs and calls
 * `decideShiftAction` per shift, then performs only the writes the decision asks for.
 *
 * Safety rules encoded here: ended shifts are never modified; uncertainty (an unknown status, unreadable times)
 * never creates and never cancels; a removal cancels (never deletes); a day hidden after a shift started never ends
 * it; only a shift the integration cancelled is reinstated, with Planday's full target.
 */

/** At most this many by-id reads per run re-check shifts missing from a complete SHIFTS phase (§6.6). */
export const ABSENT_SHIFT_RECHECK_LIMIT = 50;

/** A clock-in at most this long before a future shift's start moves the start to it (§6.8, clock reconciliation). */
export const EARLY_CLOCK_IN_MS = 60 * 60_000;

// ---------------------------------------------------------------------------------------------------------
// Classification (§6.6 "Filter")
// ---------------------------------------------------------------------------------------------------------

export const SHIFT_CLASSES = [
  "PUBLISHED",
  "DRAFT",
  "UNASSIGNED",
  "OUT_OF_SCOPE",
  "HIDDEN_DAY",
  "UNKNOWN_STATUS",
  "INVALID_TIME",
] as const;
export type ShiftClass = (typeof SHIFT_CLASSES)[number];

/** What the classification checks beyond Planday's own record. Each check is skipped when its field is absent. */
export interface ShiftScope {
  /** Included department keys (`"none"` = no department). Absent: the department scope is not checked. */
  readonly includedDepartmentIds?: Iterable<string>;
  /** Whether the Planday employee is mapped to a non-deleted ClockOff employee. Absent: not checked. */
  readonly isEmployeeMapped?: (externalEmployeeId: string) => boolean;
  /**
   * `respectHiddenDays` only: whether `scheduleDay.isVisible === false` for the department on the shift's local
   * start date. Absent (the default, D-040): no day is hidden.
   */
  readonly isHiddenDay?: (externalDepartmentId: string, localDate: string) => boolean;
}

/** A Planday shift as the filter sees it (`PlandayShift` satisfies it). */
export interface ClassifiableShift {
  readonly status: string;
  readonly externalEmployeeId: string | null;
  readonly externalDepartmentId: string | null;
  readonly times: { readonly ok: true; readonly localStartDate: string } | { readonly ok: false };
}

const PUBLISHED: ReadonlySet<string> = new Set(KNOWN_PUBLISHED_STATUSES);
const EXCLUDED: ReadonlySet<string> = new Set(EXCLUDED_STATUSES);

function includedSet(scope: ShiftScope): ReadonlySet<string> | null {
  if (scope.includedDepartmentIds === undefined) return null;
  return scope.includedDepartmentIds instanceof Set
    ? (scope.includedDepartmentIds as ReadonlySet<string>)
    : new Set(scope.includedDepartmentIds);
}

/** The scope rows of the filter (department, employee mapping, hidden day) for a shift with an employee. */
function scopeClass(
  externalEmployeeId: string,
  externalDepartmentId: string | null,
  localStartDate: string | null,
  scope: ShiftScope,
): "OUT_OF_SCOPE" | "HIDDEN_DAY" | null {
  const included = includedSet(scope);
  if (included && !included.has(departmentKeyOf(externalDepartmentId))) return "OUT_OF_SCOPE";
  if (scope.isEmployeeMapped && !scope.isEmployeeMapped(externalEmployeeId)) return "OUT_OF_SCOPE";
  if (
    scope.isHiddenDay &&
    localStartDate !== null &&
    externalDepartmentId !== null &&
    scope.isHiddenDay(externalDepartmentId, localStartDate)
  ) {
    return "HIDDEN_DAY";
  }
  return null;
}

/**
 * `classifyPlandayShift(raw)` — the §6.6 filter, first row that applies: `Draft` → DRAFT; no employee (any status,
 * `Open` included) → UNASSIGNED; department not included (null counts as "none") or employee not mapped →
 * OUT_OF_SCOPE; hidden day → HIDDEN_DAY; every documented non-draft status → PUBLISHED (an `Open` shift with an
 * employee is published, notes §10.1 rule 1); any other status → UNKNOWN_STATUS; unreadable times → INVALID_TIME.
 */
export function classifyPlandayShift(shift: ClassifiableShift, scope: ShiftScope = {}): ShiftClass {
  if (EXCLUDED.has(shift.status)) return "DRAFT";
  if (shift.externalEmployeeId === null) return "UNASSIGNED";
  const scoped = scopeClass(
    shift.externalEmployeeId,
    shift.externalDepartmentId,
    shift.times.ok ? shift.times.localStartDate : null,
    scope,
  );
  if (scoped) return scoped;
  if (!PUBLISHED.has(shift.status)) return "UNKNOWN_STATUS";
  if (!shift.times.ok) return "INVALID_TIME";
  return "PUBLISHED";
}

/** The removal reason a non-published, non-uncertain class stands for (DRAFT, UNASSIGNED, OUT_OF_SCOPE, HIDDEN_DAY). */
export function removalReasonForClass(shiftClass: ShiftClass): ShiftRemovalReason | null {
  switch (shiftClass) {
    case "DRAFT":
    case "UNASSIGNED":
    case "OUT_OF_SCOPE":
    case "HIDDEN_DAY":
      return shiftClass;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// What the sink hands the decision: the incoming evidence for one shift
// ---------------------------------------------------------------------------------------------------------

/**
 * The incoming side of the decision table: a published shift (with its window membership), removal evidence (the
 * deleted list, a by-id 404, a reclassification, or not read because it left the window), or uncertainty.
 */
export type IncomingShift =
  | {
      readonly kind: "PUBLISHED";
      readonly externalEmployeeId: string;
      readonly externalDepartmentId: string | null;
      readonly startsAt: Date;
      readonly endsAt: Date;
      readonly timezone: string;
      /** Overlaps the sync window (`endsAt > from` and `startsAt < to`). */
      readonly inWindow: boolean;
      /** Starts at or after the window's end (row 16). */
      readonly afterWindow: boolean;
    }
  | { readonly kind: "REMOVED"; readonly reason: ShiftRemovalReason | "OUT_OF_WINDOW" }
  | { readonly kind: "UNCERTAIN"; readonly reason: "UNKNOWN_STATUS" | "INVALID_TIME" };

/**
 * The incoming evidence for one record of a SHIFTS batch. The provider already turned drafts, open shifts and
 * (when it knew the scope) excluded departments into `cancelled: true` records; this adds the employee mapping and
 * the hidden-day filter (`scope`) and the window membership. Records of a SHIFTS batch can lie outside
 * `batch.window` (the ABSENT_SHIFTS phase returns by-id bodies unfiltered), so membership is always computed here.
 */
export function incomingShift(
  record: ExternalShift,
  scope: ShiftScope,
  window: SyncRange,
): { readonly shiftClass: ShiftClass | null; readonly incoming: IncomingShift } {
  if (record.cancelled) {
    const reason = record.removalReason ?? "DELETED";
    const shiftClass = (SHIFT_CLASSES as readonly string[]).includes(reason)
      ? (reason as ShiftClass)
      : null;
    return { shiftClass, incoming: { kind: "REMOVED", reason } };
  }
  // The provider passes a record uncancelled only when its status is a published one and its times are readable.
  if (record.externalEmployeeId === null) {
    return { shiftClass: "UNASSIGNED", incoming: { kind: "REMOVED", reason: "UNASSIGNED" } };
  }
  const scoped = scopeClass(
    record.externalEmployeeId,
    record.externalLocationId ?? null,
    localDateOf(record.startsAt, record.timezone),
    scope,
  );
  if (scoped) return { shiftClass: scoped, incoming: { kind: "REMOVED", reason: scoped } };
  return {
    shiftClass: "PUBLISHED",
    incoming: {
      kind: "PUBLISHED",
      externalEmployeeId: record.externalEmployeeId,
      externalDepartmentId: record.externalLocationId ?? null,
      startsAt: record.startsAt,
      endsAt: record.endsAt,
      timezone: record.timezone,
      inWindow: overlapsWindow(record, window),
      afterWindow: record.startsAt.getTime() >= window.to.getTime(),
    },
  };
}

/**
 * Removal evidence without a record: a SHIFT_REMOVALS entry (`DELETED` from `/shifts/deleted`, `NOT_FOUND` from a
 * by-id 404, or a by-id body reclassified as `DRAFT` / `UNASSIGNED` / `OUT_OF_SCOPE`), or `OUT_OF_WINDOW` for a
 * mapped future shift that now starts at or after the window's end and was therefore not read (row 16).
 */
export function removalIncoming(reason: ShiftRemovalReason | "OUT_OF_WINDOW"): IncomingShift {
  return { kind: "REMOVED", reason };
}

// ---------------------------------------------------------------------------------------------------------
// Decision-input hashing (§6.2)
// ---------------------------------------------------------------------------------------------------------

/** Where a published shift goes: the mapped employee and the department's location (null for a ClockOff department). */
export interface ShiftTarget {
  readonly employeeId: string;
  readonly locationId: string | null;
  /** The ClockOff department the shift's department maps to, when it maps to one (hash input only). */
  readonly departmentId?: string | null;
}

/**
 * The decision inputs hashed into a shift's `lastHash` (§6.2): the mapped record (times, zone, Planday employee and
 * department ids), its class or removal, the resolved target, the hidden-day flag (only with `respectHiddenDays`)
 * and the window membership. Settings changes that keep every target leave it unchanged (REHASH_ONLY at most).
 */
export function shiftDecisionInputs(input: {
  /** The record read, or null for removal evidence without one (deleted list, by-id 404, not read). */
  readonly record: ExternalShift | null;
  readonly incoming: IncomingShift;
  readonly target: ShiftTarget | null;
  readonly respectHiddenDays: boolean;
}): Record<string, unknown> {
  const { record, incoming, target } = input;
  return {
    v: 1,
    kind: "SHIFT",
    record: record
      ? {
          externalId: record.externalId,
          startsAt: record.startsAt,
          endsAt: record.endsAt,
          timezone: record.timezone,
          externalEmployeeId: record.externalEmployeeId,
          externalDepartmentId: record.externalLocationId ?? null,
        }
      : null,
    incoming: incoming.kind === "PUBLISHED" ? "PUBLISHED" : `${incoming.kind}:${incoming.reason}`,
    target:
      incoming.kind === "PUBLISHED" && target
        ? {
            employeeId: target.employeeId,
            locationId: target.locationId,
            departmentId: target.departmentId ?? null,
          }
        : null,
    ...(input.respectHiddenDays
      ? { hiddenDay: incoming.kind === "REMOVED" && incoming.reason === "HIDDEN_DAY" }
      : {}),
    inWindow: incoming.kind === "PUBLISHED" ? incoming.inWindow : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The decision table (§6.6)
// ---------------------------------------------------------------------------------------------------------

/** The ClockOff shift a map row points to, with the map row's hash and removal mark. */
export interface ExistingShift {
  readonly id: string;
  readonly status: ShiftStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly employeeId: string;
  readonly locationId: string | null;
  readonly lastHash: string | null;
  /** The integration cancelled it (eligible for REINSTATE, row 15). */
  readonly upstreamRemovedAt: Date | null;
}

export type ShiftTimeState = "FUTURE" | "IN_PROGRESS" | "ENDED";

/** FUTURE (`startsAt > now`), IN_PROGRESS (`startsAt ≤ now < endsAt`) or ENDED (`endsAt ≤ now`, or COMPLETED). */
export function shiftTimeState(
  shift: { readonly status: ShiftStatus; readonly startsAt: Date; readonly endsAt: Date },
  now: Date,
): ShiftTimeState {
  const t = now.getTime();
  if (shift.status === "COMPLETED" || shift.endsAt.getTime() <= t) return "ENDED";
  return shift.startsAt.getTime() > t ? "FUTURE" : "IN_PROGRESS";
}

/** The plan's row numbers (§6.6 table), for tests and logs. */
export type ShiftDecisionRow =
  | "1"
  | "2"
  | "3"
  | "4"
  | "4a"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "11"
  | "12"
  | "13"
  | "14"
  | "14a"
  | "15"
  | "16"
  | "17";

export type ShiftWarningCode =
  "IN_PROGRESS_START_IGNORED" | "HIDDEN_DAY_IN_PROGRESS" | "UNKNOWN_STATUS" | "INVALID_TIME";

/** Why a shift is cancelled (activity metadata `reason`). REASSIGNED: an in-progress shift moved to another person. */
export type ShiftCancelReason = ShiftRemovalReason | "OUT_OF_WINDOW" | "REASSIGNED";

export interface ShiftCreate {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timezone: string;
  readonly employeeId: string;
  readonly locationId: string | null;
}

export interface ShiftDecisionInput {
  /** The mapped ClockOff shift, or null when no map row exists (or its shift was deleted). */
  readonly existing: ExistingShift | null;
  readonly incoming: IncomingShift;
  /** The resolved target; required when `incoming` is PUBLISHED, ignored otherwise. */
  readonly target: ShiftTarget | null;
  readonly now: Date;
  /** `hashDecisionInputs(hasher, shiftDecisionInputs(...))`, compared with `existing.lastHash`. */
  readonly hash?: string;
  /**
   * The latest clock-in punch (§6.8) of the existing shift's employee, when one exists at most EARLY_CLOCK_IN_MS
   * before the incoming start and not after `now`. Clock reconciliation moved the start of the shift to such a punch,
   * so the shift has really started: row 12 applies (start kept, end followed), never row 13.
   */
  readonly clockedInAt?: Date | null;
}

interface ShiftDecisionBase {
  readonly row: ShiftDecisionRow;
  /** The existing shift's time state (null for a new record). */
  readonly existingState: ShiftTimeState | null;
  /** Write the incoming hash (and `last_seen_at`) on the map row. */
  readonly writeHash: boolean;
  /** The map row's `upstreamRemovedAt`: set by every CANCEL, cleared by REINSTATE. */
  readonly upstreamRemoved: "SET" | "CLEAR" | "KEEP";
  readonly warning?: ShiftWarningCode;
}

export type ShiftDecision = ShiftDecisionBase &
  /** Row 1: create (`source INTEGRATION`, `externalShiftId PLANDAY:<portalId>:<id>`, managed, `notes null`) and its map row. */
  (
    | { readonly action: "CREATE"; readonly create: ShiftCreate }
    /** Rows 2 and 3: nothing is written (history before connecting, or nothing published). */
    | {
        readonly action: "SKIP";
        readonly reason: "ENDED_BEFORE_IMPORT" | "NOT_PUBLISHED" | "OUT_OF_WINDOW";
      }
    /** Rows 4, 5, 14a, 17: nothing changes (only `last_seen_at`). */
    | { readonly action: "UNCHANGED" }
    /** Row 4a: new `lastHash` only; no version bump, no activity, no SCHEDULE_CHANGED. */
    | { readonly action: "REHASH_ONLY" }
    /** Rows 6 and 13: new start, end and/or location; version +1. */
    | {
        readonly action: "UPDATE";
        readonly patch: {
          readonly startsAt?: Date;
          readonly endsAt?: Date;
          readonly locationId?: string | null;
        };
      }
    /** Rows 7 and 13: in-place reassignment of a future shift; version +1, SCHEDULE_CHANGED for both employees. */
    | {
        readonly action: "REASSIGN";
        readonly previousEmployeeId: string;
        readonly patch: {
          readonly employeeId: string;
          readonly startsAt?: Date;
          readonly endsAt?: Date;
          readonly locationId?: string | null;
        };
      }
    /**
     * Rows 8, 14 and 16: status CANCELLED, version +1, never deleted. `inProgress`: also end a running break
     * (`SHIFT_ENDED`) and push.
     */
    | {
        readonly action: "CANCEL";
        readonly reason: ShiftCancelReason;
        readonly inProgress: boolean;
      }
    /** Rows 9 and 10: new end (`shortened`: end a running break outside the new window); version +1. */
    | {
        readonly action: "UPDATE_END";
        readonly shortened: boolean;
        readonly patch: { readonly endsAt: Date; readonly locationId?: string | null };
      }
    /**
     * Row 11: `endsAt = now` rounded up to the minute (the 15-minute minimum does not apply), version +1, running
     * break ended `SHIFT_ENDED`.
     */
    | { readonly action: "END_NOW"; readonly endsAt: Date; readonly locationId?: string | null }
    /** Row 15: status SCHEDULED with Planday's full target, version +1, `upstreamRemovedAt = null`. */
    | {
        readonly action: "REINSTATE";
        readonly previousEmployeeId: string;
        readonly target: ShiftCreate;
      }
    /**
     * Row 15 when the cancelled shift's own times have passed (Planday moved it, for example beyond the window and
     * back, or drafted and republished it later): ended shifts are never modified (row 5), so Planday's shift is
     * created afresh with its full target and the map row is repointed to it (`upstreamRemovedAt` cleared); the old
     * shift stays cancelled and its `externalShiftId` becomes `PLANDAY:<portalId>:<id>:superseded:<oldShiftId>`.
     */
    | {
        readonly action: "RECREATE";
        readonly previousEmployeeId: string;
        readonly create: ShiftCreate;
      }
    /**
     * Row 14, reassigned while in progress: cancel the old shift for its employee (running break ended, push) and
     * create a fresh one for the new mapped employee in the same transaction; the map row is repointed to the new
     * shift and the old one's `externalShiftId` becomes `PLANDAY:<portalId>:<id>:superseded:<oldShiftId>`.
     */
    | { readonly action: "CANCEL_AND_CREATE"; readonly create: ShiftCreate }
  );

const MINUTE_MS = 60_000;

function ceilToMinute(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

function requireTarget(target: ShiftTarget | null): ShiftTarget {
  if (!target)
    throw new TypeError("decideShiftAction: a PUBLISHED shift needs its resolved target");
  return target;
}

function createFrom(
  incoming: Extract<IncomingShift, { kind: "PUBLISHED" }>,
  target: ShiftTarget,
): ShiftCreate {
  return {
    startsAt: incoming.startsAt,
    endsAt: incoming.endsAt,
    timezone: incoming.timezone,
    employeeId: target.employeeId,
    locationId: target.locationId,
  };
}

/**
 * `decideShiftAction({ existing, incoming, now, target })` — the §6.6 table. The action is worked out first; when it
 * changes nothing ClockOff shows, the hash decides between UNCHANGED (equal: row 4) and REHASH_ONLY (row 4a). So a
 * hash match never hides a drifted shift (§6.2 step 3), and the never-short-circuited states (a shift the
 * integration cancelled that Planday publishes again, a map row without a hash) are always re-decided.
 */
export function decideShiftAction(input: ShiftDecisionInput): ShiftDecision {
  const { existing, incoming, now } = input;
  const nowMs = now.getTime();

  if (!existing) {
    const base = { existingState: null, writeHash: false, upstreamRemoved: "KEEP" } as const;
    if (incoming.kind !== "PUBLISHED") {
      return { ...base, row: "3", action: "SKIP", reason: "NOT_PUBLISHED" };
    }
    if (!incoming.inWindow) return { ...base, row: "3", action: "SKIP", reason: "OUT_OF_WINDOW" };
    if (incoming.endsAt.getTime() <= nowMs) {
      return { ...base, row: "2", action: "SKIP", reason: "ENDED_BEFORE_IMPORT" };
    }
    return {
      row: "1",
      action: "CREATE",
      create: createFrom(incoming, requireTarget(input.target)),
      existingState: null,
      writeHash: true,
      upstreamRemoved: "KEEP",
    };
  }

  const state = shiftTimeState(existing, now);
  const keep = { existingState: state, upstreamRemoved: "KEEP" } as const;
  /** Row 15's condition on the incoming side: published again, inside the window, not over yet. */
  const publishedAgain =
    existing.status === "CANCELLED" &&
    existing.upstreamRemovedAt !== null &&
    incoming.kind === "PUBLISHED" &&
    incoming.inWindow &&
    !incoming.afterWindow &&
    incoming.endsAt.getTime() > nowMs;
  const unchanged = (row: ShiftDecisionRow, warning?: ShiftWarningCode): ShiftDecision => ({
    ...keep,
    row,
    action: "UNCHANGED",
    writeHash: false,
    ...(warning ? { warning } : {}),
  });
  /** Nothing ClockOff shows changes: row 4 when the hash is equal, else row 4a. */
  const noChange = (warning?: ShiftWarningCode): ShiftDecision =>
    input.hash !== undefined && input.hash === existing.lastHash
      ? unchanged("4")
      : {
          ...keep,
          row: "4a",
          action: "REHASH_ONLY",
          writeHash: true,
          ...(warning ? { warning } : {}),
        };
  const cancel = (row: ShiftDecisionRow, reason: ShiftCancelReason): ShiftDecision => ({
    existingState: state,
    row,
    action: "CANCEL",
    reason,
    inProgress: state === "IN_PROGRESS",
    writeHash: true,
    upstreamRemoved: "SET",
  });

  // Row 15 for a shift the integration cancelled whose own (old) times have passed: it is never modified (row 5),
  // so Planday's shift comes back as a fresh one. Without this it would stay lost once its old times passed.
  if (state === "ENDED" && publishedAgain && incoming.kind === "PUBLISHED") {
    return {
      existingState: state,
      row: "15",
      action: "RECREATE",
      previousEmployeeId: existing.employeeId,
      create: createFrom(incoming, requireTarget(input.target)),
      writeHash: true,
      upstreamRemoved: "CLEAR",
    };
  }
  // Row 5: ended shifts are never modified (spec §5).
  if (state === "ENDED") return unchanged("5");
  // Row 17: never act on uncertainty.
  if (incoming.kind === "UNCERTAIN") return unchanged("17", incoming.reason);

  if (existing.status === "CANCELLED") {
    // Row 15: only a shift the integration cancelled comes back, with Planday's full target.
    if (publishedAgain && incoming.kind === "PUBLISHED") {
      return {
        existingState: state,
        row: "15",
        action: "REINSTATE",
        previousEmployeeId: existing.employeeId,
        target: createFrom(incoming, requireTarget(input.target)),
        writeHash: true,
        upstreamRemoved: "CLEAR",
      };
    }
    return noChange();
  }

  // §6.8: the employee clocked in early and clock reconciliation moved the start to the punch, so the shift has
  // started for real. Planday's (later) start must not make it FUTURE again (row 13), which would end Work Mode.
  const clockedInAt = input.clockedInAt?.getTime() ?? null;
  const heldByClockIn =
    state === "IN_PROGRESS" &&
    incoming.kind === "PUBLISHED" &&
    clockedInAt !== null &&
    clockedInAt <= nowMs &&
    clockedInAt < incoming.startsAt.getTime() &&
    incoming.startsAt.getTime() - clockedInAt <= EARLY_CLOCK_IN_MS;
  const startsInFuture =
    incoming.kind === "PUBLISHED" && incoming.startsAt.getTime() > nowMs && !heldByClockIn;
  if (state === "FUTURE" || startsInFuture) {
    // Rows 6, 7, 8, 16; row 13 when the shift was in progress but Planday moved its start into the future.
    const futureRow = (row: ShiftDecisionRow): ShiftDecisionRow =>
      state === "IN_PROGRESS" ? "13" : row;
    if (incoming.kind === "REMOVED") {
      return cancel(incoming.reason === "OUT_OF_WINDOW" ? "16" : "8", incoming.reason);
    }
    if (incoming.afterWindow) return cancel("16", "OUT_OF_WINDOW");
    const target = requireTarget(input.target);
    const patch: { startsAt?: Date; endsAt?: Date; locationId?: string | null } = {};
    if (incoming.startsAt.getTime() !== existing.startsAt.getTime())
      patch.startsAt = incoming.startsAt;
    if (incoming.endsAt.getTime() !== existing.endsAt.getTime()) patch.endsAt = incoming.endsAt;
    if (target.locationId !== existing.locationId) patch.locationId = target.locationId;
    if (target.employeeId !== existing.employeeId) {
      return {
        ...keep,
        row: futureRow("7"),
        action: "REASSIGN",
        previousEmployeeId: existing.employeeId,
        patch: { employeeId: target.employeeId, ...patch },
        writeHash: true,
      };
    }
    if (Object.keys(patch).length > 0) {
      return { ...keep, row: futureRow("6"), action: "UPDATE", patch, writeHash: true };
    }
    return noChange();
  }

  // In progress.
  if (incoming.kind === "REMOVED") {
    // Row 14a: a day hidden after the shift started never ends Work Mode mid-shift.
    if (incoming.reason === "HIDDEN_DAY") return unchanged("14a", "HIDDEN_DAY_IN_PROGRESS");
    // An in-progress shift overlaps the window, so "not read because it left the window" cannot apply to it.
    if (incoming.reason === "OUT_OF_WINDOW") return unchanged("16");
    return cancel("14", incoming.reason);
  }
  const target = requireTarget(input.target);
  if (target.employeeId !== existing.employeeId) {
    // Row 14: cancelled for the old employee; a fresh shift for the new one unless it is already over.
    if (incoming.endsAt.getTime() <= nowMs) return cancel("14", "REASSIGNED");
    return {
      existingState: state,
      row: "14",
      action: "CANCEL_AND_CREATE",
      create: createFrom(incoming, target),
      writeHash: true,
      upstreamRemoved: "KEEP",
    };
  }
  // Row 12: the start already happened; only the end (rows 9 to 11) and the location follow Planday. A start held
  // by an early clock-in is expected, not worth a warning on every run.
  const startIgnored =
    incoming.startsAt.getTime() !== existing.startsAt.getTime() && !heldByClockIn
      ? ("IN_PROGRESS_START_IGNORED" as const)
      : undefined;
  const location =
    target.locationId !== existing.locationId ? { locationId: target.locationId } : {};
  const warn = startIgnored ? { warning: startIgnored } : {};
  if (incoming.endsAt.getTime() <= nowMs) {
    const minimumEnd = existing.startsAt.getTime() + MINUTE_MS;
    const endsAt = new Date(Math.max(ceilToMinute(now).getTime(), minimumEnd));
    return { ...keep, ...warn, row: "11", action: "END_NOW", endsAt, ...location, writeHash: true };
  }
  if (incoming.endsAt.getTime() !== existing.endsAt.getTime()) {
    const shortened = incoming.endsAt.getTime() < existing.endsAt.getTime();
    return {
      ...keep,
      ...warn,
      row: shortened ? "10" : "9",
      action: "UPDATE_END",
      shortened,
      patch: { endsAt: incoming.endsAt, ...location },
      writeHash: true,
    };
  }
  if ("locationId" in location) {
    return { ...keep, ...warn, row: "6", action: "UPDATE", patch: location, writeHash: true };
  }
  if (startIgnored) {
    const decision = noChange(startIgnored);
    return decision.action === "REHASH_ONLY" ? { ...decision, row: "12" } : decision;
  }
  return noChange();
}

/** Whether a decision changes the shift itself (version bump, activity, SCHEDULE_CHANGED). */
export function shiftDecisionWritesShift(decision: ShiftDecision): boolean {
  switch (decision.action) {
    case "SKIP":
    case "UNCHANGED":
    case "REHASH_ONLY":
      return false;
    default:
      return true;
  }
}

/**
 * Ids to re-check by id in ABSENT_SHIFTS (§6.6 "Removal evidence"): mapped, non-ended, non-cancelled shifts inside
 * the window whose map row was not seen since the run started, after a complete SHIFTS phase; at most
 * ABSENT_SHIFT_RECHECK_LIMIT (the rest wait for the next run). Absence alone never cancels.
 */
export function selectAbsentShiftRechecks(input: {
  readonly mapped: ReadonlyArray<{
    readonly externalId: string;
    readonly status: ShiftStatus;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly lastSeenAt: Date;
  }>;
  readonly runStartedAt: Date;
  readonly window: SyncRange;
  readonly now: Date;
  readonly limit?: number;
}): string[] {
  const limit = input.limit ?? ABSENT_SHIFT_RECHECK_LIMIT;
  return input.mapped
    .filter(
      (row) =>
        row.status === "SCHEDULED" &&
        shiftTimeState(row, input.now) !== "ENDED" &&
        overlapsWindow(row, input.window) &&
        row.lastSeenAt.getTime() < input.runStartedAt.getTime(),
    )
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map((row) => row.externalId)
    .slice(0, limit);
}
