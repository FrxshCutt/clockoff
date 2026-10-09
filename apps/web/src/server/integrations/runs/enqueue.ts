import { prisma, Prisma, type IntegrationSyncRun } from "@clockoff/db";
import { plandayPhasesFor } from "@clockoff/integrations";
import type {
  ActivationMode,
  IntegrationProvider,
  IntegrationSyncRunKind,
  IntegrationSyncTrigger,
} from "@clockoff/shared/enums";
import { AppError } from "@clockoff/shared/errors";
import type { PhaseOptions, SyncPhase } from "@clockoff/shared/providers/workforceProvider";
import { env } from "@/lib/env";
import { publishEvent } from "@/server/events";
import { defaultRunPriority } from "./constants";
import { WAITING_TO_START_LABEL, type RunProgress } from "./progress";

/**
 * The run queue's front door (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §7.3), used by web services and the
 * worker's jobs alike. `integration_sync_runs` is the queue: a run is active while `status = 'RUNNING'` (queued
 * while `first_claimed_at` is null), and the partial unique index `integration_sync_runs_one_running` allows one
 * active run per integration. `enqueueRun` never raises a unique violation, so it is safe inside the caller's
 * transaction; `announceRunQueued` is called after that transaction commits.
 *
 * Rules, in order:
 * 1. Onboarding gate: SYNC and CLOCK runs need `onboardingCompletedAt` (else REFUSED).
 * 2. Insert with `ON CONFLICT … DO NOTHING`; a returned row is QUEUED.
 * 3. An active run exists: the same kind not yet claimed (or a manual "Sync now" while a SYNC is under way) is
 *    ALREADY_RUNNING (an unclaimed run takes the request's retryAuth, replacement ids, priority and earlier
 *    `resume_after`: `mergeIntoQueuedRun`); anything else goes into the connection's one-slot "next run" queue
 *    (FOLLOW_UP_QUEUED), which the active run's terminal write drains.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export interface EnqueueRunInput {
  organisationId: string;
  integrationId: string;
  kind: IntegrationSyncRunKind;
  trigger: IntegrationSyncTrigger;
  requestedByUserId?: string | null;
  /** Default: RUN_PRIORITY by trigger and kind (runs/constants.ts). */
  priority?: number;
  /** Not claimable before this instant (scheduled jitter, recovery backoff). */
  resumeAfter?: Date | null;
  /** Manual auth retry or automatic auth probe (§7.10): the only runs allowed to start on AUTH_ERROR. */
  retryAuth?: boolean;
  /** INITIAL SYNC only (§6.6 Overlaps). */
  replaceShiftIds?: string[];
}

export type EnqueueRunResult =
  | { outcome: "QUEUED"; run: IntegrationSyncRun }
  /** An active run of the same kind exists and has not started yet, or is the same request; nothing inserted. */
  | { outcome: "ALREADY_RUNNING"; run: IntegrationSyncRun }
  /** A run is active: the request went into the connection's pending slot and starts when that run ends. */
  | { outcome: "FOLLOW_UP_QUEUED"; run: IntegrationSyncRun }
  /** SYNC / CLOCK before onboarding is complete: nothing inserted. */
  | { outcome: "REFUSED"; reason: "ONBOARDING_INCOMPLETE" };

/** Phase options for a run (§7.2): clock events only with the Beta flag and clock-in activation; hidden days by setting. */
export function runPhaseOptions(input: {
  activationMode: ActivationMode;
  respectHiddenDays: boolean;
}): PhaseOptions {
  return {
    clockEvents: env().PLANDAY_CLOCK_MODE_ENABLED && input.activationMode === "CLOCK_EVENT",
    hiddenDays: input.respectHiddenDays,
  };
}

/** The phases of a run of `kind` for `provider` (Planday is the only provider with phases). */
export function phasesForRun(
  provider: IntegrationProvider,
  kind: IntegrationSyncRunKind,
  options: PhaseOptions,
): readonly SyncPhase[] {
  return provider === "PLANDAY" ? plandayPhasesFor(kind, options) : [];
}

/** The "Waiting to start" progress a new run is inserted with. */
export function queuedProgress(totalPhases: number): RunProgress {
  return { completedPhases: 0, totalPhases, label: WAITING_TO_START_LABEL, pagesRead: 0 };
}

/** The connection's one-slot "next run" request (§7.3). */
export interface PendingRunSlot {
  kind: IntegrationSyncRunKind;
  trigger: IntegrationSyncTrigger;
  retryAuth: boolean;
  requestedByUserId: string | null;
}

/**
 * Merges a request into the slot: a SYNC replaces a CLOCK (a SYNC includes clock events) and a wizard kind; a
 * CLOCK never replaces another kind; a wizard kind replaces an older wizard kind but never a SYNC; the same kind
 * keeps the request with the higher priority; a `retryAuth` flag is never dropped.
 */
export function mergePendingSlot(
  existing: PendingRunSlot | null,
  request: PendingRunSlot,
): PendingRunSlot {
  if (!existing) return request;
  const retryAuth = existing.retryAuth || request.retryAuth;
  let winner: PendingRunSlot;
  if (existing.kind === request.kind) {
    winner =
      defaultRunPriority(request.kind, request.trigger) <
      defaultRunPriority(existing.kind, existing.trigger)
        ? request
        : existing;
  } else if (request.kind === "CLOCK") {
    winner = existing;
  } else if (existing.kind === "CLOCK" || request.kind === "SYNC") {
    winner = request;
  } else if (existing.kind === "SYNC") {
    winner = existing;
  } else {
    winner = request;
  }
  return { ...winner, retryAuth };
}

async function insertRun(
  db: Db,
  input: EnqueueRunInput,
  context: { mappingVersion: number; totalPhases: number },
): Promise<string | null> {
  const priority = input.priority ?? defaultRunPriority(input.kind, input.trigger);
  const progress = JSON.stringify(queuedProgress(context.totalPhases));
  const replaceShiftIds = [...new Set(input.replaceShiftIds ?? [])];
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO integration_sync_runs
      (organisation_id, integration_id, trigger, kind, status, priority, mapping_version, retry_auth,
       replace_shift_ids, resume_after, requested_by_user_id, progress, updated_at)
    VALUES (${input.organisationId}::uuid, ${input.integrationId}::uuid,
            ${input.trigger}::"IntegrationSyncTrigger", ${input.kind}::"IntegrationSyncRunKind", 'RUNNING',
            ${priority}::smallint, ${context.mappingVersion}, ${input.retryAuth === true},
            ${replaceShiftIds}::uuid[], ${input.resumeAfter ?? null}::timestamptz,
            ${input.requestedByUserId ?? null}::uuid, ${progress}::jsonb, now())
    ON CONFLICT (integration_id) WHERE status = 'RUNNING' DO NOTHING
    RETURNING id::text AS id`;
  return rows[0]?.id ?? null;
}

async function writePendingSlot(
  db: Db,
  integrationId: string,
  request: PendingRunSlot,
): Promise<void> {
  const rows = await db.$queryRaw<
    Array<{
      kind: IntegrationSyncRunKind | null;
      trigger: IntegrationSyncTrigger | null;
      retry_auth: boolean;
      requested_by: string | null;
    }>
  >`
    SELECT pending_run_kind::text AS kind, pending_run_trigger::text AS trigger,
           pending_run_retry_auth AS retry_auth, pending_run_requested_by_user_id::text AS requested_by
      FROM integration_connections WHERE integration_id = ${integrationId}::uuid FOR UPDATE`;
  const current = rows[0];
  if (!current) {
    throw new AppError("INTEGRATION_NOT_CONNECTED", "The integration has no connection");
  }
  const existing: PendingRunSlot | null =
    current.kind && current.trigger
      ? {
          kind: current.kind,
          trigger: current.trigger,
          retryAuth: current.retry_auth,
          requestedByUserId: current.requested_by,
        }
      : null;
  const merged = mergePendingSlot(existing, request);
  await db.$executeRaw`
    UPDATE integration_connections
       SET pending_run_kind = ${merged.kind}::"IntegrationSyncRunKind",
           pending_run_trigger = ${merged.trigger}::"IntegrationSyncTrigger",
           pending_run_retry_auth = ${merged.retryAuth},
           pending_run_requested_by_user_id = ${merged.requestedByUserId}::uuid,
           pending_run_requested_at = now(),
           updated_at = now()
     WHERE integration_id = ${integrationId}::uuid`;
}

/**
 * What a request adds to an unclaimed run of the same kind (null: nothing): `retryAuth`, the replacement shift ids,
 * and the request's urgency, so "Sync now" merged into a queued scheduled run starts as soon as a new manual run
 * would (§7.10): the lower priority number, and the earlier `resume_after` (none when either has none).
 */
export function mergeIntoQueuedRun(
  active: Pick<IntegrationSyncRun, "retryAuth" | "replaceShiftIds" | "priority" | "resumeAfter">,
  input: Pick<
    EnqueueRunInput,
    "kind" | "trigger" | "priority" | "resumeAfter" | "retryAuth" | "replaceShiftIds"
  >,
): Prisma.IntegrationSyncRunUpdateManyMutationInput | null {
  const data: Prisma.IntegrationSyncRunUpdateManyMutationInput = {};
  if (input.retryAuth && !active.retryAuth) data.retryAuth = true;
  const extraShiftIds = (input.replaceShiftIds ?? []).filter(
    (shiftId) => !active.replaceShiftIds.includes(shiftId),
  );
  if (extraShiftIds.length > 0) {
    data.replaceShiftIds = [...active.replaceShiftIds, ...new Set(extraShiftIds)];
  }
  const priority = input.priority ?? defaultRunPriority(input.kind, input.trigger);
  if (priority < active.priority) data.priority = priority;
  if (active.resumeAfter !== null) {
    const requested = input.resumeAfter ?? null;
    if (requested === null) data.resumeAfter = null;
    else if (requested.getTime() < active.resumeAfter.getTime()) data.resumeAfter = requested;
  }
  return Object.keys(data).length > 0 ? data : null;
}

/** Safe inside the caller's transaction: never raises a unique violation. */
export async function enqueueRun(db: Db, input: EnqueueRunInput): Promise<EnqueueRunResult> {
  const integration = await db.integration.findFirst({
    where: { id: input.integrationId, organisationId: input.organisationId },
    select: {
      provider: true,
      activationMode: true,
      mappingConfig: {
        select: { onboardingCompletedAt: true, mappingVersion: true, respectHiddenDays: true },
      },
    },
  });
  if (!integration) throw new AppError("NOT_FOUND", "Integration not found");
  const config = integration.mappingConfig;
  if ((input.kind === "SYNC" || input.kind === "CLOCK") && !config?.onboardingCompletedAt) {
    return { outcome: "REFUSED", reason: "ONBOARDING_INCOMPLETE" };
  }
  const totalPhases = phasesForRun(
    integration.provider,
    input.kind,
    runPhaseOptions({
      activationMode: integration.activationMode,
      respectHiddenDays: config?.respectHiddenDays ?? false,
    }),
  ).length;
  const context = { mappingVersion: config?.mappingVersion ?? 1, totalPhases };

  // The active run may finish between the insert and the select: try again (bounded).
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = await insertRun(db, input, context);
    if (id) {
      return {
        outcome: "QUEUED",
        run: await db.integrationSyncRun.findUniqueOrThrow({ where: { id } }),
      };
    }
    const active = await db.integrationSyncRun.findFirst({
      where: { integrationId: input.integrationId, status: "RUNNING" },
    });
    if (!active) continue;
    if (active.kind === input.kind && active.firstClaimedAt === null) {
      const merge = mergeIntoQueuedRun(active, input);
      if (merge) {
        // Only while the run is still unclaimed: a slice that took it meanwhile owns `resume_after` (park, backoff).
        const { count } = await db.integrationSyncRun.updateMany({
          where: { id: active.id, status: "RUNNING", firstClaimedAt: null },
          data: merge,
        });
        if (count === 0) continue;
        return {
          outcome: "ALREADY_RUNNING",
          run: await db.integrationSyncRun.findUniqueOrThrow({ where: { id: active.id } }),
        };
      }
      return { outcome: "ALREADY_RUNNING", run: active };
    }
    if (active.kind === input.kind && input.trigger === "MANUAL" && !input.retryAuth) {
      // A mapping change made meanwhile is caught by FINALISE's follow-up rule (§7.2).
      return { outcome: "ALREADY_RUNNING", run: active };
    }
    await writePendingSlot(db, input.integrationId, {
      kind: input.kind,
      trigger: input.trigger,
      retryAuth: input.retryAuth === true,
      requestedByUserId: input.requestedByUserId ?? null,
    });
    return { outcome: "FOLLOW_UP_QUEUED", run: active };
  }
  throw new Error("enqueueRun: the active run kept changing");
}

/** Call after COMMIT only: publishes `integration.run.queued` (runner wake-up; dashboards refetch). */
export function announceRunQueued(
  run: Pick<IntegrationSyncRun, "id" | "organisationId" | "integrationId" | "kind" | "trigger">,
  provider: IntegrationProvider = "PLANDAY",
): void {
  publishEvent({
    type: "integration.run.queued",
    organisationId: run.organisationId,
    payload: {
      provider,
      integrationId: run.integrationId,
      runId: run.id,
      kind: run.kind,
      trigger: run.trigger,
    },
  });
}

const MINUTE_MS = 60_000;
/** Recovery backoff (§7.10): 1, 2, 5 and 10 minutes for 1 to 4 consecutive failures; none from 5 on. */
const RECOVERY_BACKOFF_MS = [MINUTE_MS, 2 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS] as const;

/**
 * When the RECOVERY run is due after `consecutiveFailureCount` failures, or null from 5 on (the quarter-hour
 * schedule continues, so recovery is never slower than the schedule).
 */
export function recoveryBackoffMs(consecutiveFailureCount: number): number | null {
  if (!Number.isInteger(consecutiveFailureCount) || consecutiveFailureCount < 1) return null;
  return RECOVERY_BACKOFF_MS[consecutiveFailureCount - 1] ?? null;
}

/**
 * The wait before the next automatic auth probe after `attempts` probes (§7.9 step 3): 5 minutes after entering
 * AUTH_ERROR, 15 minutes after the first probe, then hourly.
 */
export function probeBackoffMs(attempts: number): number {
  if (attempts <= 0) return 5 * MINUTE_MS;
  if (attempts === 1) return 15 * MINUTE_MS;
  return 60 * MINUTE_MS;
}
