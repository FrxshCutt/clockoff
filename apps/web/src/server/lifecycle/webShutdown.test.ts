import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shutdownEventStreams = vi.fn(() => 3);
vi.mock("@/server/realtime/sse", () => ({ shutdownEventStreams }));

const { createWebShutdownHandler, installWebShutdown, resetWebShutdownForTesting } =
  await import("./webShutdown");

function setup(closeStreams: () => number = () => 2) {
  const log = { info: vi.fn(), warn: vi.fn() };
  const exit = vi.fn();
  const timers: Array<{ fn: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
  const setTimer = (fn: () => void, ms: number) => {
    const handle = { fn, ms, unref: vi.fn() };
    timers.push(handle);
    return handle;
  };
  const close = vi.fn(closeStreams);
  const handler = createWebShutdownHandler({
    closeStreams: close,
    graceMs: 20_000,
    log,
    exit,
    setTimer,
  });
  return { handler, log, exit, timers, close };
}

describe("createWebShutdownHandler", () => {
  it("closes the event streams once and arms an unref'd exit-0 deadline on the first signal", () => {
    const { handler, log, exit, timers, close } = setup();
    handler("SIGTERM");

    expect(close).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", streamsClosed: 2, graceMs: 20_000 }),
      expect.stringMatching(/draining/),
    );
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(20_000);
    expect(timers[0]!.unref).toHaveBeenCalledTimes(1);
    // Next normally exits first; the deadline only fires for a stuck request.
    expect(exit).not.toHaveBeenCalled();
    timers[0]!.fn();
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ graceMs: 20_000 }),
      expect.stringMatching(/grace period elapsed/),
    );
  });

  it("ignores every later signal (SIGTERM twice, or SIGTERM then SIGINT)", () => {
    const { handler, timers, close, log } = setup();
    handler("SIGTERM");
    handler("SIGTERM");
    handler("SIGINT");
    expect(close).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("still arms the deadline when closing the streams throws", () => {
    const { handler, timers, log } = setup(() => {
      throw new Error("boom");
    });
    expect(() => handler("SIGINT")).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGINT" }),
      expect.stringMatching(/closing event streams failed/),
    );
    expect(timers).toHaveLength(1);
  });

  it("uses a real, unref'd timer by default (never keeps the process alive)", () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const handler = createWebShutdownHandler({
        closeStreams: () => 0,
        graceMs: 5_000,
        log: { info: vi.fn(), warn: vi.fn() },
        exit,
      });
      handler("SIGTERM");
      vi.advanceTimersByTime(4_999);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("installWebShutdown", () => {
  beforeEach(() => resetWebShutdownForTesting());
  afterEach(() => resetWebShutdownForTesting());

  it("adds one SIGTERM and one SIGINT listener, once per process (idempotent)", () => {
    const term = process.listenerCount("SIGTERM");
    const int = process.listenerCount("SIGINT");
    installWebShutdown();
    installWebShutdown();
    expect(process.listenerCount("SIGTERM")).toBe(term + 1);
    expect(process.listenerCount("SIGINT")).toBe(int + 1);
    expect(globalThis.__clockoffWebShutdown).toBeTypeOf("function");

    resetWebShutdownForTesting();
    expect(process.listenerCount("SIGTERM")).toBe(term);
    expect(process.listenerCount("SIGINT")).toBe(int);
  });

  it("wires the listener to shutdownEventStreams and process.exit(0) after the grace period", () => {
    // Fake timers: the armed deadline must never fire for real inside the test worker.
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      shutdownEventStreams.mockClear();
      installWebShutdown();
      globalThis.__clockoffWebShutdown!("SIGTERM");
      globalThis.__clockoffWebShutdown!("SIGINT");
      expect(shutdownEventStreams).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(120_000);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      exit.mockRestore();
    }
  });
});

describe("register (src/instrumentation.ts)", () => {
  const installWebShutdownMock = vi.fn();
  const startEventBusListener = vi.fn();
  const originalRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    vi.resetModules();
    installWebShutdownMock.mockClear();
    startEventBusListener.mockClear();
    // Only these two exports exist on the mocks: touching anything else would throw.
    vi.doMock("@/server/lifecycle/webShutdown", () => ({
      installWebShutdown: installWebShutdownMock,
    }));
    vi.doMock("@/server/events", () => ({ startEventBusListener }));
  });

  afterEach(() => {
    vi.doUnmock("@/server/lifecycle/webShutdown");
    vi.doUnmock("@/server/events");
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
  });

  it("does nothing in the edge runtime (or outside Next)", async () => {
    const { register } = await import("@/instrumentation");
    process.env.NEXT_RUNTIME = "edge";
    await register();
    delete process.env.NEXT_RUNTIME;
    await register();
    expect(installWebShutdownMock).not.toHaveBeenCalled();
    expect(startEventBusListener).not.toHaveBeenCalled();
  });

  it("in the Node.js runtime installs the shutdown hook and starts the bus listener, nothing else", async () => {
    const { register } = await import("@/instrumentation");
    process.env.NEXT_RUNTIME = "nodejs";
    await register();
    expect(installWebShutdownMock).toHaveBeenCalledTimes(1);
    expect(installWebShutdownMock).toHaveBeenCalledWith();
    expect(startEventBusListener).toHaveBeenCalledTimes(1);
    expect(startEventBusListener).toHaveBeenCalledWith();
  });
});
