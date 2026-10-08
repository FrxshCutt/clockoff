import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWatchdog } from "./watchdog";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T09:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createWatchdog", () => {
  it("never fires while the minute lane makes progress every minute", () => {
    let progress = Date.now();
    const onStall = vi.fn();
    const watchdog = createWatchdog({ lastProgressAt: () => progress, onStall });
    watchdog.start();
    for (let minute = 0; minute < 30; minute += 1) {
      vi.advanceTimersByTime(60_000);
      progress = Date.now();
    }
    expect(onStall).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("fires once after 10 minutes without progress", () => {
    const progress = Date.now();
    const onStall = vi.fn();
    const watchdog = createWatchdog({ lastProgressAt: () => progress, onStall });
    watchdog.start();
    vi.advanceTimersByTime(9 * 60_000 + 30_000);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]![0]).toBeGreaterThanOrEqual(10 * 60_000);
    vi.advanceTimersByTime(30 * 60_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it("stop() disarms it", () => {
    const progress = Date.now();
    const onStall = vi.fn();
    const watchdog = createWatchdog({ lastProgressAt: () => progress, onStall });
    watchdog.start();
    vi.advanceTimersByTime(5 * 60_000);
    watchdog.stop();
    vi.advanceTimersByTime(60 * 60_000);
    expect(onStall).not.toHaveBeenCalled();
  });
});
