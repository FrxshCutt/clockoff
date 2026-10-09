import { isDatabaseOnlyPhase } from "@clockoff/shared/providers/resumable";
import type {
  PhaseInputs,
  PhaseOptions,
  ResumableWorkforceProvider,
  SyncBatch,
  SyncPhase,
} from "@clockoff/shared/providers/resumable";
import type {
  ExternalClockEvent,
  ExternalEmployee,
  ExternalLocation,
  ExternalPortal,
  ExternalShift,
  ExternalTeam,
  ShiftRemovalReason,
  UpsertOutcome,
  WorkforceSyncSink,
} from "@clockoff/shared/providers/syncSink";
import type { IntegrationSyncRunKind } from "@clockoff/shared/enums";
import type { ProviderContext, SyncError } from "@clockoff/shared/providers/workforceProvider";
import { canonicalJson } from "../../core/hash";

/**
 * An in-memory `WorkforceSyncSink` and a minimal phase runner for unit tests of the provider
 * (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §13.1 `planday/provider.test.ts`: "phases against the mock with an
 * in-memory sink"). Test-only: no barrel exports it. It keeps what each batch carried so a test can assert on it; it
 * makes none of the apply sink's decisions (those live in `core/*Decisions.ts` and the web layer).
 */

export interface MemorySink extends WorkforceSyncSink {
  readonly locations: Map<string, ExternalLocation>;
  readonly teams: Map<string, ExternalTeam>;
  readonly employees: Map<string, ExternalEmployee>;
  readonly shifts: Map<string, ExternalShift>;
  readonly clockEvents: Map<string, ExternalClockEvent>;
  readonly savedCredentials: Array<{ credentials: unknown; tokenExpiresAt: Date | null }>;
  /** The last PORTAL batch. */
  portal: ExternalPortal | null;
  /** The last EMPLOYEE_COUNTS batch. */
  employeeCounts: {
    byDepartment: Readonly<Record<string, number>>;
    byGroup: Readonly<Record<string, number>>;
  } | null;
  /** EMPLOYEE_STATUS records, last one per id. */
  readonly employeeStatuses: Map<string, "DEACTIVATED" | "REMOVED" | "ACTIVE">;
  /** HIDDEN_DAYS entries as `<departmentId>:<date>`. */
  readonly hiddenDays: Set<string>;
  /** SHIFT_REMOVALS records and cancelled SHIFTS records: reason per shift id. */
  readonly shiftRemovals: Map<string, ShiftRemovalReason>;
  /** Batch kinds whose catalogue arrived complete (LOCATIONS / TEAMS with `complete: true`). */
  readonly completeCatalogues: Set<"LOCATIONS" | "TEAMS">;
  /** Every batch, in order. */
  readonly batches: SyncBatch[];
  /** Applies one batch: the upserts for record batches, the bookkeeping above for the others. */
  apply(batch: SyncBatch): Promise<UpsertOutcome[]>;
}

function upsertInto<T>(map: Map<string, T>, id: string, record: T): UpsertOutcome {
  const existing = map.get(id);
  map.set(id, record);
  if (existing === undefined) return "CREATED";
  return canonicalJson(existing) === canonicalJson(record) ? "UNCHANGED" : "UPDATED";
}

export function createMemorySink(): MemorySink {
  const sink: MemorySink = {
    locations: new Map(),
    teams: new Map(),
    employees: new Map(),
    shifts: new Map(),
    clockEvents: new Map(),
    savedCredentials: [],
    portal: null,
    employeeCounts: null,
    employeeStatuses: new Map(),
    hiddenDays: new Set(),
    shiftRemovals: new Map(),
    completeCatalogues: new Set(),
    batches: [],

    async upsertLocation(record) {
      return upsertInto(sink.locations, record.externalId, record);
    },
    async upsertTeam(record) {
      return upsertInto(sink.teams, record.externalId, record);
    },
    async upsertEmployee(record) {
      return upsertInto(sink.employees, record.externalId, record);
    },
    async upsertShift(record) {
      if (record.cancelled) {
        sink.shiftRemovals.set(record.externalId, record.removalReason ?? "DELETED");
        // A removal of a shift never stored is skipped, as the apply sink skips it (§6.6 row 3).
        if (!sink.shifts.has(record.externalId)) return "SKIPPED";
      }
      return upsertInto(sink.shifts, record.externalId, record);
    },
    async recordClockEvent(record) {
      return upsertInto(sink.clockEvents, record.externalId, record);
    },
    async saveCredentials(credentials, tokenExpiresAt) {
      sink.savedCredentials.push({ credentials, tokenExpiresAt });
    },

    async apply(batch) {
      sink.batches.push(batch);
      const outcomes: UpsertOutcome[] = [];
      switch (batch.kind) {
        case "PORTAL":
          sink.portal = batch.portal;
          break;
        case "LOCATIONS":
          for (const record of batch.records) outcomes.push(await sink.upsertLocation(record));
          if (batch.complete) sink.completeCatalogues.add("LOCATIONS");
          break;
        case "TEAMS":
          for (const record of batch.records) outcomes.push(await sink.upsertTeam(record));
          if (batch.complete) sink.completeCatalogues.add("TEAMS");
          break;
        case "EMPLOYEE_COUNTS":
          sink.employeeCounts = { byDepartment: batch.byDepartment, byGroup: batch.byGroup };
          break;
        case "EMPLOYEES":
          for (const record of batch.records) outcomes.push(await sink.upsertEmployee(record));
          break;
        case "EMPLOYEE_STATUS":
          for (const record of batch.records)
            sink.employeeStatuses.set(record.externalId, record.status);
          break;
        case "HIDDEN_DAYS":
          for (const day of batch.days)
            sink.hiddenDays.add(`${day.externalDepartmentId}:${day.date}`);
          break;
        case "SHIFTS":
          for (const record of batch.records) outcomes.push(await sink.upsertShift(record));
          break;
        case "SHIFT_REMOVALS":
          for (const record of batch.records)
            sink.shiftRemovals.set(record.externalId, record.reason);
          break;
        case "CLOCK_EVENTS":
          for (const record of batch.records) outcomes.push(await sink.recordClockEvent(record));
          break;
      }
      return outcomes;
    },
  };
  return sink;
}

export interface MemoryRunResult {
  /** The phases the provider ran (database-only phases and FINALISE excluded). */
  readonly phases: SyncPhase[];
  readonly steps: number;
  readonly requests: number;
  readonly warnings: SyncError[];
  /** Each step's phase and cursor, in order. */
  readonly cursors: Array<{ phase: SyncPhase; cursor: Readonly<Record<string, unknown>> }>;
}

/**
 * Drives every provider phase of `kind` to completion into `sink`, the way the run executor does but without a
 * database: each step's batch is applied before the next step starts with the returned cursor. Database-only phases
 * call `onDatabasePhase` (default: nothing); FINALISE ends the run. `inputsFor` supplies `PhaseInputs` per phase.
 */
export async function runPhasesInMemory(
  provider: ResumableWorkforceProvider,
  ctx: ProviderContext,
  sink: MemorySink,
  options: {
    readonly kind: IntegrationSyncRunKind;
    readonly phaseOptions?: PhaseOptions;
    readonly inputsFor?: (phase: SyncPhase, sink: MemorySink) => PhaseInputs;
    readonly onDatabasePhase?: (phase: SyncPhase, sink: MemorySink) => void | Promise<void>;
    readonly maxSteps?: number;
  },
): Promise<MemoryRunResult> {
  const phases: SyncPhase[] = [];
  const warnings: SyncError[] = [];
  const cursors: Array<{ phase: SyncPhase; cursor: Readonly<Record<string, unknown>> }> = [];
  const maxSteps = options.maxSteps ?? 10_000;
  let steps = 0;
  let requests = 0;
  const list = provider.phasesFor(
    options.kind,
    options.phaseOptions ?? { clockEvents: false, hiddenDays: false },
  );
  for (const phase of list) {
    if (phase === "FINALISE") break;
    if (isDatabaseOnlyPhase(phase)) {
      await options.onDatabasePhase?.(phase, sink);
      continue;
    }
    phases.push(phase);
    let cursor: Readonly<Record<string, unknown>> = {};
    for (;;) {
      if (steps >= maxSteps) throw new Error(`runPhasesInMemory: more than ${maxSteps} steps`);
      const inputs = options.inputsFor?.(phase, sink) ?? {};
      const step = await provider.runPhaseStep(ctx, phase, cursor, inputs);
      steps++;
      requests += step.requests;
      warnings.push(...(step.warnings ?? []));
      cursors.push({ phase, cursor: step.cursor });
      if (step.batch) await sink.apply(step.batch);
      if (step.done) break;
      cursor = step.cursor;
    }
  }
  return { phases, steps, requests, warnings, cursors };
}
