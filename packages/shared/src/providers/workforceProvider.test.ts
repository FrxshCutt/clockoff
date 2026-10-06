import { afterEach, describe, expect, it } from "vitest";
import { ACTIVATION_MODES, INTEGRATION_PROVIDERS } from "../enums";
import { AppError, ERROR_HTTP_STATUS } from "../errors";
import {
  ComingSoonProvider,
  PROVIDERS,
  ProviderError,
  SYNC_ERROR_CODES,
  createSyncReportBuilder,
  emptySyncReport,
  getProvider,
  getProviderMetadata,
  isProviderError,
  isProviderId,
  listProviders,
  providerAvailability,
  registerProvider,
  unregisterProvider,
  type ConnectResult,
  type ConnectionStatus,
  type ProviderContext,
  type ProviderId,
  type SyncReport,
  type UpsertOutcome,
  type WorkforceProvider,
} from "./workforceProvider";

const NOW = new Date("2026-10-05T10:00:00Z");
const ctx: ProviderContext = {
  organisationId: "org-1",
  integrationId: "int-1",
  settings: {},
  now: NOW,
};

/** Test-only stand-in for a Phase 2 implementation. */
class MockAvailableProvider implements WorkforceProvider {
  readonly id = "PLANDAY" as const;
  readonly displayName = "Planday (mock)";
  readonly status = "AVAILABLE" as const;
  private report(): SyncReport {
    return emptySyncReport(this.id, NOW);
  }
  async connect(): Promise<ConnectResult> {
    return { kind: "CONNECTED", credentials: { refreshToken: "r" }, tokenExpiresAt: null };
  }
  async disconnect(): Promise<void> {}
  async refreshAuthentication(): Promise<void> {}
  async syncEmployees(): Promise<SyncReport> {
    return this.report();
  }
  async syncShifts(): Promise<SyncReport> {
    return this.report();
  }
  async syncLocations(): Promise<SyncReport> {
    return this.report();
  }
  async syncTeams(): Promise<SyncReport> {
    return this.report();
  }
  async syncClockEvents(): Promise<SyncReport> {
    return this.report();
  }
  async getConnectionStatus(): Promise<ConnectionStatus> {
    return {
      status: "CONNECTED",
      connected: true,
      lastSyncAt: null,
      tokenExpiresAt: null,
      lastError: null,
    };
  }
}

const METHODS = [
  "connect",
  "disconnect",
  "refreshAuthentication",
  "syncEmployees",
  "syncShifts",
  "syncLocations",
  "syncTeams",
  "syncClockEvents",
  "getConnectionStatus",
] as const satisfies readonly (keyof WorkforceProvider)[];

async function callMethod(
  provider: WorkforceProvider,
  method: (typeof METHODS)[number],
): Promise<unknown> {
  switch (method) {
    case "connect":
      return provider.connect(ctx, { activationMode: "SCHEDULED" });
    case "disconnect":
      return provider.disconnect(ctx);
    case "refreshAuthentication":
      return provider.refreshAuthentication(ctx);
    case "syncEmployees":
      return provider.syncEmployees(ctx);
    case "syncShifts":
      return provider.syncShifts(ctx, { from: NOW, to: NOW });
    case "syncLocations":
      return provider.syncLocations(ctx);
    case "syncTeams":
      return provider.syncTeams(ctx);
    case "syncClockEvents":
      return provider.syncClockEvents(ctx, NOW);
    case "getConnectionStatus":
      return provider.getConnectionStatus(ctx);
    default: {
      const exhaustive: never = method;
      throw new Error(String(exhaustive));
    }
  }
}

describe("PROVIDERS metadata", () => {
  it("covers exactly the IntegrationProvider enum, in enum order", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual([...INTEGRATION_PROVIDERS].sort());
    expect(listProviders().map((p) => p.id)).toEqual([...INTEGRATION_PROVIDERS]);
  });

  it("has consistent ids, https websites, descriptions and supported activation modes", () => {
    for (const meta of listProviders()) {
      expect(PROVIDERS[meta.id]).toEqual(meta);
      expect(getProviderMetadata(meta.id)).toEqual(PROVIDERS[meta.id]);
      expect(PROVIDERS[meta.id].id).toBe(meta.id);
      expect(meta.website).toMatch(/^https:\/\/[a-z0-9.-]+$/);
      expect(meta.description.length).toBeGreaterThan(30);
      expect(meta.description).toMatch(/Will sync/); // nothing syncs until an implementation exists
      expect(meta.activationModes.length).toBeGreaterThan(0);
      expect(new Set(meta.activationModes).size).toBe(meta.activationModes.length);
      for (const mode of meta.activationModes) expect(ACTIVATION_MODES).toContain(mode);
      expect(meta.status).toBe("COMING_SOON");
    }
  });

  it("uses each provider's brand spelling", () => {
    expect(PROVIDERS.SEVENSHIFTS.displayName).toBe("7shifts");
    expect(PROVIDERS.WHEN_I_WORK.displayName).toBe("When I Work");
    expect(PROVIDERS.PLANDAY.displayName).toBe("Planday");
    expect(PROVIDERS.DEPUTY.displayName).toBe("Deputy");
    expect(PROVIDERS.ROTAREADY.displayName).toBe("Rotaready");
    expect(PROVIDERS.HOMEBASE.displayName).toBe("Homebase");
  });

  it("isProviderId narrows strings", () => {
    expect(isProviderId("PLANDAY")).toBe(true);
    expect(isProviderId("SEVENSHIFTS")).toBe(true);
    expect(isProviderId("planday")).toBe(false);
    expect(isProviderId("7shifts")).toBe(false);
    expect(isProviderId("")).toBe(false);
    expect(isProviderId(42)).toBe(false);
    expect(isProviderId(null)).toBe(false);
  });
});

describe("ComingSoonProvider", () => {
  const provider = new ComingSoonProvider("DEPUTY", "Deputy");

  it("exposes id, displayName and COMING_SOON status", () => {
    expect(provider.id).toBe("DEPUTY");
    expect(provider.displayName).toBe("Deputy");
    expect(provider.status).toBe("COMING_SOON");
  });

  it.each(METHODS)("%s rejects with AppError COMING_SOON (501)", async (method) => {
    const err = await callMethod(provider, method).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    const appError = err as AppError;
    expect(appError.code).toBe("COMING_SOON");
    expect(appError.status).toBe(ERROR_HTTP_STATUS.COMING_SOON);
    expect(appError.status).toBe(501);
    expect(appError.message).toBe("Deputy integration is coming soon");
    expect(appError.details).toEqual({ provider: "DEPUTY" });
    expect(appError.toBody()).toEqual({
      error: {
        code: "COMING_SOON",
        message: "Deputy integration is coming soon",
        details: { provider: "DEPUTY" },
      },
    });
  });

  it("rejects asynchronously (returns a rejected promise rather than throwing synchronously)", () => {
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = provider.syncEmployees(ctx);
    }).not.toThrow();
    return expect(promise).rejects.toMatchObject({ code: "COMING_SOON" });
  });
});

describe("registry", () => {
  afterEach(() => {
    for (const id of INTEGRATION_PROVIDERS) unregisterProvider(id);
  });

  it("getProvider returns a ComingSoonProvider for every id until something is registered", async () => {
    for (const id of INTEGRATION_PROVIDERS) {
      const p = getProvider(id);
      expect(p).toBeInstanceOf(ComingSoonProvider);
      expect(p.id).toBe(id);
      expect(p.displayName).toBe(PROVIDERS[id].displayName);
      expect(p.status).toBe("COMING_SOON");
      expect(providerAvailability(id)).toBe("COMING_SOON");
      await expect(p.syncShifts(ctx, { from: NOW, to: NOW })).rejects.toMatchObject({
        code: "COMING_SOON",
      });
    }
  });

  it("every method of every placeholder rejects with COMING_SOON naming that provider", async () => {
    for (const id of INTEGRATION_PROVIDERS) {
      for (const method of METHODS) {
        await expect(callMethod(getProvider(id), method), `${id}.${method}`).rejects.toMatchObject({
          name: "AppError",
          code: "COMING_SOON",
          status: 501,
          message: `${PROVIDERS[id].displayName} integration is coming soon`,
          details: { provider: id },
        });
      }
    }
  });

  it("METHODS covers every function on the WorkforceProvider interface", () => {
    const placeholder = getProvider("PLANDAY");
    const fnNames = Object.getOwnPropertyNames(Object.getPrototypeOf(placeholder)).filter(
      (k) => k !== "constructor" && typeof Reflect.get(placeholder, k) === "function",
    );
    // `comingSoon` is the private helper; everything else must be an interface method under test.
    expect(fnNames.filter((k) => k !== "comingSoon").sort()).toEqual([...METHODS].sort());
  });

  it("caches the placeholder instance", () => {
    expect(getProvider("HOMEBASE")).toBe(getProvider("HOMEBASE"));
  });

  it("unknown ids are NOT_FOUND, not a crash", () => {
    const bogus = "MYSPACE" as ProviderId;
    for (const fn of [
      () => getProvider(bogus),
      () => getProviderMetadata(bogus),
      () => providerAvailability(bogus),
    ]) {
      let caught: unknown;
      try {
        fn();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).code).toBe("NOT_FOUND");
      expect((caught as AppError).status).toBe(404);
    }
    const impostor = Object.assign(new MockAvailableProvider(), { id: bogus });
    expect(() => registerProvider(impostor)).toThrow(AppError);
  });

  it("registerProvider replaces the placeholder and flips availability; unregister restores it", async () => {
    const mock = new MockAvailableProvider();
    registerProvider(mock);
    expect(getProvider("PLANDAY")).toBe(mock);
    expect(providerAvailability("PLANDAY")).toBe("AVAILABLE");
    expect(listProviders().find((p) => p.id === "PLANDAY")?.status).toBe("AVAILABLE");
    expect(listProviders().find((p) => p.id === "DEPUTY")?.status).toBe("COMING_SOON");
    expect(getProviderMetadata("PLANDAY").status).toBe("AVAILABLE"); // same view as listProviders()
    expect(getProviderMetadata("DEPUTY").status).toBe("COMING_SOON");
    expect(PROVIDERS.PLANDAY.status).toBe("COMING_SOON"); // static metadata is untouched
    const result = await getProvider("PLANDAY").connect(ctx, { activationMode: "CLOCK_EVENT" });
    expect(result.kind).toBe("CONNECTED");

    unregisterProvider("PLANDAY");
    expect(getProvider("PLANDAY")).toBeInstanceOf(ComingSoonProvider);
    expect(providerAvailability("PLANDAY")).toBe("COMING_SOON");
    expect(getProviderMetadata("PLANDAY").status).toBe("COMING_SOON");
  });
});

describe("SyncReport helpers", () => {
  it("emptySyncReport is zeroed and defaults finishedAt to startedAt", () => {
    const r = emptySyncReport("ROTAREADY", NOW);
    expect(r).toEqual({
      provider: "ROTAREADY",
      startedAt: NOW,
      finishedAt: NOW,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    });
    const later = new Date(NOW.getTime() + 1000);
    expect(emptySyncReport("ROTAREADY", NOW, later).finishedAt).toBe(later);
  });

  it("error codes are unique SCREAMING_SNAKE_CASE", () => {
    expect(new Set(SYNC_ERROR_CODES).size).toBe(SYNC_ERROR_CODES.length);
    for (const code of SYNC_ERROR_CODES) expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
  });
});

describe("createSyncReportBuilder", () => {
  it("tallies outcomes and errors into a SyncReport", () => {
    const builder = createSyncReportBuilder("PLANDAY", NOW);
    const outcomes: UpsertOutcome[] = ["CREATED", "CREATED", "UPDATED", "UNCHANGED", "SKIPPED"];
    for (const o of outcomes) builder.record(o);
    builder.error({ code: "UNKNOWN_EMPLOYEE", message: "No employee 42", externalId: "shift-9" });
    const finishedAt = new Date(NOW.getTime() + 5000);
    expect(builder.finish(finishedAt)).toEqual({
      provider: "PLANDAY",
      startedAt: NOW,
      finishedAt,
      created: 2,
      updated: 1,
      skipped: 2,
      errors: [{ code: "UNKNOWN_EMPLOYEE", message: "No employee 42", externalId: "shift-9" }],
    });
  });

  it("finish() returns a snapshot that later records do not mutate", () => {
    const builder = createSyncReportBuilder("DEPUTY", NOW);
    builder.error({ code: "PROVIDER_ERROR", message: "x" });
    const first = builder.finish(NOW);
    builder.record("CREATED");
    builder.error({ code: "RATE_LIMITED", message: "y" });
    expect(first.created).toBe(0);
    expect(first.errors).toHaveLength(1);
    expect(builder.finish(NOW).created).toBe(1);
    expect(builder.finish(NOW).errors).toHaveLength(2);
  });

  it("an empty builder equals emptySyncReport", () => {
    expect(createSyncReportBuilder("HOMEBASE", NOW).finish(NOW)).toEqual(
      emptySyncReport("HOMEBASE", NOW),
    );
  });
});

describe("ProviderError", () => {
  it("carries provider, code and retryability", () => {
    const cause = new Error("HTTP 429");
    const err = new ProviderError("PLANDAY", "RATE_LIMITED", "Planday rate limit reached", {
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProviderError");
    expect(err.provider).toBe("PLANDAY");
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
    expect(err.cause).toBe(cause);
    expect(isProviderError(err)).toBe(true);
    expect(isProviderError(new Error("x"))).toBe(false);
    expect(isProviderError(new AppError("COMING_SOON"))).toBe(false);
  });

  it("only transient codes are retryable", () => {
    const retryable = SYNC_ERROR_CODES.filter(
      (code) => new ProviderError("DEPUTY", code, code).retryable,
    );
    expect(retryable.sort()).toEqual(["PROVIDER_ERROR", "RATE_LIMITED"]);
    expect(new ProviderError("DEPUTY", "AUTH_EXPIRED", "consent revoked").retryable).toBe(false);
    expect(new ProviderError("DEPUTY", "AUTH_EXPIRED", "x").cause).toBeUndefined();
  });
});
