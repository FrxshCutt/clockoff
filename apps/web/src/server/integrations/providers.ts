import { createPlandayProvider, type PlandayLogger } from "@clockoff/integrations";
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from "@clockoff/shared/enums";
import {
  getProvider,
  isResumableProvider,
  providerAvailability,
  registerProvider,
  unregisterProvider,
  type ResumableWorkforceProvider,
  type WorkforceProvider,
} from "@clockoff/shared/providers/workforceProvider";
import { env } from "@/lib/env";
import { childLogger, type Logger } from "@/lib/logger";
import { plandayTransportClock, resolvingPlandayTransport } from "./transport";

/**
 * Provider registration (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §3.4). `ensureProvidersRegistered()` is
 * idempotent against the registry itself: it registers Planday whenever `getProvider("PLANDAY")` is not a resumable
 * provider, so a fresh module graph or an HMR-reloaded registry gets it again (no `globalThis` flag that could
 * outlive the registry it guards). With `PLANDAY_ENABLED=false` it registers nothing, and removes a Planday
 * provider it registered earlier, so Planday's effective availability is the static COMING_SOON in web and
 * worker alike (the kill switch, appendix A).
 *
 * Called at the top of every Planday service function, `runSyncSlice`, the scheduled slot, the upkeep job and the
 * runner's `start()`.
 */

/** Providers this module registered (only those are ever unregistered by it). */
const ours = new WeakSet<WorkforceProvider>();

/** A pino logger as the provider-facing logger (ids, codes, counts and path templates only, §4.9). */
export function toProviderLogger(log: Logger): PlandayLogger {
  return {
    debug: (obj, msg) => log.debug({ ...obj }, msg),
    info: (obj, msg) => log.info({ ...obj }, msg),
    warn: (obj, msg) => log.warn({ ...obj }, msg),
    error: (obj, msg) => log.error({ ...obj }, msg),
  };
}

export function ensureProvidersRegistered(): void {
  const e = env();
  const current = getProvider("PLANDAY");
  if (!e.PLANDAY_ENABLED) {
    if (ours.has(current)) unregisterProvider("PLANDAY");
    return;
  }
  if (isResumableProvider(current)) return;
  const provider = createPlandayProvider({
    transport: resolvingPlandayTransport,
    logger: toProviderLogger(childLogger({ module: "planday" })),
    config: { clockModeEnabled: e.PLANDAY_CLOCK_MODE_ENABLED },
    // The real clock, unless a test injected the in-process mock with its own clock.
    clock: () => plandayTransportClock()?.() ?? new Date(),
  });
  ours.add(provider);
  registerProvider(provider);
}

/** Tests only: drop a registered Planday provider so the next `ensureProvidersRegistered()` reads the env again. */
export function resetProvidersForTesting(): void {
  if (ours.has(getProvider("PLANDAY"))) unregisterProvider("PLANDAY");
}

/** The registered provider for `id` when it is AVAILABLE and resumable (the run executor's precondition). */
export function availableResumableProvider(
  id: IntegrationProvider,
): ResumableWorkforceProvider | null {
  if (providerAvailability(id) !== "AVAILABLE") return null;
  const provider = getProvider(id);
  return isResumableProvider(provider) ? provider : null;
}

/** Providers whose registered implementation is AVAILABLE and resumable (empty while PLANDAY_ENABLED=false). */
export function availableResumableProviders(): IntegrationProvider[] {
  ensureProvidersRegistered();
  return INTEGRATION_PROVIDERS.filter((id) => availableResumableProvider(id) !== null);
}
