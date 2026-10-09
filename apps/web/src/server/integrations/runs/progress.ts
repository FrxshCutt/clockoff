import type {
  IntegrationProvider,
  IntegrationSyncRunKind,
  IntegrationSyncRunStatus,
  IntegrationSyncTrigger,
} from "@clockoff/shared/enums";
import { publishEvent } from "@/server/events";
import { PROGRESS_EVENT_MIN_INTERVAL_MS } from "./constants";

/**
 * Run progress for the wizard and the Integrations card (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §7.11).
 * `IntegrationSyncRun.progress` holds `{ completedPhases, totalPhases, label, pagesRead }`; labels are ClockOff's own
 * words. `publishRunProgress` sends `integration.sync.progress` on the bus at most once per run every
 * PROGRESS_EVENT_MIN_INTERVAL_MS, and always when forced (a phase change, a park, a yield, the finish). Events are
 * hints: the dashboard refetches the run. Payloads hold ids, enums, numbers and labels only.
 */

export interface RunProgress {
  completedPhases: number;
  totalPhases: number;
  label: string;
  pagesRead: number;
}

/** Reads a stored `progress` JSON (anything malformed reads as an empty progress). */
export function readRunProgress(value: unknown): RunProgress {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    completedPhases: int(record.completedPhases),
    totalPhases: int(record.totalPhases),
    label: typeof record.label === "string" ? record.label : "",
    pagesRead: int(record.pagesRead),
  };
}

export const WAITING_TO_START_LABEL = "Waiting to start";

const PHASE_LABELS: Readonly<Record<string, string>> = {
  START: WAITING_TO_START_LABEL,
  PORTAL_CHECK: "Checking the Planday connection",
  DEPARTMENTS: "Reading departments",
  EMPLOYEE_GROUPS: "Reading employee groups",
  EMPLOYEE_COUNTS: "Counting employees",
  EMPLOYEES: "Reading employees",
  MATCH_EMPLOYEES: "Matching employees",
  DEACTIVATED_EMPLOYEES: "Checking deactivated employees",
  ABSENT_EMPLOYEES: "Checking missing employees",
  REACTIVATIONS: "Reactivating employees",
  SCHEDULE_DAYS: "Reading hidden days",
  PREVIEW_SHIFTS: "Reading the next two weeks of shifts",
  SHIFTS: "Importing shifts",
  DELETED_SHIFTS: "Checking deleted shifts",
  ABSENT_SHIFTS: "Checking missing shifts",
  APPLY_EMPLOYEES: "Importing employees",
  CLOCK_EVENTS: "Reading punch clock",
  FINALISE: "Finishing",
};

/** "Reading employees (page 3)": the phase's label, with the page within the phase when it pages. */
export function phaseLabel(phase: string, pageInPhase = 0): string {
  const label = PHASE_LABELS[phase] ?? "Syncing";
  return pageInPhase > 1 ? `${label} (page ${pageInPhase})` : label;
}

/** "Waiting for Planday's rate limit — resumes at 10:42" (in the portal's zone, else UTC). */
export function parkedLabel(
  reason: "RATE_LIMITED" | "RETRY_BACKOFF",
  resumeAfter: Date,
  timezone: string | null,
): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone ?? "UTC",
  }).format(resumeAfter);
  return reason === "RATE_LIMITED"
    ? `Waiting for Planday's rate limit — resumes at ${time}`
    : `Planday could not be reached — retrying at ${time}`;
}

export const FINISHED_LABELS: Readonly<
  Record<Exclude<IntegrationSyncRunStatus, "RUNNING">, string>
> = {
  SUCCEEDED: "Finished",
  PARTIAL: "Finished with warnings",
  FAILED: "Failed",
};

/** The run fields a progress event carries. */
export interface ProgressRun {
  id: string;
  organisationId: string;
  integrationId: string;
  kind: IntegrationSyncRunKind;
  trigger: IntegrationSyncTrigger;
  status: IntegrationSyncRunStatus;
  phase: string;
  progress: RunProgress;
  firstClaimedAt: Date | null;
  resumeAfter: Date | null;
}

const lastPublished = new Map<string, { atMs: number; phase: string }>();

/**
 * Publishes `integration.sync.progress` for `run` (after the transaction that wrote it committed). Throttled per
 * run unless `force`; a phase change is always published. Finished runs are forgotten.
 */
export function publishRunProgress(
  run: ProgressRun,
  options: { force?: boolean; provider?: IntegrationProvider; nowMs?: number } = {},
): boolean {
  const nowMs = options.nowMs ?? Date.now();
  const previous = lastPublished.get(run.id);
  const finished = run.status !== "RUNNING";
  const due =
    options.force === true ||
    finished ||
    !previous ||
    previous.phase !== run.phase ||
    nowMs - previous.atMs >= PROGRESS_EVENT_MIN_INTERVAL_MS;
  if (!due) return false;
  if (finished) lastPublished.delete(run.id);
  else lastPublished.set(run.id, { atMs: nowMs, phase: run.phase });
  publishEvent({
    type: "integration.sync.progress",
    organisationId: run.organisationId,
    payload: {
      provider: options.provider ?? "PLANDAY",
      integrationId: run.integrationId,
      runId: run.id,
      kind: run.kind,
      trigger: run.trigger,
      status: run.status,
      phase: run.phase.slice(0, 64),
      label: run.progress.label.slice(0, 200),
      completedPhases: run.progress.completedPhases,
      totalPhases: run.progress.totalPhases,
      pagesRead: run.progress.pagesRead,
      queued: run.status === "RUNNING" && run.firstClaimedAt === null,
      resumeAfter: run.resumeAfter ? run.resumeAfter.toISOString() : null,
      finished,
    },
  });
  return true;
}

/** Forgets a run's throttle entry without publishing (a slice whose run another actor ended). */
export function forgetRunProgress(runId: string): void {
  lastPublished.delete(runId);
}

/** Tests only: whether the throttle still tracks `runId`. */
export function isRunProgressTrackedForTesting(runId: string): boolean {
  return lastPublished.has(runId);
}

/** Tests only: forget the throttle state. */
export function resetRunProgressThrottleForTesting(): void {
  lastPublished.clear();
}
