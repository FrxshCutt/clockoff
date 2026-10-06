import { prisma, type Prisma } from "@workmode/db";
import type { ActivationMode, IntegrationProvider } from "@workmode/shared/enums";
import { AppError } from "@workmode/shared/errors";
import {
  getProvider,
  getProviderMetadata,
  listProviders,
  type ProviderMetadata,
} from "@workmode/shared/providers/workforceProvider";
import type {
  ConnectIntegrationInput,
  ConnectIntegrationResponse,
  Integration,
  IntegrationResponse,
  ListIntegrationsResponse,
  SyncIntegrationResponse,
} from "@workmode/validation/integrations";
import { encrypt } from "@/lib/crypto";
import { errorSummary, logger } from "@/lib/logger";
import { audit, toJsonValue } from "@/server/audit/audit";
import type { ManagerContext } from "@/server/tenancy/context";
import {
  deleteIntegrationConnection,
  findIntegration,
  findIntegrations,
  saveIntegrationConnection,
  upsertIntegration,
  type IntegrationRow,
} from "./integrations.repository";

/**
 * Workforce integrations (§5 integrations, §6.6). The dashboard lists every provider from the shared
 * registry merged with the organisation's `Integration` rows. While a provider is COMING_SOON (every
 * provider in the MVP) connect and sync answer 501 COMING_SOON and managers can ask to be notified;
 * once a real `WorkforceProvider` is registered, connect persists the encrypted credentials and
 * disconnect deletes them. Scheduling never talks to providers (docs/INTEGRATIONS.md).
 */

function readSettings(value: Prisma.JsonValue | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function toIntegrationDto(meta: ProviderMetadata, row: IntegrationRow | null): Integration {
  const settings = readSettings(row?.settings);
  const externalAccountName = settings.externalAccountName;
  return {
    provider: meta.id,
    displayName: meta.displayName,
    description: meta.description,
    website: meta.website,
    availability: meta.status,
    status: row?.status ?? "NOT_CONNECTED",
    supportedActivationModes: [...meta.activationModes],
    activationMode: row?.activationMode ?? meta.activationModes[0] ?? "SCHEDULED",
    notifyRequested: row?.notifyRequested ?? false,
    lastSyncAt: row?.connection?.lastSyncAt?.toISOString() ?? null,
    lastError: row?.connection?.lastError ?? null,
    externalAccountName: typeof externalAccountName === "string" ? externalAccountName : null,
  };
}

function comingSoon(meta: ProviderMetadata): AppError {
  return new AppError("COMING_SOON", `${meta.displayName} integration is coming soon`, {
    details: { provider: meta.id },
  });
}

async function integrationDto(organisationId: string, provider: IntegrationProvider): Promise<Integration> {
  const [meta, row] = [getProviderMetadata(provider), await findIntegration(organisationId, provider)];
  return toIntegrationDto(meta, row);
}

/** `GET /api/integrations` — one entry per provider in enum order, connected or not. */
export async function listIntegrations(ctx: ManagerContext): Promise<ListIntegrationsResponse> {
  const rows = await findIntegrations(ctx.organisation.id);
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return {
    integrations: listProviders().map((meta) => toIntegrationDto(meta, byProvider.get(meta.id) ?? null)),
  };
}

/**
 * `POST /api/integrations/:provider/connect` (integrations:write). 501 COMING_SOON unless the provider is
 * AVAILABLE. For an available provider: an OAuth provider first answers with `authorizationUrl` (the
 * manager authorises there and the dashboard calls connect again with `code` + `state`); a credentials
 * provider connects directly. Credentials are AES-256-GCM encrypted at rest and never returned.
 */
export async function connectIntegration(
  ctx: ManagerContext,
  provider: IntegrationProvider,
  input: ConnectIntegrationInput,
): Promise<ConnectIntegrationResponse> {
  const organisationId = ctx.organisation.id;
  const meta = getProviderMetadata(provider);
  if (meta.status !== "AVAILABLE") throw comingSoon(meta);
  const implementation = getProvider(provider);

  const activationMode: ActivationMode =
    input.activationMode ?? meta.activationModes[0] ?? "SCHEDULED";
  const row = await upsertIntegration(organisationId, provider, { activationMode });
  const result = await implementation.connect(
    {
      organisationId,
      integrationId: row.id,
      settings: readSettings(row.settings),
      now: new Date(),
    },
    { activationMode, authorizationCode: input.code, state: input.state },
  );

  if (result.kind === "REDIRECT_REQUIRED") {
    return { integration: toIntegrationDto(meta, row), authorizationUrl: result.authorizationUrl };
  }

  const settings = {
    ...readSettings(row.settings),
    ...(result.settings ?? {}),
    ...(result.externalAccountId !== undefined ? { externalAccountId: result.externalAccountId } : {}),
    ...(result.externalAccountName !== undefined
      ? { externalAccountName: result.externalAccountName }
      : {}),
  };
  const connected = await prisma.$transaction(async (tx) => {
    await saveIntegrationConnection(tx, row.id, {
      encryptedCredentials: encrypt(JSON.stringify(result.credentials ?? null)),
      tokenExpiresAt: result.tokenExpiresAt,
    });
    const updated = await upsertIntegration(
      organisationId,
      provider,
      {
        status: "CONNECTED",
        activationMode,
        settings: (toJsonValue(settings) ?? {}) as Prisma.InputJsonValue,
      },
      tx,
    );
    await audit(
      ctx,
      {
        action: "integration.connected",
        entityType: "Integration",
        entityId: updated.id,
        before: { provider, status: row.status },
        after: {
          provider,
          status: updated.status,
          activationMode,
          externalAccountName: settings.externalAccountName ?? null,
        },
      },
      tx,
    );
    return updated;
  });
  return { integration: toIntegrationDto(meta, connected), authorizationUrl: null };
}

/**
 * `POST /api/integrations/:provider/disconnect` (integrations:write). Deletes stored credentials and marks
 * the integration DISCONNECTED; imported shifts are kept. Idempotent: a provider that was never connected
 * is returned unchanged (200), whatever its availability.
 */
export async function disconnectIntegration(
  ctx: ManagerContext,
  provider: IntegrationProvider,
): Promise<IntegrationResponse> {
  const organisationId = ctx.organisation.id;
  const meta = getProviderMetadata(provider);
  const row = await findIntegration(organisationId, provider);
  const hasConnection =
    row !== null && (row.status === "CONNECTED" || row.status === "ERROR" || row.connection !== null);
  if (!row || !hasConnection) return { integration: toIntegrationDto(meta, row) };

  if (meta.status === "AVAILABLE") {
    try {
      await getProvider(provider).disconnect({
        organisationId,
        integrationId: row.id,
        settings: readSettings(row.settings),
        now: new Date(),
      });
    } catch (err) {
      // The provider-side revocation is best effort: the local credentials are removed regardless.
      logger.warn(
        { organisationId, provider, error: errorSummary(err) },
        "provider disconnect failed; removing local credentials anyway",
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const removed = await deleteIntegrationConnection(tx, row.id);
    const after = await upsertIntegration(organisationId, provider, { status: "DISCONNECTED" }, tx);
    await audit(
      ctx,
      {
        action: "integration.disconnected",
        entityType: "Integration",
        entityId: row.id,
        before: { provider, status: row.status },
        after: { provider, status: after.status, credentialsRemoved: removed > 0 },
      },
      tx,
    );
    return after;
  });
  return { integration: toIntegrationDto(meta, updated) };
}

/**
 * `POST /api/integrations/:provider/sync` (integrations:write). 501 COMING_SOON unless the provider is
 * AVAILABLE; CONFLICT when it is available but not connected. The sync itself needs the
 * `WorkforceSyncSink` that writes through the shifts / employees services (Phase 2, with the first real
 * provider); until that sink exists an available, connected provider also answers COMING_SOON with
 * `details.reason = "SYNC_SINK_PENDING"` rather than pretending to have synced.
 */
export async function syncIntegration(
  ctx: ManagerContext,
  provider: IntegrationProvider,
): Promise<SyncIntegrationResponse> {
  const meta = getProviderMetadata(provider);
  if (meta.status !== "AVAILABLE") throw comingSoon(meta);
  const row = await findIntegration(ctx.organisation.id, provider);
  if (!row || row.status !== "CONNECTED") {
    throw new AppError("CONFLICT", `Connect ${meta.displayName} before syncing`, {
      details: { provider, status: row?.status ?? "NOT_CONNECTED" },
    });
  }
  throw new AppError("COMING_SOON", `${meta.displayName} sync is not available yet`, {
    details: { provider, reason: "SYNC_SINK_PENDING" },
  });
}

/** `POST /api/integrations/:provider/notify-me` — remember that this organisation wants to hear about the provider. */
export async function requestIntegrationNotification(
  ctx: ManagerContext,
  provider: IntegrationProvider,
): Promise<IntegrationResponse> {
  const organisationId = ctx.organisation.id;
  const meta = getProviderMetadata(provider);
  const existing = await findIntegration(organisationId, provider);
  if (existing?.notifyRequested) return { integration: toIntegrationDto(meta, existing) };

  const updated = await prisma.$transaction(async (tx) => {
    const row = await upsertIntegration(organisationId, provider, { notifyRequested: true }, tx);
    await audit(
      ctx,
      {
        action: "integration.notify_requested",
        entityType: "Integration",
        entityId: row.id,
        before: { provider, notifyRequested: existing?.notifyRequested ?? false },
        after: { provider, notifyRequested: true },
      },
      tx,
    );
    return row;
  });
  return { integration: toIntegrationDto(meta, updated) };
}

export { integrationDto as getIntegration };
