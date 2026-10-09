import { randomUUID } from "node:crypto";
import { prisma, Prisma, type IntegrationSyncRun } from "@clockoff/db";
import type {
  IntegrationProvider,
  IntegrationSyncRunKind,
  IntegrationSyncTrigger,
} from "@clockoff/shared/enums";
import { setConnectionStatus, type ConnectionStatusChange } from "../status";
import { LEASE_TTL_MS } from "./constants";
import { enqueueRun, recoveryBackoffMs, type EnqueueRunResult } from "./enqueue";
import type { RunProgress } from "./progress";

/**
 * SQL of the run queue and the per-portal lease (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §7.3, §7.4, §7.6).
 * Leases live on `integration_connections.sync_lease_*` and use the database clock; the holder uuid doubles as the
 * fencing token every slice write checks. Run rows are written only while `status = 'RUNNING'`.
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

function ttlSeconds(ttlMs: number): number {
  return ttlMs / 1000;
}

// ── Leases (§7.4) ───────────────────────────────────────────────────────────

/** Takes the portal's lease for `holder` (free, expired or already this holder's). */
export async function acquireLease(
  integrationId: string,
  holder: string,
  ttlMs: number = LEASE_TTL_MS,
  db: Db = prisma,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE integration_connections
       SET sync_lease_id = ${holder}::uuid,
           sync_lease_expires_at = now() + make_interval(secs => ${ttlSeconds(ttlMs)}::double precision)
     WHERE integration_id = ${integrationId}::uuid
       AND (sync_lease_id IS NULL OR sync_lease_expires_at < now() OR sync_lease_id = ${holder}::uuid)
    RETURNING id::text AS id`;
  return rows.length > 0;
}

/** Renews the lease while `holder` still holds it; false means it was lost (expired, taken or cleared). */
export async function renewLease(
  db: Db,
  integrationId: string,
  holder: string,
  ttlMs: number = LEASE_TTL_MS,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE integration_connections
       SET sync_lease_expires_at = now() + make_interval(secs => ${ttlSeconds(ttlMs)}::double precision)
     WHERE integration_id = ${integrationId}::uuid
       AND sync_lease_id = ${holder}::uuid
       AND sync_lease_expires_at > now()
    RETURNING id::text AS id`;
  return rows.length > 0;
}

/** Releases the lease if `holder` still has it. */
export async function releaseLease(
  integrationId: string,
  holder: string,
  db: Db = prisma,
): Promise<void> {
  await db.$executeRaw`
    UPDATE integration_connections SET sync_lease_id = NULL, sync_lease_expires_at = NULL
     WHERE integration_id = ${integrationId}::uuid AND sync_lease_id = ${holder}::uuid`;
}

// ── Claims (§7.3) ───────────────────────────────────────────────────────────

export interface ClaimedRun {
  runId: string;
  integrationId: string;
  organisationId: string;
  kind: IntegrationSyncRunKind;
  trigger: IntegrationSyncTrigger;
  /** The lease token: pass it to `runSyncSlice`, which renews and finally releases it. */
  holder: string;
}

export interface ClaimDueRunsResult {
  claimed: ClaimedRun[];
  /** The earliest future `resume_after` among active runs (the runner's next timer). */
  nextResumeAt: Date | null;
}

/**
 * Claims up to `limit` due runs of AVAILABLE providers whose portal is not leased: queued interactive runs first, then
 * every started run round-robin at the scheduled level by when it last got service (§7.3). Each claim takes the
 * portal's lease (a single conditional UPDATE, so two workers never both win) and stamps the run.
 */
export async function claimDueRuns(input: {
  limit: number;
  providers: readonly IntegrationProvider[];
  instanceId: string;
  db?: typeof prisma;
}): Promise<ClaimDueRunsResult> {
  const db = input.db ?? prisma;
  const nextRows = await db.$queryRaw<Array<{ next: Date | null }>>`
    SELECT min(resume_after) AS next FROM integration_sync_runs
     WHERE status = 'RUNNING' AND resume_after > now()`;
  const nextResumeAt = nextRows[0]?.next ?? null;
  if (input.limit <= 0 || input.providers.length === 0) return { claimed: [], nextResumeAt };
  const providers = [...input.providers];
  const candidates = await db.$queryRaw<
    Array<{
      id: string;
      integration_id: string;
      organisation_id: string;
      kind: IntegrationSyncRunKind;
      trigger: IntegrationSyncTrigger;
    }>
  >`
    SELECT r.id::text AS id, r.integration_id::text AS integration_id,
           r.organisation_id::text AS organisation_id, r.kind::text AS kind, r.trigger::text AS trigger
      FROM integration_sync_runs r
      JOIN integrations i ON i.id = r.integration_id
      JOIN integration_connections c ON c.integration_id = r.integration_id
     WHERE r.status = 'RUNNING'
       AND i.provider = ANY(${providers}::"IntegrationProvider"[])
       AND (r.resume_after IS NULL OR r.resume_after <= now())
       AND (c.sync_lease_id IS NULL OR c.sync_lease_expires_at < now())
     ORDER BY CASE WHEN r.first_claimed_at IS NULL THEN r.priority ELSE GREATEST(r.priority, 3) END,
              COALESCE(r.last_slice_at, r.created_at)
     LIMIT ${input.limit * 3}`;
  const claimed: ClaimedRun[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= input.limit) break;
    const holder = randomUUID();
    if (!(await acquireLease(candidate.integration_id, holder, LEASE_TTL_MS, db))) continue;
    const stamped = await db.$queryRaw<Array<{ id: string }>>`
      UPDATE integration_sync_runs
         SET claimed_by = ${input.instanceId.slice(0, 128)},
             first_claimed_at = COALESCE(first_claimed_at, now()), updated_at = now()
       WHERE id = ${candidate.id}::uuid AND status = 'RUNNING'
      RETURNING id::text AS id`;
    if (stamped.length === 0) {
      await releaseLease(candidate.integration_id, holder, db);
      continue;
    }
    claimed.push({
      runId: candidate.id,
      integrationId: candidate.integration_id,
      organisationId: candidate.organisation_id,
      kind: candidate.kind,
      trigger: candidate.trigger,
      holder,
    });
  }
  return { claimed, nextResumeAt };
}

// ── Run rows (§7.6) ─────────────────────────────────────────────────────────

/** Fence 1 of every slice transaction: the run is still RUNNING (heartbeat stamped). */
export async function fenceRun(tx: Tx, runId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE integration_sync_runs SET heartbeat_at = now(), updated_at = now()
     WHERE id = ${runId}::uuid AND status = 'RUNNING'
    RETURNING id::text AS id`;
  return rows.length > 0;
}

export interface RunStepWrite {
  phase: string;
  cursor: Prisma.InputJsonValue;
  counts: Prisma.InputJsonValue;
  warnings: Prisma.InputJsonValue;
  progress: RunProgress;
  requestCount: number;
}

/** The step's run-row write (same transaction as the step's records): cursor, counts, progress; `attempt = 0`. */
export async function persistStep(tx: Tx, runId: string, step: RunStepWrite): Promise<void> {
  await tx.integrationSyncRun.update({
    where: { id: runId },
    data: {
      phase: step.phase,
      cursor: step.cursor,
      counts: step.counts,
      warnings: step.warnings,
      progress: step.progress as unknown as Prisma.InputJsonValue,
      requestCount: step.requestCount,
      attempt: 0,
      resumeAfter: null,
    },
  });
}

/** Keeps the run RUNNING, not claimable before `resumeAfter` (rate limit, retry backoff; §7.6). */
export async function parkRun(
  tx: Tx,
  runId: string,
  input: { resumeAfter: Date; attempt: number; progress: RunProgress },
): Promise<void> {
  await tx.integrationSyncRun.update({
    where: { id: runId },
    data: {
      resumeAfter: input.resumeAfter,
      attempt: input.attempt,
      progress: input.progress as unknown as Prisma.InputJsonValue,
    },
  });
}

/** The run fields the terminal write and its follow-up rules read. */
export type TerminalRun = Pick<
  IntegrationSyncRun,
  | "id"
  | "organisationId"
  | "integrationId"
  | "kind"
  | "trigger"
  | "requestedByUserId"
  | "mappingVersion"
>;

export interface TerminalRunWrite {
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  errorCode?: string | null;
  errorMessage?: string | null;
  counts?: Prisma.InputJsonValue;
  warnings?: Prisma.InputJsonValue;
  progress?: RunProgress;
  requestCount?: number;
}

/** The terminal write (`cursor = {}`: no per-run list survives the run). False when the run had already ended. */
export async function writeTerminalRun(
  tx: Tx,
  runId: string,
  input: TerminalRunWrite,
): Promise<boolean> {
  const result = await tx.integrationSyncRun.updateMany({
    where: { id: runId, status: "RUNNING" },
    data: {
      status: input.status,
      finishedAt: new Date(),
      cursor: {},
      resumeAfter: null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ? input.errorMessage.slice(0, 300) : null,
      ...(input.counts !== undefined ? { counts: input.counts } : {}),
      ...(input.warnings !== undefined ? { warnings: input.warnings } : {}),
      ...(input.progress !== undefined
        ? { progress: input.progress as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.requestCount !== undefined ? { requestCount: input.requestCount } : {}),
    },
  });
  return result.count > 0;
}

const FOLLOW_UP_TRIGGER: Partial<Record<IntegrationSyncRunKind, IntegrationSyncTrigger>> = {
  SYNC: "MANUAL",
  DIRECTORY: "INITIAL",
};

/**
 * The FINALISE follow-up rules (§7.2), run in the terminal transaction of every run (finished or failed):
 * 1. the mapping moved while the run ran → a follow-up of the same kind (SYNC → MANUAL SYNC, DIRECTORY →
 *    DIRECTORY; none for STRUCTURE, IMPORT_EMPLOYEES and CLOCK);
 * 2. the connection's pending slot holds a request → inserted when rule 1 queued nothing, simply cleared when rule 1
 *    queued the same kind, left for the rule 1 run otherwise.
 * Returns the runs to announce after commit.
 */
export async function applyRunFollowUps(tx: Tx, run: TerminalRun): Promise<IntegrationSyncRun[]> {
  const rows = await tx.$queryRaw<
    Array<{
      status: string;
      mapping_version: number | null;
      kind: IntegrationSyncRunKind | null;
      trigger: IntegrationSyncTrigger | null;
      retry_auth: boolean;
      requested_by: string | null;
    }>
  >`
    SELECT c.status::text AS status, m.mapping_version,
           c.pending_run_kind::text AS kind, c.pending_run_trigger::text AS trigger,
           c.pending_run_retry_auth AS retry_auth, c.pending_run_requested_by_user_id::text AS requested_by
      FROM integration_connections c
      LEFT JOIN integration_mapping_configs m ON m.integration_id = c.integration_id
     WHERE c.integration_id = ${run.integrationId}::uuid
     FOR UPDATE OF c`;
  const connection = rows[0];
  if (!connection || connection.status === "DISCONNECTED") return [];
  const queued: IntegrationSyncRun[] = [];
  const keep = (result: EnqueueRunResult) => {
    if (result.outcome === "QUEUED") queued.push(result.run);
    return result.outcome === "QUEUED" ? result.run : null;
  };

  let ruleOne: IntegrationSyncRun | null = null;
  const followUpTrigger = FOLLOW_UP_TRIGGER[run.kind];
  if (
    followUpTrigger &&
    connection.mapping_version !== null &&
    connection.mapping_version !== run.mappingVersion
  ) {
    ruleOne = keep(
      await enqueueRun(tx, {
        organisationId: run.organisationId,
        integrationId: run.integrationId,
        kind: run.kind,
        trigger: followUpTrigger,
        requestedByUserId: run.requestedByUserId,
      }),
    );
  }

  if (connection.kind && connection.trigger) {
    const clearSlot = () => tx.$executeRaw`
      UPDATE integration_connections
         SET pending_run_kind = NULL, pending_run_trigger = NULL, pending_run_retry_auth = false,
             pending_run_requested_by_user_id = NULL, pending_run_requested_at = NULL, updated_at = now()
       WHERE integration_id = ${run.integrationId}::uuid`;
    if (!ruleOne) {
      await clearSlot();
      keep(
        await enqueueRun(tx, {
          organisationId: run.organisationId,
          integrationId: run.integrationId,
          kind: connection.kind,
          trigger: connection.trigger,
          retryAuth: connection.retry_auth,
          requestedByUserId: connection.requested_by,
        }),
      );
    } else if (ruleOne.kind === connection.kind) {
      await clearSlot();
      if (connection.retry_auth && !ruleOne.retryAuth) {
        const updated = await tx.integrationSyncRun.update({
          where: { id: ruleOne.id },
          data: { retryAuth: true },
        });
        queued[queued.indexOf(ruleOne)] = updated;
      }
    }
  }
  return queued;
}

export interface FailRunInput extends TerminalRunWrite {
  status: "FAILED";
  errorCode: string;
  errorMessage: string;
  /**
   * SYNC and CLOCK runs only: failure count +1, the error on the connection, SYNCING → CONNECTED (health decides
   * DEGRADED by time). Wizard runs and auth failures touch no connection field here.
   */
  touchConnection: boolean;
  /** SYNC and CLOCK runs only: `nextSyncAt = now + recoveryBackoffMs(consecutiveFailureCount)` (§7.10). */
  scheduleRecovery: boolean;
  /** The slice's `credential_version` (§7.6); omitted by callers that hold no credential store (upkeep). */
  credentialVersion?: number;
  /** Business clock for the recovery time. */
  now: Date;
}

export interface FailRunResult {
  /** False when the run had already ended (nothing written). */
  failed: boolean;
  statusChange: ConnectionStatusChange | null;
  /** Follow-up runs to announce after commit. */
  queued: IntegrationSyncRun[];
}

/**
 * `failRun` (§7.6): the run ends FAILED with a sanitised error and an empty cursor, the follow-up rules run, and for
 * SYNC and CLOCK runs the connection records the failure through compare-and-set writes (status in CONNECTED,
 * SYNCING, DEGRADED at the caller's `credential_version`), so a run a disconnect or reconnect overtook writes nothing
 * on the connection.
 */
export async function failRun(
  tx: Tx,
  run: TerminalRun,
  input: FailRunInput,
): Promise<FailRunResult> {
  const failed = await writeTerminalRun(tx, run.id, input);
  if (!failed) return { failed, statusChange: null, queued: [] };
  let statusChange: ConnectionStatusChange | null = null;
  const connectionRun = run.kind === "SYNC" || run.kind === "CLOCK";
  if (connectionRun && input.touchConnection) {
    statusChange = await setConnectionStatus(tx, run.integrationId, "CONNECTED", {
      from: ["SYNCING"],
      ...(input.credentialVersion !== undefined
        ? { credentialVersion: input.credentialVersion }
        : {}),
      reason: input.errorCode,
    });
    const versionGuard =
      input.credentialVersion === undefined
        ? Prisma.empty
        : Prisma.sql`AND credential_version = ${input.credentialVersion}`;
    const counted = await tx.$queryRaw<Array<{ failures: number }>>`
      UPDATE integration_connections
         SET consecutive_failure_count = consecutive_failure_count + 1,
             last_error_code = ${input.errorCode},
             last_error = ${input.errorMessage.slice(0, 300)},
             updated_at = now()
       WHERE integration_id = ${run.integrationId}::uuid
         AND status IN ('CONNECTED', 'SYNCING', 'DEGRADED')
         ${versionGuard}
      RETURNING consecutive_failure_count AS failures`;
    const failures = counted[0]?.failures;
    const backoff = failures === undefined ? null : recoveryBackoffMs(failures);
    if (input.scheduleRecovery && backoff !== null) {
      await tx.$executeRaw`
        UPDATE integration_connections
           SET next_sync_at = ${new Date(input.now.getTime() + backoff)}::timestamptz, updated_at = now()
         WHERE integration_id = ${run.integrationId}::uuid
           AND status IN ('CONNECTED', 'SYNCING', 'DEGRADED')
           ${versionGuard}`;
    }
  }
  const queued = await applyRunFollowUps(tx, run);
  return { failed, statusChange, queued };
}
