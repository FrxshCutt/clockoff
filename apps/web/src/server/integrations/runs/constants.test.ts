import { describe, expect, it } from "vitest";
import { isHealthTransition, coarseStatus } from "../status";
import { defaultRunPriority, prismaPoolSize, RUN_PRIORITY, runnerConcurrency } from "./constants";
import { mergePendingSlot, probeBackoffMs, recoveryBackoffMs } from "./enqueue";
import { nextQuarterHour } from "./executor";
import { parkedLabel, phaseLabel, readRunProgress } from "./progress";

/** Pure parts of the run queue (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §7.3, §7.5, §7.10, §8.1, §7.11). */

const MINUTE = 60_000;

describe("run priorities (§7.3)", () => {
  it("interactive first, then clock, recovery and scheduled runs", () => {
    expect(defaultRunPriority("STRUCTURE", "INITIAL")).toBe(RUN_PRIORITY.INTERACTIVE);
    expect(defaultRunPriority("SYNC", "MANUAL")).toBe(0);
    expect(defaultRunPriority("CLOCK", "SCHEDULED")).toBe(1);
    expect(defaultRunPriority("SYNC", "RECOVERY")).toBe(2);
    expect(defaultRunPriority("SYNC", "SCHEDULED")).toBe(3);
  });
});

describe("the runner's pool guard (§7.5)", () => {
  it("reads connection_limit and keeps two connections free, never below one slice", () => {
    expect(prismaPoolSize("postgresql://u:p@h/db?connection_limit=5")).toBe(5);
    expect(runnerConcurrency("postgresql://u:p@h/db?connection_limit=10")).toBe(2);
    expect(runnerConcurrency("postgresql://u:p@h/db?connection_limit=3")).toBe(1);
    expect(runnerConcurrency("postgresql://u:p@h/db?connection_limit=1")).toBe(1);
    expect(prismaPoolSize("postgresql://u:p@h/db")).toBeGreaterThanOrEqual(3);
    expect(prismaPoolSize("not a url")).toBeGreaterThanOrEqual(3);
  });
});

describe("backoffs (§7.9, §7.10)", () => {
  it("recovery after 1, 2, 5 and 10 minutes, none from five failures", () => {
    expect([1, 2, 3, 4].map(recoveryBackoffMs)).toEqual([
      MINUTE,
      2 * MINUTE,
      5 * MINUTE,
      10 * MINUTE,
    ]);
    expect(recoveryBackoffMs(5)).toBeNull();
    expect(recoveryBackoffMs(0)).toBeNull();
  });

  it("auth probes after 5 minutes, 15 minutes, then hourly", () => {
    expect([0, 1, 2, 9].map(probeBackoffMs)).toEqual([
      5 * MINUTE,
      15 * MINUTE,
      60 * MINUTE,
      60 * MINUTE,
    ]);
  });
});

describe("the pending slot (§7.3)", () => {
  const slot = (kind: "SYNC" | "CLOCK" | "DIRECTORY" | "STRUCTURE", retryAuth = false) =>
    ({
      kind,
      trigger: kind === "CLOCK" ? "SCHEDULED" : "MANUAL",
      retryAuth,
      requestedByUserId: null,
    }) as const;

  it("keeps one request: SYNC over CLOCK and wizard kinds, newer wizard kinds over older ones", () => {
    expect(mergePendingSlot(null, slot("CLOCK")).kind).toBe("CLOCK");
    expect(mergePendingSlot(slot("CLOCK"), slot("SYNC")).kind).toBe("SYNC");
    expect(mergePendingSlot(slot("SYNC"), slot("CLOCK")).kind).toBe("SYNC");
    expect(mergePendingSlot(slot("STRUCTURE"), slot("DIRECTORY")).kind).toBe("DIRECTORY");
    expect(mergePendingSlot(slot("SYNC"), slot("DIRECTORY")).kind).toBe("SYNC");
    expect(mergePendingSlot(slot("SYNC", true), slot("SYNC")).retryAuth).toBe(true);
    expect(mergePendingSlot(slot("CLOCK"), slot("SYNC", true)).retryAuth).toBe(true);
  });
});

describe("connection statuses (§2.2, §8.1)", () => {
  it("maps fine statuses to the coarse ones", () => {
    expect(coarseStatus("CONNECTING")).toBe("NOT_CONNECTED");
    expect(coarseStatus("SYNCING")).toBe("CONNECTED");
    expect(coarseStatus("DEGRADED")).toBe("CONNECTED");
    expect(coarseStatus("AUTH_ERROR")).toBe("ERROR");
    expect(coarseStatus("DISCONNECTED")).toBe("DISCONNECTED");
  });

  it("publishes health hints only for banner transitions", () => {
    expect(isHealthTransition("CONNECTED", "SYNCING")).toBe(false);
    expect(isHealthTransition("SYNCING", "CONNECTED")).toBe(false);
    expect(isHealthTransition("SYNCING", "AUTH_ERROR")).toBe(true);
    expect(isHealthTransition("DEGRADED", "CONNECTED")).toBe(true);
    expect(isHealthTransition("CONNECTED", "DISCONNECTED")).toBe(true);
    expect(isHealthTransition("AUTH_ERROR", "AUTH_ERROR")).toBe(false);
  });
});

describe("progress labels (§7.11)", () => {
  it("names the phase and its page; parks say when they resume", () => {
    expect(phaseLabel("EMPLOYEES", 3)).toBe("Reading employees (page 3)");
    expect(phaseLabel("EMPLOYEES", 1)).toBe("Reading employees");
    expect(phaseLabel("START")).toBe("Waiting to start");
    expect(parkedLabel("RATE_LIMITED", new Date("2026-10-21T09:42:00Z"), "Europe/London")).toBe(
      "Waiting for Planday's rate limit — resumes at 10:42",
    );
    expect(readRunProgress({})).toEqual({
      completedPhases: 0,
      totalPhases: 0,
      label: "",
      pagesRead: 0,
    });
  });

  it("next quarter hour", () => {
    expect(nextQuarterHour(new Date("2026-10-21T10:31:10Z")).toISOString()).toBe(
      "2026-10-21T10:45:00.000Z",
    );
    expect(nextQuarterHour(new Date("2026-10-21T10:45:00Z")).toISOString()).toBe(
      "2026-10-21T11:00:00.000Z",
    );
  });
});
