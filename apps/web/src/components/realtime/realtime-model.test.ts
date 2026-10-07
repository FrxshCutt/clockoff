import { REALTIME_EVENT_TYPES } from "@clockoff/validation/realtime";
import { describe, expect, it } from "vitest";
import { activityKeys } from "@/components/activity/activity-keys";
import { importKeys } from "@/components/imports/import-queries";
import { complianceKeys } from "@/components/overview/compliance-keys";
import { breakPolicyQueryKeys, policyQueryKeys } from "@/components/policies/policy-query-keys";
import { scheduleKeys } from "@/components/schedule/schedule-queries";
import { queryKeys } from "@/lib/query-client";
import {
  DEFAULT_INVALIDATION_KEYS,
  REALTIME_ALL_KEYS,
  REALTIME_CONNECTING_META,
  REALTIME_INVALIDATIONS,
  REALTIME_STATUS_META,
  REALTIME_STREAM_PATH,
  REALTIME_TIMING,
  invalidationKeysFor,
  isPollingFallbackDue,
  isRealtimeEventType,
  nextBackoffMs,
  parseSseEvent,
  statusWhileDisconnected,
  type RealtimeStatus,
} from "./realtime-model";

const ORG_ID = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";

describe("REALTIME_TIMING", () => {
  it("matches the product rules: polling after 10 s down, refetch every 30 s while polling", () => {
    expect(REALTIME_TIMING.pollingAfterMs).toBe(10_000);
    expect(REALTIME_TIMING.pollIntervalMs).toBe(30_000);
    expect(REALTIME_TIMING.baseDelayMs).toBeLessThanOrEqual(REALTIME_TIMING.maxDelayMs);
    expect(REALTIME_STREAM_PATH).toBe("/api/realtime/stream");
  });
});

describe("nextBackoffMs", () => {
  it("uses equal jitter: attempt n lands in [base·2ⁿ / 2, base·2ⁿ]", () => {
    expect(nextBackoffMs(0, () => 0)).toBe(500);
    expect(nextBackoffMs(0, () => 1)).toBe(1_000);
    expect(nextBackoffMs(1, () => 0)).toBe(1_000);
    expect(nextBackoffMs(1, () => 1)).toBe(2_000);
    expect(nextBackoffMs(2, () => 0.5)).toBe(3_000);
  });

  it("caps the delay at maxDelayMs however many attempts have failed", () => {
    expect(nextBackoffMs(10, () => 1)).toBe(REALTIME_TIMING.maxDelayMs);
    expect(nextBackoffMs(10, () => 0)).toBe(REALTIME_TIMING.maxDelayMs / 2);
    expect(nextBackoffMs(1_000, () => 1)).toBe(REALTIME_TIMING.maxDelayMs);
  });

  it("never shrinks as attempts grow (for a fixed random draw)", () => {
    const delays = Array.from({ length: 12 }, (_, attempt) => nextBackoffMs(attempt, () => 0.3));
    for (let i = 1; i < delays.length; i += 1)
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] ?? 0);
  });

  it("treats nonsense attempts and out-of-range randomness as the safe extremes", () => {
    expect(nextBackoffMs(-5, () => 0)).toBe(500);
    expect(nextBackoffMs(Number.NaN, () => 0)).toBe(500);
    expect(nextBackoffMs(0, () => 7)).toBe(1_000);
    expect(nextBackoffMs(0, () => -1)).toBe(500);
  });

  it("stays within bounds with the real random source", () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const delay = nextBackoffMs(attempt);
      const ceiling = Math.min(
        REALTIME_TIMING.maxDelayMs,
        REALTIME_TIMING.baseDelayMs * 2 ** attempt,
      );
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it("honours a custom timing table", () => {
    const timing = { ...REALTIME_TIMING, baseDelayMs: 100, maxDelayMs: 250 };
    expect(nextBackoffMs(0, () => 1, timing)).toBe(100);
    expect(nextBackoffMs(5, () => 1, timing)).toBe(250);
  });
});

describe("polling fallback", () => {
  const now = 1_700_000_000_000;

  it("is not due while connected or within the first 10 s of an outage", () => {
    expect(isPollingFallbackDue(null, now)).toBe(false);
    expect(isPollingFallbackDue(now, now)).toBe(false);
    expect(isPollingFallbackDue(now - REALTIME_TIMING.pollingAfterMs, now)).toBe(false);
  });

  it("is due once the outage has lasted longer than 10 s", () => {
    expect(isPollingFallbackDue(now - REALTIME_TIMING.pollingAfterMs - 1, now)).toBe(true);
    expect(isPollingFallbackDue(now - 60_000, now)).toBe(true);
  });

  it("reads a short blip as reconnecting and a long outage as polling", () => {
    expect(statusWhileDisconnected(now - 2_000, now)).toBe<RealtimeStatus>("reconnecting");
    expect(statusWhileDisconnected(now - 20_000, now)).toBe<RealtimeStatus>("polling");
    expect(statusWhileDisconnected(null, now)).toBe<RealtimeStatus>("reconnecting");
  });
});

describe("invalidation table", () => {
  it("knows every realtime event type the contract declares", () => {
    for (const type of REALTIME_EVENT_TYPES) {
      expect(isRealtimeEventType(type)).toBe(true);
      expect(invalidationKeysFor(type).length).toBeGreaterThan(0);
    }
  });

  it("ignores event kinds this UI has never heard of", () => {
    expect(isRealtimeEventType("something.new")).toBe(false);
    expect(invalidationKeysFor("something.new")).toEqual([]);
    expect(invalidationKeysFor("")).toEqual([]);
  });

  it("routes each kind to the queries it can stale", () => {
    expect(invalidationKeysFor("notification.created")).toEqual([queryKeys.notifications]);
    expect(invalidationKeysFor("activity.recorded")).toEqual(
      expect.arrayContaining([activityKeys.all, complianceKeys.all]),
    );
    expect(invalidationKeysFor("device.status.changed")).toEqual(
      expect.arrayContaining([complianceKeys.all, queryKeys.onboarding]),
    );
    expect(invalidationKeysFor("override.changed")).toEqual(
      expect.arrayContaining([["org", "overrides"]]),
    );
    // The schedule page sees other managers' edits and finished imports without a reload.
    expect(invalidationKeysFor("shift.changed")).toEqual(
      expect.arrayContaining([scheduleKeys.shiftsRoot]),
    );
    expect(invalidationKeysFor("import.completed")).toEqual(
      expect.arrayContaining([importKeys.root, scheduleKeys.shiftsRoot]),
    );
    expect(invalidationKeysFor("policy.changed")).toEqual(
      expect.arrayContaining([policyQueryKeys.all, breakPolicyQueryKeys.all]),
    );
  });

  it("has entries ready for the policy kinds the server publishes (live once the contract declares them)", () => {
    expect(REALTIME_INVALIDATIONS.POLICY_CHANGED).toEqual(
      expect.arrayContaining([policyQueryKeys.all, complianceKeys.all]),
    );
    expect(REALTIME_INVALIDATIONS.BREAK_POLICY_CHANGED).toEqual(
      expect.arrayContaining([breakPolicyQueryKeys.all, complianceKeys.all]),
    );
    for (const kind of ["POLICY_CHANGED", "BREAK_POLICY_CHANGED"]) {
      // Declared → routed to the policy pages; undeclared → ignored (the stream never delivers it).
      expect(invalidationKeysFor(kind)).toEqual(
        isRealtimeEventType(kind) ? REALTIME_INVALIDATIONS[kind as "POLICY_CHANGED"] : [],
      );
    }
  });

  it("falls back to the dashboard summaries for a declared kind without a specific entry", () => {
    const known = REALTIME_EVENT_TYPES.find((type) => REALTIME_INVALIDATIONS[type] === undefined);
    if (known) expect(invalidationKeysFor(known)).toBe(DEFAULT_INVALIDATION_KEYS);
    expect(DEFAULT_INVALIDATION_KEYS).toEqual(
      expect.arrayContaining([complianceKeys.all, activityKeys.all]),
    );
  });

  it("collects every key once for the polling refetch", () => {
    const ids = REALTIME_ALL_KEYS.map((key) => JSON.stringify(key));
    expect(new Set(ids).size).toBe(ids.length);
    expect(REALTIME_ALL_KEYS).toEqual(
      expect.arrayContaining([
        queryKeys.notifications,
        complianceKeys.all,
        activityKeys.all,
        ["org", "employees"],
        ["org", "devices"],
      ]),
    );
    // Every key is organisation-scoped so switching organisation clears them together.
    for (const key of REALTIME_ALL_KEYS) expect(key[0]).toBe("org");
  });
});

describe("parseSseEvent", () => {
  const frame = {
    type: "activity.recorded",
    organisationId: ORG_ID,
    employeeId: ORG_ID,
    payload: { activityId: "x" },
    at: "2026-10-06T09:00:00.000Z",
  };

  it("parses a well-formed data field", () => {
    expect(parseSseEvent(JSON.stringify(frame))).toEqual(frame);
  });

  it("keeps kinds it does not know (the type is an open string in the contract)", () => {
    expect(parseSseEvent(JSON.stringify({ ...frame, type: "brand.new" }))?.type).toBe("brand.new");
  });

  it("drops malformed frames instead of throwing", () => {
    expect(parseSseEvent("not json")).toBeNull();
    expect(parseSseEvent("")).toBeNull();
    expect(parseSseEvent("   ")).toBeNull();
    expect(parseSseEvent(undefined)).toBeNull();
    expect(parseSseEvent(42)).toBeNull();
    expect(parseSseEvent(JSON.stringify({ ...frame, organisationId: "nope" }))).toBeNull();
    expect(parseSseEvent(JSON.stringify({ type: "x" }))).toBeNull();
    expect(parseSseEvent(JSON.stringify({ ...frame, payload: "string" }))).toBeNull();
  });
});

describe("REALTIME_STATUS_META", () => {
  const statuses: RealtimeStatus[] = ["connected", "reconnecting", "polling"];
  const labels = () => statuses.map((status) => REALTIME_STATUS_META[status].label);

  it("has a distinct label for each status so colour is never the only signal", () => {
    expect(new Set(labels()).size).toBe(statuses.length);
    for (const status of statuses)
      expect(REALTIME_STATUS_META[status].description.trim()).not.toBe("");
    expect(REALTIME_STATUS_META.polling.label).toContain("30 s");
  });

  it("reads the first connection attempt as neutral, not as a dropped connection", () => {
    expect(labels()).not.toContain(REALTIME_CONNECTING_META.label);
    expect(REALTIME_CONNECTING_META.tone).toBe("neutral");
    expect(REALTIME_STATUS_META.reconnecting.tone).not.toBe("neutral");
  });
});
