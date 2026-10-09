import { setTimeout as sleep } from "node:timers/promises";
import { Prisma, prisma } from "@clockoff/db";
import {
  CredentialPersistError,
  CredentialsWipedError,
  LeaseLostError,
  type CredentialStore,
  type RefreshAtomicallyOptions,
  type StoredCredentials,
} from "@clockoff/shared/providers/credentialStore";
import { decryptToString, encrypt, integrationAad, sha256Hex } from "@/lib/crypto";

export { CredentialPersistError, CredentialsWipedError, LeaseLostError };

/**
 * `PrismaCredentialStore` (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.3, §4.3.1): Planday credentials on
 * `integration_connections`, each column AES-256-GCM with associated data `integration:<id>:<column>`, refreshed
 * under the caller's per-portal sync lease without ever holding a database connection across the token request.
 *
 * ```text
 * refreshAtomically(exchange, { minValidityMs, rejectAccessTokenHash, force })
 *   read the row (plain read, lease checked on the database clock)
 *   wiped → CredentialsWipedError; lease not held → LeaseLostError
 *   stored token valid for minValidityMs (and not forced, not the rejected one) → return it
 *   next = await exchange(current)                 // no database connection held
 *   one guarded UPDATE (credential_version, lease, not DISCONNECTED) writes the access token, and the refresh
 *   token only when it rotated, in one statement; up to 3 attempts (≤ 5 s) on transient database errors with the
 *   same in-memory `next`; 0 rows → re-read: wiped / lease lost / CredentialPersistError (never retried)
 * ```
 *
 * The new access token is returned only after its UPDATE committed; when persisting fails the caller never sees it
 * (§4.3 failure path). `knownVersion()` is the `credential_version` last read or written: the slice fences its
 * connection-status writes with it (§7.6), so a disconnect or a reconnect (each bumps the version) turns every later
 * status write of that slice into a no-op.
 */

/** Transient database errors worth retrying the same statement (§4.3, §7.6). */
const TRANSIENT_PRISMA_CODES: ReadonlySet<string> = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2028",
  "P2034",
]);

/** Whether `err` is a transient database failure (connection refused or dropped, pool timeout, serialization). */
export function isTransientDatabaseError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return TRANSIENT_PRISMA_CODES.has(err.code);
  }
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return /connection|terminat|closed|ECONNRESET/i.test(err.message);
  }
  return false;
}

/** Last four characters of a refresh token: "ending ••••4f2a" (§5.5). Nothing else of a secret is ever shown. */
export function credentialHintOf(refreshToken: string): string {
  return refreshToken.slice(-4);
}

/** Prisma `Bytes` from a ciphertext (a copy on a plain ArrayBuffer). */
function bytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer);
}

/** The encrypted columns for `credentials` (connect transaction, §5.5; refresh). */
export function encryptCredentialColumns(integrationId: string, credentials: StoredCredentials) {
  return {
    encryptedClientId: bytes(
      encrypt(credentials.clientId, undefined, integrationAad(integrationId, "client_id")),
    ),
    encryptedRefreshToken: bytes(
      encrypt(credentials.refreshToken, undefined, integrationAad(integrationId, "refresh_token")),
    ),
    encryptedAccessToken:
      credentials.accessToken === null
        ? null
        : bytes(
            encrypt(
              credentials.accessToken,
              undefined,
              integrationAad(integrationId, "access_token"),
            ),
          ),
    accessTokenExpiresAt: credentials.accessTokenExpiresAt,
    credentialHint: credentialHintOf(credentials.refreshToken),
  };
}

interface StoredRow {
  encrypted_client_id: Uint8Array | null;
  encrypted_refresh_token: Uint8Array | null;
  encrypted_access_token: Uint8Array | null;
  token_expires_at: Date | null;
  credential_version: number;
  status: string;
  lease_held: boolean;
}

/** Decrypts a connection's credential columns (AAD-bound to the integration). */
export function decryptCredentialColumns(
  integrationId: string,
  row: {
    encryptedClientId: Uint8Array;
    encryptedRefreshToken: Uint8Array;
    encryptedAccessToken: Uint8Array | null;
    accessTokenExpiresAt: Date | null;
  },
): StoredCredentials {
  const accessToken = row.encryptedAccessToken
    ? decryptToString(
        Buffer.from(row.encryptedAccessToken),
        undefined,
        integrationAad(integrationId, "access_token"),
      )
    : null;
  return {
    clientId: decryptToString(
      Buffer.from(row.encryptedClientId),
      undefined,
      integrationAad(integrationId, "client_id"),
    ),
    refreshToken: decryptToString(
      Buffer.from(row.encryptedRefreshToken),
      undefined,
      integrationAad(integrationId, "refresh_token"),
    ),
    accessToken,
    accessTokenExpiresAt: accessToken ? row.accessTokenExpiresAt : null,
  };
}

/** Fault injection for the token-refresh suite (§4.3 test): runs before every persist attempt. */
export interface CredentialStoreFaults {
  beforePersist?: (attempt: number) => void | Promise<void>;
}

let testFaults: CredentialStoreFaults | null = null;

/** Tests only: inject database faults into every store's persist step (`null` removes them). */
export function setCredentialStoreFaultsForTesting(faults: CredentialStoreFaults | null): void {
  testFaults = faults;
}

export interface PrismaCredentialStoreOptions {
  readonly integrationId: string;
  /** The caller's lease token (`sync_lease_id`): every refresh runs under it. */
  readonly holder: string;
  /** Clock for the stored token's validity (the provider's HTTP clock). */
  readonly now?: () => Date;
  readonly db?: typeof prisma;
  /** Persist attempts on transient errors (default 3) within {@link PERSIST_BUDGET_MS}. */
  readonly persistAttempts?: number;
}

/** Total time the persist retries may take (§4.3: ≤ 5 s). */
export const PERSIST_BUDGET_MS = 5_000;
const PERSIST_RETRY_DELAY_MS = 250;

export class PrismaCredentialStore implements CredentialStore {
  private version = -1;
  private readonly integrationId: string;
  private readonly holder: string;
  private readonly now: () => Date;
  private readonly db: typeof prisma;
  private readonly persistAttempts: number;

  constructor(options: PrismaCredentialStoreOptions) {
    this.integrationId = options.integrationId;
    this.holder = options.holder;
    this.now = options.now ?? (() => new Date());
    this.db = options.db ?? prisma;
    this.persistAttempts = options.persistAttempts ?? 3;
  }

  knownVersion(): number {
    return this.version;
  }

  /** Sets the version the slice read before the store made any call (§7.6 `v0`). */
  seedVersion(version: number): void {
    if (this.version < 0) this.version = version;
  }

  private async readRow(): Promise<StoredRow> {
    const rows = await this.db.$queryRaw<StoredRow[]>`
      SELECT encrypted_client_id, encrypted_refresh_token, encrypted_access_token, token_expires_at,
             credential_version, status::text AS status,
             (sync_lease_id = ${this.holder}::uuid AND sync_lease_expires_at > now()) AS lease_held
        FROM integration_connections WHERE integration_id = ${this.integrationId}::uuid`;
    const row = rows[0];
    if (!row) throw new CredentialsWipedError();
    return row;
  }

  private decrypt(row: StoredRow): StoredCredentials {
    if (
      row.status === "DISCONNECTED" ||
      row.encrypted_refresh_token === null ||
      row.encrypted_client_id === null
    ) {
      throw new CredentialsWipedError();
    }
    return decryptCredentialColumns(this.integrationId, {
      encryptedClientId: row.encrypted_client_id,
      encryptedRefreshToken: row.encrypted_refresh_token,
      encryptedAccessToken: row.encrypted_access_token,
      accessTokenExpiresAt: row.token_expires_at,
    });
  }

  async read(): Promise<StoredCredentials> {
    const row = await this.readRow();
    const credentials = this.decrypt(row);
    this.version = row.credential_version;
    return credentials;
  }

  async refreshAtomically(
    exchange: (current: StoredCredentials) => Promise<StoredCredentials>,
    options: RefreshAtomicallyOptions,
  ): Promise<StoredCredentials> {
    const row = await this.readRow();
    const current = this.decrypt(row);
    if (!row.lease_held) throw new LeaseLostError();
    this.version = row.credential_version;

    const rejected =
      options.rejectAccessTokenHash !== undefined &&
      current.accessToken !== null &&
      sha256Hex(current.accessToken) === options.rejectAccessTokenHash;
    const valid =
      current.accessToken !== null &&
      current.accessTokenExpiresAt !== null &&
      current.accessTokenExpiresAt.getTime() > this.now().getTime() + options.minValidityMs;
    if (!options.force && !rejected && valid) return current;

    // One token request; no database connection is held while it runs.
    const next = await exchange(current);
    const rotated = next.refreshToken !== current.refreshToken;
    await this.persist(next, rotated, row.credential_version);
    return next;
  }

  private async persist(
    next: StoredCredentials,
    rotated: boolean,
    expectedVersion: number,
  ): Promise<void> {
    const id = this.integrationId;
    const accessToken =
      next.accessToken === null
        ? null
        : encrypt(next.accessToken, undefined, integrationAad(id, "access_token"));
    const refreshToken = rotated
      ? encrypt(next.refreshToken, undefined, integrationAad(id, "refresh_token"))
      : null;
    const hint = rotated ? credentialHintOf(next.refreshToken) : null;
    const startedAt = Date.now();
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.persistAttempts; attempt++) {
      try {
        await testFaults?.beforePersist?.(attempt);
        const updated = await this.db.$queryRaw<Array<{ credential_version: number }>>`
          UPDATE integration_connections SET
                 encrypted_access_token = ${accessToken},
                 token_expires_at = ${next.accessTokenExpiresAt}::timestamptz,
                 encrypted_refresh_token = CASE WHEN ${rotated} THEN ${refreshToken}::bytea
                                                ELSE encrypted_refresh_token END,
                 credential_hint = CASE WHEN ${rotated} THEN ${hint}::varchar ELSE credential_hint END,
                 refresh_token_rotated_at = CASE WHEN ${rotated} THEN now() ELSE refresh_token_rotated_at END,
                 credential_version = credential_version + 1,
                 updated_at = now()
           WHERE integration_id = ${id}::uuid
             AND credential_version = ${expectedVersion}
             AND sync_lease_id = ${this.holder}::uuid
             AND sync_lease_expires_at > now()
             AND status <> 'DISCONNECTED'
          RETURNING credential_version`;
        const written = updated[0];
        if (written) {
          this.version = written.credential_version;
          return;
        }
        // Zero rows: never retried. Tell a wipe and a lost lease apart from anything else.
        const now = await this.readRow();
        if (
          now.status === "DISCONNECTED" ||
          now.encrypted_refresh_token === null ||
          now.encrypted_client_id === null
        ) {
          throw new CredentialsWipedError();
        }
        if (!now.lease_held) throw new LeaseLostError();
        throw new CredentialPersistError("The credential row changed while refreshing");
      } catch (err) {
        if (!isTransientDatabaseError(err)) throw err;
        lastError = err;
        if (attempt >= this.persistAttempts || Date.now() - startedAt >= PERSIST_BUDGET_MS) break;
        await sleep(PERSIST_RETRY_DELAY_MS);
      }
    }
    throw new CredentialPersistError(undefined, { cause: lastError });
  }
}

/** A store for one integration under `holder` (the runner's slice, the connect proof's lease). */
export function createPrismaCredentialStore(
  options: PrismaCredentialStoreOptions,
): PrismaCredentialStore {
  return new PrismaCredentialStore(options);
}
