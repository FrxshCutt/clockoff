import { prisma, type Prisma } from "@clockoff/db";
import type {
  ActivationMode,
  IntegrationProvider,
  IntegrationStatus,
} from "@clockoff/shared/enums";

/**
 * `Integration` rows (one per organisation and provider, created lazily) and their `IntegrationConnection`
 * secrets. Credentials are only ever read back decrypted inside the integrations service. A connection row
 * lives as long as its integration: disconnecting wipes its secrets and keeps the row (and its portal id).
 */

export type Db = Prisma.TransactionClient | typeof prisma;

export const integrationInclude = {
  connection: {
    select: {
      status: true,
      lastSuccessfulSyncAt: true,
      lastErrorMessage: true,
      accessTokenExpiresAt: true,
    },
  },
} satisfies Prisma.IntegrationInclude;
export type IntegrationRow = Prisma.IntegrationGetPayload<{ include: typeof integrationInclude }>;

export async function findIntegrations(
  organisationId: string,
  db: Db = prisma,
): Promise<IntegrationRow[]> {
  return db.integration.findMany({ where: { organisationId }, include: integrationInclude });
}

export async function findIntegration(
  organisationId: string,
  provider: IntegrationProvider,
  db: Db = prisma,
): Promise<IntegrationRow | null> {
  return db.integration.findFirst({
    where: { organisationId, provider },
    include: integrationInclude,
  });
}

export interface IntegrationUpsertData {
  notifyRequested?: boolean;
  activationMode?: ActivationMode;
  status?: IntegrationStatus;
  settings?: Prisma.InputJsonValue;
}

/** Create the row with defaults when missing, otherwise apply `data`. */
export async function upsertIntegration(
  organisationId: string,
  provider: IntegrationProvider,
  data: IntegrationUpsertData,
  db: Db = prisma,
): Promise<IntegrationRow> {
  return db.integration.upsert({
    where: { organisationId_provider: { organisationId, provider } },
    create: { organisationId, provider, ...data },
    update: data,
    include: integrationInclude,
  });
}

/**
 * Generic (non-Planday) connect: stores the provider's credential blob in the legacy column and marks the
 * connection CONNECTED. Planday connections are written by the Planday service, never here.
 */
export async function saveIntegrationConnection(
  tx: Prisma.TransactionClient,
  integrationId: string,
  data: {
    legacyEncryptedCredentials: Buffer;
    accessTokenExpiresAt: Date | null;
    connectedByUserId: string | null;
    now: Date;
  },
): Promise<void> {
  // Prisma `Bytes` columns take a Uint8Array backed by a plain ArrayBuffer.
  const legacyEncryptedCredentials = new Uint8Array(data.legacyEncryptedCredentials);
  const connected = {
    legacyEncryptedCredentials,
    accessTokenExpiresAt: data.accessTokenExpiresAt,
    status: "CONNECTED",
    statusChangedAt: data.now,
    connectedByUserId: data.connectedByUserId,
    connectedAt: data.now,
    disconnectedAt: null,
  } satisfies Prisma.IntegrationConnectionUncheckedUpdateInput;
  await tx.integrationConnection.upsert({
    where: { integrationId },
    create: { integrationId, ...connected, credentialVersion: 1 },
    update: {
      ...connected,
      credentialVersion: { increment: 1 },
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
}

/**
 * `SELECT … FOR UPDATE` on the integration row inside a transaction, so concurrent disconnects (and later
 * connects) of one integration serialise: the caller re-reads the row after the lock and decides on that.
 * Returns false when the row does not exist.
 */
export async function lockIntegrationRow(
  tx: Prisma.TransactionClient,
  integrationId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM integrations WHERE id = ${integrationId}::uuid FOR UPDATE`;
  return rows.length === 1;
}

/**
 * Disconnect keeps the row: wipes every stored secret (legacy blob, client id, refresh and access tokens,
 * expiry, hint; `credentialVersion + 1`), releases the sync lease and the pending-run slot, stops scheduling and
 * marks the connection DISCONNECTED. The portal id, mapping config and entity maps stay so reconnecting the same
 * portal reuses them. A compare-and-set: a connection already DISCONNECTED with no secret left is not touched
 * again (no second `credentialVersion` bump, `disconnectedAt` kept). Returns the number of connection rows wiped
 * (0 or 1).
 */
export async function wipeIntegrationConnection(
  tx: Prisma.TransactionClient,
  integrationId: string,
  now: Date,
): Promise<number> {
  const result = await tx.integrationConnection.updateMany({
    where: {
      integrationId,
      OR: [
        { status: { not: "DISCONNECTED" } },
        // A row the migration marked DISCONNECTED may still hold a legacy secret (plan §2.7).
        { legacyEncryptedCredentials: { not: null } },
        { encryptedClientId: { not: null } },
        { encryptedRefreshToken: { not: null } },
        { encryptedAccessToken: { not: null } },
      ],
    },
    data: {
      legacyEncryptedCredentials: null,
      encryptedClientId: null,
      encryptedRefreshToken: null,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
      credentialHint: null,
      credentialVersion: { increment: 1 },
      status: "DISCONNECTED",
      statusChangedAt: now,
      disconnectedAt: now,
      nextSyncAt: null,
      syncLeaseId: null,
      syncLeaseExpiresAt: null,
      pendingRunKind: null,
      pendingRunTrigger: null,
      pendingRunRetryAuth: false,
      pendingRunRequestedByUserId: null,
      pendingRunRequestedAt: null,
    },
  });
  return result.count;
}
