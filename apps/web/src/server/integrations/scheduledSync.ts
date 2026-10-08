import { prisma } from "@clockoff/db";
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from "@clockoff/shared/enums";
import { providerAvailability } from "@clockoff/shared/providers/workforceProvider";
import { childLogger, type Logger } from "@/lib/logger";

/**
 * Scheduled provider syncs — the worker's `integrations-sync` job (every 15 minutes, under its own
 * advisory lock and slot claim; `node main.mjs run integrations-sync` for a manual run).
 *
 * TODAY THIS IS A DOCUMENTED NO-OP. Every provider is COMING_SOON, so nothing is AVAILABLE and the job
 * reports `NO_AVAILABLE_PROVIDER`. Once a real provider registers (`registerProvider`, e.g. Planday) its
 * CONNECTED integrations are found here but skipped with `SYNC_SINK_PENDING`, mirroring
 * `syncIntegration` in integrations.service.ts: the `WorkforceSyncSink` that writes synced records
 * through the shifts / employees services does not exist yet, and this function never calls a provider
 * or pretends to have synced.
 *
 * For the Planday implementer: replace the skip in the loop below with the real sync for each connected
 * integration — decrypt the credentials, build the `ProviderContext` with the sink, call the provider's
 * sync methods, record `IntegrationConnection.lastSyncAt` / `lastError` — and throttle on `lastSyncAt`
 * (skip an integration synced less than ~14 minutes ago). The throttle matters: the job's lock and slot
 * claim make a scheduled slot run once across workers, but a manual run or a lock session lost mid-run
 * can start a second sync. Keep each integration's failure isolated (log + `lastError`, continue) and
 * bound the whole run with a deadline well under 15 minutes; the worker does not watch this lane.
 */

export interface ScheduledSyncReport {
  /** Providers whose effective availability is AVAILABLE (a real implementation is registered). */
  availableProviders: number;
  /** CONNECTED integrations of those providers. */
  integrations: number;
  synced: number;
  skipped: number;
  reason?: "NO_AVAILABLE_PROVIDER" | "SYNC_SINK_PENDING";
}

export interface ScheduledSyncOptions {
  log?: Logger;
  /** CONNECTED integrations of one provider (test seam; default reads the `integrations` table). */
  findConnected?: (
    provider: IntegrationProvider,
  ) => Promise<Array<{ id: string; organisationId: string }>>;
}

async function findConnectedIntegrations(
  provider: IntegrationProvider,
): Promise<Array<{ id: string; organisationId: string }>> {
  return prisma.integration.findMany({
    where: { provider, status: "CONNECTED" },
    select: { id: true, organisationId: true },
    orderBy: [{ organisationId: "asc" }],
  });
}

export async function runScheduledIntegrationSyncs(
  now: Date,
  opts: ScheduledSyncOptions = {},
): Promise<ScheduledSyncReport> {
  const log = opts.log ?? childLogger({ module: "integrationsSync" });
  const findConnected = opts.findConnected ?? findConnectedIntegrations;
  const available = INTEGRATION_PROVIDERS.filter((id) => providerAvailability(id) === "AVAILABLE");
  if (available.length === 0) {
    return {
      availableProviders: 0,
      integrations: 0,
      synced: 0,
      skipped: 0,
      reason: "NO_AVAILABLE_PROVIDER",
    };
  }

  const report: ScheduledSyncReport = {
    availableProviders: available.length,
    integrations: 0,
    synced: 0,
    skipped: 0,
  };
  for (const provider of available) {
    const connected = await findConnected(provider);
    report.integrations += connected.length;
    for (const integration of connected) {
      // No sync sink yet (see the module comment): skip instead of calling the provider.
      report.skipped += 1;
      log.debug(
        { provider, integrationId: integration.id, at: now.toISOString() },
        "scheduled sync skipped: sync sink pending",
      );
    }
  }
  if (report.skipped > 0) report.reason = "SYNC_SINK_PENDING";
  return report;
}
