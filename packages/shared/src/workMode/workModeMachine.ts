/**
 * Work Mode state machine (§6.2). Public barrel — see docs/WORK_MODE_STATE_MACHINE.md and the shared
 * fixtures in docs/fixtures/workmode-cases.json (consumed by the Vitest suite and the Swift port).
 *
 *   computeExpectedState(input)          → ExpectedState      pure evaluation at `now`
 *   diffStates(prev, next)               → Transition[]       ActivityEvents implied by a change
 *   replayTransitions(input, since, previous?) → ReplayResult every change in (since, now] at its exact instant
 *   mergeShiftIntervals(shifts)          → WorkingInterval[]  union of SCHEDULED shifts (schedule / conflict code)
 */
export type {
  BreakRef,
  ComputeExpectedStateInput,
  ExpectedState,
  ExpectedStateJson,
  InstantInput,
  OverridePayloadLike,
  OverrideRef,
  RelaxationSource,
  ReplayResult,
  RestrictionRelaxation,
  ShiftRef,
  Transition,
  WorkingInterval,
  WorkModeBreakSessionLike,
  WorkModeMachineOptions,
  WorkModeOverrideLike,
  WorkModeShiftLike,
} from "./types";
export {
  coveringShiftAt,
  isEffectiveShift,
  mergeShiftIntervals,
  nextWorkingIntervalAfter,
  normaliseShifts,
  workingIntervalAt,
} from "./mergeShiftIntervals";
export {
  DEFAULT_WORK_MODE_OPTIONS,
  computeExpectedState,
  isPermissionApproved,
  nextTransitionAt,
  restrictionSignature,
  toExpectedStateJson,
} from "./computeExpectedState";
export { diffStates, isWorkModeActiveState } from "./diffStates";
export { replayTransitions } from "./replay";
