import type { ActivationMode, IntegrationProvider, IntegrationStatus } from "../enums";
import type { CredentialStore } from "./credentialStore";
import type { UpsertOutcome, WorkforceSyncSink } from "./syncSink";

export * from "./comingSoonProvider";
export * from "./credentialStore";
export * from "./registry";
export * from "./resumable";
export * from "./syncSink";

/**
 * §6.6 — Workforce provider abstraction. Each rota / time-and-attendance system (Planday, Deputy, 7shifts,
 * When I Work, Rotaready, Homebase) is wrapped in a `WorkforceProvider`. Providers pull data INTO ClockOff's
 * own tables (Employee, Shift, Location, Team, ClockEvent) through a `WorkforceSyncSink`. Nothing else in the
 * system talks to a provider: the Work Mode state machine, break rules and dashboard consume `Shift` (and
 * `ClockEvent`) rows only — never provider objects — so a provider can be added, replaced or removed without
 * touching scheduling logic. See docs/INTEGRATIONS.md.
 */

export type ProviderId = IntegrationProvider;

export type ProviderAvailability = "AVAILABLE" | "COMING_SOON";

/**
 * Structured logger handed to providers (the web layer passes a pino child logger). Objects carry ids, codes,
 * counts and path templates only: never tokens, client ids, codes, names, emails or response bodies.
 */
export interface ProviderLogger {
  debug(obj: Readonly<Record<string, unknown>>, msg: string): void;
  info(obj: Readonly<Record<string, unknown>>, msg: string): void;
  warn(obj: Readonly<Record<string, unknown>>, msg: string): void;
  error(obj: Readonly<Record<string, unknown>>, msg: string): void;
}

/** Everything a provider needs for one call. Credentials arrive decrypted; the caller handles AES-256-GCM. */
export interface ProviderContext {
  readonly organisationId: string;
  readonly integrationId: string;
  /** Integration.settings (provider-specific, e.g. { portalId, locationMapping }). */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Decrypted IntegrationConnection credentials; shape is provider-specific. Absent before connect(). */
  readonly credentials?: unknown;
  /** Injected clock (UTC instant) so sync windows and token expiry are testable. */
  readonly now: Date;
  /**
   * Where sync methods write mapped records and `refreshAuthentication` stores new tokens. Required by those
   * methods; not needed for connect / disconnect / getConnectionStatus.
   */
  readonly sink?: WorkforceSyncSink;
  /** Credential persistence with an atomic refresh hook. Required by sync and refresh of a token provider. */
  readonly credentialStore?: CredentialStore;
  /** The connect proof's bound in web: providers start no request they cannot finish before it. */
  readonly deadline?: { remainingMs(): number };
  /**
   * Worker shutdown or a lost lease: checked before every request and combined with each API request's
   * timeout. Token, code-exchange and revocation requests ignore it (their answer may carry a rotated token).
   */
  readonly signal?: AbortSignal;
  readonly log?: ProviderLogger;
}

export interface ConnectParams {
  readonly activationMode: ActivationMode;
  /** Client-credentials style secrets entered by the manager (e.g. { clientId, clientSecret, refreshToken }). */
  readonly credentials?: unknown;
  /** Authorization-code flow: the code returned to the callback URL. */
  readonly authorizationCode?: string;
  /** Authorization-code flow: the callback URL registered with the provider. */
  readonly redirectUri?: string;
  /** Opaque CSRF state echoed by the provider on callback. */
  readonly state?: string;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export type ConnectResult =
  | {
      readonly kind: "CONNECTED";
      /**
       * Plain credentials to encrypt and persist in the generic connect flow's
       * IntegrationConnection.legacyEncryptedCredentials column. Planday never uses it: its connection
       * stores the client id and tokens in their own encrypted columns (planday.service.ts).
       */
      readonly credentials: unknown;
      readonly tokenExpiresAt: Date | null;
      readonly externalAccountId?: string;
      readonly externalAccountName?: string;
      /** Settings the provider wants merged into Integration.settings. */
      readonly settings?: Readonly<Record<string, unknown>>;
    }
  | {
      /** The manager must be redirected to the provider to authorise; call connect() again with the code. */
      readonly kind: "REDIRECT_REQUIRED";
      readonly authorizationUrl: string;
      readonly state: string;
    };

export const SYNC_ERROR_CODES = [
  "PROVIDER_ERROR",
  "RATE_LIMITED",
  "AUTH_EXPIRED",
  "UNKNOWN_EMPLOYEE",
  "UNKNOWN_LOCATION",
  "INVALID_TIME",
  "MAPPING_FAILED",
  "CONFLICT",
  /** The provider answered 2xx with a body that failed validation. Not retryable: the next schedule retries. */
  "INVALID_RESPONSE",
] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

export interface SyncError {
  readonly code: SyncErrorCode;
  readonly message: string;
  /** The provider's id for the record that failed, when there is one. */
  readonly externalId?: string;
}

/** Codes for which retrying later can succeed without a manager reconnecting. */
const RETRYABLE_SYNC_ERROR_CODES: ReadonlySet<SyncErrorCode> = new Set([
  "PROVIDER_ERROR",
  "RATE_LIMITED",
]);

/**
 * Rejection reason for a provider-level failure (the whole call failed: auth refused, provider down, rate
 * limited). Per-record problems are NOT thrown; they go into `SyncReport.errors`. The integrations service
 * maps a ProviderError to `Integration.status = ERROR` + `lastError`, and retries only when `retryable`.
 */
export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly code: SyncErrorCode;
  readonly retryable: boolean;

  constructor(
    provider: ProviderId,
    code: SyncErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.retryable = RETRYABLE_SYNC_ERROR_CODES.has(code);
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

export interface SyncReport {
  readonly provider: ProviderId;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: readonly SyncError[];
}

export interface ConnectionStatus {
  readonly status: IntegrationStatus;
  readonly connected: boolean;
  readonly lastSyncAt: Date | null;
  readonly tokenExpiresAt: Date | null;
  readonly lastError: string | null;
  readonly externalAccountName?: string | null;
}

/** Half-open UTC window [from, to) for shift syncs. */
export interface SyncRange {
  readonly from: Date;
  readonly to: Date;
}

export interface WorkforceProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly status: ProviderAvailability;
  connect(ctx: ProviderContext, params: ConnectParams): Promise<ConnectResult>;
  disconnect(ctx: ProviderContext): Promise<void>;
  refreshAuthentication(ctx: ProviderContext): Promise<void>;
  syncEmployees(ctx: ProviderContext): Promise<SyncReport>;
  syncShifts(ctx: ProviderContext, range: SyncRange): Promise<SyncReport>;
  syncLocations(ctx: ProviderContext): Promise<SyncReport>;
  syncTeams(ctx: ProviderContext): Promise<SyncReport>;
  syncClockEvents(ctx: ProviderContext, since: Date): Promise<SyncReport>;
  getConnectionStatus(ctx: ProviderContext): Promise<ConnectionStatus>;
}

/** A zero-count report, for providers that have nothing to do or as a starting accumulator. */
export function emptySyncReport(
  provider: ProviderId,
  startedAt: Date,
  finishedAt: Date = startedAt,
): SyncReport {
  return { provider, startedAt, finishedAt, created: 0, updated: 0, skipped: 0, errors: [] };
}

/** Mutable accumulator providers use while syncing; `finish()` freezes it into a `SyncReport`. */
export interface SyncReportBuilder {
  record(outcome: UpsertOutcome): void;
  error(error: SyncError): void;
  finish(finishedAt: Date): SyncReport;
}

/**
 * Tallies sink outcomes: CREATED → created, UPDATED → updated, UNCHANGED / SKIPPED → skipped. Errors are
 * recorded separately and do not count as skipped (a record either produced an outcome or an error).
 */
export function createSyncReportBuilder(provider: ProviderId, startedAt: Date): SyncReportBuilder {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: SyncError[] = [];
  return {
    record(outcome) {
      switch (outcome) {
        case "CREATED":
          created++;
          return;
        case "UPDATED":
          updated++;
          return;
        case "UNCHANGED":
        case "SKIPPED":
          skipped++;
          return;
        default: {
          const exhaustive: never = outcome;
          throw new Error(`Unknown upsert outcome: ${String(exhaustive)}`);
        }
      }
    },
    error(error) {
      errors.push(error);
    },
    finish(finishedAt) {
      return { provider, startedAt, finishedAt, created, updated, skipped, errors: [...errors] };
    },
  };
}
