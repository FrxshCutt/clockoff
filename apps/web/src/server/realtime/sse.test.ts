import { REALTIME_RECONNECT_EVENT } from "@clockoff/validation/realtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InProcessEventBus,
  REALTIME_EVENT_TYPES,
  getEventBus,
  setEventBusForTesting,
  type EventBus,
  type RealtimeEventHandler,
} from "@/server/events";
import { DEFAULT_REALTIME_STREAM_MAX_LIFETIME_MS, REALTIME_HEARTBEAT_MS } from "./realtime.service";
import {
  RECONNECT_FRAME,
  createOrganisationEventStream,
  formatSseFrame,
  openEventStreamCount,
  resetEventStreamsForTesting,
  shutdownEventStreams,
} from "./sse";

afterEach(() => {
  resetEventStreamsForTesting();
  setEventBusForTesting(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ORG = "org-1";

/** Opens a stream under fake timers and returns a reader that decodes one chunk per `next()`. */
function openStream(options: { heartbeatMs?: number; maxLifetimeMs?: number } = {}) {
  const controller = new AbortController();
  const response = createOrganisationEventStream({
    organisationId: ORG,
    signal: controller.signal,
    heartbeatMs: options.heartbeatMs ?? 15_000,
    maxLifetimeMs: options.maxLifetimeMs,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const next = async (): Promise<string | null> => {
    const chunk = await reader.read();
    return chunk.done ? null : decoder.decode(chunk.value);
  };
  return { controller, reader, next };
}

describe("SSE helper", () => {
  it("formats frames", () => {
    const frame = formatSseFrame(
      { type: "shift.changed", organisationId: "o", payload: { a: 1 }, at: "t" },
      3,
    );
    expect(frame).toBe(
      'event: shift.changed\nid: 3\ndata: {"type":"shift.changed","organisationId":"o","payload":{"a":1},"at":"t"}\n\n',
    );
  });

  it("streams the organisation's bus events, filters, and unsubscribes on abort", async () => {
    setEventBusForTesting(new InProcessEventBus());
    const controller = new AbortController();
    const response = createOrganisationEventStream({
      organisationId: "org-1",
      signal: controller.signal,
      filter: (e) => e.employeeId !== "hidden",
      heartbeatMs: 60_000,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const hello = decoder.decode((await reader.read()).value);
    expect(hello).toContain("retry: 5000");
    expect(getEventBus().subscriberCount("org-1")).toBe(1);

    getEventBus().publish({
      type: "x",
      organisationId: "org-1",
      employeeId: "hidden",
      payload: {},
      at: "t0",
    });
    getEventBus().publish({ type: "y", organisationId: "org-2", payload: {}, at: "t1" });
    getEventBus().publish({ type: "z", organisationId: "org-1", payload: { n: 1 }, at: "t2" });
    const frame = decoder.decode((await reader.read()).value);
    expect(frame).toContain("event: z\nid: 1\n");

    controller.abort();
    expect(getEventBus().subscriberCount("org-1")).toBe(0);
    expect((await reader.read()).done).toBe(true);
  });
});

describe("stream lifetime cap", () => {
  it("sends the reconnect control frame, then ends, leaving no timer, subscription or abort listener", async () => {
    vi.useFakeTimers();
    setEventBusForTesting(new InProcessEventBus());
    const { controller, next } = openStream({ heartbeatMs: 15_000, maxLifetimeMs: 20_000 });
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    expect(await next()).toContain("retry: 5000");
    expect(getEventBus().subscriberCount(ORG)).toBe(1);
    expect(vi.getTimerCount()).toBe(2); // heartbeat + lifetime

    await vi.advanceTimersByTimeAsync(15_000);
    expect(await next()).toMatch(/^: ping \d+\n\n$/);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await next()).toBe(RECONNECT_FRAME);
    expect(await next()).toBeNull();

    expect(getEventBus().subscriberCount(ORG)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(() => controller.abort()).not.toThrow();
  });

  it("uses a named `reconnect` event with an empty JSON body (comments never reach EventSource script)", () => {
    expect(RECONNECT_FRAME).toBe(`event: ${REALTIME_RECONNECT_EVENT}\ndata: {}\n\n`);
    expect(REALTIME_RECONNECT_EVENT).toBe("reconnect");
    // A control frame, never a bus event kind (server copy of the list; the contract copy is tested in
    // @clockoff/validation).
    expect((REALTIME_EVENT_TYPES as readonly string[]).includes(REALTIME_RECONNECT_EVENT)).toBe(
      false,
    );
  });

  it("keeps sending heartbeats and events until the lifetime is reached", async () => {
    vi.useFakeTimers();
    setEventBusForTesting(new InProcessEventBus());
    const { next } = openStream({ heartbeatMs: 6_000, maxLifetimeMs: 20_000 });
    await next(); // hello

    const frames: string[] = [];
    for (let elapsed = 0; elapsed < 20_000; elapsed += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      if (elapsed === 9_000)
        getEventBus().publish({ type: "shift.changed", organisationId: ORG, payload: {}, at: "t" });
    }
    for (let text = await next(); text !== null; text = await next()) frames.push(text);

    expect(frames.filter((f) => f.startsWith(": ping"))).toHaveLength(3); // 6 s, 12 s, 18 s
    expect(frames.filter((f) => f.startsWith("event: shift.changed\nid: 1\n"))).toHaveLength(1);
    expect(frames.at(-1)).toBe(RECONNECT_FRAME);
  });

  it("stays open without a lifetime (long-lived hosts that opt out)", async () => {
    vi.useFakeTimers();
    setEventBusForTesting(new InProcessEventBus());
    const { controller, next } = openStream({ heartbeatMs: 15_000 });
    await next();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getEventBus().subscriberCount(ORG)).toBe(1);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an abort before the lifetime releases everything, and the lifetime never fires afterwards", async () => {
    vi.useFakeTimers();
    setEventBusForTesting(new InProcessEventBus());
    const { controller, next } = openStream({ maxLifetimeMs: 20_000 });
    await next();
    await vi.advanceTimersByTimeAsync(5_000);

    controller.abort();
    expect(await next()).toBeNull();
    expect(getEventBus().subscriberCount(ORG)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await next()).toBeNull();
  });

  it("a consumer cancel before the lifetime releases everything, including the abort listener", async () => {
    vi.useFakeTimers();
    setEventBusForTesting(new InProcessEventBus());
    const { controller, reader, next } = openStream({ maxLifetimeMs: 20_000 });
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    await next();

    await reader.cancel();
    expect(getEventBus().subscriberCount(ORG)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(() => controller.abort()).not.toThrow();
  });

  it("closes at once, holding nothing, when the request was already aborted", async () => {
    vi.useFakeTimers();
    setEventBusForTesting(new InProcessEventBus());
    const controller = new AbortController();
    controller.abort();
    const response = createOrganisationEventStream({
      organisationId: ORG,
      signal: controller.signal,
      maxLifetimeMs: 20_000,
    });
    expect((await response.body!.getReader().read()).done).toBe(true);
    expect(getEventBus().subscriberCount(ORG)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never enqueues after close, even if a bus keeps calling a released handler", async () => {
    vi.useFakeTimers();
    // A bus whose unsubscribe does not detach: the stream itself must refuse late frames.
    const handlers: RealtimeEventHandler[] = [];
    const leakyBus: EventBus = {
      publish: (event) => handlers.forEach((handler) => handler(event)),
      subscribe: (_organisationId, handler) => {
        handlers.push(handler);
        return () => undefined;
      },
      subscribeAll: (handler) => {
        handlers.push(handler);
        return () => undefined;
      },
      subscriberCount: () => handlers.length,
    };
    setEventBusForTesting(leakyBus);
    const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue");
    const { next } = openStream({ heartbeatMs: 60_000, maxLifetimeMs: 20_000 });
    await next();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await next()).toBe(RECONNECT_FRAME);
    expect(await next()).toBeNull();

    const callsAtClose = enqueue.mock.calls.length;
    expect(() =>
      leakyBus.publish({ type: "shift.changed", organisationId: ORG, payload: {}, at: "t" }),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enqueue.mock.calls.length).toBe(callsAtClose);
  });
});

describe("server shutdown", () => {
  it("sends the reconnect frame to every open stream, closes it and leaves nothing behind", async () => {
    vi.useFakeTimers();
    setEventBusForTesting(new InProcessEventBus());
    const a = openStream({ maxLifetimeMs: DEFAULT_REALTIME_STREAM_MAX_LIFETIME_MS });
    const b = openStream();
    expect(await a.next()).toContain("retry: 5000");
    expect(await b.next()).toContain("retry: 5000");
    expect(openEventStreamCount()).toBe(2);
    expect(getEventBus().subscriberCount(ORG)).toBe(2);
    const removeListener = vi.spyOn(a.controller.signal, "removeEventListener");

    expect(shutdownEventStreams()).toBe(2);
    for (const stream of [a, b]) {
      expect(await stream.next()).toBe(RECONNECT_FRAME);
      expect(await stream.next()).toBeNull();
    }
    expect(openEventStreamCount()).toBe(0);
    expect(getEventBus().subscriberCount(ORG)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    // Idempotent: nothing left to close.
    expect(shutdownEventStreams()).toBe(0);
  });

  it("ends a stream opened while draining at once: retry hint, reconnect frame, no subscription", async () => {
    vi.useFakeTimers();
    setEventBusForTesting(new InProcessEventBus());
    shutdownEventStreams();
    const { next } = openStream({ maxLifetimeMs: DEFAULT_REALTIME_STREAM_MAX_LIFETIME_MS });
    expect(await next()).toContain("retry: 5000");
    expect(await next()).toBe(RECONNECT_FRAME);
    expect(await next()).toBeNull();
    expect(getEventBus().subscriberCount(ORG)).toBe(0);
    expect(openEventStreamCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forgets streams that ended on their own", async () => {
    vi.useFakeTimers();
    setEventBusForTesting(new InProcessEventBus());
    const { controller, next } = openStream({ maxLifetimeMs: 20_000 });
    await next();
    expect(openEventStreamCount()).toBe(1);
    controller.abort();
    expect(openEventStreamCount()).toBe(0);

    const capped = openStream({ maxLifetimeMs: 20_000 });
    await capped.next();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(openEventStreamCount()).toBe(0);
    expect(shutdownEventStreams()).toBe(0);
  });
});

describe("realtime stream timing", () => {
  it("pings at least once per stream: 15 s heartbeat, 5 min default lifetime", () => {
    expect(REALTIME_HEARTBEAT_MS).toBe(15_000);
    expect(DEFAULT_REALTIME_STREAM_MAX_LIFETIME_MS).toBe(300_000);
    expect(REALTIME_HEARTBEAT_MS).toBeLessThan(DEFAULT_REALTIME_STREAM_MAX_LIFETIME_MS);
  });
});
