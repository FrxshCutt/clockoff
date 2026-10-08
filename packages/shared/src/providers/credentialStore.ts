/**
 * Credential persistence for providers whose access tokens expire and whose refresh tokens may rotate (Planday;
 * docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §3.3, §4.3). The web layer implements it on
 * `IntegrationConnection` (AES-256-GCM with per-column associated data, guarded by `credential_version` and the
 * per-portal sync lease); providers only ever see decrypted values through this interface and never touch the
 * database.
 */

export interface StoredCredentials {
  /** The App ID that issued the tokens (ClockOff's for methods A and B, the customer's for C). */
  readonly clientId: string;
  readonly refreshToken: string;
  /** Cached access token; null when none is stored yet or it was wiped. */
  readonly accessToken: string | null;
  readonly accessTokenExpiresAt: Date | null;
}

export interface RefreshAtomicallyOptions {
  /** Resolve with the stored access token, without a token request, while it stays valid this long. */
  readonly minValidityMs: number;
  /**
   * sha256 hex of the access token the provider just answered 401 to: if the stored token is still that one it
   * is treated as invalid whatever its expiry (forced refresh); if another process already replaced it, the
   * replacement is returned without a token request.
   */
  readonly rejectAccessTokenHash?: string;
  /** Always run the refresh grant (the SYNC run's PORTAL_CHECK phase and retryAuth runs). */
  readonly force?: boolean;
}

export interface CredentialStore {
  read(): Promise<StoredCredentials>;
  /**
   * Runs under the caller's per-portal sync lease. If the stored access token is still valid for
   * `minValidityMs` (and neither `force` nor `rejectAccessTokenHash` rules it out), resolves with it and never
   * calls `exchange`. Otherwise calls `exchange(current)` with no database connection held, then persists `next`
   * (access and refresh token) in one UPDATE guarded by `credential_version` and the lease, and resolves only
   * after it committed. Rejects with {@link CredentialPersistError} when that UPDATE fails or matches no row,
   * with {@link LeaseLostError} when the lease is gone and with {@link CredentialsWipedError} after a disconnect.
   */
  refreshAtomically(
    exchange: (current: StoredCredentials) => Promise<StoredCredentials>,
    options: RefreshAtomicallyOptions,
  ): Promise<StoredCredentials>;
  /** `credential_version` last read or written by this store (fences the slice's status writes). */
  knownVersion(): number;
}

/**
 * New credentials could not be persisted (the guarded UPDATE kept failing, or matched no row for a reason other
 * than a wipe or a lost lease). The unpersisted access token is never used. Retryable at run level.
 */
export class CredentialPersistError extends Error {
  constructor(
    message = "Refreshed credentials could not be persisted",
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CredentialPersistError";
  }
}

/** The connection was disconnected (credentials wiped) while the caller ran; stop without side effects. */
export class CredentialsWipedError extends Error {
  constructor(message = "The connection's credentials were wiped") {
    super(message);
    this.name = "CredentialsWipedError";
  }
}

/**
 * The caller no longer holds the per-portal sync lease (it expired or was taken over, or a disconnect cleared
 * it); stop without writing anything. Declared here, next to the store that raises it, so providers can let it
 * through untouched instead of mapping it to a provider error.
 */
export class LeaseLostError extends Error {
  constructor(message = "The sync lease was lost") {
    super(message);
    this.name = "LeaseLostError";
  }
}

export function isCredentialPersistError(err: unknown): err is CredentialPersistError {
  return err instanceof CredentialPersistError;
}

export function isCredentialsWipedError(err: unknown): err is CredentialsWipedError {
  return err instanceof CredentialsWipedError;
}

export function isLeaseLostError(err: unknown): err is LeaseLostError {
  return err instanceof LeaseLostError;
}
