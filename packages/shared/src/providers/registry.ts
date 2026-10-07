import type { ActivationMode } from "../enums";
import { INTEGRATION_PROVIDERS } from "../enums";
import { AppError } from "../errors";
import { ComingSoonProvider } from "./comingSoonProvider";
import type { ProviderAvailability, ProviderId, WorkforceProvider } from "./workforceProvider";

/**
 * Static, UI-facing facts about a provider, independent of whether an implementation exists yet.
 * Scheduling, the Work Mode state machine and the dashboard never call providers: they read Shift,
 * Employee, Location, Team and ClockEvent rows that a provider sync wrote. See docs/INTEGRATIONS.md.
 */
export interface ProviderMetadata {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly website: string;
  readonly description: string;
  /**
   * Activation modes ClockOff will support for this provider: SCHEDULED (Work Mode follows synced shifts)
   * and/or CLOCK_EVENT (Work Mode follows synced clock-in / clock-out events).
   */
  readonly activationModes: readonly ActivationMode[];
  readonly status: ProviderAvailability;
}

const BOTH_MODES: readonly ActivationMode[] = ["SCHEDULED", "CLOCK_EVENT"];

export const PROVIDERS: Record<ProviderId, ProviderMetadata> = {
  PLANDAY: {
    id: "PLANDAY",
    displayName: "Planday",
    website: "https://www.planday.com",
    description:
      "Shift scheduling, punch clock and payroll prep for hospitality and retail. Will sync employees, departments, shifts and punch-clock events.",
    activationModes: BOTH_MODES,
    status: "COMING_SOON",
  },
  DEPUTY: {
    id: "DEPUTY",
    displayName: "Deputy",
    website: "https://www.deputy.com",
    description:
      "Rostering and timesheets for hourly teams. Will sync employees, locations, areas, rosters and timesheet clock-ins.",
    activationModes: BOTH_MODES,
    status: "COMING_SOON",
  },
  SEVENSHIFTS: {
    id: "SEVENSHIFTS",
    displayName: "7shifts",
    website: "https://www.7shifts.com",
    description:
      "Restaurant scheduling and time clocking. Will sync employees, locations, departments, shifts and time punches.",
    activationModes: BOTH_MODES,
    status: "COMING_SOON",
  },
  WHEN_I_WORK: {
    id: "WHEN_I_WORK",
    displayName: "When I Work",
    website: "https://wheniwork.com",
    description:
      "Employee scheduling and time clock for small businesses. Will sync employees, locations, positions, shifts and time entries.",
    activationModes: BOTH_MODES,
    status: "COMING_SOON",
  },
  ROTAREADY: {
    id: "ROTAREADY",
    displayName: "Rotaready",
    website: "https://www.rotaready.com",
    description:
      "Rota, time and attendance and HR for UK hospitality, retail and leisure. Will sync staff, sites, rotas and clock-in records.",
    activationModes: BOTH_MODES,
    status: "COMING_SOON",
  },
  HOMEBASE: {
    id: "HOMEBASE",
    displayName: "Homebase",
    website: "https://joinhomebase.com",
    description:
      "Scheduling, time clock and team communication for small businesses. Will sync employees, locations, shifts and timecards.",
    activationModes: BOTH_MODES,
    status: "COMING_SOON",
  },
};

/** Real implementations registered at startup (Phase 2). Anything unregistered resolves to a placeholder. */
const implementations = new Map<ProviderId, WorkforceProvider>();
/** One ComingSoonProvider per id, created lazily. */
const placeholders = new Map<ProviderId, ComingSoonProvider>();

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (INTEGRATION_PROVIDERS as readonly string[]).includes(value);
}

function assertProviderId(id: unknown): asserts id is ProviderId {
  if (!isProviderId(id)) {
    throw new AppError("NOT_FOUND", `Unknown integration provider: ${String(id)}`, {
      details: { provider: id },
    });
  }
}

/**
 * Metadata for one provider, with `status` reflecting any registered implementation — the same view as the
 * matching `listProviders()` entry. `PROVIDERS[id]` is the static table and does not.
 */
export function getProviderMetadata(id: ProviderId): ProviderMetadata {
  assertProviderId(id);
  return { ...PROVIDERS[id], status: providerAvailability(id) };
}

/** Effective availability: the registered implementation's status, else the static metadata's. */
export function providerAvailability(id: ProviderId): ProviderAvailability {
  assertProviderId(id);
  return implementations.get(id)?.status ?? PROVIDERS[id].status;
}

/**
 * Metadata for every provider in enum order (the order the dashboard lists them), with `status` reflecting
 * any registered implementation, so registering an AVAILABLE provider flips its card from "Coming soon" to
 * connectable without touching the static table.
 */
export function listProviders(): ProviderMetadata[] {
  return INTEGRATION_PROVIDERS.map((id) => getProviderMetadata(id));
}

/**
 * The implementation for `id`: a registered real provider, or a `ComingSoonProvider` whose every method
 * rejects with AppError COMING_SOON (HTTP 501). Throws AppError NOT_FOUND for an unknown id (e.g. a bad
 * URL segment that skipped validation).
 */
export function getProvider(id: ProviderId): WorkforceProvider {
  assertProviderId(id);
  const registered = implementations.get(id);
  if (registered) return registered;
  let placeholder = placeholders.get(id);
  if (!placeholder) {
    placeholder = new ComingSoonProvider(id, PROVIDERS[id].displayName);
    placeholders.set(id, placeholder);
  }
  return placeholder;
}

/** Registers a real implementation (call once at server startup). Replaces any earlier registration for the id. */
export function registerProvider(provider: WorkforceProvider): void {
  assertProviderId(provider.id);
  implementations.set(provider.id, provider);
}

/** Removes a registered implementation so `getProvider` falls back to the placeholder. Intended for tests. */
export function unregisterProvider(id: ProviderId): void {
  implementations.delete(id);
}
