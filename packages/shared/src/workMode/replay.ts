import { computeExpectedState } from "./computeExpectedState";
import { diffStates } from "./diffStates";
import { toDate } from "./instants";
import type { WorkModeState } from "../enums";
import type { ComputeExpectedStateInput, ExpectedState, ReplayResult, Transition } from "./types";

/**
 * Hard ceiling on evaluations per replay. Each step strictly advances to the next real change and the number
 * of candidate instants is finite (≤ 4 per working interval, ≤ 3 per break / override), so this only guards
 * against a future regression turning the walk into an infinite loop.
 */
const MAX_REPLAY_STEPS = 10_000;

/**
 * Replays the machine from `since` up to `input.now` over the same rows, stepping from one real change to the
 * next via `nextTransitionAt`. Unlike a single `diffStates(stateAtSince, stateAtNow)`, intermediate changes
 * are not collapsed (a whole break between two job ticks still yields BREAK_STARTED + BREAK_EXPIRED) and
 * every Transition's `at` is the exact instant the change took effect — use it as ActivityEvent.occurredAt.
 *
 * Typical server use: `since` = EmployeeWorkState.expectedComputedAt, `now` = the job tick, `previous` = the
 * persisted EmployeeWorkState.expectedState. The replay reflects the rows as they are *now* (e.g. a break
 * ended early is seen through its endedAt), which is what the activity feed should record.
 *
 * `previous` is what was believed at `since` (a bare persisted state, or the full `ExpectedState` from the
 * last run). The rows can change in ways that rewrite the past — permission lost (`permissionState` applies
 * to the whole replay), a shift cancelled / deleted / completed mid-shift — and then the state at `since`
 * recomputed from today's rows no longer matches what was persisted. When `previous` is given, those
 * differences are emitted first via `diffStates(previous, stateAtSince)`, stamped at `since` (the exact
 * instant of such an edit is not in the rows). Without it they are silently absorbed.
 *
 * Throws `RangeError` when `since` is after `now`.
 */
export function replayTransitions(
  input: ComputeExpectedStateInput,
  since: Date | string,
  previous?: WorkModeState | ExpectedState | null,
): ReplayResult {
  const now = toDate(input.now, "now");
  const start = toDate(since, "since");
  if (start.getTime() > now.getTime()) {
    throw new RangeError(
      `workMode: replay since (${start.toISOString()}) is after now (${now.toISOString()})`,
    );
  }

  let current: ExpectedState = computeExpectedState({ ...input, now: start });
  const states: ExpectedState[] = [current];
  const transitions: Transition[] =
    previous === null || previous === undefined ? [] : diffStates(previous, current);

  for (let step = 0; ; step += 1) {
    if (step >= MAX_REPLAY_STEPS) {
      throw new RangeError(`workMode: replay exceeded ${MAX_REPLAY_STEPS} steps`);
    }
    const at = current.nextTransitionAt;
    if (at === null || at.getTime() > now.getTime()) break;
    const next = computeExpectedState({ ...input, now: at });
    transitions.push(...diffStates(current, next));
    states.push(next);
    current = next;
  }

  // Close on `now` itself so callers can persist the final state; same signature, so no transitions.
  if (current.computedAt.getTime() !== now.getTime()) {
    const final = computeExpectedState({ ...input, now });
    transitions.push(...diffStates(current, final));
    states.push(final);
  }
  return { states, transitions };
}
