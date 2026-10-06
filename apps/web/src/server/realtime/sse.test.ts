import { afterEach, describe, expect, it } from "vitest";
import { InProcessEventBus, getEventBus, setEventBusForTesting } from "@/server/events";
import { createOrganisationEventStream, formatSseFrame } from "./sse";

afterEach(() => setEventBusForTesting(undefined));

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
