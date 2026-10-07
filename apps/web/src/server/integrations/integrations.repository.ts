import { prisma, type Prisma } from "@clockoff/db";
import type {
  ActivationMode,
  IntegrationProvider,
  IntegrationStatus,
} from "@clockoff/shared/enums";

/**
 * `Integration` rows (one per organisation and provider, created lazily) and their `IntegrationConnection`
 * secrets. Credentials are only ever read back decrypted inside the integrations service.
 */

export type Db = Prisma.TransactionClient | typeof prisma;

export const integrationInclude = {
  connection: { select: { lastSyncAt: true, lastError: true, tokenExpiresAt: true } },
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

export async function saveIntegrationConnection(
  tx: Prisma.TransactionClient,
  integrationId: string,
  data: { encryptedCredentials: Buffer; tokenExpiresAt: Date | null },
): Promise<void> {
  // Prisma `Bytes` columns take a Uint8Array backed by a plain ArrayBuffer.
  const encryptedCredentials = new Uint8Array(data.encryptedCredentials);
  await tx.integrationConnection.upsert({
    where: { integrationId },
    create: { integrationId, encryptedCredentials, tokenExpiresAt: data.tokenExpiresAt },
    update: { encryptedCredentials, tokenExpiresAt: data.tokenExpiresAt, lastError: null },
  });
}

export async function deleteIntegrationConnection(
  tx: Prisma.TransactionClient,
  integrationId: string,
): Promise<number> {
  const result = await tx.integrationConnection.deleteMany({ where: { integrationId } });
  return result.count;
}
