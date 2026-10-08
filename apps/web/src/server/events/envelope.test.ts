import { describe, expect, it } from "vitest";
import type { RealtimeEvent } from "./EventBus";
import {
  NOTIFY_MAX_BYTES,
  decodeEnvelope,
  encodeEnvelope,
  organisationWideTruncatedEvent,
  truncatedEvent,
} from "./envelope";

const ORIGIN = "6f1c3c38-4b0e-4a58-9d0c-7a1d2c3b4e5f";
const ORG = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";

const event = (payload: Record<string, unknown> = { shiftIds: ["s1"] }): RealtimeEvent => ({
  type: "SCHEDULE_CHANGED",
  organisationId: ORG,
  employeeId: EMPLOYEE,
  payload,
  at: "2026-10-08T09:00:00.000Z",
});

/** The envelope's fixed overhead around a payload: what a filler string must not exceed to fit. */
function fillerFor(targetBytes: number, char: string): string {
  const base = encodeEnvelope(ORIGIN, event({ filler: "" }), Number.MAX_SAFE_INTEGER)!.bytes;
  const charBytes = Buffer.byteLength(char, "utf8");
  return char.repeat(Math.floor((targetBytes - base) / charBytes));
}

describe("encodeEnvelope / decodeEnvelope", () => {
  it("round-trips an event with its origin", () => {
    const encoded = encodeEnvelope(ORIGIN, event())!;
    expect(encoded.truncated).toBe(false);
    expect(JSON.parse(encoded.payload)).toEqual({ v: 1, o: ORIGIN, e: event() });
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.payload, "utf8"));
    expect(decodeEnvelope(encoded.payload)).toEqual({ originId: ORIGIN, event: event() });
  });

  it("round-trips an organisation-level event (no employeeId key)", () => {
    const orgEvent: RealtimeEvent = {
      type: "import.completed",
      organisationId: ORG,
      payload: {},
      at: "t",
    };
    const decoded = decodeEnvelope(encodeEnvelope(ORIGIN, orgEvent)!.payload)!;
    expect(decoded.event).toEqual(orgEvent);
    expect("employeeId" in decoded.event).toBe(false);
  });

  it("counts UTF-8 bytes, not characters, at the 7500-byte boundary", () => {
    expect(NOTIFY_MAX_BYTES).toBe(7500);
    // "é" is 2 bytes and "€" 3: a character count would let these through at ~2× / ~3× the limit.
    for (const char of ["a", "é", "€"]) {
      const atLimit = event({ filler: fillerFor(NOTIFY_MAX_BYTES, char) });
      const fits = encodeEnvelope(ORIGIN, atLimit)!;
      expect(fits.truncated).toBe(false);
      expect(fits.bytes).toBeLessThanOrEqual(NOTIFY_MAX_BYTES);
      expect(fits.bytes).toBeGreaterThan(NOTIFY_MAX_BYTES - Buffer.byteLength(char, "utf8"));

      const over = event({ filler: `${fillerFor(NOTIFY_MAX_BYTES, char)}${char}` });
      expect(encodeEnvelope(ORIGIN, over)!.truncated).toBe(true);
    }
  });

  it("truncates an oversize payload, keeping type, organisation, employee and time", () => {
    const big = event({
      shiftIds: Array.from({ length: 400 }, (_, i) => `shift-${i}-${"x".repeat(20)}`),
    });
    const encoded = encodeEnvelope(ORIGIN, big)!;
    expect(encoded.truncated).toBe(true);
    expect(encoded.bytes).toBeLessThanOrEqual(NOTIFY_MAX_BYTES);
    expect(decodeEnvelope(encoded.payload)).toEqual({
      originId: ORIGIN,
      event: {
        type: "SCHEDULE_CHANGED",
        organisationId: ORG,
        employeeId: EMPLOYEE,
        payload: { truncated: true },
        at: "2026-10-08T09:00:00.000Z",
      },
    });
    expect(truncatedEvent(big)).toEqual(decodeEnvelope(encoded.payload)!.event);
  });

  it("returns null when even the truncated envelope cannot fit", () => {
    const absurd: RealtimeEvent = { ...event(), type: "x".repeat(NOTIFY_MAX_BYTES) };
    expect(encodeEnvelope(ORIGIN, absurd)).toBeNull();
  });

  it("builds organisation-wide truncated events without the employee", () => {
    expect(organisationWideTruncatedEvent(event())).toEqual({
      type: "SCHEDULE_CHANGED",
      organisationId: ORG,
      payload: { truncated: true },
      at: "2026-10-08T09:00:00.000Z",
    });
  });

  it("rejects malformed or foreign payloads", () => {
    const valid = { v: 1, o: ORIGIN, e: event() };
    const cases: unknown[] = [
      "not json",
      "",
      "null",
      "[]",
      JSON.stringify({ ...valid, v: 2 }),
      JSON.stringify({ ...valid, o: "" }),
      JSON.stringify({ ...valid, o: 7 }),
      JSON.stringify({ v: 1, o: ORIGIN }),
      JSON.stringify({ ...valid, e: { ...event(), type: "" } }),
      JSON.stringify({ ...valid, e: { ...event(), organisationId: 5 } }),
      JSON.stringify({ ...valid, e: { ...event(), payload: [] } }),
      JSON.stringify({ ...valid, e: { ...event(), payload: null } }),
      JSON.stringify({ ...valid, e: { ...event(), at: undefined } }),
      JSON.stringify({ ...valid, e: { ...event(), employeeId: 42 } }),
      JSON.stringify({ hello: "from another app" }),
    ];
    for (const text of cases) expect(decodeEnvelope(text as string)).toBeNull();
  });
});
