import type { MigrationStatus } from "@clockoff/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForMigrations } from "./migrationGate";
import { captureLogger } from "./testing";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function statuses(...sequence: Array<MigrationStatus | Error>) {
  let i = 0;
  return vi.fn(async (): Promise<MigrationStatus> => {
    const next = sequence[Math.min(i, sequence.length - 1)]!;
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  });
}

describe("waitForMigrations", () => {
  it("polls every 15 s: pending → pending → up_to_date resolves after 2 polls, logging the wait once", async () => {
    const { log, messages } = captureLogger();
    const status = statuses("pending", "pending", "up_to_date");
    const onWaiting = vi.fn();
    let resolved: boolean | undefined;
    void waitForMigrations({
      status,
      log,
      signal: new AbortController().signal,
      onWaiting,
    }).then((value) => {
      resolved = value;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    expect(onWaiting).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(status).toHaveBeenCalledTimes(2);
    expect(resolved).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(status).toHaveBeenCalledTimes(3);
    expect(resolved).toBe(true);
    expect(onWaiting).toHaveBeenLastCalledWith(false);
    expect(messages().filter((m) => m === "waiting for migrations")).toHaveLength(1);
  });

  it("keeps waiting through database errors and failed migrations, warning every 5 minutes", async () => {
    const { log, lines } = captureLogger();
    const status = statuses(new Error("connect ECONNREFUSED"), "failed");
    let resolved: boolean | undefined;
    void waitForMigrations({ status, log, signal: new AbortController().signal }).then((v) => {
      resolved = v;
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(resolved).toBeUndefined();
    expect(status.mock.calls.length).toBeGreaterThanOrEqual(40);
    const entry = lines.find((l) => l.msg === "waiting for migrations");
    expect(entry).toMatchObject({ level: "info", status: "error" });
    expect(lines.filter((l) => l.msg === "still waiting for migrations")).toHaveLength(2);
  });

  it("returns false when aborted (shutdown) and true at once when already up to date", async () => {
    const { log, messages } = captureLogger();
    const controller = new AbortController();
    const pending = waitForMigrations({
      status: statuses("pending"),
      log,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    controller.abort();
    expect(await pending).toBe(false);

    const ready = await waitForMigrations({
      status: statuses("up_to_date"),
      log,
      signal: new AbortController().signal,
    });
    expect(ready).toBe(true);
    expect(messages().filter((m) => m === "waiting for migrations")).toHaveLength(1);
  });
});
