import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, hashDecisionInputs, type RecordHasher } from "./hash";

const hmac: RecordHasher = (canonical) =>
  createHmac("sha256", "test-key").update(canonical).digest("hex");

describe("canonicalJson", () => {
  it("sorts keys at every level and drops undefined properties", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("does not depend on insertion order", () => {
    const a = { startsAt: new Date("2026-10-21T08:00:00Z"), employee: "1001", status: "Assigned" };
    const b = { status: "Assigned", employee: "1001", startsAt: new Date("2026-10-21T08:00:00Z") };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("writes Dates as ISO strings, undefined array items as null and -0 as 0", () => {
    expect(canonicalJson([new Date("2026-10-21T08:00:00Z"), undefined, -0, null, "x"])).toBe(
      '["2026-10-21T08:00:00.000Z",null,0,null,"x"]',
    );
  });

  it("refuses values without a stable JSON form", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ n: Infinity })).toThrow(TypeError);
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
    expect(() => canonicalJson(new Date(Number.NaN))).toThrow(TypeError);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(TypeError);
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { id: "1" };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"id":"1"},"b":{"id":"1"}}');
  });
});

describe("hashDecisionInputs", () => {
  const inputs = {
    record: {
      externalId: "5001",
      startsAt: new Date("2026-10-21T08:00:00Z"),
      endsAt: new Date("2026-10-21T16:00:00Z"),
      timezone: "Europe/London",
    },
    class: "PUBLISHED",
    targets: { employeeId: "e-1", locationId: "l-1" },
  };

  it("is stable for equal inputs and changes when a target changes", () => {
    const h = hashDecisionInputs(hmac, inputs);
    expect(hashDecisionInputs(hmac, structuredClone(inputs))).toBe(h);
    expect(
      hashDecisionInputs(hmac, { ...inputs, targets: { ...inputs.targets, locationId: "l-2" } }),
    ).not.toBe(h);
    expect(
      hashDecisionInputs(hmac, {
        ...inputs,
        record: { ...inputs.record, endsAt: new Date("2026-10-21T17:00:00Z") },
      }),
    ).not.toBe(h);
  });

  it("ignores settings that are not part of the inputs (e.g. a mapping version)", () => {
    // The caller decides what the inputs are; anything outside them (mappingVersion, §6.2) cannot change the hash.
    const withExtraUndefined = { ...inputs, mappingVersion: undefined };
    expect(hashDecisionInputs(hmac, withExtraUndefined)).toBe(hashDecisionInputs(hmac, inputs));
  });

  it("depends on the key (the HMAC is the caller's)", () => {
    const other: RecordHasher = (c) => createHmac("sha256", "other-key").update(c).digest("hex");
    expect(hashDecisionInputs(other, inputs)).not.toBe(hashDecisionInputs(hmac, inputs));
  });
});
