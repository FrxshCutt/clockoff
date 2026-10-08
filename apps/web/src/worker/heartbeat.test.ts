import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatLoop, workerIdentity } from "./heartbeat";
import { captureLogger } from "./testing";

describe("workerIdentity", () => {
  it("uses Railway's replica id, service name and commit", () => {
    expect(
      workerIdentity(
        {
          RAILWAY_REPLICA_ID: "c0ffee-replica",
          RAILWAY_SERVICE_NAME: "worker",
          RAILWAY_GIT_COMMIT_SHA: "0123456789abcdef0123",
        },
        "host",
        7,
      ),
    ).toEqual({ instanceId: "c0ffee-replica", service: "worker", version: "0123456789ab" });
  });

  it("falls back to hostname-pid, `worker` and no version", () => {
    expect(workerIdentity({}, "laptop.local", 4242)).toEqual({
      instanceId: "laptop.local-4242",
      service: "worker",
      version: null,
    });
    expect(workerIdentity({ RAILWAY_REPLICA_ID: "x".repeat(300) }, "h", 1).instanceId).toHaveLength(
      128,
    );
  });
});

describe("createHeartbeatLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T09:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("beats at start and every 60 s with the current details, pruning at start and hourly", async () => {
    const record = vi.fn(async (_input: unknown) => undefined);
    const prune = vi.fn(async () => 0);
    let jobs = 0;
    const loop = createHeartbeatLoop({
      identity: { instanceId: "i-1", service: "worker", version: null },
      startedAt: new Date("2026-10-08T08:59:00.000Z"),
      details: () => ({ jobs }),
      log: captureLogger().log,
      record,
      prune,
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenLastCalledWith({
      instanceId: "i-1",
      service: "worker",
      version: null,
      startedAt: new Date("2026-10-08T08:59:00.000Z"),
      now: new Date("2026-10-08T09:00:00.000Z"),
      details: { jobs: 0 },
    });
    expect(prune).toHaveBeenCalledTimes(1);

    jobs = 3;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]![0]).toMatchObject({ details: { jobs: 3 } });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prune).toHaveBeenCalledTimes(2);

    await loop.stop();
    const calls = record.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(record).toHaveBeenCalledTimes(calls);
  });

  it("beatNow during a beat in flight sends a fresh beat with the details changed meanwhile", async () => {
    const gate: { release?: () => void } = {};
    const record = vi.fn(
      (_input: { details: Record<string, unknown> }) =>
        new Promise<void>((resolve) => {
          gate.release = resolve;
        }),
    );
    let waiting = true;
    const loop = createHeartbeatLoop({
      identity: { instanceId: "i-1", service: "worker", version: null },
      startedAt: new Date(),
      details: () => ({ waitingForMigrations: waiting }),
      log: captureLogger().log,
      record,
      prune: async () => 0,
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(record).toHaveBeenCalledTimes(1);
    // The migration gate opens while the start-up beat (waiting: true) is still being written.
    waiting = false;
    const now = loop.beatNow();
    gate.release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]![0].details).toEqual({ waitingForMigrations: false });
    gate.release!();
    await expect(now).resolves.toBe(true);
    await loop.stop();
  });

  it("stop() during a beat in flight with a beatNow chained behind it: no beat starts after stop", async () => {
    const gate: { release?: () => void } = {};
    const events: string[] = [];
    const record = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push(`record#${record.mock.calls.length} start`);
          gate.release = () => {
            events.push(`record#${record.mock.calls.length} committed`);
            resolve();
          };
        }),
    );
    const loop = createHeartbeatLoop({
      identity: { instanceId: "i-1", service: "worker", version: null },
      startedAt: new Date(),
      details: () => ({}),
      log: captureLogger().log,
      record,
      prune: async () => 0,
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    const chained = loop.beatNow(); // the migration gate opened during the start-up beat
    const stopped = loop.stop().then(() => events.push("stop resolved"));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["record#1 start"]); // stop() waits for the beat in flight
    gate.release!();
    await stopped;
    await expect(chained).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(record).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["record#1 start", "record#1 committed", "stop resolved"]);
    await expect(loop.beatNow()).resolves.toBe(false);
  });

  it("retries a failed beat after 10 s and never throws", async () => {
    const captured = captureLogger();
    const record = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValue(undefined);
    const loop = createHeartbeatLoop({
      identity: { instanceId: "i-1", service: "worker", version: null },
      startedAt: new Date(),
      details: () => ({}),
      log: captured.log,
      record,
      prune: async () => 0,
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(record).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(record).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(record).toHaveBeenCalledTimes(3);
    expect(
      captured.messages().filter((m) => m === "worker heartbeat failed; retrying"),
    ).toHaveLength(1);
    expect(captured.messages()).toContain("worker heartbeat recovered");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(record).toHaveBeenCalledTimes(3);
    await loop.stop();
  });
});
