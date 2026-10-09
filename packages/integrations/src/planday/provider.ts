import {
  isCredentialsWipedError,
  type CredentialStore,
  type StoredCredentials,
} from "@clockoff/shared/providers/credentialStore";
import type {
  PhaseInputs,
  PhaseOptions,
  PhaseStepResult,
  ResumableWorkforceProvider,
  SyncBatch,
  SyncPhase,
} from "@clockoff/shared/providers/resumable";
import type { UpsertOutcome, WorkforceSyncSink } from "@clockoff/shared/providers/syncSink";
import {
  createSyncReportBuilder,
  type ConnectionStatus,
  type ConnectParams,
  type ConnectResult,
  type ProviderContext,
  type SyncRange,
  type SyncReport,
  type SyncReportBuilder,
} from "@clockoff/shared/providers/workforceProvider";
import { localDateOf } from "@clockoff/shared/time/zone";
import type { IntegrationSyncRunKind } from "@clockoff/shared/enums";
import {
  createInMemoryCredentialStore,
  createPlandayClient,
  type InMemoryCredentialStore,
  type PlandayClient,
} from "./client";
import { requiredScopes } from "./constants";
import { isPlandayError, PlandayError, toProviderError } from "./errors";
import type { PlandayBudgets, PlandayTransport, Sleep, TimeoutSignalFactory } from "./http";
import { noopPlandayLogger, type PlandayLogger } from "./logging";
import type { PlandayPortal } from "./mappers";
import { parsePlandayPhaseSettings, plandayPhasesFor, runPlandayPhaseStep } from "./phases";
import { exchangeCode, revokeToken, type TokenRequestDeps } from "./tokens";

/**
 * `PlandayProvider` (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §3.3, §5.6, §6.1, §7.2): the real
 * `WorkforceProvider` for Planday, resumable. Registration (apps/web `providers.ts`) makes Planday's effective
 * availability AVAILABLE only while `PLANDAY_ENABLED` is true; `PROVIDERS.PLANDAY.status` stays COMING_SOON as the
 * fallback (§3.4).
 *
 * - `connect()` is the proof of connection (§5.6): token (code exchange for A, refresh grant for B and C), portal
 *   info and the scope probes, all against an in-memory credential store; nothing is persisted here and nothing is
 *   returned unless the portal answered with valid data. It accepts only `PlandayConnectCredentials` and never
 *   returns REDIRECT_REQUIRED.
 * - `phasesFor()` / `runPhaseStep()` are what the worker's run executor calls (`phases.ts`).
 * - The classic `syncEmployees` / `syncShifts` / … loop one phase to completion into `ctx.sink`.
 */

// ---------------------------------------------------------------------------------------------------------
// The connect contract (§3.3)
// ---------------------------------------------------------------------------------------------------------

declare const verified: unique symbol;

/** Produced only by `consumeOAuthState()` in apps/web (5.2), through `verifiedAuthorizationCode()`. */
export type VerifiedAuthorizationCode = {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier?: string;
} & {
  readonly [verified]: true;
};

const verifiedCodes = new WeakSet<object>();

/**
 * Marks an authorization code whose OAuth `state` was verified and consumed (§5.2 step 3). Only
 * `consumeOAuthState()` calls it; `connect()` refuses any other object, so a code taken from a request body (the
 * generic connect route) can never reach the exchange, at compile time (the brand) and at run time.
 */
export function verifiedAuthorizationCode(input: {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier?: string | null;
}): VerifiedAuthorizationCode {
  if (!input.code || !input.redirectUri) {
    throw new TypeError("A verified authorization code needs a code and a redirect URI");
  }
  const value = Object.freeze({
    code: input.code,
    redirectUri: input.redirectUri,
    ...(input.codeVerifier ? { codeVerifier: input.codeVerifier } : {}),
  });
  verifiedCodes.add(value);
  return value as VerifiedAuthorizationCode;
}

export function isVerifiedAuthorizationCode(value: unknown): value is VerifiedAuthorizationCode {
  return typeof value === "object" && value !== null && verifiedCodes.has(value);
}

export type PlandayConnectMethod = "OAUTH" | "CUSTOMER_ADDED_APP_ID" | "CUSTOMER_OWN_APP";

/** `ConnectParams.credentials` for Planday, built by `planday.service.ts` (A: callback; B and C: `connect/token`). */
export type PlandayConnectCredentials =
  | {
      readonly method: "OAUTH";
      /** `PLANDAY_CLIENT_ID`. */
      readonly clientId: string;
      readonly authorization: VerifiedAuthorizationCode;
    }
  | {
      readonly method: "CUSTOMER_ADDED_APP_ID" | "CUSTOMER_OWN_APP";
      /** `PLANDAY_APP_ID` (B) or the App ID the customer pasted (C). */
      readonly clientId: string;
      /** The pasted Token column value. */
      readonly refreshToken: string;
    };

/**
 * `ConnectResult.credentials` of a successful proof: what the connect transaction persists (§5.5), identical in
 * shape for A, B and C. Tokens stay in memory until then; `credentials.refreshToken` is the rotated one when Planday
 * rotated it during the proof.
 */
export interface PlandayConnectedCredentials {
  readonly method: PlandayConnectMethod;
  readonly credentials: StoredCredentials;
  /** A: the token response's `scope` when it has one; otherwise (and for B and C) the probed scopes. */
  readonly scopesGranted: readonly string[];
  readonly portal: PlandayPortal;
}

export function isPlandayConnectedCredentials(
  value: unknown,
): value is PlandayConnectedCredentials {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PlandayConnectedCredentials>;
  return (
    typeof candidate.method === "string" &&
    typeof candidate.credentials === "object" &&
    candidate.credentials !== null &&
    Array.isArray(candidate.scopesGranted) &&
    typeof candidate.portal === "object" &&
    candidate.portal !== null
  );
}

/**
 * `connect()` was called with the generic connect fields (`authorizationCode` / `state`) or with anything but
 * `PlandayConnectCredentials`. PLANDAY_AUTH_FAILED: Planday connects only through its own endpoints.
 */
export class PlandayConnectRefusedError extends PlandayError {
  constructor() {
    super("PLANDAY_AUTH_FAILED");
    this.name = "PlandayConnectRefusedError";
    this.message =
      "Planday refused ClockOff's credentials: use the Planday connect endpoints (connect/oauth, connect/token, callback)";
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseConnectCredentials(value: unknown): PlandayConnectCredentials {
  if (typeof value !== "object" || value === null) throw new PlandayConnectRefusedError();
  const candidate = value as Record<string, unknown>;
  if (!nonEmpty(candidate.clientId)) throw new PlandayConnectRefusedError();
  if (candidate.method === "OAUTH") {
    if (!isVerifiedAuthorizationCode(candidate.authorization))
      throw new PlandayConnectRefusedError();
    return {
      method: "OAUTH",
      clientId: candidate.clientId,
      authorization: candidate.authorization,
    };
  }
  if (candidate.method === "CUSTOMER_ADDED_APP_ID" || candidate.method === "CUSTOMER_OWN_APP") {
    if (!nonEmpty(candidate.refreshToken)) throw new PlandayConnectRefusedError();
    return {
      method: candidate.method,
      clientId: candidate.clientId,
      refreshToken: candidate.refreshToken,
    };
  }
  throw new PlandayConnectRefusedError();
}

// ---------------------------------------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------------------------------------

export interface PlandayProviderConfig {
  /**
   * `PLANDAY_CLOCK_MODE_ENABLED`: the connect proof then also requires and probes `punchclockshift:read` (§5.2
   * step 4, §5.6 step 3).
   */
  readonly clockModeEnabled?: boolean;
}

export interface PlandayProviderDeps {
  /** Live fetch, the mock server's rewrite, or the in-process mock (`getPlandayTransport()`, §4.1). */
  readonly transport: PlandayTransport;
  /** Used when the call's `ProviderContext.log` is absent. */
  readonly logger?: PlandayLogger;
  readonly config?: PlandayProviderConfig;
  /** Process-wide rate state; `sharedPlandayBudgets()` unless given (tests). */
  readonly budgets?: PlandayBudgets;
  /**
   * The clock the HTTP layer paces requests and dates tokens with (the real clock; tests pass the mock's).
   * `ProviderContext.now` stays the run's business instant (windows, dismissal dates, "today").
   */
  readonly clock?: () => Date;
  /** Test seams. */
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly createTimeoutSignal?: TimeoutSignalFactory;
}

export interface PlandayProvider extends ResumableWorkforceProvider {
  readonly id: "PLANDAY";
  readonly status: "AVAILABLE";
}

/** Safety stop for the classic `sync*` loops (a phase that never reports done). */
const MAX_LOOP_STEPS = 100_000;

export function createPlandayProvider(deps: PlandayProviderDeps): PlandayProvider {
  const clock = deps.clock ?? (() => new Date());
  const clockMode = deps.config?.clockModeEnabled === true;

  const logOf = (ctx: ProviderContext): PlandayLogger =>
    ctx.log ?? deps.logger ?? noopPlandayLogger;

  function clientFor(
    ctx: ProviderContext,
    store: CredentialStore,
    portalKey: string,
    runId?: string,
  ): PlandayClient {
    return createPlandayClient({
      transport: deps.transport,
      credentialStore: store,
      portalKey,
      logger: logOf(ctx),
      now: clock,
      integrationId: ctx.integrationId,
      ...(deps.budgets ? { budget: deps.budgets } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.deadline ? { deadline: ctx.deadline } : {}),
      ...(runId !== undefined ? { runId } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      ...(deps.createTimeoutSignal ? { createTimeoutSignal: deps.createTimeoutSignal } : {}),
    });
  }

  function tokenDeps(ctx: ProviderContext, forRevocation = false): TokenRequestDeps {
    return {
      transport: deps.transport,
      logger: logOf(ctx),
      now: clock,
      integrationId: ctx.integrationId,
      // Revocation is best effort with its own 5 s timeout; the code exchange respects the connect deadline.
      ...(!forRevocation && ctx.deadline ? { deadline: ctx.deadline } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      ...(deps.createTimeoutSignal ? { createTimeoutSignal: deps.createTimeoutSignal } : {}),
    };
  }

  function requireStore(ctx: ProviderContext): CredentialStore {
    if (!ctx.credentialStore) {
      throw new TypeError("Planday needs ProviderContext.credentialStore for this call");
    }
    return ctx.credentialStore;
  }

  async function runPhaseStep(
    ctx: ProviderContext,
    phase: SyncPhase,
    cursor: Readonly<Record<string, unknown>>,
    inputs: PhaseInputs,
  ): Promise<PhaseStepResult> {
    if (phase === "FINALISE") return { done: true, cursor: {}, requests: 0 };
    const settings = parsePlandayPhaseSettings(ctx.settings);
    const client = clientFor(ctx, requireStore(ctx), settings.portalId, settings.runId);
    return runPlandayPhaseStep(client, ctx, settings, phase, cursor, inputs);
  }

  async function connect(ctx: ProviderContext, params: ConnectParams): Promise<ConnectResult> {
    // The generic fields never reach Planday (§3.3): a code is only accepted once its state was verified.
    if (params.authorizationCode !== undefined || params.state !== undefined) {
      throw new PlandayConnectRefusedError();
    }
    const credentials = parseConnectCredentials(params.credentials);
    const required = requiredScopes({ clockMode });

    // 1. Token: the code exchange (A) or the refresh grant (B, C). Nothing is persisted during the proof.
    let store: InMemoryCredentialStore;
    let tokenScope: string | null = null;
    if (credentials.method === "OAUTH") {
      const { code, redirectUri, codeVerifier } = credentials.authorization;
      const requestedAt = clock().getTime();
      const set = await exchangeCode(
        {
          clientId: credentials.clientId,
          code,
          redirectUri,
          ...(codeVerifier ? { codeVerifier } : {}),
          requiredScopes: required,
        },
        tokenDeps(ctx),
      );
      tokenScope = set.scope;
      store = createInMemoryCredentialStore(
        {
          clientId: credentials.clientId,
          refreshToken: set.refreshToken,
          accessToken: set.accessToken,
          accessTokenExpiresAt: new Date(requestedAt + set.expiresInS * 1000),
        },
        clock,
      );
    } else {
      store = createInMemoryCredentialStore(
        {
          clientId: credentials.clientId,
          refreshToken: credentials.refreshToken,
          accessToken: null,
          accessTokenExpiresAt: null,
        },
        clock,
      );
    }

    // Before the portal is known, the integration id keys the serial queue and the budget (§4.5).
    const first = clientFor(ctx, store, ctx.integrationId);
    if (credentials.method !== "OAUTH") await first.accessToken();

    // 2. The portal.
    const portal = await first.getPortalInfo();

    // 3. The scope probes (limit=1 reads; every 200 body must parse).
    const probe = clientFor(ctx, store, portal.externalId);
    const { grantedScopes } = await probe.probeScopes({
      clockMode,
      today: localDateOf(ctx.now, portal.timezone ?? "UTC"),
      portalZone: portal.timezone,
    });

    const stored = store.current();
    const scopesGranted = tokenScope
      ? [...new Set(tokenScope.split(/\s+/).filter(Boolean))]
      : [...grantedScopes];
    const connected: PlandayConnectedCredentials = {
      method: credentials.method,
      credentials: stored,
      scopesGranted,
      portal,
    };
    return {
      kind: "CONNECTED",
      credentials: connected,
      tokenExpiresAt: stored.accessTokenExpiresAt,
      externalAccountId: portal.externalId,
      externalAccountName: portal.name,
    };
  }

  /**
   * Best-effort revocation of the refresh token in `ctx.credentials` (`{ clientId, refreshToken }`, read by the
   * disconnect transaction before the wipe, §5.8 step 3): 5 s, no retries. Rejects when Planday did not confirm, so
   * the caller can record `revokedAtPlanday: false`; does nothing without credentials.
   */
  async function disconnect(ctx: ProviderContext): Promise<void> {
    const value = ctx.credentials as { clientId?: unknown; refreshToken?: unknown } | undefined;
    if (!value || !nonEmpty(value.clientId) || !nonEmpty(value.refreshToken)) return;
    await revokeToken(
      { clientId: value.clientId, refreshToken: value.refreshToken },
      tokenDeps(ctx, true),
    );
  }

  async function refreshAuthentication(ctx: ProviderContext): Promise<void> {
    const store = requireStore(ctx);
    const settings =
      ctx.settings.portalId !== undefined ? parsePlandayPhaseSettings(ctx.settings) : null;
    await clientFor(ctx, store, settings?.portalId ?? ctx.integrationId).accessToken({
      force: true,
    });
  }

  async function getConnectionStatus(ctx: ProviderContext): Promise<ConnectionStatus> {
    const disconnected: ConnectionStatus = {
      status: "DISCONNECTED",
      connected: false,
      lastSyncAt: null,
      tokenExpiresAt: null,
      lastError: null,
    };
    if (!ctx.credentialStore) return { ...disconnected, status: "NOT_CONNECTED" };
    try {
      const stored = await ctx.credentialStore.read();
      return {
        status: "CONNECTED",
        connected: true,
        lastSyncAt: null,
        tokenExpiresAt: stored.accessTokenExpiresAt,
        lastError: null,
      };
    } catch (err) {
      if (isCredentialsWipedError(err)) return disconnected;
      throw err;
    }
  }

  /** Loops one phase to completion and hands each batch to `apply` (the classic `sync*` surface). */
  async function drainPhase(
    ctx: ProviderContext,
    phase: SyncPhase,
    inputs: PhaseInputs,
    report: SyncReportBuilder,
    apply: (batch: SyncBatch) => Promise<void>,
  ): Promise<void> {
    let cursor: Readonly<Record<string, unknown>> = {};
    for (let steps = 0; steps < MAX_LOOP_STEPS; steps++) {
      let step: PhaseStepResult;
      try {
        step = await runPhaseStep(ctx, phase, cursor, inputs);
      } catch (err) {
        throw isPlandayError(err) ? toProviderError(err) : err;
      }
      for (const warning of step.warnings ?? []) report.error(warning);
      if (step.batch) await apply(step.batch);
      if (step.done) return;
      cursor = step.cursor;
    }
    throw new PlandayError("PLANDAY_INVALID_RESPONSE", { reason: "PAGINATION_RUNAWAY" });
  }

  function requireSink(ctx: ProviderContext): WorkforceSyncSink {
    if (!ctx.sink) throw new TypeError("Planday sync methods need ProviderContext.sink");
    return ctx.sink;
  }

  async function syncWith(
    ctx: ProviderContext,
    phase: SyncPhase,
    inputs: PhaseInputs,
    apply: (sink: WorkforceSyncSink, batch: SyncBatch) => Promise<UpsertOutcome[]>,
  ): Promise<SyncReport> {
    const sink = requireSink(ctx);
    const report = createSyncReportBuilder("PLANDAY", ctx.now);
    await drainPhase(ctx, phase, inputs, report, async (batch) => {
      for (const outcome of await apply(sink, batch)) report.record(outcome);
    });
    return report.finish(clock());
  }

  async function eachRecord<T>(
    records: readonly T[],
    write: (record: T) => Promise<UpsertOutcome>,
  ): Promise<UpsertOutcome[]> {
    const outcomes: UpsertOutcome[] = [];
    for (const record of records) outcomes.push(await write(record));
    return outcomes;
  }

  const provider: PlandayProvider = {
    id: "PLANDAY",
    displayName: "Planday",
    status: "AVAILABLE",

    phasesFor(kind: IntegrationSyncRunKind, options: PhaseOptions) {
      return plandayPhasesFor(kind, options);
    },
    runPhaseStep,
    connect,
    disconnect,
    refreshAuthentication,
    getConnectionStatus,

    syncLocations(ctx) {
      return syncWith(ctx, "DEPARTMENTS", {}, (sink, batch) =>
        batch.kind === "LOCATIONS"
          ? eachRecord(batch.records, (r) => sink.upsertLocation(r))
          : Promise.resolve([]),
      );
    },
    syncTeams(ctx) {
      return syncWith(ctx, "EMPLOYEE_GROUPS", {}, (sink, batch) =>
        batch.kind === "TEAMS"
          ? eachRecord(batch.records, (r) => sink.upsertTeam(r))
          : Promise.resolve([]),
      );
    },
    syncEmployees(ctx) {
      return syncWith(ctx, "EMPLOYEES", {}, (sink, batch) =>
        batch.kind === "EMPLOYEES"
          ? eachRecord(batch.records, (r) => sink.upsertEmployee(r))
          : Promise.resolve([]),
      );
    },
    syncShifts(ctx, range: SyncRange) {
      return syncWith(ctx, "SHIFTS", { window: range }, (sink, batch) =>
        batch.kind === "SHIFTS"
          ? eachRecord(batch.records, (r) => sink.upsertShift(r))
          : Promise.resolve([]),
      );
    },
    syncClockEvents(ctx, since: Date) {
      const withWindow: ProviderContext = {
        ...ctx,
        settings: { ...ctx.settings, clockEventsFrom: since },
      };
      return syncWith(withWindow, "CLOCK_EVENTS", {}, (sink, batch) =>
        batch.kind === "CLOCK_EVENTS"
          ? eachRecord(batch.records, (r) => sink.recordClockEvent(r))
          : Promise.resolve([]),
      );
    },
  };
  return provider;
}
