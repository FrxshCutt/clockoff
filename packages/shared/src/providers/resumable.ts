import type { IntegrationSyncRunKind } from "../enums";
import type {
  ExternalClockEvent,
  ExternalEmployee,
  ExternalLocation,
  ExternalPortal,
  ExternalShift,
  ExternalTeam,
  ShiftRemovalReason,
} from "./syncSink";
import type { ProviderContext, SyncError, SyncRange, WorkforceProvider } from "./workforceProvider";

/**
 * Resumable providers (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §3.3, §6.1, §7.2). A sync run is a list
 * of phases; each step of a phase reads at most one page from the provider and returns it as a batch plus a
 * JSON-serialisable cursor. The worker's run executor writes the batch and the cursor in one transaction, so a
 * crash, a shutdown or a lost lease resumes at the next page and replaying a step is a no-op. The classic
 * `syncEmployees` / `syncShifts` / … methods loop a phase to completion on top of this.
 */

/** Phase names, in no particular order (a run kind's order comes from `phasesFor`). */
export const SYNC_PHASES = [
  "PORTAL_CHECK",
  "DEPARTMENTS",
  "EMPLOYEE_GROUPS",
  "EMPLOYEE_COUNTS",
  "EMPLOYEES",
  "MATCH_EMPLOYEES",
  "DEACTIVATED_EMPLOYEES",
  "ABSENT_EMPLOYEES",
  "REACTIVATIONS",
  "SCHEDULE_DAYS",
  "PREVIEW_SHIFTS",
  "SHIFTS",
  "DELETED_SHIFTS",
  "ABSENT_SHIFTS",
  "APPLY_EMPLOYEES",
  "CLOCK_EVENTS",
  "FINALISE",
] as const;
export type SyncPhase = (typeof SYNC_PHASES)[number];

/** Phases that make no provider call: the executor runs them against the sink, never the provider. */
export const DATABASE_ONLY_PHASES = [
  "MATCH_EMPLOYEES",
  "REACTIVATIONS",
  "APPLY_EMPLOYEES",
] as const satisfies readonly SyncPhase[];
export type DatabaseOnlyPhase = (typeof DATABASE_ONLY_PHASES)[number];

export function isSyncPhase(value: unknown): value is SyncPhase {
  return typeof value === "string" && (SYNC_PHASES as readonly string[]).includes(value);
}

export function isDatabaseOnlyPhase(phase: SyncPhase): phase is DatabaseOnlyPhase {
  return (DATABASE_ONLY_PHASES as readonly string[]).includes(phase);
}

/** What one phase step read, already mapped to ClockOff's vocabulary (UTC instants, decimal-string ids). */
export type SyncBatch =
  | { readonly kind: "PORTAL"; readonly portal: ExternalPortal }
  | {
      readonly kind: "LOCATIONS";
      readonly records: readonly ExternalLocation[];
      /** True on the phase's last page: the catalogue is complete, so absent departments are missing. */
      readonly complete: boolean;
    }
  | {
      readonly kind: "TEAMS";
      readonly records: readonly ExternalTeam[];
      readonly complete: boolean;
    }
  | {
      readonly kind: "EMPLOYEE_COUNTS";
      /** Employees per external department id (`"none"` for people outside every department). */
      readonly byDepartment: Readonly<Record<string, number>>;
      readonly byGroup: Readonly<Record<string, number>>;
    }
  | { readonly kind: "EMPLOYEES"; readonly records: readonly ExternalEmployee[] }
  | {
      readonly kind: "EMPLOYEE_STATUS";
      readonly records: ReadonlyArray<{
        readonly externalId: string;
        readonly status: "DEACTIVATED" | "REMOVED" | "ACTIVE";
      }>;
    }
  | {
      readonly kind: "HIDDEN_DAYS";
      readonly days: ReadonlyArray<{
        readonly externalDepartmentId: string;
        readonly date: string;
      }>;
    }
  | {
      readonly kind: "SHIFTS";
      readonly records: readonly ExternalShift[];
      readonly window: SyncRange;
    }
  | {
      readonly kind: "SHIFT_REMOVALS";
      readonly records: ReadonlyArray<{
        readonly externalId: string;
        readonly reason: ShiftRemovalReason;
      }>;
    }
  | { readonly kind: "CLOCK_EVENTS"; readonly records: readonly ExternalClockEvent[] };

export type SyncBatchKind = SyncBatch["kind"];

export interface PhaseStepResult {
  /** The phase finished with this step. */
  readonly done: boolean;
  /** JSON-serialisable; persisted by the executor together with the batch's writes. */
  readonly cursor: Readonly<Record<string, unknown>>;
  readonly batch?: SyncBatch;
  /** Provider requests made in this step (the run's request budget). */
  readonly requests: number;
  /** Record-level problems; never personal data in `message`. */
  readonly warnings?: readonly SyncError[];
}

export interface PhaseInputs {
  /** Ids the sink asked the provider to re-check (absent employees / shifts), read by the ABSENT_* phases. */
  readonly recheckExternalIds?: readonly string[];
  readonly window?: SyncRange;
  readonly deactivatedSince?: Date;
}

export interface PhaseOptions {
  /** CLOCK_EVENTS phases (clock-in mode, behind PLANDAY_CLOCK_MODE_ENABLED). */
  readonly clockEvents: boolean;
  /** SCHEDULE_DAYS phase (skip shifts on days hidden from employees; off by default). */
  readonly hiddenDays: boolean;
}

export interface ResumableWorkforceProvider extends WorkforceProvider {
  phasesFor(kind: IntegrationSyncRunKind, options: PhaseOptions): readonly SyncPhase[];
  runPhaseStep(
    ctx: ProviderContext,
    phase: SyncPhase,
    cursor: Readonly<Record<string, unknown>>,
    inputs: PhaseInputs,
  ): Promise<PhaseStepResult>;
}

/** Whether `provider` runs resumable phases (a registered real implementation, never a ComingSoonProvider). */
export function isResumableProvider(
  provider: WorkforceProvider,
): provider is ResumableWorkforceProvider {
  const candidate = provider as Partial<ResumableWorkforceProvider>;
  return typeof candidate.phasesFor === "function" && typeof candidate.runPhaseStep === "function";
}
