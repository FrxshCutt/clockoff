import type {
  BreakRestrictionBehaviour,
  BreakSessionStatus,
  EffectiveRestriction,
  OverrideType,
  PermissionState,
  RestrictionCategory,
  ShiftStatus,
  WorkModeState,
  ActivityEventType,
} from "../enums";

/**
 * Work Mode state machine — input and output types (§6.2).
 *
 * Every type here is framework-free and JSON-friendly so the same contract can be consumed by the server job
 * (Prisma rows are structurally assignable), the web dashboard, the Vitest fixture suite and the Swift port.
 * All instants are UTC. The machine accepts `Date` or an ISO-8601 string *with* an offset (`Z` or `±hh:mm`)
 * and normalises internally; outputs always use `Date` (which `JSON.stringify` turns into ISO strings).
 *
 * Input types carry a `WorkMode` prefix because `@workmode/shared`'s barrel re-exports every module into one
 * namespace (`breaks/` already exports a narrower `BreakSessionLike`).
 */

/** An instant in time: a `Date`, or an ISO-8601 string that carries a timezone offset. */
export type InstantInput = Date | string;

/** Minimal shift shape. A Prisma `Shift` row satisfies it directly. */
export interface WorkModeShiftLike {
  id: string;
  startsAt: InstantInput;
  endsAt: InstantInput;
  status: ShiftStatus;
  version?: number | null;
  deletedAt?: InstantInput | null;
}

/** Minimal break-session shape. A Prisma `BreakSession` row satisfies it directly. */
export interface WorkModeBreakSessionLike {
  id: string;
  shiftId: string;
  startedAt: InstantInput;
  plannedEndsAt: InstantInput;
  endedAt?: InstantInput | null;
  status: BreakSessionStatus;
  /** Snapshot of the behaviour applied for this break. */
  restrictionBehaviour: BreakRestrictionBehaviour;
  /** JSON array of `RestrictionCategory`. Unknown entries are dropped; only read for RELAX_CATEGORIES. */
  relaxedCategories?: unknown;
}

/**
 * Payload a TEMPORARY_EXCEPTION override may carry. Parsed defensively from JSON: a missing or invalid
 * `restrictionBehaviour` means RELAX_ALL, unknown categories are dropped. Other keys are ignored — in
 * particular a stored `{ breakPolicyId }` is NOT resolved here (the machine is pure); callers that store a
 * break-policy reference must merge that policy's `resolveBreakBehaviour(...)` into the payload first.
 */
export interface OverridePayloadLike {
  restrictionBehaviour?: BreakRestrictionBehaviour;
  relaxedCategories?: readonly RestrictionCategory[];
}

/** Minimal manager-override shape. A Prisma `ManagerOverride` row satisfies it directly. */
export interface WorkModeOverrideLike {
  id: string;
  type: OverrideType;
  startsAt: InstantInput;
  expiresAt: InstantInput;
  revokedAt?: InstantInput | null;
  /** Null for org-wide EMERGENCY_POLICY_OVERRIDE. */
  employeeId?: string | null;
  payload?: unknown;
}

export interface WorkModeMachineOptions {
  /** Minutes before a shift start during which the state is SHIFT_STARTING_SOON (and permission errors surface). Default 15. */
  preShiftWarningMinutes?: number;
  /** Minutes before the end of a working interval during which the state is SHIFT_ENDING. Default 5. */
  shiftEndingWarningMinutes?: number;
}

export interface ComputeExpectedStateInput {
  now: InstantInput;
  shifts: readonly WorkModeShiftLike[];
  breakSessions?: readonly WorkModeBreakSessionLike[];
  overrides?: readonly WorkModeOverrideLike[];
  permissionState: PermissionState;
  /**
   * IANA zone of the employee / organisation. Informational only: every instant is UTC and the machine never
   * converts. It is kept in the signature for parity with the Swift port and echoed on the output so
   * presentation layers can format local wall-clock times.
   */
  timezone?: string | null;
  /**
   * When given, overrides scoped to a *different* employee are ignored. Org-wide overrides (`employeeId`
   * null) always apply. When omitted, every override passed in is considered applicable.
   */
  employeeId?: string | null;
  options?: WorkModeMachineOptions;
}

/** Normalised reference to a shift the state refers to. */
export interface ShiftRef {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

/** Normalised reference to the break session governing the current (or intended) relaxation. */
export interface BreakRef {
  id: string;
  shiftId: string;
  startedAt: Date;
  plannedEndsAt: Date;
  /** Effective end: min(plannedEndsAt, endedAt, end of the break's own shift). */
  endsAt: Date;
}

/** Normalised reference to the override affecting the output. */
export interface OverrideRef {
  id: string;
  type: OverrideType;
  startsAt: Date;
  expiresAt: Date;
  employeeId: string | null;
}

/**
 * A continuous working interval: the union of overlapping/adjacent SCHEDULED shifts. Restrictions never flap
 * inside one; SHIFT_ENDING only applies to its end.
 */
export interface WorkingInterval {
  startsAt: Date;
  endsAt: Date;
  /** Ids of the shifts merged into this interval, ordered by start. */
  shiftIds: string[];
  /** The merged shifts, ordered by start (ties: end, then id). */
  shifts: ShiftRef[];
}

export type RelaxationSource = "BREAK" | "OVERRIDE";

/**
 * Present exactly when `effectiveRestriction === "BREAK_RELAXED"`: what the break (or TEMPORARY_EXCEPTION)
 * relaxes. `relaxedCategories` is the stored snapshot (only meaningful for RELAX_CATEGORIES, canonical
 * order); `liftedCategories` is what the device actually unblocks (every category for RELAX_ALL) — the same
 * convention as `breakRestrictionForSession` in `breaks/`.
 */
export interface RestrictionRelaxation {
  source: RelaxationSource;
  restrictionBehaviour: BreakRestrictionBehaviour;
  relaxedCategories: RestrictionCategory[];
  liftedCategories: RestrictionCategory[];
}

export interface ExpectedState {
  state: WorkModeState;
  /** What the restriction engine should apply right now (the *intended* restriction in PERMISSION_ERROR). */
  effectiveRestriction: EffectiveRestriction;
  /** True when at least part of the policy's shield set should currently be enforced. */
  restrictionsShouldBeActive: boolean;
  /** The instant this state was computed for (`now`). */
  computedAt: Date;
  /** Echo of the input, for presentation only. */
  timezone: string | null;
  permissionState: PermissionState;
  /**
   * The shift in progress (now ∈ [startsAt, endsAt)), else null. Inside a merged interval of overlapping
   * shifts this is the earliest-starting shift that covers `now`. Null while merely imminent.
   */
  activeShift: ShiftRef | null;
  /** First shift of the next working interval that starts after `now` (imminent or not), else null. */
  upcomingShift: ShiftRef | null;
  /**
   * The break session running inside the current working interval (see `BreakRef.endsAt`), else null. Still reported under
   * MANAGER_OVERRIDE and PERMISSION_ERROR (the session keeps running and counts towards the allowance), so its
   * expiry is a transition there too.
   */
  activeBreak: BreakRef | null;
  /**
   * The override that changed the output (MANAGER_OVERRIDE, or a TEMPORARY_EXCEPTION that relaxes), else null.
   * An override that does not change the output (off shift, or a KEEP_RESTRICTIONS exception) is not reported.
   */
  activeOverride: OverrideRef | null;
  /** The working interval the state refers to (current, or the imminent one), else null. */
  workingInterval: WorkingInterval | null;
  relaxation: RestrictionRelaxation | null;
  /** Earliest future instant at which this output changes; null when nothing will ever change (no future shift). */
  nextTransitionAt: Date | null;
}

/** `ExpectedState` with every instant as an ISO-8601 UTC string — the wire / fixture representation. */
export interface ExpectedStateJson {
  state: WorkModeState;
  effectiveRestriction: EffectiveRestriction;
  restrictionsShouldBeActive: boolean;
  computedAt: string;
  timezone: string | null;
  permissionState: PermissionState;
  activeShift: { id: string; startsAt: string; endsAt: string } | null;
  upcomingShift: { id: string; startsAt: string; endsAt: string } | null;
  activeBreak: {
    id: string;
    shiftId: string;
    startedAt: string;
    plannedEndsAt: string;
    endsAt: string;
  } | null;
  activeOverride: {
    id: string;
    type: OverrideType;
    startsAt: string;
    expiresAt: string;
    employeeId: string | null;
  } | null;
  workingInterval: {
    startsAt: string;
    endsAt: string;
    shiftIds: string[];
    shifts: { id: string; startsAt: string; endsAt: string }[];
  } | null;
  relaxation: RestrictionRelaxation | null;
  nextTransitionAt: string | null;
}

/** Result of `replayTransitions`: every evaluation from `since` to `now`, and the transitions between them. */
export interface ReplayResult {
  /** The state at `since`, then the state at each real transition instant ≤ `now`; the last entry is evaluated at `now`. */
  states: ExpectedState[];
  /**
   * `diffStates(previous, states[0])` when a `previous` state was supplied (stamped at `since`), then the
   * concatenated `diffStates` of consecutive states; each of those `at` is the exact instant the change took effect.
   */
  transitions: Transition[];
}

/**
 * One observed change between two evaluations. `from`/`to` are the observed states; when a single change
 * implies several ActivityEvents (e.g. ON_BREAK → OFF_SHIFT at shift end emits BREAK_ENDED then
 * WORK_MODE_ENDED) `diffStates` returns one Transition per event, in causal order. A Transition without
 * `eventType` records a state/restriction change that produces no ActivityEvent (e.g. WORKING → SHIFT_ENDING).
 */
export interface Transition {
  from: WorkModeState;
  to: WorkModeState;
  at: Date;
  eventType?: ActivityEventType;
  shiftId?: string;
  breakSessionId?: string;
  overrideId?: string;
}
