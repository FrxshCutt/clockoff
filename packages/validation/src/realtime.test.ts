import { describe, expect, it } from "vitest";
import { REALTIME_EVENT_TYPES, REALTIME_RECONNECT_EVENT, sseEventSchema } from "./realtime";

describe("REALTIME_RECONNECT_EVENT", () => {
  it("is the stream's `reconnect` control frame", () => {
    expect(REALTIME_RECONNECT_EVENT).toBe("reconnect");
  });

  it("is not an event kind (it would drive invalidations, contract parity and the push bridge)", () => {
    expect((REALTIME_EVENT_TYPES as readonly string[]).includes(REALTIME_RECONNECT_EVENT)).toBe(
      false,
    );
  });

  it("carries no SseEvent payload (`data: {}`)", () => {
    expect(sseEventSchema.safeParse({}).success).toBe(false);
  });
});
