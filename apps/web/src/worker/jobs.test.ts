import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@/lib/logger";

const tickReport = {
  now: "2026-10-08T09:00:00.000Z",
  durationMs: 5,
  organisations: 2,
  employeesEvaluated: 7,
  stateRowsChanged: 1,
  transitions: 0,
  breaksExpired: 1,
  breaksEndedByShift: 0,
  scheduledBreaksStarted: 0,
  scheduledBreaksSkipped: 0,
  syncDelayedEpisodes: 0,
  resolutionWarnings: 0,
  overridesExpired: 0,
  digestsSent: 0,
  recurrencesCreated: 0,
  shiftsCompleted: 0,
  errors: [] as string[],
};

const mocks = vi.hoisted(() => ({
  runWorkModeTick: vi.fn(),
  sweepExpiredOverrides: vi.fn(),
  runScheduleUpkeep: vi.fn(),
  runScheduledIntegrationSyncs: vi.fn(),
}));

vi.mock("@/server/workState/workStateJob", () => ({
  runWorkModeTick: mocks.runWorkModeTick,
  sweepExpiredOverrides: mocks.sweepExpiredOverrides,
  runScheduleUpkeep: mocks.runScheduleUpkeep,
}));
vi.mock("@/server/integrations/scheduledSync", () => ({
  runScheduledIntegrationSyncs: mocks.runScheduledIntegrationSyncs,
}));

const { WORKER_JOBS, findWorkerJob } = await import("./jobs");
const { LOCK_KEYS } = await import("./lockKeys");

const log = createLogger({ level: "silent" });
const now = new Date("2026-10-08T09:00:00.000Z");
const ctx = { now, requestId: "req", log };

function job(name: string) {
  const found = findWorkerJob(name);
  if (!found) throw new Error(`missing job ${name}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WORKER_JOBS", () => {
  it("has stable, unique names and lock keys (D1 literals: never renumber)", () => {
    expect(WORKER_JOBS.map((j) => j.name)).toEqual([
      "work-mode-tick",
      "override-expiry",
      "schedule-upkeep",
      "integrations-sync",
    ]);
    expect(WORKER_JOBS.map((j) => j.lockKey)).toEqual([
      4849333701445681153n,
      4849333701445681154n,
      4849333701445681155n,
      4849333701445681156n,
    ]);
    expect(LOCK_KEYS.pushLeader).toBe(4849333701445681157n);
    expect(LOCK_KEYS.workModeTick).toBe(0x434c4b4f00000001n);
    const keys = [...WORKER_JOBS.map((j) => j.lockKey), LOCK_KEYS.pushLeader];
    expect(new Set(keys).size).toBe(keys.length);
    // Outside int4, so they can never collide with hashtext() / the integration-suite lock.
    for (const key of keys) expect(key > 2n ** 31n).toBe(true);
    // Fits a Postgres bigint.
    for (const key of keys) expect(key < 2n ** 63n).toBe(true);
  });

  it("puts the three minute jobs on the minute lane in tick order and the sync every 15 minutes", () => {
    expect(WORKER_JOBS.map((j) => [j.name, j.lane, j.intervalMinutes])).toEqual([
      ["work-mode-tick", "minute", 1],
      ["override-expiry", "minute", 1],
      ["schedule-upkeep", "minute", 1],
      ["integrations-sync", "integrations", 15],
    ]);
    for (const j of WORKER_JOBS) expect(j.description).toBeTruthy();
  });
});

describe("job implementations", () => {
  it("work-mode-tick runs the tick without the override sweep and schedule upkeep", async () => {
    mocks.runWorkModeTick.mockResolvedValue({ ...tickReport, errors: ["org-1"] });
    const result = await job("work-mode-tick").run(ctx);
    expect(mocks.runWorkModeTick).toHaveBeenCalledWith(now, {
      log,
      sweepOverrides: false,
      scheduleUpkeep: false,
    });
    // Per-organisation failures are counted; the run itself completed.
    expect(result).toMatchObject({
      ok: true,
      processed: 7,
      details: { organisations: 2, employees: 7, breaksExpired: 1, organisationErrors: 1 },
    });
  });

  it("override-expiry sweeps expired overrides", async () => {
    mocks.sweepExpiredOverrides.mockResolvedValue(3);
    const result = await job("override-expiry").run(ctx);
    expect(mocks.sweepExpiredOverrides).toHaveBeenCalledWith(now);
    expect(result).toEqual({ ok: true, processed: 3, details: { overridesExpired: 3 } });
  });

  it("schedule-upkeep fails when a step failed", async () => {
    mocks.runScheduleUpkeep.mockResolvedValue({
      recurrencesCreated: 2,
      shiftsCompleted: 1,
      errors: [],
    });
    expect(await job("schedule-upkeep").run(ctx)).toMatchObject({ ok: true, processed: 3 });
    expect(mocks.runScheduleUpkeep).toHaveBeenCalledWith(now, log);

    mocks.runScheduleUpkeep.mockResolvedValue({
      recurrencesCreated: 0,
      shiftsCompleted: 1,
      errors: ["recurrences"],
    });
    expect(await job("schedule-upkeep").run(ctx)).toMatchObject({
      ok: false,
      details: { failedSteps: ["recurrences"] },
      error: "failed: recurrences",
    });
  });

  it("integrations-sync reports NO_AVAILABLE_PROVIDER as a successful no-op", async () => {
    mocks.runScheduledIntegrationSyncs.mockResolvedValue({
      availableProviders: 0,
      integrations: 0,
      synced: 0,
      skipped: 0,
      reason: "NO_AVAILABLE_PROVIDER",
    });
    const result = await job("integrations-sync").run(ctx);
    expect(mocks.runScheduledIntegrationSyncs).toHaveBeenCalledWith(now, { log });
    expect(result).toMatchObject({
      ok: true,
      processed: 0,
      details: { reason: "NO_AVAILABLE_PROVIDER" },
    });
  });
});
