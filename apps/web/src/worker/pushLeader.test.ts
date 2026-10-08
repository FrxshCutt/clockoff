import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@/lib/logger";
import { LOCK_KEYS } from "./lockKeys";
import { createPushLeader, type PushLeaderDeps } from "./pushLeader";
import { createWorkerShutdown } from "./shutdown";
import { captureLogger, FakeLockServer, FakeLockSession } from "./testing";

const LEASE = LOCK_KEYS.pushLeader;

function leader(
  session: FakeLockSession,
  overrides: Partial<PushLeaderDeps> = {},
  events: string[] = [],
) {
  const captured = captureLogger();
  const deps: PushLeaderDeps = {
    locks: session,
    log: captured.log,
    enable: vi.fn(() => {
      events.push(`${session.name}:enable`);
    }),
    disable: vi.fn(async ({ flush }: { flush: boolean }) => {
      events.push(`${session.name}:disable:${flush}`);
    }),
    selfTest: vi.fn(async () => true),
    ...overrides,
  };
  return { leader: createPushLeader(deps), deps, captured, events };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPushLeader", () => {
  it("acquires the lease once and enables the bridge once", async () => {
    const session = new FakeLockSession(new FakeLockServer(), "a");
    const { leader: a, deps, captured } = leader(session);
    void a.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.isLeader()).toBe(true);
    expect(session.isHeld(LEASE)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.enable).toHaveBeenCalledTimes(1);
    expect(captured.messages().filter((m) => m === "push bridge leader acquired")).toHaveLength(1);
    a.stop();
  });

  it("stands down the moment its lock session is lost (no flush), then competes again", async () => {
    const session = new FakeLockSession(new FakeLockServer(), "a");
    const { leader: a, deps, captured } = leader(session);
    void a.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.isLeader()).toBe(true);

    session.failing.add(LEASE); // still reconnecting
    session.lose();
    // Synchronously, not at the next 5 s lease tick: a resumed zombie must not keep bridging.
    expect(a.isLeader()).toBe(false);
    expect(deps.disable).toHaveBeenCalledTimes(1);
    expect(deps.disable).toHaveBeenCalledWith({ flush: false });
    expect(captured.messages()).toContain("push bridge leadership lost");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.isLeader()).toBe(false);
    expect(deps.disable).toHaveBeenCalledTimes(1);

    session.failing.delete(LEASE);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.isLeader()).toBe(true);
    expect(deps.enable).toHaveBeenCalledTimes(2);
    a.stop();
  });

  it("the lease tick is the fallback when the lease is gone without a session-lost signal", async () => {
    const server = new FakeLockServer();
    const session = new FakeLockSession(server, "a");
    const { leader: a, deps } = leader(session);
    void a.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.isLeader()).toBe(true);
    server.holders.delete(LEASE); // gone, no listener fired
    server.holders.set(LEASE, new FakeLockSession(server, "b"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.isLeader()).toBe(false);
    expect(deps.disable).toHaveBeenCalledWith({ flush: false });
    a.stop();
  });

  it("passes enable a stillLeader check that follows the lease", async () => {
    const session = new FakeLockSession(new FakeLockServer(), "a");
    let stillLeader: (() => boolean) | undefined;
    const { leader: a } = leader(session, {
      enable: (check) => {
        stillLeader = check;
      },
    });
    void a.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(stillLeader?.()).toBe(true);
    session.lose();
    expect(stillLeader?.()).toBe(false);
    a.stop();
  });

  it("start() resolves once the first lease attempt settled, leader or standby", async () => {
    const server = new FakeLockServer();
    const events: string[] = [];
    const a = leader(new FakeLockSession(server, "a"), {}, events);
    let started = false;
    void a.leader.start().then(() => {
      started = true;
      events.push("a:started");
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(true);
    expect(events).toEqual(["a:enable", "a:started"]);

    const b = leader(new FakeLockSession(server, "b"));
    await b.leader.start();
    expect(b.leader.isLeader()).toBe(false);
    expect(b.captured.messages()).toContain("push bridge standby");

    // A failed first self-test settles too (the retry runs in the background).
    const c = leader(new FakeLockSession(new FakeLockServer(), "c"), {
      selfTest: vi.fn(async () => false),
    });
    await c.leader.start();
    expect(c.leader.isLeader()).toBe(false);
    a.leader.stop();
    b.leader.stop();
    c.leader.stop();
  });

  it("a standby retries every 5 s, logs standby once, and takes over within 5 s of the holder's release", async () => {
    const server = new FakeLockServer();
    const events: string[] = [];
    const a = leader(new FakeLockSession(server, "a"), {}, events);
    const b = leader(new FakeLockSession(server, "b"), {}, events);
    void a.leader.start();
    await vi.advanceTimersByTimeAsync(0);
    void b.leader.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.leader.isLeader()).toBe(true);
    expect(b.leader.isLeader()).toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);
    const bSession = b.deps.locks as FakeLockSession;
    expect(bSession.calls.filter((c) => c === `acquire:${LEASE}`)).toHaveLength(5);
    expect(b.captured.messages().filter((m) => m === "push bridge standby")).toHaveLength(1);

    await a.leader.handOver();
    expect(events).toEqual(["a:enable", "a:disable:true"]);
    expect(server.holders.has(LEASE)).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.leader.isLeader()).toBe(true);
    expect(events.at(-1)).toBe("b:enable");
    b.leader.stop();
  });

  it("does not compete before the bus delivery self-test passes (retried every 30 s)", async () => {
    const session = new FakeLockSession(new FakeLockServer(), "a");
    const selfTest = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false);
    selfTest.mockResolvedValue(true);
    const { leader: a, deps } = leader(session, { selfTest });
    void a.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(session.calls).toEqual([]);
    expect(a.isLeader()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(selfTest).toHaveBeenCalledTimes(2);
    expect(a.isLeader()).toBe(true);
    expect(deps.enable).toHaveBeenCalledTimes(1);
    a.stop();
  });

  it("handOver on a standby releases nothing", async () => {
    const server = new FakeLockServer();
    const holder = new FakeLockSession(server, "holder");
    await holder.tryAcquire(LEASE);
    const session = new FakeLockSession(server, "b");
    const { leader: b, deps } = leader(session);
    void b.start();
    await vi.advanceTimersByTimeAsync(0);
    await b.handOver();
    expect(deps.disable).not.toHaveBeenCalled();
    expect(session.calls.filter((c) => c.startsWith("release"))).toEqual([]);
    expect(holder.isHeld(LEASE)).toBe(true);
  });
});

describe("worker shutdown order", () => {
  it("hands push leadership over (disable + release) before the scheduler stops, then closes the rest", async () => {
    vi.useRealTimers();
    const order: string[] = [];
    const server = new FakeLockServer();
    const session = new FakeLockSession(server, "a");
    const { leader: a } = leader(
      session,
      {
        disable: async () => {
          order.push("disablePushBridge");
        },
      },
      [],
    );
    void a.start();
    await vi.waitFor(() => expect(a.isLeader()).toBe(true));
    const release = session.release.bind(session);
    session.release = async (key) => {
      if (key === LEASE) order.push("release lease");
      return release(key);
    };

    const exit = vi.fn();
    const shutdown = createWorkerShutdown({
      log: createLogger({ level: "silent" }),
      graceMs: 1_000,
      stopTimers: () => {
        order.push("stop timers");
      },
      handOverPushLeadership: (ms) => a.handOver(ms),
      stopScheduler: async () => {
        order.push("scheduler.stop");
        return { abandoned: [] };
      },
      markStopped: async () => {
        order.push("markWorkerStopped");
      },
      closeLocks: async () => {
        order.push("locks.close");
      },
      closeEventBus: async () => {
        order.push("closeEventBus");
      },
      settleBackgroundTasks: async () => {
        order.push("settle");
      },
      disconnectDatabase: async () => {
        order.push("prisma.$disconnect");
        throw new Error("already disconnected"); // a failing step never blocks the exit
      },
      exit,
    });
    await shutdown("SIGTERM");
    await shutdown("SIGTERM"); // second signal ignored

    expect(order).toEqual([
      "stop timers",
      "disablePushBridge",
      "release lease",
      "scheduler.stop",
      "markWorkerStopped",
      "locks.close",
      "closeEventBus",
      "settle",
      "prisma.$disconnect",
    ]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
