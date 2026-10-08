import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@/lib/logger";
import { parseEnv, type Env } from "@/lib/env";
import {
  EXIT_CODES,
  LEADER_SETTLE_TIMEOUT_MS,
  parseWorkerArgs,
  resolveJobsEnabled,
  resolveLockConnection,
  runWorkerCli,
  startAfterMigrationGate,
  WorkerConfigError,
  type StartAfterGateDeps,
  type WorkerCliDeps,
} from "./cli";
import { createPushLeader } from "./pushLeader";
import { captureLogger, FakeLockServer, FakeLockSession } from "./testing";

const LOCAL = "postgresql://u:p@localhost:5433/clockoff";
const NEON_POOLED =
  "postgresql://u:p@ep-cool-name-123456-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require&pgbouncer=true";
const NEON_DIRECT =
  "postgresql://u:p@ep-cool-name-123456.eu-west-2.aws.neon.tech/neondb?sslmode=require";

const VALID = {
  DATABASE_URL: LOCAL,
  APP_URL: "http://localhost:3000",
  SESSION_SECRET: "s".repeat(64),
  MOBILE_JWT_SECRET: "m".repeat(64),
  INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

function makeEnv(overrides: Record<string, string | undefined> = {}): Env {
  return parseEnv({ NODE_ENV: "development", ...VALID, ...overrides }).env;
}

function harness(overrides: Partial<WorkerCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const exit = vi.fn<(code: number) => void>();
  const deps: Partial<WorkerCliDeps> = {
    stdout: async (text) => {
      out.push(text);
    },
    stderr: async (text) => {
      err.push(text);
    },
    exit,
    loadEnv: () => {
      throw new Error("env must not be read");
    },
    envWarnings: () => [],
    migrationStatus: async () => {
      throw new Error("migration status must not be read");
    },
    log: createLogger({ level: "silent" }),
    ...overrides,
  };
  return { deps, out, err, exit, stdout: () => out.join(""), stderr: () => err.join("") };
}

describe("parseWorkerArgs", () => {
  it("parses every command and rejects bad input", () => {
    expect(parseWorkerArgs([])).toEqual({ kind: "serve" });
    expect(parseWorkerArgs(["serve"])).toEqual({ kind: "serve" });
    expect(parseWorkerArgs(["list"])).toEqual({ kind: "list" });
    expect(parseWorkerArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseWorkerArgs(["run", "override-expiry"])).toEqual({
      kind: "run",
      job: "override-expiry",
    });
    expect(parseWorkerArgs(["emit-diagnostic", "0F8FAD5B-D9CB-469F-A165-70867728950E"])).toEqual({
      kind: "emit-diagnostic",
      organisationId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    });

    expect(parseWorkerArgs(["run"])).toMatchObject({ kind: "invalid", message: /job name/ });
    expect(parseWorkerArgs(["run", "nope"])).toMatchObject({
      kind: "invalid",
      message: /unknown job "nope"/,
    });
    expect(parseWorkerArgs(["run", "work-mode-tick", "extra"])).toMatchObject({ kind: "invalid" });
    expect(parseWorkerArgs(["emit-diagnostic", "not-a-uuid"])).toMatchObject({
      kind: "invalid",
      message: /UUID/,
    });
    expect(parseWorkerArgs(["emit-diagnostic"])).toMatchObject({ kind: "invalid" });
    expect(parseWorkerArgs(["serve", "now"])).toMatchObject({ kind: "invalid" });
    expect(parseWorkerArgs(["bogus"])).toMatchObject({
      kind: "invalid",
      message: /unknown command "bogus"/,
    });
  });
});

describe("resolveLockConnection", () => {
  it("uses DIRECT_URL, falls back to DATABASE_URL only outside production", () => {
    expect(resolveLockConnection(makeEnv({ DIRECT_URL: LOCAL }))).toEqual({
      connectionString: LOCAL,
      warnings: [],
    });
    const fallback = resolveLockConnection(makeEnv());
    expect(fallback.connectionString).toBe(LOCAL);
    expect(fallback.warnings[0]).toMatch(/DIRECT_URL is not set/);
    expect(() =>
      resolveLockConnection({
        DATABASE_URL: NEON_POOLED,
        DIRECT_URL: undefined,
        isProduction: true,
      }),
    ).toThrow(/DIRECT_URL is required/);
  });

  it("refuses a pooled lock URL in every environment, without echoing it", () => {
    for (const isProduction of [false, true]) {
      let thrown: unknown;
      try {
        resolveLockConnection({ DATABASE_URL: NEON_POOLED, DIRECT_URL: NEON_POOLED, isProduction });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkerConfigError);
      expect((thrown as Error).message).toMatch(/non-pooled/);
      expect((thrown as Error).message).not.toContain("neon.tech");
    }
    expect(() =>
      resolveLockConnection({
        DATABASE_URL: NEON_POOLED,
        DIRECT_URL: undefined,
        isProduction: false,
      }),
    ).toThrow(/DATABASE_URL is a pooled connection string/);
    expect(
      resolveLockConnection({
        DATABASE_URL: NEON_POOLED,
        DIRECT_URL: NEON_DIRECT,
        isProduction: true,
      }).connectionString,
    ).toBe(NEON_DIRECT);
  });
});

describe("runWorkerCli", () => {
  it("list prints the four jobs and exits 0 without reading the environment", async () => {
    const h = harness();
    await runWorkerCli(["list"], h.deps);
    expect(h.exit).toHaveBeenCalledWith(EXIT_CODES.ok);
    const lines = h.stdout().trim().split("\n");
    expect(lines.map((l) => l.split("\t")[0])).toEqual([
      "work-mode-tick",
      "override-expiry",
      "schedule-upkeep",
      "integrations-sync",
    ]);
    expect(lines[3]).toContain("every 15 min");
  });

  it("an unknown job or a bad organisation id exits 2 with the usage", async () => {
    const unknownJob = harness();
    await runWorkerCli(["run", "nope"], unknownJob.deps);
    expect(unknownJob.exit).toHaveBeenCalledWith(EXIT_CODES.usage);
    expect(unknownJob.stderr()).toContain('unknown job "nope"');
    expect(unknownJob.stderr()).toContain("Usage:");

    const badUuid = harness();
    await runWorkerCli(["emit-diagnostic", "1234"], badUuid.deps);
    expect(badUuid.exit).toHaveBeenCalledWith(EXIT_CODES.usage);

    const unknownCommand = harness();
    await runWorkerCli(["bogus"], unknownCommand.deps);
    expect(unknownCommand.exit).toHaveBeenCalledWith(EXIT_CODES.usage);
  });

  it("run exits 4 while migrations are not up to date, before touching any lock", async () => {
    const h = harness({
      loadEnv: () => makeEnv({ DIRECT_URL: LOCAL }),
      migrationStatus: async () => "pending",
    });
    await runWorkerCli(["run", "work-mode-tick"], h.deps);
    expect(h.exit).toHaveBeenCalledWith(EXIT_CODES.migrationsPending);
    expect(h.stderr()).toMatch(/Migrations are pending/);
  });

  it("run exits 1 when the environment is invalid", async () => {
    const h = harness({
      loadEnv: () => {
        throw new Error("Invalid environment configuration:\n - DATABASE_URL: required");
      },
    });
    await runWorkerCli(["run", "work-mode-tick"], h.deps);
    expect(h.exit).toHaveBeenCalledWith(EXIT_CODES.error);
    expect(h.stderr()).toContain("DATABASE_URL: required");
  });

  it("serve exits 1 on a pooled DIRECT_URL, without echoing it", async () => {
    const h = harness({ loadEnv: () => makeEnv({ DIRECT_URL: NEON_POOLED }) });
    await runWorkerCli(["serve"], h.deps);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(EXIT_CODES.error);
    expect(h.stderr()).toMatch(/non-pooled/);
    expect(h.stderr()).not.toContain("neon.tech");
  });

  it("serve exits 1 in production without DIRECT_URL or with an invalid environment", async () => {
    const missing = harness({
      loadEnv: () => ({ ...makeEnv(), isProduction: true, DIRECT_URL: undefined }) satisfies Env,
    });
    await runWorkerCli([], missing.deps);
    expect(missing.exit).toHaveBeenCalledWith(EXIT_CODES.error);
    expect(missing.stderr()).toMatch(/DIRECT_URL is required/);

    const production = harness({
      loadEnv: () => parseEnv({ ...VALID, NODE_ENV: "production", DIRECT_URL: NEON_POOLED }).env,
    });
    await runWorkerCli(["serve"], production.deps);
    expect(production.exit).toHaveBeenCalledWith(EXIT_CODES.error);
    expect(production.stderr()).not.toContain("neon.tech");
  });

  it("emit-diagnostic refuses without DIRECT_URL (the event would reach no other process)", async () => {
    const h = harness({ loadEnv: () => makeEnv() });
    await runWorkerCli(["emit-diagnostic", "0f8fad5b-d9cb-469f-a165-70867728950e"], h.deps);
    expect(h.exit).toHaveBeenCalledWith(EXIT_CODES.error);
    expect(h.stderr()).toMatch(/needs DIRECT_URL/);
  });
});

describe("resolveJobsEnabled", () => {
  it("WORKER_JOBS_ENABLED decides; the retired JOBS_ENABLED=false is a configuration error", () => {
    expect(resolveJobsEnabled(makeEnv())).toBe(true);
    expect(resolveJobsEnabled(makeEnv({ WORKER_JOBS_ENABLED: "false" }))).toBe(false);
    expect(resolveJobsEnabled(makeEnv({ JOBS_ENABLED: "true" }))).toBe(true);
    expect(() => resolveJobsEnabled(makeEnv({ JOBS_ENABLED: "false" }))).toThrow(WorkerConfigError);
    expect(() =>
      resolveJobsEnabled(makeEnv({ JOBS_ENABLED: "0", WORKER_JOBS_ENABLED: "true" })),
    ).toThrow(/retired Netlify-era variable/);
  });

  it("serve exits 1 while the Netlify-era JOBS_ENABLED=false is set (never a silent no-jobs worker)", async () => {
    const h = harness({ loadEnv: () => makeEnv({ DIRECT_URL: LOCAL, JOBS_ENABLED: "false" }) });
    await runWorkerCli(["serve"], h.deps);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(EXIT_CODES.error);
    expect(h.stderr()).toMatch(/WORKER_JOBS_ENABLED=false pauses the jobs/);
  });
});

describe("startAfterMigrationGate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function gateDeps(events: string[], overrides: Partial<StartAfterGateDeps> = {}) {
    const captured = captureLogger();
    const deps: StartAfterGateDeps = {
      jobsEnabled: true,
      leader: { start: async () => undefined },
      trigger: {
        start: (immediate) => {
          events.push(`trigger.start(${String(immediate)})`);
        },
      },
      watchdog: {
        start: () => {
          events.push("watchdog.start");
        },
      },
      heartbeat: {
        beatNow: async () => {
          events.push("beatNow");
          return true;
        },
      },
      isStopping: () => false,
      onJobsStarted: () => {
        events.push("jobsStarted");
      },
      log: captured.log,
      ...overrides,
    };
    return { deps, captured };
  }

  it("enables the push bridge before the immediate first job pass when no other leader exists", async () => {
    const events: string[] = [];
    const locks = new FakeLockSession(new FakeLockServer(), "w");
    const leader = createPushLeader({
      locks,
      log: createLogger({ level: "silent" }),
      enable: () => {
        events.push("enablePushBridge");
      },
      disable: async () => undefined,
      // The real self-test takes a LISTEN + NOTIFY round trip.
      selfTest: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return true;
      },
    });
    const { deps } = gateDeps(events, { leader });
    await startAfterMigrationGate(deps);
    expect(events).toEqual([
      "enablePushBridge",
      "jobsStarted",
      "trigger.start(true)",
      "watchdog.start",
      "beatNow",
    ]);
    leader.stop();
  });

  it("starts the jobs after a bounded wait when leadership does not settle", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const { deps, captured } = gateDeps(events, {
      leader: { start: () => new Promise<void>(() => undefined) },
    });
    const done = startAfterMigrationGate(deps);
    await vi.advanceTimersByTimeAsync(LEADER_SETTLE_TIMEOUT_MS - 1);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(events).toEqual(["jobsStarted", "trigger.start(true)", "watchdog.start", "beatNow"]);
    expect(captured.messages()).toContain("push leadership not settled yet; starting jobs anyway");
  });

  it("starts no jobs when disabled or when shutdown began during the wait", async () => {
    const disabled: string[] = [];
    const off = gateDeps(disabled, { jobsEnabled: false });
    await startAfterMigrationGate(off.deps);
    expect(disabled).toEqual(["beatNow"]);
    expect(off.captured.messages()).toContain(
      "WORKER_JOBS_ENABLED=false: no jobs will run (heartbeat and push leadership continue)",
    );

    const stopping: string[] = [];
    await startAfterMigrationGate(gateDeps(stopping, { isStopping: () => true }).deps);
    expect(stopping).toEqual([]);
  });
});
