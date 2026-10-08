import {
  emptySyncReport,
  getProviderMetadata,
  registerProvider,
  unregisterProvider,
  type WorkforceProvider,
} from "@clockoff/shared/providers/workforceProvider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@/lib/logger";
import { runScheduledIntegrationSyncs } from "./scheduledSync";

const log = createLogger({ level: "silent" });
const now = new Date("2026-10-08T09:15:00.000Z");

function fakeProvider(): WorkforceProvider {
  const report = async () => emptySyncReport("PLANDAY", now);
  return {
    id: "PLANDAY",
    displayName: "Planday",
    status: "AVAILABLE",
    connect: vi.fn(),
    disconnect: vi.fn(),
    refreshAuthentication: vi.fn(),
    syncEmployees: vi.fn(report),
    syncShifts: vi.fn(report),
    syncLocations: vi.fn(report),
    syncTeams: vi.fn(report),
    syncClockEvents: vi.fn(report),
    getConnectionStatus: vi.fn(),
  };
}

afterEach(() => {
  unregisterProvider("PLANDAY");
});

describe("runScheduledIntegrationSyncs", () => {
  it("is a no-op while no provider is AVAILABLE", async () => {
    expect(getProviderMetadata("PLANDAY").status).toBe("COMING_SOON");
    const findConnected = vi.fn(async () => []);
    expect(await runScheduledIntegrationSyncs(now, { log, findConnected })).toEqual({
      availableProviders: 0,
      integrations: 0,
      synced: 0,
      skipped: 0,
      reason: "NO_AVAILABLE_PROVIDER",
    });
    expect(findConnected).not.toHaveBeenCalled();
  });

  it("skips connected integrations of an AVAILABLE provider with SYNC_SINK_PENDING and never calls the provider", async () => {
    const provider = fakeProvider();
    registerProvider(provider);
    const findConnected = vi.fn(async (p: string) =>
      p === "PLANDAY"
        ? [{ id: "1d8a4d3e-1f5c-4c39-9a62-1b0f6f2b9c11", organisationId: "org-1" }]
        : [],
    );
    expect(await runScheduledIntegrationSyncs(now, { log, findConnected })).toEqual({
      availableProviders: 1,
      integrations: 1,
      synced: 0,
      skipped: 1,
      reason: "SYNC_SINK_PENDING",
    });
    expect(findConnected).toHaveBeenCalledWith("PLANDAY");
    for (const method of Object.values(provider)) {
      if (typeof method === "function") expect(method).not.toHaveBeenCalled();
    }
  });

  it("an AVAILABLE provider without connected integrations has nothing to do", async () => {
    registerProvider(fakeProvider());
    expect(await runScheduledIntegrationSyncs(now, { log, findConnected: async () => [] })).toEqual(
      {
        availableProviders: 1,
        integrations: 0,
        synced: 0,
        skipped: 0,
      },
    );
  });
});
