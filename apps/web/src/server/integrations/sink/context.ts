import type { ActivityEvent, IntegrationSyncRun, Prisma } from "@clockoff/db";
import type { RecordHasher } from "@clockoff/integrations";
import type {
  ActivationMode,
  IntegrationProvider,
  IntegrationSyncRunKind,
  IntegrationSyncTrigger,
  Plan,
} from "@clockoff/shared/enums";
import type { SyncBatch, SyncError, SyncPhase } from "@clockoff/shared/providers/workforceProvider";
import {
  departmentMappingsSchema,
  groupMappingsSchema,
  plandayCatalogSchema,
  type DepartmentMappings,
  type GroupMappings,
  type PlandayCatalog,
} from "@clockoff/validation/planday";
import type { Logger } from "@/lib/logger";
import {
  publishManagedEmployeeWrite,
  type ManagedEmployeeWriteResult,
} from "@/server/employees/employees.integration";
import {
  publishIntegrationShiftWrite,
  type IntegrationShiftWriteResult,
} from "@/server/shifts/shifts.integration";
import { publishActivity } from "@/server/activity";
import { deliverIntegrationAlerts, type IntegrationAlertDelivery } from "../notifications";
import { publishConnectionStatusChange, type ConnectionStatusChange } from "../status";
import { announceRunQueued } from "../runs/enqueue";
import { RUN_WARNINGS_MAX } from "../runs/constants";

/**
 * What a sink step works with (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.1, §7.6): the run, a snapshot of
 * the connection and the mapping config taken at the start of the slice, the run's persisted executor state, the
 * counts and warnings of the run, and the effects to publish after the step's transaction commits. Nothing in here
 * holds personal data beyond what the step is writing anyway.
 */

type Tx = Prisma.TransactionClient;

// ── Counts and warnings (IntegrationSyncRun.counts / warnings) ─────────────

export interface EntityCounts {
  created: number;
  updated: number;
  cancelled: number;
  skipped: number;
}

export interface ExcludedCounts {
  drafts: number;
  open: number;
  hiddenDays: number;
  unknownStatus: number;
  outOfScope: number;
}

export interface RunCounts {
  employees: EntityCounts;
  locations: EntityCounts;
  teams: EntityCounts;
  shifts: EntityCounts;
  clockEvents: EntityCounts;
  /** Employees waiting in the pending queue after the run (FINALISE). */
  pending: number;
  excluded: ExcludedCounts;
}

export type CountedEntity = "employees" | "locations" | "teams" | "shifts" | "clockEvents";

function emptyEntityCounts(): EntityCounts {
  return { created: 0, updated: 0, cancelled: 0, skipped: 0 };
}

export function emptyRunCounts(): RunCounts {
  return {
    employees: emptyEntityCounts(),
    locations: emptyEntityCounts(),
    teams: emptyEntityCounts(),
    shifts: emptyEntityCounts(),
    clockEvents: emptyEntityCounts(),
    pending: 0,
    excluded: { drafts: 0, open: 0, hiddenDays: 0, unknownStatus: 0, outOfScope: 0 },
  };
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readEntity(value: unknown): EntityCounts {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    created: int(record.created),
    updated: int(record.updated),
    cancelled: int(record.cancelled),
    skipped: int(record.skipped),
  };
}

/** Reads a stored `counts` JSON (missing parts read as zero). */
export function readRunCounts(value: unknown): RunCounts {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const excluded =
    record.excluded && typeof record.excluded === "object"
      ? (record.excluded as Record<string, unknown>)
      : {};
  return {
    employees: readEntity(record.employees),
    locations: readEntity(record.locations),
    teams: readEntity(record.teams),
    shifts: readEntity(record.shifts),
    clockEvents: readEntity(record.clockEvents),
    pending: int(record.pending),
    excluded: {
      drafts: int(excluded.drafts),
      open: int(excluded.open),
      hiddenDays: int(excluded.hiddenDays),
      unknownStatus: int(excluded.unknownStatus),
      outOfScope: int(excluded.outOfScope),
    },
  };
}

/** Whether the run changed anything a manager would see (created, updated or cancelled records). */
export function countsChangedSomething(counts: RunCounts): boolean {
  return (["employees", "locations", "teams", "shifts", "clockEvents"] as const).some(
    (key) => counts[key].created > 0 || counts[key].updated > 0 || counts[key].cancelled > 0,
  );
}

export interface RunWarning {
  code: string;
  /** ClockOff's own words; never personal data. */
  message: string;
  externalId: string | null;
}

export function readRunWarnings(value: unknown): RunWarning[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      code: typeof item.code === "string" ? item.code : "UNKNOWN",
      message: typeof item.message === "string" ? item.message : "",
      externalId: typeof item.externalId === "string" ? item.externalId : null,
    }));
}

/** Counts and warnings of a run, mutated by the sink and persisted with every step. */
export class RunTally {
  readonly counts: RunCounts;
  readonly warnings: RunWarning[];
  /** Warnings added by the current step (for logs). */
  private seen: Set<string>;

  constructor(counts: RunCounts, warnings: RunWarning[]) {
    this.counts = counts;
    this.warnings = warnings;
    this.seen = new Set(warnings.map((w) => RunTally.key(w.code, w.message, w.externalId)));
  }

  count(entity: CountedEntity, outcome: keyof EntityCounts, n = 1): void {
    this.counts[entity][outcome] += n;
  }

  exclude(kind: keyof ExcludedCounts, n = 1): void {
    this.counts.excluded[kind] += n;
  }

  /** A warning about a record is kept once per code and record; one about no record, once per message. */
  private static key(code: string, message: string, externalId: string | null): string {
    return externalId === null ? `${code}|${message}` : `${code}:${externalId}`;
  }

  /** Records a warning once (see `key`); at most RUN_WARNINGS_MAX are kept. */
  warn(code: string, message: string, externalId?: string | null): void {
    const key = RunTally.key(code, message.slice(0, 300), externalId ?? null);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.warnings.length >= RUN_WARNINGS_MAX) return;
    this.warnings.push({ code, message: message.slice(0, 300), externalId: externalId ?? null });
  }

  hasWarnings(): boolean {
    return this.warnings.length > 0;
  }
}

// ── Executor state (persisted in IntegrationSyncRun.cursor.run) ────────────

/**
 * The executor's own state, persisted beside the phase cursor (ids only, small). Emptied with the cursor at the
 * run's terminal write, so no per-run list survives the run (§7.2).
 */
export interface ExecutorState {
  /** The run's phases, fixed at its first slice. */
  phases: SyncPhase[];
  /** Business instant the first slice started: "seen in this run" means `last_seen_at >= startedAt`. */
  startedAt: string;
  /** Pages (provider steps) read so far, and in the current phase. */
  pagesRead: number;
  phasePages: number;
  completed: SyncPhase[];
  /** Guarded phases skipped (the run ends PARTIAL). */
  skipped: SyncPhase[];
  /** The sync window of this run (SCHEDULE_DAYS, SHIFTS, PREVIEW_SHIFTS, ABSENT_SHIFTS). */
  window?: { from: string; to: string };
  /** `<departmentId>:<date>` days hidden from employees (respectHiddenDays). */
  hiddenDays: string[];
  /** Planday ids queued for REACTIVATIONS by the EMPLOYEES phase. */
  reactivate: string[];
  /** Planday ids on this run's deactivated list (any date): never re-checked by id. */
  listed: string[];
  /** Planday ids this run's deactivation phases reported DEACTIVATED (date passed). */
  listedDeactivated: string[];
  /** Ids the ABSENT_* phases re-check, fixed when the phase starts. */
  absentEmployees?: string[];
  absentShifts?: string[];
  /** MATCH_EMPLOYEES: hashed name keys shared by more than one staged person (never a name). */
  namesakes?: Record<string, number>;
  /** MATCH_EMPLOYEES: second pass over duplicate matches. */
  matchPass?: "MATCH" | "DEDUPE";
  /** Pending rows this run created (FINALISE notifies when > 0). */
  newPending: number;
  /** DEACTIVATION_SCHEDULED is reported once per run. */
  scheduledDeactivationWarned?: boolean;
  /** The INITIAL SYNC's replaced conflicts, so FINALISE can list the unresolved ones. */
  replacedShiftIds?: string[];
}

export function newExecutorState(phases: readonly SyncPhase[], startedAt: Date): ExecutorState {
  return {
    phases: [...phases],
    startedAt: startedAt.toISOString(),
    pagesRead: 0,
    phasePages: 0,
    completed: [],
    skipped: [],
    hiddenDays: [],
    reactivate: [],
    listed: [],
    listedDeactivated: [],
    newPending: 0,
  };
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/** The run fields the sink reads. */
export type SinkRun = Pick<
  IntegrationSyncRun,
  | "id"
  | "organisationId"
  | "integrationId"
  | "kind"
  | "trigger"
  | "requestedByUserId"
  | "replaceShiftIds"
  | "retryAuth"
  | "mappingVersion"
> & { kind: IntegrationSyncRunKind; trigger: IntegrationSyncTrigger };

/** `IntegrationMappingConfig`, parsed. */
export interface MappingSnapshot {
  includedDepartmentIds: string[];
  excludedEmployeeIds: string[];
  /** Mappings whose ClockOff target exists (what employee and shift decisions resolve through). */
  departmentMappings: DepartmentMappings;
  groupMappings: GroupMappings;
  /** The mappings as stored (the structure phases warn about targets that no longer exist). */
  storedDepartmentMappings: DepartmentMappings;
  storedGroupMappings: GroupMappings;
  autoIncludeNewEmployees: boolean;
  importEmails: boolean;
  syncWindowDays: number;
  respectHiddenDays: boolean;
  catalog: PlandayCatalog;
  mappingVersion: number;
  onboardingCompletedAt: Date | null;
}

export function parseMappingSnapshot(row: {
  includedDepartmentIds: string[];
  excludedEmployeeIds: string[];
  departmentMappings: Prisma.JsonValue;
  groupMappings: Prisma.JsonValue;
  autoIncludeNewEmployees: boolean;
  importEmails: boolean;
  syncWindowDays: number;
  respectHiddenDays: boolean;
  catalog: Prisma.JsonValue;
  mappingVersion: number;
  onboardingCompletedAt: Date | null;
}): MappingSnapshot {
  const departmentMappings = departmentMappingsSchema.parse(row.departmentMappings ?? {});
  const groupMappings = groupMappingsSchema.parse(row.groupMappings ?? {});
  return {
    includedDepartmentIds: [...new Set(row.includedDepartmentIds)],
    excludedEmployeeIds: [...new Set(row.excludedEmployeeIds)],
    departmentMappings,
    groupMappings,
    storedDepartmentMappings: departmentMappings,
    storedGroupMappings: groupMappings,
    autoIncludeNewEmployees: row.autoIncludeNewEmployees,
    importEmails: row.importEmails,
    syncWindowDays: row.syncWindowDays,
    respectHiddenDays: row.respectHiddenDays,
    catalog: plandayCatalogSchema.parse(row.catalog ?? {}),
    mappingVersion: row.mappingVersion,
    onboardingCompletedAt: row.onboardingCompletedAt,
  };
}

/** The empty mapping (a wizard run before step 3 saved anything). */
export function emptyMappingSnapshot(): MappingSnapshot {
  return parseMappingSnapshot({
    includedDepartmentIds: [],
    excludedEmployeeIds: [],
    departmentMappings: {},
    groupMappings: {},
    autoIncludeNewEmployees: true,
    importEmails: true,
    syncWindowDays: 28,
    respectHiddenDays: false,
    catalog: {},
    mappingVersion: 1,
    onboardingCompletedAt: null,
  });
}

// ── After-commit effects ─────────────────────────────────────────────────────

export interface SinkEffects {
  shiftWrites: IntegrationShiftWriteResult[];
  employeeWrites: ManagedEmployeeWriteResult[];
  activities: ActivityEvent[];
  alerts: IntegrationAlertDelivery[];
  statusChanges: Array<ConnectionStatusChange | null>;
  queuedRuns: IntegrationSyncRun[];
}

export function emptySinkEffects(): SinkEffects {
  return {
    shiftWrites: [],
    employeeWrites: [],
    activities: [],
    alerts: [],
    statusChanges: [],
    queuedRuns: [],
  };
}

/** After the step's transaction committed: activities, SCHEDULE_CHANGED, device hints, alerts, health, queued runs. */
export function publishSinkEffects(
  organisationId: string,
  provider: IntegrationProvider,
  effects: SinkEffects,
): void {
  for (const write of effects.shiftWrites) publishIntegrationShiftWrite(organisationId, write);
  for (const write of effects.employeeWrites) publishManagedEmployeeWrite(organisationId, write);
  for (const event of effects.activities) publishActivity(event);
  deliverIntegrationAlerts(...effects.alerts);
  for (const change of effects.statusChanges) publishConnectionStatusChange(change);
  for (const run of effects.queuedRuns) announceRunQueued(run, provider);
}

// ── The context ──────────────────────────────────────────────────────────────

export interface SinkContext {
  readonly run: SinkRun;
  readonly organisationId: string;
  readonly integrationId: string;
  readonly provider: IntegrationProvider;
  /** The connection's portal (`externalPortalId`). */
  readonly portalId: string;
  /** IANA zone of the portal; null when Planday gave none ClockOff can use. */
  readonly portalTimezone: string | null;
  readonly activationMode: ActivationMode;
  readonly plan: Plan;
  readonly config: MappingSnapshot;
  /** The slice's `credential_version` (fences connection writes). */
  readonly credentialVersion: () => number;
  /** Business instant of this step. */
  readonly now: Date;
  readonly hasher: RecordHasher;
  readonly state: ExecutorState;
  readonly tally: RunTally;
  readonly effects: SinkEffects;
  readonly log: Logger;
}

/** The result of one database-only phase step. */
export interface DatabasePhaseStepResult {
  done: boolean;
  cursor: Record<string, unknown>;
}

/** What a phase transition may ask for: skip the phase (its inputs are empty, or a guarded phase must not run). */
export interface EnterPhaseResult {
  skip: boolean;
  /** A guarded phase skipped for a reason that makes the run PARTIAL. */
  partial?: boolean;
}

/** The two sinks' common surface (§6.1). Every method runs inside the step's fenced transaction. */
export interface RunSink {
  /** Applies one provider batch (at most one page) and the step's warnings. */
  apply(
    tx: Tx,
    ctx: SinkContext,
    phase: SyncPhase,
    step: {
      readonly batch?: SyncBatch;
      readonly done: boolean;
      readonly cursor: Readonly<Record<string, unknown>>;
      readonly warnings?: readonly SyncError[];
    },
  ): Promise<void>;
  /** One batch of a database-only phase (MATCH_EMPLOYEES, REACTIVATIONS, APPLY_EMPLOYEES). */
  runDatabasePhaseStep(
    tx: Tx,
    ctx: SinkContext,
    phase: SyncPhase,
    cursor: Readonly<Record<string, unknown>>,
  ): Promise<DatabasePhaseStepResult>;
  /** Called in the transaction that completed the previous phase, before `phase` starts. */
  enterPhase(tx: Tx, ctx: SinkContext, phase: SyncPhase): Promise<EnterPhaseResult>;
  /** FINALISE's sink work (inside the terminal transaction, before the run row is written). */
  finalise(tx: Tx, ctx: SinkContext): Promise<void>;
}
