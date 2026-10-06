import { describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { InProcessEventBus } from "./InProcessEventBus";
import { getEventBus, publishEvent, setEventBusForTesting, type RealtimeEvent } from "./index";

const event = (organisationId: string): RealtimeEvent => ({
  type: "shift.changed",
  organisationId,
  payload: { shiftId: "s1" },
  at: "2026-10-06T09:00:00.000Z",
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

  it("isolates a throwing handler", () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const bus = new InProcessEventBus();
    const good = vi.fn();
    bus.subscribe("org-a", () => {
      throw new Error("bad handler");
    });
    bus.subscribe("org-a", good);
    bus.publish(event("org-a"));
    expect(good).toHaveBeenCalledOnce();
  });

  it("publishEvent stamps `at` on the process-wide bus", () => {
    const bus = new InProcessEventBus();
    setEventBusForTesting(bus);
    const handler = vi.fn();
    getEventBus().subscribe("org-z", handler);
    publishEvent({ type: "policy.changed", organisationId: "org-z", payload: {} });
    expect(handler.mock.calls[0]?.[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    setEventBusForTesting(undefined);
  });
});
