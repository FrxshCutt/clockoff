import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { InProcessEventBus } from "./InProcessEventBus";
import { PostgresEventBus } from "./PostgresEventBus";
import {
  closeEventBus,
  createDefaultEventBus,
  eventBusDiagnostics,
  flushEventBus,
  getEventBus,
  publishEvent,
  setEventBusForTesting,
  startEventBusListener,
  verifyEventBusDelivery,
  type RealtimeEvent,
} from "./index";

const event = (organisationId: string): RealtimeEvent => ({
  type: "shift.changed",
  organisationId,
  payload: { shiftId: "s1" },
  at: "2026-10-06T09:00:00.000Z",
});

afterEach(() => {
  setEventBusForTesting(undefined);
  vi.restoreAllMocks();
});

describe("InProcessEventBus", () => {
  it("delivers only to subscribers of the event's organisation", () => {
    const bus = new InProcessEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("org-a", a);
    bus.subscribe("org-b", b);
    bus.publish(event("org-a"));
    expect(a).toHaveBeenCalledWith(event("org-a"));
    expect(b).not.toHaveBeenCalled();
  });

  it("unsubscribes and tracks subscriber counts", () => {
    const bus = new InProcessEventBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe("org-a", handler);
    expect(bus.subscriberCount("org-a")).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(bus.subscriberCount("org-a")).toBe(0);
    bus.publish(event("org-a"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("subscribeAll receives every organisation's events, after the organisation's own subscribers", () => {
    const bus = new InProcessEventBus();
    const order: string[] = [];
    const all = vi.fn((_event: RealtimeEvent) => {
      order.push("all");
    });
    const unsubscribe = bus.subscribeAll(all);
    bus.subscribe("org-a", () => order.push("org-a"));
    bus.publish(event("org-a"));
    bus.publish(event("org-b"));
    expect(all.mock.calls.map(([e]) => e.organisationId)).toEqual(["org-a", "org-b"]);
    expect(order).toEqual(["org-a", "all", "all"]);
    // All-organisations subscribers are not counted per organisation.
    expect(bus.subscriberCount("org-b")).toBe(0);

    unsubscribe();
    unsubscribe();
    bus.publish(event("org-b"));
    expect(all).toHaveBeenCalledTimes(2);
  });

  it("isolates a throwing handler", () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const bus = new InProcessEventBus();
    const good = vi.fn();
    const goodAll = vi.fn();
    bus.subscribe("org-a", () => {
      throw new Error("bad handler");
    });
    bus.subscribeAll(() => {
      throw new Error("bad all handler");
    });
    bus.subscribe("org-a", good);
    bus.subscribeAll(goodAll);
    bus.publish(event("org-a"));
    expect(good).toHaveBeenCalledOnce();
    expect(goodAll).toHaveBeenCalledOnce();
  });

  it("publishEvent stamps `at` on the process-wide bus", () => {
    const bus = new InProcessEventBus();
    setEventBusForTesting(bus);
    const handler = vi.fn();
    getEventBus().subscribe("org-z", handler);
    publishEvent({ type: "policy.changed", organisationId: "org-z", payload: {} });
    expect(handler.mock.calls[0]?.[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

describe("default bus", () => {
  const directUrl = "postgresql://u:p@localhost:5433/clockoff";

  it("is in-process under tests, even with DIRECT_URL", () => {
    expect(createDefaultEventBus({ nodeEnv: "test", directUrl })).toBeInstanceOf(InProcessEventBus);
    // The cached bus of this test process (NODE_ENV=test) is in-process too.
    expect(getEventBus()).toBeInstanceOf(InProcessEventBus);
  });

  it("is in-process without DIRECT_URL", () => {
    expect(createDefaultEventBus({ nodeEnv: "development", directUrl: undefined })).toBeInstanceOf(
      InProcessEventBus,
    );
    expect(createDefaultEventBus({ nodeEnv: "production", directUrl: "" })).toBeInstanceOf(
      InProcessEventBus,
    );
  });

  it("is a Postgres bus with DIRECT_URL outside tests (nothing connects until it is started)", () => {
    const bus = createDefaultEventBus({ nodeEnv: "production", directUrl, serviceName: "web" });
    expect(bus).toBeInstanceOf(PostgresEventBus);
    expect((bus as PostgresEventBus).diagnostics()).toMatchObject({
      mode: "postgres",
      listening: false,
    });
  });
});

describe("bus helpers", () => {
  it("are inert for an in-process bus", async () => {
    setEventBusForTesting(new InProcessEventBus());
    expect(() => startEventBusListener()).not.toThrow();
    await expect(flushEventBus(10)).resolves.toBeUndefined();
    await expect(verifyEventBusDelivery(10)).resolves.toBe(true);
    expect(eventBusDiagnostics()).toEqual({
      mode: "in_process",
      listening: false,
      reconnects: 0,
      notifySent: 0,
      notifyBatches: 0,
      notifyTruncated: 0,
      notifyCoalesced: 0,
      notifyDropped: 0,
      received: 0,
    });
    await expect(closeEventBus(10)).resolves.toBeUndefined();
  });

  it("flush and close do nothing when no bus was ever created", async () => {
    setEventBusForTesting(undefined);
    await expect(flushEventBus(10)).resolves.toBeUndefined();
    await expect(closeEventBus(10)).resolves.toBeUndefined();
    expect(globalThis.__clockoffEventBus).toBeUndefined();
  });
});
