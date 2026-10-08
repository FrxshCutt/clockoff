import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobContext, JobResult } from "@/server/jobs/types";
import type { WorkerJob, WorkerJobName, WorkerLane } from "./jobs";
import { createMinuteTrigger, createScheduler, isJobDue } from "./scheduler";
import { captureLogger, deferred, FakeLockServer, FakeLockSession } from "./testing";

const at = (iso: string) => new Date(iso);

function fakeJob(
  name: WorkerJobName,
  lane: WorkerLane,
  intervalMinutes: 1 | 15,
  lockKey: bigint,
  run: (ctx: JobContext) => Promise<JobResult> = async () => ({ ok: true }),
): WorkerJob & { run: ReturnType<typeof vi.fn> } {
  return { name, lane, intervalMinutes, lockKey, description: name, run: vi.fn(run) };
}

function setup(
  overrides: {
    run?: Partial<Record<WorkerJobName, (ctx: JobContext) => Promise<JobResult>>>;
    claim?: (job: WorkerJobName, slot: bigint) => boolean;
    session?: FakeLockSession;
  } = {},
) {
  const order: string[] = [];
  const track =
    (name: WorkerJobName) =>
    async (ctx: JobContext): Promise<JobResult> => {
      order.push(name);
      return overrides.run?.[name] ? overrides.run[name]!(ctx) : { ok: true, details: { n: 1 } };
    };
  const jobs = [
    fakeJob("work-mode-tick", "minute", 1, 1n, track("work-mode-tick")),
    fakeJob("override-expiry", "minute", 1, 2n, track("override-expiry")),
    fakeJob("schedule-upkeep", "minute", 1, 3n, track("schedule-upkeep")),
    fakeJob("integrations-sync", "integrations", 15, 4n, track("integrations-sync")),
  ];
  const locks = overrides.session ?? new FakeLockSession();
  const claims: Array<{ job: WorkerJobName; slot: bigint }> = [];
  const finished: Array<{ job: WorkerJobName; outcome: string }> = [];
  const captured = captureLogger();
  const scheduler = createScheduler({
    jobs,
    locks,
    // As in cli.ts: the worker's logger carries `module: "worker"`; the scheduler adds no module key.
    log: captured.log.child({ module: "worker" }),
    claimSlot: async (job, slot) => {
      claims.push({ job, slot });
      return overrides.claim ? overrides.claim(job, slot) : true;
    },
    recordFinished: async (job, outcome) => {
      finished.push({ job, outcome });
    },
  });
  return { scheduler, jobs, locks, claims, finished, order, captured };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isJobDue", () => {
  it("runs 1-minute jobs every minute and 15-minute jobs on the quarter hours", () => {
    const every15 = { intervalMinutes: 15 as const };
    const every1 = { intervalMinutes: 1 as const };
    expect(isJobDue(every15, at("2026-10-08T12:00:00.000Z"))).toBe(true);
    expect(isJobDue(every15, at("2026-10-08T12:00:59.999Z"))).toBe(true);
    expect(isJobDue(every15, at("2026-10-08T12:01:00.000Z"))).toBe(false);
    expect(isJobDue(every15, at("2026-10-08T12:14:59.000Z"))).toBe(false);
    expect(isJobDue(every15, at("2026-10-08T12:15:00.000Z"))).toBe(true);
    expect(isJobDue(every1, at("2026-10-08T12:01:00.000Z"))).toBe(true);
    expect(isJobDue(every1, at("2026-10-08T12:07:31.000Z"))).toBe(true);
  });
});

describe("createScheduler", () => {
  it("runs the minute lane in order, the integrations lane at :15, with lock → claim → run → record", async () => {
    const { scheduler, order, claims, finished, locks } = setup();
    const now = at("2026-10-08T12:15:20.000Z");
    await scheduler.onMinute(now);

    const minuteOrder = order.filter((n) => n !== "integrations-sync");
    expect(minuteOrder).toEqual(["work-mode-tick", "override-expiry", "schedule-upkeep"]);
    expect(order).toContain("integrations-sync");
    const slot = BigInt(Math.floor(now.getTime() / 60_000));
    expect(claims).toHaveLength(4);
    for (const claim of claims) expect(claim.slot).toBe(slot);
    expect(finished.every((f) => f.outcome === "ok")).toBe(true);
    // Every lock was released.
    expect(locks.calls.filter((c) => c.startsWith("acquire"))).toHaveLength(4);
    expect(locks.calls.filter((c) => c.startsWith("release"))).toHaveLength(4);
    for (const key of [1n, 2n, 3n, 4n]) expect(locks.isHeld(key)).toBe(false);
    expect(Object.values(scheduler.lastRuns()).map((r) => r.outcome)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
    ]);

    order.length = 0;
    await scheduler.onMinute(at("2026-10-08T12:16:00.000Z"));
    expect(order).toEqual(["work-mode-tick", "override-expiry", "schedule-upkeep"]);
  });

  it("skips a minute whose lane is still busy (skipped_overlap) without advancing minute-lane progress", async () => {
    const gate = deferred();
    let first = true;
    const { scheduler, order, captured } = setup({
      run: {
        "work-mode-tick": async () => {
          if (first) {
            first = false;
            await gate.promise;
          }
          return { ok: true };
        },
      },
    });
    const pass = scheduler.onMinute(at("2026-10-08T12:01:00.000Z"));
    await vi.waitFor(() => expect(order).toEqual(["work-mode-tick"]));
    expect(scheduler.inFlight().map((f) => f.job)).toEqual(["work-mode-tick"]);
    expect(scheduler.minuteLaneLastCompletedAt()).toBeNull();

    await scheduler.onMinute(at("2026-10-08T12:02:00.000Z"));
    expect(scheduler.lastRuns()["work-mode-tick"]?.outcome).toBe("skipped_overlap");
    expect(scheduler.lastRuns()["override-expiry"]?.outcome).toBe("skipped_overlap");
    const overlapLines = captured.lines.filter(
      (l) => l.msg === "job finished" && l.outcome === "skipped_overlap",
    );
    expect(overlapLines).toHaveLength(3);
    expect(overlapLines.every((l) => l.level === "warn")).toBe(true);
    expect(scheduler.minuteLaneLastCompletedAt()).toBeNull();

    gate.resolve();
    await pass;
    expect(scheduler.minuteLaneLastCompletedAt()).not.toBeNull();
    expect(order).toEqual(["work-mode-tick", "override-expiry", "schedule-upkeep"]);
  });

  it("skips a job whose lock is held elsewhere (skipped_locked) and still runs the next", async () => {
    const server = new FakeLockServer();
    const other = new FakeLockSession(server, "other");
    await other.tryAcquire(1n);
    const { scheduler, order, claims } = setup({ session: new FakeLockSession(server) });
    await scheduler.onMinute(at("2026-10-08T12:01:00.000Z"));
    expect(scheduler.lastRuns()["work-mode-tick"]?.outcome).toBe("skipped_locked");
    expect(claims.map((c) => c.job)).not.toContain("work-mode-tick");
    expect(order).toEqual(["override-expiry", "schedule-upkeep"]);
    expect(other.isHeld(1n)).toBe(true);
    expect(scheduler.minuteLaneLastCompletedAt()).not.toBeNull();
  });

  it("skips a slot another instance already ran (skipped_already_ran): job not called, lock released", async () => {
    const { scheduler, order, locks, finished } = setup({
      claim: (job) => job !== "override-expiry",
    });
    await scheduler.onMinute(at("2026-10-08T12:01:00.000Z"));
    expect(scheduler.lastRuns()["override-expiry"]?.outcome).toBe("skipped_already_ran");
    expect(order).toEqual(["work-mode-tick", "schedule-upkeep"]);
    expect(locks.calls).toContain("release:2");
    expect(locks.isHeld(2n)).toBe(false);
    expect(finished.map((f) => f.job)).not.toContain("override-expiry");
  });

  it("reports an error when the lock session is unavailable or the claim cannot be written", async () => {
    const session = new FakeLockSession();
    session.failing.add(1n);
    const { scheduler, order } = setup({
      session,
      claim: (job) => {
        if (job === "override-expiry") throw new Error("database down");
        return true;
      },
    });
    await scheduler.onMinute(at("2026-10-08T12:01:00.000Z"));
    expect(scheduler.lastRuns()["work-mode-tick"]?.outcome).toBe("error");
    expect(scheduler.lastRuns()["override-expiry"]?.outcome).toBe("error");
    expect(order).toEqual(["schedule-upkeep"]);
    expect(session.isHeld(2n)).toBe(false);
  });

  it("never lets a throwing job stop the next one", async () => {
    const { scheduler, order, finished, captured } = setup({
      run: {
        "work-mode-tick": async () => {
          throw new Error("boom");
        },
      },
    });
    await scheduler.onMinute(at("2026-10-08T12:01:00.000Z"));
    expect(order).toEqual(["work-mode-tick", "override-expiry", "schedule-upkeep"]);
    expect(finished).toEqual([
      { job: "work-mode-tick", outcome: "error" },
      { job: "override-expiry", outcome: "ok" },
      { job: "schedule-upkeep", outcome: "ok" },
    ]);
    expect(captured.messages()).toContain("job failed");
    // A failed pass still counts as progress for the watchdog.
    expect(scheduler.minuteLaneLastCompletedAt()).not.toBeNull();
  });

  it("logs one `job finished` line per run with outcome, duration and counts", async () => {
    const { scheduler, captured } = setup();
    await scheduler.onMinute(at("2026-10-08T12:01:00.000Z"));
    const lines = captured.lines.filter((l) => l.msg === "job finished");
    expect(lines.map((l) => l.job)).toEqual([
      "work-mode-tick",
      "override-expiry",
      "schedule-upkeep",
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({ module: "worker", outcome: "ok", n: 1, level: "info" });
      expect(typeof line.durationMs).toBe("number");
    }
  });

  it("a job with runsAfter waits (skipped_waiting, slot unclaimed) until its predecessor finished the slot", async () => {
    const finishedSlots = new Set<string>();
    const claims: WorkerJobName[] = [];
    const upkeep = {
      ...fakeJob("schedule-upkeep", "minute", 1, 3n),
      runsAfter: "work-mode-tick" as const,
    };
    const locks = new FakeLockSession();
    const scheduler = createScheduler({
      jobs: [upkeep],
      locks,
      log: captureLogger().log,
      claimSlot: async (job) => {
        claims.push(job);
        return true;
      },
      recordFinished: async () => undefined,
      finishedSlot: async (job, slot) => finishedSlots.has(`${job}:${slot}`),
    });
    const now = at("2026-10-08T12:01:10.000Z");
    const slot = BigInt(Math.floor(now.getTime() / 60_000));

    // Another worker is still running this minute's work-mode-tick.
    await scheduler.onMinute(now);
    expect(scheduler.lastRuns()["schedule-upkeep"]?.outcome).toBe("skipped_waiting");
    expect(claims).toEqual([]);
    expect(upkeep.run).not.toHaveBeenCalled();
    expect(locks.isHeld(3n)).toBe(false);

    // It finished: the slot is still unclaimed, so the next pass for it runs the job.
    finishedSlots.add(`work-mode-tick:${slot}`);
    await scheduler.onMinute(now);
    expect(scheduler.lastRuns()["schedule-upkeep"]?.outcome).toBe("ok");
    expect(claims).toEqual(["schedule-upkeep"]);

    // A manual run never waits.
    finishedSlots.clear();
    expect((await scheduler.runOnce("schedule-upkeep", now)).outcome).toBe("ok");

    // The ordering check failing is an error of the run, not a crash.
    const failing = createScheduler({
      jobs: [upkeep],
      locks,
      log: captureLogger().log,
      claimSlot: async () => true,
      recordFinished: async () => undefined,
      finishedSlot: async () => {
        throw new Error("connection refused");
      },
    });
    await failing.onMinute(now);
    expect(failing.lastRuns()["schedule-upkeep"]?.outcome).toBe("error");
    expect(locks.isHeld(3n)).toBe(false);
  });

  it("runOnce takes the lock but never claims a slot", async () => {
    const { scheduler, claims, finished, locks } = setup();
    const result = await scheduler.runOnce("schedule-upkeep", at("2026-10-08T12:01:00.000Z"));
    expect(result.outcome).toBe("ok");
    expect(result.result).toEqual({ ok: true, details: { n: 1 } });
    expect(claims).toEqual([]);
    expect(finished).toEqual([{ job: "schedule-upkeep", outcome: "ok" }]);
    expect(locks.calls).toEqual(["acquire:3", "release:3"]);
    await expect(scheduler.runOnce("nope" as WorkerJobName)).rejects.toThrow(/Unknown worker job/);
  });

  it("stop() waits up to the grace period, reports abandoned jobs and starts nothing new", async () => {
    const never = deferred<JobResult>();
    const { scheduler, order } = setup({ run: { "work-mode-tick": () => never.promise } });
    void scheduler.onMinute(at("2026-10-08T12:01:00.000Z"));
    await vi.waitFor(() => expect(order).toEqual(["work-mode-tick"]));

    const started = Date.now();
    const { abandoned } = await scheduler.stop(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(abandoned).toEqual(["work-mode-tick"]);

    await scheduler.onMinute(at("2026-10-08T12:02:00.000Z"));
    expect(order).toEqual(["work-mode-tick"]);
    expect((await scheduler.runOnce("override-expiry")).outcome).toBe("skipped_shutdown");

    // The abandoned job finishing late skips the rest of its pass.
    never.resolve({ ok: true });
    await vi.waitFor(() =>
      expect(scheduler.lastRuns()["schedule-upkeep"]?.outcome).toBe("skipped_shutdown"),
    );
    expect(order).toEqual(["work-mode-tick"]);
  });

  it("stop() returns at once when nothing runs", async () => {
    const { scheduler } = setup();
    expect(await scheduler.stop(10_000)).toEqual({ abandoned: [] });
  });
});

describe("createMinuteTrigger", () => {
  it("fires at every minute boundary, optionally once right away, until stopped", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at("2026-10-08T12:00:30.000Z"));
    const fired: string[] = [];
    const trigger = createMinuteTrigger((now) => fired.push(now.toISOString()));
    trigger.start(true);
    expect(fired).toEqual(["2026-10-08T12:00:30.000Z"]);

    vi.advanceTimersByTime(29_999);
    expect(fired).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(fired.at(-1)).toBe("2026-10-08T12:01:00.000Z");
    vi.advanceTimersByTime(60_000);
    expect(fired.at(-1)).toBe("2026-10-08T12:02:00.000Z");
    expect(fired).toHaveLength(3);

    trigger.stop();
    vi.advanceTimersByTime(180_000);
    expect(fired).toHaveLength(3);
  });

  it("re-arms an early wake-up instead of firing in the previous minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at("2026-10-08T12:00:59.000Z"));
    const fired: string[] = [];
    let skew = 0;
    const trigger = createMinuteTrigger((now) => fired.push(now.toISOString()), {
      clock: () => Date.now() - skew,
    });
    trigger.start();
    skew = 5; // the clock reads 5 ms behind when the timer fires
    vi.advanceTimersByTime(1_000);
    expect(fired).toEqual([]);
    skew = 0;
    vi.advanceTimersByTime(5);
    expect(fired).toEqual(["2026-10-08T12:01:00.005Z"]);
    trigger.stop();
  });
});
