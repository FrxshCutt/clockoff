import { prisma, Prisma, type IntegrationSyncRun } from "@clockoff/db";
import {
  fullJitterBackoff,
  isAbortError,
  isPlandayAuthError,
  isPlandayError,
  isPlandayPortalMismatchError,
  isPlandayRateLimitedError,
  RUN_REQUEST_BUDGET,
  type PlandayPhaseSettings,
} from "@clockoff/integrations";
import type { IntegrationProvider } from "@clockoff/shared/enums";
import { isAppError } from "@clockoff/shared/errors";
import {
  isCredentialsWipedError,
  isDatabaseOnlyPhase,
  isLeaseLostError,
  LeaseLostError,
  type PhaseInputs,
  type PhaseStepResult,
  type ProviderContext,
  type ResumableWorkforceProvider,
  type SyncPhase,
} from "@clockoff/shared/providers/workforceProvider";
import { recordActivity } from "@/server/activity";
import { env } from "@/lib/env";
import { childLogger, errorSummary, type Logger } from "@/lib/logger";
import { createPrismaCredentialStore, isTransientDatabaseError } from "../credentials";
import { enterAuthError } from "../health";
import { recordHasher } from "../hasher";
import type { AuthErrorReason } from "../notifications";
import {
  availableResumableProvider,
  ensureProvidersRegistered,
  toProviderLogger,
} from "../providers";
import { setConnectionStatus } from "../status";
import { plandayTransportClock } from "../transport";
import { createApplySink } from "../sink/applySink";
import {
  countsChangedSomething,
  emptySinkEffects,
  newExecutorState,
  publishSinkEffects,
  readRunCounts,
  readRunWarnings,
  RunTally,
  type ExecutorState,
  type MappingSnapshot,
  type RunCounts,
  type RunSink,
  type RunWarning,
  type SinkContext,
  type SinkEffects,
} from "../sink/context";
import { loadMappingSnapshot } from "../sink/load";
import { createStagingSink } from "../sink/stagingSink";
import {
  LEASE_RENEW_MS,
  RUN_RETRY_ATTEMPTS,
  RUN_RETRY_BACKOFF,
  SLICE_MAX_MS,
  STEP_TRANSACTION_MAX_WAIT_MS,
  STEP_TRANSACTION_TIMEOUT_MS,
} from "./constants";
import { phasesForRun, runPhaseOptions } from "./enqueue";
import {
  FINISHED_LABELS,
  forgetRunProgress,
  parkedLabel,
  phaseLabel,
  publishRunProgress,
  readRunProgress,
  type RunProgress,
} from "./progress";
import {
  applyRunFollowUps,
  failRun,
  fenceRun,
  parkRun,
  persistStep,
  releaseLease,
  renewLease,
  writeTerminalRun,
  type TerminalRun,
} from "./runs.repository";

/**
 * `runSyncSlice` (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §7.6): executes one slice of a queued run under
 * the portal's lease. A step reads one Planday page (or one batch of a database-only phase) with no transaction open,
 * then applies it and writes the run's cursor, counts, warnings and progress in one short transaction fenced by the
 * run status and the lease; replaying a step is a no-op (§6.2). The slice yields after `maxMs`, on shutdown and when
 * the lease is lost; it parks on a rate limit or a retryable failure; it fails the run on an auth failure (with the
 * connection's AUTH_ERROR), on an unreadable answer or after three retryable failures. Every write — steps, park,
 * fail, finalise and the connection-status changes they carry — goes through the fence, and every connection write
 * is a compare-and-set at the slice's `credential_version`, so a run a disconnect, a Finish or the upkeep job ended
 * (or a slice that lost its lease) writes nothing.
 *
 * Only the worker's integration runner and the tests call it (`src/deploy/processBoundaries.test.ts`).
 */

export type SliceOutcome =
  | { state: "DONE"; status: "SUCCEEDED" | "PARTIAL" | "FAILED"; steps: number; requests: number }
  | {
      state: "YIELDED";
      reason: "SLICE_TIME" | "SHUTDOWN" | "LEASE_LOST";
      steps: number;
      requests: number;
    }
  | {
      state: "PARKED";
      reason: "RATE_LIMITED" | "RETRY_BACKOFF";
      resumeAfter: Date;
      steps: number;
      requests: number;
    }
  | { state: "SKIPPED"; reason: "NOT_RUNNING" | "PROVIDER_UNAVAILABLE" };

export interface RunSliceOptions {
  /** Lease token from claimDueRuns (or a test holder); the slice renews and finally releases it. */
  holder: string;
  instanceId: string;
  signal: AbortSignal;
  maxMs?: number;
  now?: () => Date;
  log?: Logger;
}

/** The run was ended (or never queued) by someone else while the slice ran: stop, write nothing. */
class RunCancelledError extends Error {
  constructor() {
    super("The run is no longer running");
    this.name = "RunCancelledError";
  }
}

/** Run error messages: ClockOff's own words, never Planday response text (≤ 300 characters). */
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  PLANDAY_AUTH_FAILED: "Planday refused ClockOff's credentials. Reconnect Planday.",
  PLANDAY_SCOPE_MISSING:
    "The Planday app is missing a permission ClockOff needs. Reconnect Planday.",
  INTEGRATION_PORTAL_MISMATCH:
    "The Planday credentials now open a different portal. Reconnect Planday.",
  MOCK_CONNECTION_IN_LIVE_MODE:
    "This connection was made against Mock Planday and cannot reach Planday. Reconnect Planday.",
  PLANDAY_UNAVAILABLE: "Planday could not be reached. ClockOff will try again.",
  PLANDAY_RATE_LIMITED: "Planday's rate limit was reached. ClockOff will try again.",
  CREDENTIAL_PERSIST_FAILED:
    "Refreshed Planday credentials could not be saved. ClockOff will try again.",
  PLANDAY_INVALID_RESPONSE: "Planday sent a response ClockOff could not read.",
  PLANDAY_NOT_FOUND: "Planday sent a response ClockOff could not read.",
  TIME_ENCODING_MISMATCH: "Planday's shift times could not be read reliably. Contact support.",
  DATABASE_UNAVAILABLE: "The sync could not save its progress. ClockOff will try again.",
  DISCONNECTED: "The Planday connection was disconnected.",
  AUTH_ERROR: "Planday needs to be reconnected before it can sync.",
  ONBOARDING_INCOMPLETE: "Finish the Planday setup before syncing.",
  INTEGRATION_ONBOARDING_INCOMPLETE: "Finish the Planday setup step this run needs first.",
  CONNECTION_INCOMPLETE: "The Planday connection has no portal yet. Connect Planday again.",
  UNEXPECTED_ERROR: "The sync stopped because of an unexpected error. ClockOff will try again.",
};

export function runErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? (ERROR_MESSAGES.UNEXPECTED_ERROR as string);
}

/** The next quarter hour after `now` (the card's "Next scheduled sync"; the slot job creates the runs). */
export function nextQuarterHour(now: Date): Date {
  const step = 15 * 60_000;
  return new Date(Math.floor(now.getTime() / step) * step + step);
}

// ── The run as a slice holds it ──────────────────────────────────────────────

interface RunCursor {
  phase: Record<string, unknown>;
  run: ExecutorState | null;
}

function readRunCursor(value: Prisma.JsonValue): RunCursor {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const phase = (record as Record<string, unknown>).phase;
  const run = (record as Record<string, unknown>).run;
  return {
    phase: phase && typeof phase === "object" ? { ...(phase as Record<string, unknown>) } : {},
    run: run && typeof run === "object" ? (structuredClone(run) as ExecutorState) : null,
  };
}

interface SliceState {
  phase: string;
  phaseCursor: Record<string, unknown>;
  state: ExecutorState;
  counts: RunCounts;
  warnings: RunWarning[];
  requestCount: number;
  attempt: number;
  status: IntegrationSyncRun["status"];
  resumeAfter: Date | null;
  progress: RunProgress;
  firstClaimedAt: Date | null;
}

const loadRunInclude = {
  integration: {
    select: {
      provider: true,
      activationMode: true,
      organisation: { select: { id: true, plan: true } },
      connection: {
        select: {
          status: true,
          credentialVersion: true,
          encryptedRefreshToken: true,
          externalPortalId: true,
          externalPortalTimezone: true,
          isMock: true,
          connectedAt: true,
          deletedShiftsCheckedAt: true,
          deactivationCheckedAt: true,
        },
      },
    },
  },
} as const;

type LoadedRun = Prisma.IntegrationSyncRunGetPayload<{ include: typeof loadRunInclude }>;

function terminalRunOf(run: LoadedRun): TerminalRun {
  return {
    id: run.id,
    organisationId: run.organisationId,
    integrationId: run.integrationId,
    kind: run.kind,
    trigger: run.trigger,
    requestedByUserId: run.requestedByUserId,
    mappingVersion: run.mappingVersion,
  };
}

function progressFor(phases: readonly string[], phase: string, label: string, pagesRead: number) {
  const index = phases.indexOf(phase);
  return {
    completedPhases: index < 0 ? 0 : index,
    totalPhases: phases.length,
    label,
    pagesRead,
  };
}

/** A sink step's context over copies of the run's state (a rolled-back step leaves the in-memory state as it was). */
function sinkContext(input: {
  run: LoadedRun;
  provider: IntegrationProvider;
  config: MappingSnapshot;
  slice: SliceState;
  now: Date;
  credentialVersion: () => number;
  log: Logger;
}): SinkContext {
  const { run } = input;
  return {
    run: {
      id: run.id,
      organisationId: run.organisationId,
      integrationId: run.integrationId,
      kind: run.kind,
      trigger: run.trigger,
      requestedByUserId: run.requestedByUserId,
      replaceShiftIds: run.replaceShiftIds,
      retryAuth: run.retryAuth,
      mappingVersion: run.mappingVersion,
    },
    organisationId: run.organisationId,
    integrationId: run.integrationId,
    provider: input.provider,
    portalId: run.integration.connection?.externalPortalId ?? "",
    portalTimezone: run.integration.connection?.externalPortalTimezone ?? null,
    activationMode: run.integration.activationMode,
    plan: run.integration.organisation.plan,
    config: input.config,
    credentialVersion: input.credentialVersion,
    now: input.now,
    hasher: recordHasher(),
    state: structuredClone(input.slice.state),
    tally: new RunTally(structuredClone(input.slice.counts), structuredClone(input.slice.warnings)),
    effects: emptySinkEffects(),
    log: input.log,
  };
}

function sinkFor(run: LoadedRun): RunSink {
  return run.kind === "STRUCTURE" || run.kind === "DIRECTORY"
    ? createStagingSink()
    : createApplySink();
}

/** A unique violation (Prisma P2002, or SQLSTATE 23505 from a raw statement). */
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === "P2002") return true;
  return err.code === "P2010" && (err.meta as { code?: unknown } | undefined)?.code === "23505";
}

/** `fenced(work)` (§7.6): one short transaction opened by the run fence and the lease fence. */
async function fenced<T>(
  runId: string,
  integrationId: string,
  holder: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      if (!(await fenceRun(tx, runId))) throw new RunCancelledError();
      if (!(await renewLease(tx, integrationId, holder))) throw new LeaseLostError();
      return work(tx);
    },
    { timeout: STEP_TRANSACTION_TIMEOUT_MS, maxWait: STEP_TRANSACTION_MAX_WAIT_MS },
  );
}

// ── The slice ────────────────────────────────────────────────────────────────

export async function runSyncSlice(runId: string, opts: RunSliceOptions): Promise<SliceOutcome> {
  const now = opts.now ?? (() => new Date());
  const log = (opts.log ?? childLogger({ module: "integrationRun" })).child({ runId });
  const maxMs = opts.maxMs ?? SLICE_MAX_MS;
  const startedMs = now().getTime();
  const leaseLost = new AbortController();
  const local = AbortSignal.any([opts.signal, leaseLost.signal]);
  let steps = 0;
  let requests = 0;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let run: LoadedRun | null = null;
  let slice: SliceState | null = null;
  let provider: IntegrationProvider = "PLANDAY";
  /** Another actor ended the run (disconnect, Finish, upkeep): this slice publishes nothing more for it. */
  let endedElsewhere = false;
  const notRunning = (): SliceOutcome => {
    endedElsewhere = true;
    return { state: "SKIPPED", reason: "NOT_RUNNING" };
  };

  const loaded = await prisma.integrationSyncRun.findUnique({
    where: { id: runId },
    include: loadRunInclude,
  });
  if (!loaded || loaded.status !== "RUNNING") {
    if (loaded) await releaseLease(loaded.integrationId, opts.holder).catch(() => undefined);
    forgetRunProgress(runId);
    return { state: "SKIPPED", reason: "NOT_RUNNING" };
  }
  run = loaded;
  provider = run.integration.provider;
  const integrationId = run.integrationId;
  const connection = run.integration.connection;
  const store = createPrismaCredentialStore({
    integrationId,
    holder: opts.holder,
    now: () => plandayTransportClock()?.() ?? now(),
  });
  store.seedVersion(connection?.credentialVersion ?? 0);
  const v0 = connection?.credentialVersion ?? 0;
  const cursor = readRunCursor(run.cursor);
  slice = {
    phase: run.phase,
    phaseCursor: cursor.phase,
    state: cursor.run ?? newExecutorState([], now()),
    counts: readRunCounts(run.counts),
    warnings: readRunWarnings(run.warnings),
    requestCount: run.requestCount,
    attempt: run.attempt,
    status: run.status,
    resumeAfter: run.resumeAfter,
    progress: readRunProgress(run.progress),
    firstClaimedAt: run.firstClaimedAt,
  };

  const progressRun = () => ({
    id: runId,
    organisationId: run!.organisationId,
    integrationId,
    kind: run!.kind,
    trigger: run!.trigger,
    status: slice!.status,
    phase: slice!.phase,
    progress: slice!.progress,
    firstClaimedAt: slice!.firstClaimedAt,
    resumeAfter: slice!.resumeAfter,
  });

  /** Ends the run FAILED (and, for auth failures, the connection AUTH_ERROR) in one fenced transaction. */
  const fail = async (
    errorCode: string,
    options: {
      touchConnection: boolean;
      scheduleRecovery: boolean;
      auth?: AuthErrorReason;
      config?: MappingSnapshot;
    },
  ): Promise<SliceOutcome> => {
    const effects = emptySinkEffects();
    const progress = progressFor(
      slice!.state.phases,
      slice!.phase,
      FINISHED_LABELS.FAILED,
      slice!.state.pagesRead,
    );
    await fenced(runId, integrationId, opts.holder, async (tx) => {
      const message = runErrorMessage(errorCode);
      const connectionRun = run!.kind === "SYNC" || run!.kind === "CLOCK";
      const result = await failRun(tx, terminalRunOf(run!), {
        status: "FAILED",
        errorCode,
        errorMessage: message,
        touchConnection: options.touchConnection && connectionRun,
        scheduleRecovery: options.scheduleRecovery && connectionRun,
        credentialVersion: store.knownVersion(),
        now: now(),
        counts: slice!.counts as unknown as Prisma.InputJsonValue,
        warnings: slice!.warnings as unknown as Prisma.InputJsonValue,
        progress,
        requestCount: slice!.requestCount,
      });
      effects.statusChanges.push(result.statusChange);
      effects.queuedRuns.push(...result.queued);
      if (options.auth && result.failed) {
        const config =
          options.config ??
          (await loadMappingSnapshot(tx, { organisationId: run!.organisationId, integrationId }));
        const entered = await enterAuthError(tx, {
          organisationId: run!.organisationId,
          integrationId,
          provider,
          credentialVersion: store.knownVersion(),
          errorCode,
          errorMessage: message,
          reason: options.auth,
          onboardingCompletedAt: config.onboardingCompletedAt,
          now: now(),
        });
        effects.statusChanges.push(entered.change);
        effects.alerts.push(entered.delivery);
      }
    });
    slice!.status = "FAILED";
    slice!.progress = progress;
    publishSinkEffects(run!.organisationId, provider, effects);
    return { state: "DONE", status: "FAILED", steps, requests };
  };

  /** Keeps the run RUNNING, not claimable before `resumeAfter`. */
  const park = async (
    reason: "RATE_LIMITED" | "RETRY_BACKOFF",
    resumeAfter: Date,
    attempt: number,
  ): Promise<SliceOutcome> => {
    const progress: RunProgress = {
      ...slice!.progress,
      label: parkedLabel(reason, resumeAfter, connection?.externalPortalTimezone ?? null),
    };
    await fenced(runId, integrationId, opts.holder, (tx) =>
      parkRun(tx, runId, { resumeAfter, attempt, progress }),
    );
    slice!.resumeAfter = resumeAfter;
    slice!.attempt = attempt;
    slice!.progress = progress;
    return { state: "PARKED", reason, resumeAfter, steps, requests };
  };

  /** Run RUNNING, lease held, connection not disconnected, credentials not replaced since the slice started. */
  const stillOwned = async (): Promise<boolean> => {
    const rows = await prisma.$queryRaw<
      Array<{
        run_status: string;
        connection_status: string;
        credential_version: number;
        lease_held: boolean;
      }>
    >`
      SELECT r.status::text AS run_status, c.status::text AS connection_status, c.credential_version,
             (c.sync_lease_id = ${opts.holder}::uuid AND c.sync_lease_expires_at > now()) AS lease_held
        FROM integration_sync_runs r
        JOIN integration_connections c ON c.integration_id = r.integration_id
       WHERE r.id = ${runId}::uuid`;
    const row = rows[0];
    return (
      !!row &&
      row.run_status === "RUNNING" &&
      row.lease_held &&
      row.connection_status !== "DISCONNECTED" &&
      row.credential_version === store.knownVersion()
    );
  };

  try {
    ensureProvidersRegistered();
    const implementation: ResumableWorkforceProvider | null = availableResumableProvider(provider);
    if (!implementation) return { state: "SKIPPED", reason: "PROVIDER_UNAVAILABLE" };

    renewTimer = setInterval(() => {
      renewLease(prisma, integrationId, opts.holder)
        .then((held) => {
          if (!held) leaseLost.abort(new LeaseLostError());
        })
        .catch((err: unknown) =>
          log.warn({ err: errorSummary(err) }, "integration lease renewal failed"),
        );
    }, LEASE_RENEW_MS);
    renewTimer.unref?.();

    // Preconditions (§7.6): a disconnected, unfinished, broken or mock-in-live connection never runs.
    if (!connection || connection.status === "DISCONNECTED" || !connection.encryptedRefreshToken) {
      return await fail("DISCONNECTED", { touchConnection: false, scheduleRecovery: false });
    }
    let config = await loadMappingSnapshot(prisma, {
      organisationId: run.organisationId,
      integrationId,
    });
    if ((run.kind === "SYNC" || run.kind === "CLOCK") && !config.onboardingCompletedAt) {
      return await fail("ONBOARDING_INCOMPLETE", {
        touchConnection: false,
        scheduleRecovery: false,
      });
    }
    if (connection.status === "AUTH_ERROR" && !run.retryAuth) {
      return await fail("AUTH_ERROR", { touchConnection: false, scheduleRecovery: false });
    }
    if (connection.isMock && env().PLANDAY_MODE === "live") {
      return await fail("MOCK_CONNECTION_IN_LIVE_MODE", {
        touchConnection: false,
        scheduleRecovery: false,
        auth: "MOCK_CONNECTION_IN_LIVE_MODE",
        config,
      });
    }
    if (!connection.externalPortalId) {
      return await fail("CONNECTION_INCOMPLETE", {
        touchConnection: false,
        scheduleRecovery: false,
      });
    }

    const sink = sinkFor(run);
    const loadedRun = run;
    const providerLog = toProviderLogger(log);
    const options = runPhaseOptions({
      activationMode: run.integration.activationMode,
      respectHiddenDays: config.respectHiddenDays,
    });

    /** Moves past `phase` (and any phase the sink skips) inside `tx`; returns the next phase. */
    const advance = async (
      tx: Prisma.TransactionClient,
      ctx: SinkContext,
      from: string,
    ): Promise<SyncPhase> => {
      const phases = ctx.state.phases;
      if (from !== "START" && from !== "FINALISE") ctx.state.completed.push(from as SyncPhase);
      ctx.state.phasePages = 0;
      let index = from === "START" ? 0 : phases.indexOf(from as SyncPhase) + 1;
      for (;;) {
        const candidate = phases[index] ?? "FINALISE";
        if (candidate === "FINALISE") return "FINALISE";
        const entered = await sink.enterPhase(tx, ctx, candidate);
        if (!entered.skip) return candidate;
        if (entered.partial) ctx.state.skipped.push(candidate);
        else ctx.state.completed.push(candidate);
        index += 1;
      }
    };

    /** Commits a sink context's results into the slice's in-memory state (after its transaction committed). */
    const adopt = (ctx: SinkContext, phase: string, phaseCursor: Record<string, unknown>) => {
      slice!.phase = phase;
      slice!.phaseCursor = phaseCursor;
      slice!.state = ctx.state;
      slice!.counts = ctx.tally.counts;
      slice!.warnings = ctx.tally.warnings;
    };

    // First write of the slice: claim stamps, the run's phase list on its first slice, SYNCING for a SYNC run.
    {
      const ctx = sinkContext({
        run: loadedRun,
        provider,
        config,
        slice,
        now: now(),
        credentialVersion: () => store.knownVersion(),
        log,
      });
      let phase = slice.phase;
      await fenced(runId, integrationId, opts.holder, async (tx) => {
        await tx.$executeRaw`
          UPDATE integration_sync_runs
             SET first_claimed_at = COALESCE(first_claimed_at, now()),
                 claimed_by = COALESCE(claimed_by, ${opts.instanceId.slice(0, 128)}), resume_after = NULL
           WHERE id = ${runId}::uuid`;
        if (phase === "START" || ctx.state.phases.length === 0) {
          const fresh = newExecutorState(phasesForRun(provider, loadedRun.kind, options), now());
          Object.assign(ctx.state, fresh);
          phase = await advance(tx, ctx, "START");
          const progress = progressFor(ctx.state.phases, phase, phaseLabel(phase), 0);
          await persistStep(tx, runId, {
            phase,
            cursor: { phase: {}, run: ctx.state } as unknown as Prisma.InputJsonValue,
            counts: ctx.tally.counts as unknown as Prisma.InputJsonValue,
            warnings: ctx.tally.warnings as unknown as Prisma.InputJsonValue,
            progress,
            requestCount: slice!.requestCount,
          });
          slice!.progress = progress;
        }
        if (loadedRun.kind === "SYNC") {
          ctx.effects.statusChanges.push(
            await setConnectionStatus(tx, integrationId, "SYNCING", {
              from: ["CONNECTED"],
              credentialVersion: v0,
            }),
          );
        }
      });
      if (phase !== slice.phase) adopt(ctx, phase, {});
      else slice.state = ctx.state;
      slice.firstClaimedAt ??= now();
      slice.resumeAfter = null;
      publishSinkEffects(run.organisationId, provider, ctx.effects);
      publishRunProgress(progressRun(), { force: true, provider });
    }

    const settingsFor = (): PlandayPhaseSettings => ({
      portalId: connection.externalPortalId!,
      portalTimezone: connection.externalPortalTimezone,
      runKind: loadedRun.kind,
      retryAuth: loadedRun.retryAuth,
      includedDepartmentIds: config.includedDepartmentIds,
      syncWindowDays: config.syncWindowDays,
      ...(connection.deletedShiftsCheckedAt || connection.connectedAt
        ? { deletedShiftsSince: (connection.deletedShiftsCheckedAt ?? connection.connectedAt)! }
        : {}),
      runId,
    });
    const inputsFor = (phase: SyncPhase, state: ExecutorState): PhaseInputs => {
      const window = state.window
        ? { from: new Date(state.window.from), to: new Date(state.window.to) }
        : undefined;
      switch (phase) {
        case "DEACTIVATED_EMPLOYEES": {
          const since = connection.deactivationCheckedAt ?? connection.connectedAt;
          return since ? { deactivatedSince: since } : {};
        }
        case "ABSENT_EMPLOYEES":
          return { recheckExternalIds: state.absentEmployees ?? [] };
        case "ABSENT_SHIFTS":
          return { recheckExternalIds: state.absentShifts ?? [], ...(window ? { window } : {}) };
        case "SCHEDULE_DAYS":
        case "SHIFTS":
        case "PREVIEW_SHIFTS":
          return window ? { window } : {};
        default:
          return {};
      }
    };

    for (;;) {
      if (local.aborted) {
        return {
          state: "YIELDED",
          reason: leaseLost.signal.aborted ? "LEASE_LOST" : "SHUTDOWN",
          steps,
          requests,
        };
      }
      if (steps > 0 && now().getTime() - startedMs >= maxMs) {
        return { state: "YIELDED", reason: "SLICE_TIME", steps, requests };
      }
      const phase = slice.phase;
      const budgetExhausted = slice.requestCount >= RUN_REQUEST_BUDGET;
      if (phase === "FINALISE" || budgetExhausted) {
        config = await loadMappingSnapshot(prisma, {
          organisationId: run.organisationId,
          integrationId,
        });
        const status = await finalise({
          run: loadedRun,
          provider,
          config,
          slice,
          sink,
          budgetExhausted,
          holder: opts.holder,
          now,
          credentialVersion: () => store.knownVersion(),
          log,
        });
        steps += 1;
        return { state: "DONE", status, steps, requests };
      }

      const stepNow = now();
      let providerStep: PhaseStepResult | null = null;
      if (!isDatabaseOnlyPhase(phase as SyncPhase)) {
        const ctx: ProviderContext = {
          organisationId: run.organisationId,
          integrationId,
          settings: settingsFor(),
          now: stepNow,
          credentialStore: store,
          signal: local,
          log: providerLog,
        };
        // The Planday page is read completely here, before any transaction opens.
        providerStep = await implementation.runPhaseStep(
          ctx,
          phase as SyncPhase,
          slice.phaseCursor,
          inputsFor(phase as SyncPhase, slice.state),
        );
        requests += providerStep.requests;
      }

      const stepContext = () =>
        sinkContext({
          run: loadedRun!,
          provider,
          config,
          slice: slice!,
          now: stepNow,
          credentialVersion: () => store.knownVersion(),
          log,
        });
      const requestCount = slice.requestCount + (providerStep?.requests ?? 0);
      const applyStep = (ctx: SinkContext) =>
        fenced(runId, integrationId, opts.holder, async (tx) => {
          let done: boolean;
          let phaseCursor: Record<string, unknown>;
          if (providerStep) {
            await sink.apply(tx, ctx, phase as SyncPhase, providerStep);
            ctx.state.pagesRead += 1;
            ctx.state.phasePages += 1;
            done = providerStep.done;
            phaseCursor = { ...providerStep.cursor };
          } else {
            const result = await sink.runDatabasePhaseStep(
              tx,
              ctx,
              phase as SyncPhase,
              slice!.phaseCursor,
            );
            done = result.done;
            phaseCursor = result.cursor;
          }
          const label = phaseLabel(phase, ctx.state.phasePages);
          let nextPhase: string = phase;
          if (done) {
            nextPhase = await advance(tx, ctx, phase);
            phaseCursor = {};
          }
          const progress = progressFor(
            ctx.state.phases,
            nextPhase,
            done ? phaseLabel(nextPhase) : label,
            ctx.state.pagesRead,
          );
          await persistStep(tx, runId, {
            phase: nextPhase,
            cursor: { phase: phaseCursor, run: ctx.state } as unknown as Prisma.InputJsonValue,
            counts: ctx.tally.counts as unknown as Prisma.InputJsonValue,
            warnings: ctx.tally.warnings as unknown as Prisma.InputJsonValue,
            progress,
            requestCount,
          });
          return { nextPhase, phaseCursor, progress };
        });
      let ctx = stepContext();
      let committed: Awaited<ReturnType<typeof applyStep>>;
      try {
        committed = await applyStep(ctx);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // §6.2 step 5: another writer created the same row (a map row, an external id) between this step's reads and
        // its insert. The step rolled back; applied once more over a fresh copy of the run's state, it reads that row
        // and decides an update or a link instead of a create. A second violation fails the run as before.
        // The code only: a violation's message can quote the conflicting values.
        log.warn(
          { phase, code: (err as Prisma.PrismaClientKnownRequestError).code },
          "integration step hit a unique violation; applying it once more",
        );
        ctx = stepContext();
        committed = await applyStep(ctx);
      }
      steps += 1;
      adopt(ctx, committed.nextPhase, committed.phaseCursor);
      slice.requestCount = requestCount;
      slice.attempt = 0;
      slice.progress = committed.progress;
      publishSinkEffects(run.organisationId, provider, ctx.effects);
      publishRunProgress(progressRun(), { force: committed.nextPhase !== phase, provider });
    }
  } catch (err) {
    return await handleSliceError(err);
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    await prisma.$executeRaw`
      UPDATE integration_sync_runs
         SET claimed_by = CASE WHEN claimed_by = ${opts.instanceId.slice(0, 128)} THEN NULL ELSE claimed_by END,
             last_slice_at = now()
       WHERE id = ${runId}::uuid`.catch((err: unknown) =>
      log.warn({ err: errorSummary(err) }, "integration slice could not release its claim"),
    );
    await releaseLease(integrationId, opts.holder).catch((err: unknown) =>
      log.warn({ err: errorSummary(err) }, "integration slice could not release its lease"),
    );
    // A run another actor ended must not get a stale RUNNING event (its terminal write published the truth).
    if (endedElsewhere) forgetRunProgress(runId);
    else if (slice) publishRunProgress(progressRun(), { force: true, provider });
  }

  async function handleSliceError(err: unknown): Promise<SliceOutcome> {
    if (err instanceof RunCancelledError || isCredentialsWipedError(err)) return notRunning();
    if (isLeaseLostError(err)) return { state: "YIELDED", reason: "LEASE_LOST", steps, requests };
    if (isAbortError(err) || local.aborted) {
      return {
        state: "YIELDED",
        reason: leaseLost.signal.aborted ? "LEASE_LOST" : "SHUTDOWN",
        steps,
        requests,
      };
    }
    try {
      if (!(await stillOwned())) return notRunning();
      if (isPlandayRateLimitedError(err)) {
        return await park("RATE_LIMITED", err.retryAt, slice!.attempt);
      }
      if (isPlandayPortalMismatchError(err)) {
        return await fail("INTEGRATION_PORTAL_MISMATCH", {
          touchConnection: false,
          scheduleRecovery: false,
          auth: "DIFFERENT_PORTAL",
        });
      }
      if (isPlandayAuthError(err)) {
        return await fail(err.code, {
          touchConnection: false,
          scheduleRecovery: false,
          auth: err.code === "PLANDAY_SCOPE_MISSING" ? "MISSING_PERMISSION" : "ACCESS_REVOKED",
        });
      }
      const retryable = (isPlandayError(err) && err.retryable) || isTransientDatabaseError(err);
      if (retryable) {
        const code = isPlandayError(err) ? err.code : "DATABASE_UNAVAILABLE";
        const attempt = slice!.attempt + 1;
        if (attempt >= RUN_RETRY_ATTEMPTS) {
          log.warn({ code, attempt }, "integration run failed after its retries");
          return await fail(code, { touchConnection: true, scheduleRecovery: true });
        }
        const resumeAfter = new Date(
          now().getTime() + fullJitterBackoff(attempt, RUN_RETRY_BACKOFF),
        );
        return await park("RETRY_BACKOFF", resumeAfter, attempt);
      }
      const code = isPlandayError(err)
        ? err.reason === "TIME_ENCODING_MISMATCH"
          ? "TIME_ENCODING_MISMATCH"
          : err.code
        : isAppError(err)
          ? err.code
          : "UNEXPECTED_ERROR";
      log.error({ code, err: errorSummary(err) }, "integration run failed");
      return await fail(code, { touchConnection: true, scheduleRecovery: true });
    } catch (inner) {
      if (inner instanceof RunCancelledError || isCredentialsWipedError(inner)) return notRunning();
      if (isLeaseLostError(inner))
        return { state: "YIELDED", reason: "LEASE_LOST", steps, requests };
      throw inner;
    }
  }
}

// ── FINALISE (§7.2) ──────────────────────────────────────────────────────────

async function finalise(input: {
  run: LoadedRun;
  provider: IntegrationProvider;
  config: MappingSnapshot;
  slice: SliceState;
  sink: RunSink;
  budgetExhausted: boolean;
  holder: string;
  now: () => Date;
  credentialVersion: () => number;
  log: Logger;
}): Promise<"SUCCEEDED" | "PARTIAL"> {
  const { run, slice } = input;
  const at = input.now();
  const ctx = sinkContext({
    run,
    provider: input.provider,
    config: input.config,
    slice,
    now: at,
    credentialVersion: input.credentialVersion,
    log: input.log,
  });
  const effects: SinkEffects = ctx.effects;
  let status: "SUCCEEDED" | "PARTIAL" = "SUCCEEDED";
  let progress: RunProgress = slice.progress;
  await fenced(run.id, run.integrationId, input.holder, async (tx) => {
    if (input.budgetExhausted) {
      ctx.tally.warn(
        "REQUEST_BUDGET_EXHAUSTED",
        "The sync reached its Planday request budget; the next scheduled sync continues",
      );
    }
    await input.sink.finalise(tx, ctx);
    status = ctx.tally.hasWarnings() || ctx.state.skipped.length > 0 ? "PARTIAL" : "SUCCEEDED";
    if (run.kind === "SYNC") await finaliseSyncConnection(tx, ctx, input.credentialVersion());
    if (run.kind === "SYNC" && countsChangedSomething(ctx.tally.counts)) {
      const { event } = await recordActivity(
        {
          organisationId: run.organisationId,
          actorType: "SYSTEM",
          type: "INTEGRATION_SYNCED",
          occurredAt: at,
          metadata: {
            source: input.provider,
            integrationId: run.integrationId,
            runId: run.id,
            trigger: run.trigger,
            counts: ctx.tally.counts,
          },
        },
        { db: tx, publish: false },
      );
      effects.activities.push(event);
    }
    progress = {
      completedPhases: ctx.state.phases.length,
      totalPhases: ctx.state.phases.length,
      label: FINISHED_LABELS[status],
      pagesRead: ctx.state.pagesRead,
    };
    const written = await writeTerminalRun(tx, run.id, {
      status,
      counts: ctx.tally.counts as unknown as Prisma.InputJsonValue,
      warnings: ctx.tally.warnings as unknown as Prisma.InputJsonValue,
      progress,
      requestCount: slice.requestCount,
    });
    if (!written) throw new RunCancelledError();
    effects.queuedRuns.push(...(await applyRunFollowUps(tx, terminalRunOf(run))));
  });
  slice.status = status;
  slice.phase = "FINALISE";
  slice.progress = progress;
  slice.counts = ctx.tally.counts;
  slice.warnings = ctx.tally.warnings;
  publishSinkEffects(run.organisationId, input.provider, effects);
  return status;
}

/**
 * A SYNC's connection writes at FINALISE (§7.2), compare-and-set at the slice's `credential_version`: the watermarks
 * of the phases that completed (`lastSuccessfulSyncAt` only when SHIFTS completed), the failure count reset, the next
 * quarter hour for display, and SYNCING (or DEGRADED, once the shifts were read) back to CONNECTED.
 */
async function finaliseSyncConnection(
  tx: Prisma.TransactionClient,
  ctx: SinkContext,
  credentialVersion: number,
): Promise<void> {
  const completed = new Set(ctx.state.completed);
  const startedAt = new Date(ctx.state.startedAt);
  const shiftsDone = completed.has("SHIFTS");
  const deactivationDone = completed.has("DEACTIVATED_EMPLOYEES");
  const deletedDone = completed.has("DELETED_SHIFTS");
  await tx.$executeRaw`
    UPDATE integration_connections
       SET last_sync_at = CASE WHEN ${shiftsDone} THEN ${startedAt}::timestamptz ELSE last_sync_at END,
           deactivation_checked_at = CASE WHEN ${deactivationDone} THEN ${startedAt}::timestamptz
                                          ELSE deactivation_checked_at END,
           deleted_shifts_checked_at = CASE WHEN ${deletedDone} THEN ${startedAt}::timestamptz
                                            ELSE deleted_shifts_checked_at END,
           consecutive_failure_count = 0,
           last_error_code = CASE WHEN ${shiftsDone} THEN NULL ELSE last_error_code END,
           last_error = CASE WHEN ${shiftsDone} THEN NULL ELSE last_error END,
           next_sync_at = ${nextQuarterHour(ctx.now)}::timestamptz,
           updated_at = now()
     WHERE integration_id = ${ctx.integrationId}::uuid
       AND credential_version = ${credentialVersion}
       AND status IN ('CONNECTED', 'SYNCING', 'DEGRADED')`;
  ctx.effects.statusChanges.push(
    await setConnectionStatus(tx, ctx.integrationId, "CONNECTED", {
      from: shiftsDone ? ["SYNCING", "DEGRADED"] : ["SYNCING"],
      credentialVersion,
      reason: "SYNC_FINISHED",
    }),
  );
}
