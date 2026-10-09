import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExternalShift } from "@clockoff/shared/providers/syncSink";
import { EXCLUDED_STATUSES, KNOWN_PUBLISHED_STATUSES } from "../planday/constants";
import { hashDecisionInputs, type RecordHasher } from "./hash";
import {
  ABSENT_SHIFT_RECHECK_LIMIT,
  classifyPlandayShift,
  decideShiftAction,
  incomingShift,
  removalIncoming,
  selectAbsentShiftRechecks,
  shiftDecisionInputs,
  shiftDecisionWritesShift,
  shiftTimeState,
  type ClassifiableShift,
  type ExistingShift,
  type IncomingShift,
  type ShiftDecision,
  type ShiftTarget,
} from "./shiftDecisions";

/** docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.6: the filter and every row of the decision table. */

const NOW = new Date("2026-10-21T10:30:00Z");
const at = (iso: string) => new Date(iso);
const WINDOW = { from: at("2026-10-19T23:00:00Z"), to: at("2026-11-18T00:00:00Z") };
const TARGET: ShiftTarget = { employeeId: "emp-a", locationId: "loc-bar" };

const hmac: RecordHasher = (canonical) => createHmac("sha256", "k").update(canonical).digest("hex");

function shift(partial: Partial<ClassifiableShift> = {}): ClassifiableShift {
  return {
    status: "Assigned",
    externalEmployeeId: "1001",
    externalDepartmentId: "101",
    times: { ok: true, localStartDate: "2026-10-22" },
    ...partial,
  };
}

function published(
  startsAt: string,
  endsAt: string,
  extra: Partial<Extract<IncomingShift, { kind: "PUBLISHED" }>> = {},
): IncomingShift {
  return {
    kind: "PUBLISHED",
    externalEmployeeId: "1001",
    externalDepartmentId: "101",
    startsAt: at(startsAt),
    endsAt: at(endsAt),
    timezone: "Europe/London",
    inWindow: true,
    afterWindow: false,
    ...extra,
  };
}

function existing(partial: Partial<ExistingShift> = {}): ExistingShift {
  return {
    id: "shift-1",
    status: "SCHEDULED",
    startsAt: at("2026-10-22T09:00:00Z"),
    endsAt: at("2026-10-22T17:00:00Z"),
    employeeId: "emp-a",
    locationId: "loc-bar",
    lastHash: "old-hash",
    upstreamRemovedAt: null,
    ...partial,
  };
}

/** In progress at NOW (09:00–17:00 UTC on 21 Oct). */
const IN_PROGRESS = existing({
  startsAt: at("2026-10-21T09:00:00Z"),
  endsAt: at("2026-10-21T17:00:00Z"),
});

function decide(
  ex: ExistingShift | null,
  incoming: IncomingShift,
  target: ShiftTarget | null = TARGET,
  hash = "new-hash",
): ShiftDecision {
  return decideShiftAction({ existing: ex, incoming, target, now: NOW, hash });
}

describe("classifyPlandayShift (§6.6 filter)", () => {
  it("classifies every documented status with an employee as PUBLISHED, Open included", () => {
    for (const status of KNOWN_PUBLISHED_STATUSES) {
      expect(classifyPlandayShift(shift({ status })), status).toBe("PUBLISHED");
    }
    expect(classifyPlandayShift(shift({ status: "Open", externalEmployeeId: "1001" }))).toBe(
      "PUBLISHED",
    );
  });

  it("never imports a Draft, whoever it is assigned to", () => {
    for (const status of EXCLUDED_STATUSES) {
      expect(classifyPlandayShift(shift({ status }))).toBe("DRAFT");
      expect(classifyPlandayShift(shift({ status, externalEmployeeId: null }))).toBe("DRAFT");
    }
  });

  it("ignores a shift without an employee whatever its status (Open included)", () => {
    expect(classifyPlandayShift(shift({ status: "Open", externalEmployeeId: null }))).toBe(
      "UNASSIGNED",
    );
    expect(classifyPlandayShift(shift({ status: "Assigned", externalEmployeeId: null }))).toBe(
      "UNASSIGNED",
    );
    expect(classifyPlandayShift(shift({ status: "Whatever", externalEmployeeId: null }))).toBe(
      "UNASSIGNED",
    );
  });

  it("puts a shift of an excluded department, or of no department unless 'none' is included, out of scope", () => {
    const scope = { includedDepartmentIds: ["101"] };
    expect(classifyPlandayShift(shift({ externalDepartmentId: "103" }), scope)).toBe(
      "OUT_OF_SCOPE",
    );
    expect(classifyPlandayShift(shift({ externalDepartmentId: null }), scope)).toBe("OUT_OF_SCOPE");
    expect(
      classifyPlandayShift(shift({ externalDepartmentId: null }), {
        includedDepartmentIds: ["none"],
      }),
    ).toBe("PUBLISHED");
    expect(classifyPlandayShift(shift(), scope)).toBe("PUBLISHED");
    // Without a scope the department is not checked (the provider before it knows the mapping).
    expect(classifyPlandayShift(shift({ externalDepartmentId: "103" }))).toBe("PUBLISHED");
  });

  it("puts a shift of an unmapped employee out of scope", () => {
    const scope = { isEmployeeMapped: (id: string) => id === "1001" };
    expect(classifyPlandayShift(shift(), scope)).toBe("PUBLISHED");
    expect(classifyPlandayShift(shift({ externalEmployeeId: "1010" }), scope)).toBe("OUT_OF_SCOPE");
  });

  it("flags hidden days only when the filter is on", () => {
    const isHiddenDay = (dept: string, date: string) => dept === "101" && date === "2026-10-22";
    expect(classifyPlandayShift(shift(), { isHiddenDay })).toBe("HIDDEN_DAY");
    expect(
      classifyPlandayShift(shift({ times: { ok: true, localStartDate: "2026-10-23" } }), {
        isHiddenDay,
      }),
    ).toBe("PUBLISHED");
    expect(classifyPlandayShift(shift())).toBe("PUBLISHED");
    // A shift outside every department has no schedule day.
    expect(
      classifyPlandayShift(shift({ externalDepartmentId: null }), { isHiddenDay: () => true }),
    ).toBe("PUBLISHED");
  });

  it("skips an undocumented status and unreadable times", () => {
    expect(classifyPlandayShift(shift({ status: "Archived" }))).toBe("UNKNOWN_STATUS");
    expect(classifyPlandayShift(shift({ status: "assigned" }))).toBe("UNKNOWN_STATUS");
    expect(classifyPlandayShift(shift({ times: { ok: false } }))).toBe("INVALID_TIME");
    // Order: an unknown status wins over unreadable times; scope wins over both.
    expect(classifyPlandayShift(shift({ status: "Archived", times: { ok: false } }))).toBe(
      "UNKNOWN_STATUS",
    );
    expect(
      classifyPlandayShift(shift({ status: "Archived", externalDepartmentId: "103" }), {
        includedDepartmentIds: ["101"],
      }),
    ).toBe("OUT_OF_SCOPE");
  });
});

describe("incomingShift (the sink's view of a SHIFTS record)", () => {
  const record: ExternalShift = {
    externalId: "5001",
    externalEmployeeId: "1001",
    externalLocationId: "101",
    startsAt: at("2026-10-22T09:00:00Z"),
    endsAt: at("2026-10-22T17:00:00Z"),
    timezone: "Europe/London",
    cancelled: false,
  };

  it("passes a published record with its window membership", () => {
    const { shiftClass, incoming } = incomingShift(record, {}, WINDOW);
    expect(shiftClass).toBe("PUBLISHED");
    expect(incoming).toMatchObject({ kind: "PUBLISHED", inWindow: true, afterWindow: false });
    const later = incomingShift(
      { ...record, startsAt: at("2026-11-19T09:00:00Z"), endsAt: at("2026-11-19T17:00:00Z") },
      {},
      WINDOW,
    );
    expect(later.incoming).toMatchObject({ kind: "PUBLISHED", inWindow: false, afterWindow: true });
  });

  it("turns the provider's cancelled records into removals", () => {
    expect(
      incomingShift(
        { ...record, cancelled: true, removalReason: "DRAFT", externalEmployeeId: null },
        {},
        WINDOW,
      ),
    ).toEqual({ shiftClass: "DRAFT", incoming: { kind: "REMOVED", reason: "DRAFT" } });
    expect(incomingShift({ ...record, externalEmployeeId: null }, {}, WINDOW).incoming).toEqual({
      kind: "REMOVED",
      reason: "UNASSIGNED",
    });
  });

  it("adds the employee mapping and hidden days", () => {
    expect(incomingShift(record, { isEmployeeMapped: () => false }, WINDOW)).toEqual({
      shiftClass: "OUT_OF_SCOPE",
      incoming: { kind: "REMOVED", reason: "OUT_OF_SCOPE" },
    });
    // 09:00Z on 22 Oct is 10:00 BST on 22 Oct: the local start date is looked up.
    const hidden = incomingShift(
      record,
      { isHiddenDay: (dept, date) => dept === "101" && date === "2026-10-22" },
      WINDOW,
    );
    expect(hidden.incoming).toEqual({ kind: "REMOVED", reason: "HIDDEN_DAY" });
  });
});

describe("decideShiftAction (§6.6 table)", () => {
  it("row 1: a new published shift ending in the future is created with its full target", () => {
    const d = decide(null, published("2026-10-22T09:00:00Z", "2026-10-22T17:00:00Z"));
    expect(d).toMatchObject({
      row: "1",
      action: "CREATE",
      writeHash: true,
      create: {
        startsAt: at("2026-10-22T09:00:00Z"),
        endsAt: at("2026-10-22T17:00:00Z"),
        timezone: "Europe/London",
        employeeId: "emp-a",
        locationId: "loc-bar",
      },
    });
    // A shift in progress at the first sync is created too.
    expect(decide(null, published("2026-10-21T09:00:00Z", "2026-10-21T17:00:00Z")).row).toBe("1");
  });

  it("row 2: history before connecting is not imported", () => {
    expect(decide(null, published("2026-10-20T09:00:00Z", "2026-10-20T17:00:00Z"))).toMatchObject({
      row: "2",
      action: "SKIP",
      reason: "ENDED_BEFORE_IMPORT",
      writeHash: false,
    });
  });

  it("row 3: nothing is created from a removal, an uncertain record or a shift outside the window", () => {
    for (const incoming of [
      removalIncoming("DELETED"),
      removalIncoming("DRAFT"),
      removalIncoming("UNASSIGNED"),
      removalIncoming("OUT_OF_SCOPE"),
      { kind: "UNCERTAIN", reason: "UNKNOWN_STATUS" } as const,
    ]) {
      expect(decide(null, incoming)).toMatchObject({ row: "3", action: "SKIP" });
    }
    expect(
      decide(null, published("2026-11-19T09:00:00Z", "2026-11-19T17:00:00Z", { inWindow: false })),
    ).toMatchObject({ row: "3", action: "SKIP", reason: "OUT_OF_WINDOW" });
  });

  it("row 4: equal hash and nothing to change → UNCHANGED, no hash write", () => {
    const d = decide(
      existing(),
      published("2026-10-22T09:00:00Z", "2026-10-22T17:00:00Z"),
      TARGET,
      "old-hash",
    );
    expect(d).toMatchObject({ row: "4", action: "UNCHANGED", writeHash: false });
    expect(shiftDecisionWritesShift(d)).toBe(false);
  });

  it("row 4a: a new hash with nothing visible to change → REHASH_ONLY (no version bump)", () => {
    const d = decide(existing(), published("2026-10-22T09:00:00Z", "2026-10-22T17:00:00Z"));
    expect(d).toMatchObject({ row: "4a", action: "REHASH_ONLY", writeHash: true });
    expect(shiftDecisionWritesShift(d)).toBe(false);
  });

  it("a hash match never hides a drifted shift (§6.2 step 3)", () => {
    const drifted = existing({ endsAt: at("2026-10-22T18:00:00Z") });
    expect(
      decide(
        drifted,
        published("2026-10-22T09:00:00Z", "2026-10-22T17:00:00Z"),
        TARGET,
        "old-hash",
      ),
    ).toMatchObject({ row: "6", action: "UPDATE", patch: { endsAt: at("2026-10-22T17:00:00Z") } });
  });

  it("row 5: ended, completed or cancelled-and-ended shifts are never modified", () => {
    const ended = existing({
      startsAt: at("2026-10-20T09:00:00Z"),
      endsAt: at("2026-10-20T17:00:00Z"),
    });
    const completed = existing({ status: "COMPLETED" });
    const cancelledEnded = existing({
      status: "CANCELLED",
      upstreamRemovedAt: at("2026-10-19T00:00:00Z"),
      startsAt: at("2026-10-20T09:00:00Z"),
      endsAt: at("2026-10-20T17:00:00Z"),
    });
    for (const ex of [ended, completed, cancelledEnded]) {
      for (const incoming of [
        published("2026-10-20T09:00:00Z", "2026-10-20T19:00:00Z"),
        removalIncoming("DELETED"),
      ]) {
        expect(decide(ex, incoming)).toMatchObject({
          row: "5",
          action: "UNCHANGED",
          writeHash: false,
        });
      }
    }
    for (const ex of [ended, completed]) {
      expect(decide(ex, published("2026-10-22T09:00:00Z", "2026-10-22T19:00:00Z"))).toMatchObject({
        row: "5",
        action: "UNCHANGED",
        writeHash: false,
      });
    }
    // Cancelled by someone else (no upstreamRemovedAt) and ended: never comes back.
    expect(
      decide(
        { ...cancelledEnded, upstreamRemovedAt: null },
        published("2026-10-22T09:00:00Z", "2026-10-22T19:00:00Z"),
      ),
    ).toMatchObject({ row: "5", action: "UNCHANGED" });
  });

  it("row 15 after the cancelled shift's own times passed: Planday's shift is created afresh (RECREATE)", () => {
    // Moved beyond the window (row 16) or drafted (row 8) while its ClockOff copy kept the old times, which have
    // passed since; Planday now publishes it again inside the window.
    const cancelledEnded = existing({
      status: "CANCELLED",
      upstreamRemovedAt: at("2026-10-12T00:00:00Z"),
      startsAt: at("2026-10-13T09:00:00Z"),
      endsAt: at("2026-10-13T17:00:00Z"),
    });
    const d = decide(
      cancelledEnded,
      published("2026-10-25T09:00:00Z", "2026-10-25T17:00:00Z"),
      { employeeId: "emp-c", locationId: "loc-kitchen" },
      "old-hash",
    );
    expect(d).toMatchObject({
      row: "15",
      action: "RECREATE",
      existingState: "ENDED",
      previousEmployeeId: "emp-a",
      upstreamRemoved: "CLEAR",
      writeHash: true,
      create: {
        employeeId: "emp-c",
        locationId: "loc-kitchen",
        startsAt: at("2026-10-25T09:00:00Z"),
        endsAt: at("2026-10-25T17:00:00Z"),
        timezone: "Europe/London",
      },
    });
    expect(shiftDecisionWritesShift(d)).toBe(true);
    // Still beyond the window, or already over: nothing.
    expect(
      decide(
        cancelledEnded,
        published("2026-12-01T09:00:00Z", "2026-12-01T17:00:00Z", {
          inWindow: false,
          afterWindow: true,
        }),
      ),
    ).toMatchObject({ row: "5", action: "UNCHANGED" });
    expect(
      decide(cancelledEnded, published("2026-10-20T09:00:00Z", "2026-10-20T17:00:00Z")),
    ).toMatchObject({ row: "5", action: "UNCHANGED" });
    expect(decide(cancelledEnded, removalIncoming("DELETED"))).toMatchObject({
      row: "5",
      action: "UNCHANGED",
    });
  });

  it("row 6: a future shift's new times or location are updated", () => {
    const d = decide(existing(), published("2026-10-22T10:00:00Z", "2026-10-22T18:00:00Z"), {
      employeeId: "emp-a",
      locationId: "loc-kitchen",
    });
    expect(d).toMatchObject({
      row: "6",
      action: "UPDATE",
      writeHash: true,
      patch: {
        startsAt: at("2026-10-22T10:00:00Z"),
        endsAt: at("2026-10-22T18:00:00Z"),
        locationId: "loc-kitchen",
      },
    });
    const onlyEnd = decide(existing(), published("2026-10-22T09:00:00Z", "2026-10-22T18:00:00Z"));
    expect(onlyEnd).toMatchObject({ row: "6", patch: { endsAt: at("2026-10-22T18:00:00Z") } });
    expect("startsAt" in (onlyEnd as { patch: object }).patch).toBe(false);
  });

  it("row 7: a future shift moved to another mapped employee is reassigned in place", () => {
    const d = decide(existing(), published("2026-10-22T09:00:00Z", "2026-10-22T17:00:00Z"), {
      employeeId: "emp-c",
      locationId: "loc-bar",
    });
    expect(d).toMatchObject({
      row: "7",
      action: "REASSIGN",
      previousEmployeeId: "emp-a",
      patch: { employeeId: "emp-c" },
    });
  });

  it("row 8: a future shift is cancelled on any removal, hidden day included, never deleted", () => {
    for (const reason of [
      "DELETED",
      "NOT_FOUND",
      "DRAFT",
      "UNASSIGNED",
      "OUT_OF_SCOPE",
      "HIDDEN_DAY",
    ] as const) {
      expect(decide(existing(), removalIncoming(reason))).toMatchObject({
        row: "8",
        action: "CANCEL",
        reason,
        inProgress: false,
        writeHash: true,
        upstreamRemoved: "SET",
      });
    }
  });

  it("row 9: an in-progress shift extended gets the new end", () => {
    const d = decide(IN_PROGRESS, published("2026-10-21T09:00:00Z", "2026-10-21T19:00:00Z"));
    expect(d).toMatchObject({
      row: "9",
      action: "UPDATE_END",
      shortened: false,
      existingState: "IN_PROGRESS",
      patch: { endsAt: at("2026-10-21T19:00:00Z") },
    });
  });

  it("row 10: an in-progress shift shortened (end still after now)", () => {
    expect(
      decide(IN_PROGRESS, published("2026-10-21T09:00:00Z", "2026-10-21T12:00:00Z")),
    ).toMatchObject({
      row: "10",
      action: "UPDATE_END",
      shortened: true,
      patch: { endsAt: at("2026-10-21T12:00:00Z") },
    });
  });

  it("row 11: an in-progress shift whose new end has passed ends now, rounded up to the minute", () => {
    const now = at("2026-10-21T10:30:20Z");
    const d = decideShiftAction({
      existing: IN_PROGRESS,
      incoming: published("2026-10-21T09:00:00Z", "2026-10-21T10:00:00Z"),
      target: TARGET,
      now,
      hash: "new-hash",
    });
    expect(d).toMatchObject({ row: "11", action: "END_NOW", endsAt: at("2026-10-21T10:31:00Z") });
    // Never before the start plus a minute, even when the shift started this very minute.
    const justStarted = existing({ startsAt: now, endsAt: at("2026-10-21T17:00:00Z") });
    const e = decideShiftAction({
      existing: justStarted,
      incoming: published("2026-10-21T10:30:20Z", "2026-10-21T10:30:20Z"),
      target: TARGET,
      now: at("2026-10-21T10:30:20Z"),
    });
    expect(e).toMatchObject({ action: "END_NOW" });
    expect((e as { endsAt: Date }).endsAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("row 12: an in-progress start change is ignored with a warning; the end still follows", () => {
    const startOnly = decide(
      IN_PROGRESS,
      published("2026-10-21T08:00:00Z", "2026-10-21T17:00:00Z"),
    );
    expect(startOnly).toMatchObject({
      row: "12",
      action: "REHASH_ONLY",
      warning: "IN_PROGRESS_START_IGNORED",
    });
    const withEnd = decide(IN_PROGRESS, published("2026-10-21T08:00:00Z", "2026-10-21T18:00:00Z"));
    expect(withEnd).toMatchObject({
      row: "9",
      action: "UPDATE_END",
      warning: "IN_PROGRESS_START_IGNORED",
    });
    expect("startsAt" in (withEnd as { patch: object }).patch).toBe(false);
  });

  it("row 13: an in-progress shift whose new start is in the future is treated as future", () => {
    expect(
      decide(IN_PROGRESS, published("2026-10-21T12:00:00Z", "2026-10-21T18:00:00Z")),
    ).toMatchObject({
      row: "13",
      action: "UPDATE",
      existingState: "IN_PROGRESS",
      patch: { startsAt: at("2026-10-21T12:00:00Z"), endsAt: at("2026-10-21T18:00:00Z") },
    });
    expect(
      decide(IN_PROGRESS, published("2026-10-21T12:00:00Z", "2026-10-21T18:00:00Z"), {
        employeeId: "emp-c",
        locationId: "loc-bar",
      }),
    ).toMatchObject({ row: "13", action: "REASSIGN" });
  });

  it("row 12, not 13, when an early clock-in moved the start (§6.8): the start is kept, the end followed", () => {
    // Clock reconciliation moved the start to the 08:30 punch; Planday's start is still 11:00 (after NOW 10:30).
    const punched = existing({
      startsAt: at("2026-10-21T10:00:00Z"),
      endsAt: at("2026-10-21T17:00:00Z"),
    });
    const plandayStart = "2026-10-21T11:00:00Z";
    const withPunch = (incoming: IncomingShift, clockedInAt: string | null, hash = "new-hash") =>
      decideShiftAction({
        existing: punched,
        incoming,
        target: TARGET,
        now: NOW,
        hash,
        clockedInAt: clockedInAt ? at(clockedInAt) : null,
      });
    // Nothing else changed: no update, no warning.
    expect(
      withPunch(
        published(plandayStart, "2026-10-21T17:00:00Z"),
        "2026-10-21T10:00:00Z",
        "old-hash",
      ),
    ).toMatchObject({ row: "4", action: "UNCHANGED", existingState: "IN_PROGRESS" });
    const unchanged = withPunch(
      published(plandayStart, "2026-10-21T17:00:00Z"),
      "2026-10-21T10:00:00Z",
    );
    expect(unchanged).toMatchObject({ action: "REHASH_ONLY" });
    expect(unchanged.warning).toBeUndefined();
    // The end still follows Planday.
    expect(
      withPunch(published(plandayStart, "2026-10-21T18:00:00Z"), "2026-10-21T10:00:00Z"),
    ).toMatchObject({
      row: "9",
      action: "UPDATE_END",
      patch: { endsAt: at("2026-10-21T18:00:00Z") },
    });
    // A punch more than 60 minutes before Planday's start, or none, is not this shift's: row 13.
    for (const punch of ["2026-10-21T09:59:00Z", null]) {
      expect(withPunch(published(plandayStart, "2026-10-21T17:00:00Z"), punch)).toMatchObject({
        row: "13",
        action: "UPDATE",
        patch: { startsAt: at(plandayStart) },
      });
    }
    // A future shift is not affected by a punch.
    expect(
      decideShiftAction({
        existing: existing(),
        incoming: published("2026-10-22T10:00:00Z", "2026-10-22T17:00:00Z"),
        target: TARGET,
        now: NOW,
        hash: "new-hash",
        clockedInAt: at("2026-10-21T10:00:00Z"),
      }),
    ).toMatchObject({ row: "6", action: "UPDATE" });
  });

  it("row 14: an in-progress shift removed is cancelled (running break ended, push)", () => {
    for (const reason of ["DELETED", "NOT_FOUND", "DRAFT", "UNASSIGNED", "OUT_OF_SCOPE"] as const) {
      expect(decide(IN_PROGRESS, removalIncoming(reason))).toMatchObject({
        row: "14",
        action: "CANCEL",
        reason,
        inProgress: true,
        upstreamRemoved: "SET",
      });
    }
  });

  it("row 14: an in-progress shift reassigned is cancelled for the old employee and created for the new one", () => {
    const d = decide(IN_PROGRESS, published("2026-10-21T09:00:00Z", "2026-10-21T17:00:00Z"), {
      employeeId: "emp-c",
      locationId: "loc-bar",
    });
    expect(d).toMatchObject({
      row: "14",
      action: "CANCEL_AND_CREATE",
      create: { employeeId: "emp-c", startsAt: at("2026-10-21T09:00:00Z") },
      writeHash: true,
    });
    // Reassigned and already over: only the cancellation.
    expect(
      decide(IN_PROGRESS, published("2026-10-21T09:00:00Z", "2026-10-21T10:00:00Z"), {
        employeeId: "emp-c",
        locationId: "loc-bar",
      }),
    ).toMatchObject({ row: "14", action: "CANCEL", reason: "REASSIGNED", inProgress: true });
  });

  it("row 14a: a day hidden after the shift started never ends it", () => {
    expect(decide(IN_PROGRESS, removalIncoming("HIDDEN_DAY"))).toMatchObject({
      row: "14a",
      action: "UNCHANGED",
      warning: "HIDDEN_DAY_IN_PROGRESS",
      writeHash: false,
    });
  });

  it("row 15: a shift the integration cancelled is reinstated with Planday's full target", () => {
    const cancelled = existing({
      status: "CANCELLED",
      upstreamRemovedAt: at("2026-10-20T12:00:00Z"),
    });
    // Same hash as when it was cancelled: still never short-circuited.
    const d = decide(
      cancelled,
      published("2026-10-22T09:00:00Z", "2026-10-22T17:00:00Z"),
      TARGET,
      "old-hash",
    );
    expect(d).toMatchObject({
      row: "15",
      action: "REINSTATE",
      upstreamRemoved: "CLEAR",
      writeHash: true,
      previousEmployeeId: "emp-a",
      target: { employeeId: "emp-a", locationId: "loc-bar" },
    });
    // With a new employee (A → unmapped Y → mapped C): the shift belongs to C.
    const toC = decide(cancelled, published("2026-10-22T10:00:00Z", "2026-10-22T18:00:00Z"), {
      employeeId: "emp-c",
      locationId: "loc-kitchen",
    });
    expect(toC).toMatchObject({
      row: "15",
      action: "REINSTATE",
      previousEmployeeId: "emp-a",
      target: {
        employeeId: "emp-c",
        locationId: "loc-kitchen",
        startsAt: at("2026-10-22T10:00:00Z"),
        endsAt: at("2026-10-22T18:00:00Z"),
      },
    });
  });

  it("row 15: a shift cancelled by anyone else, or published again after the window, stays cancelled", () => {
    const manual = existing({ status: "CANCELLED", upstreamRemovedAt: null });
    expect(
      decide(manual, published("2026-10-22T09:00:00Z", "2026-10-22T17:00:00Z")).action,
    ).not.toBe("REINSTATE");
    const cancelled = existing({
      status: "CANCELLED",
      upstreamRemovedAt: at("2026-10-20T12:00:00Z"),
    });
    expect(
      decide(
        cancelled,
        published("2026-11-19T09:00:00Z", "2026-11-19T17:00:00Z", {
          inWindow: false,
          afterWindow: true,
        }),
      ).action,
    ).not.toBe("REINSTATE");
    // Still removed: nothing visible changes.
    expect(decide(cancelled, removalIncoming("DELETED"))).toMatchObject({ action: "REHASH_ONLY" });
    expect(decide(cancelled, removalIncoming("DELETED"), null, "old-hash")).toMatchObject({
      action: "UNCHANGED",
    });
  });

  it("row 16: a future shift past the window's end is cancelled, and reinstated when it comes back", () => {
    expect(decide(existing(), removalIncoming("OUT_OF_WINDOW"))).toMatchObject({
      row: "16",
      action: "CANCEL",
      reason: "OUT_OF_WINDOW",
      upstreamRemoved: "SET",
    });
    expect(
      decide(
        existing(),
        published("2026-11-19T09:00:00Z", "2026-11-19T17:00:00Z", {
          inWindow: false,
          afterWindow: true,
        }),
      ),
    ).toMatchObject({ row: "16", action: "CANCEL", reason: "OUT_OF_WINDOW" });
    // An in-progress shift overlaps the window: never cancelled for it.
    expect(decide(IN_PROGRESS, removalIncoming("OUT_OF_WINDOW"))).toMatchObject({
      action: "UNCHANGED",
    });
  });

  it("row 17: an unknown status or unreadable times never change a non-ended shift", () => {
    for (const ex of [
      existing(),
      IN_PROGRESS,
      existing({ status: "CANCELLED", upstreamRemovedAt: NOW }),
    ]) {
      for (const reason of ["UNKNOWN_STATUS", "INVALID_TIME"] as const) {
        expect(decide(ex, { kind: "UNCERTAIN", reason })).toMatchObject({
          row: "17",
          action: "UNCHANGED",
          warning: reason,
          writeHash: false,
        });
      }
    }
  });

  it("refuses a PUBLISHED incoming without its target", () => {
    expect(() =>
      decide(null, published("2026-10-22T09:00:00Z", "2026-10-22T17:00:00Z"), null),
    ).toThrow(TypeError);
  });

  it("shiftTimeState", () => {
    expect(shiftTimeState(existing(), NOW)).toBe("FUTURE");
    expect(shiftTimeState(IN_PROGRESS, NOW)).toBe("IN_PROGRESS");
    expect(shiftTimeState(existing({ status: "COMPLETED" }), NOW)).toBe("ENDED");
    expect(shiftTimeState(existing({ endsAt: NOW }), NOW)).toBe("ENDED");
  });
});

describe("shiftDecisionInputs (§6.2)", () => {
  const record: ExternalShift = {
    externalId: "5001",
    externalEmployeeId: "1001",
    externalLocationId: "101",
    startsAt: at("2026-10-22T09:00:00Z"),
    endsAt: at("2026-10-22T17:00:00Z"),
    timezone: "Europe/London",
    cancelled: false,
    timeWarning: null,
  };
  const incoming = published("2026-10-22T09:00:00Z", "2026-10-22T17:00:00Z");
  const hash = (
    target: ShiftTarget | null,
    over: Partial<Parameters<typeof shiftDecisionInputs>[0]> = {},
  ) =>
    hashDecisionInputs(
      hmac,
      shiftDecisionInputs({ record, incoming, target, respectHiddenDays: false, ...over }),
    );

  it("changes when a resolved target changes", () => {
    const base = hash(TARGET);
    expect(hash({ ...TARGET })).toBe(base);
    expect(hash({ ...TARGET, locationId: "loc-kitchen" })).not.toBe(base);
    expect(hash({ ...TARGET, employeeId: "emp-c" })).not.toBe(base);
    expect(hash(TARGET, { incoming: { ...incoming, inWindow: false } as IncomingShift })).not.toBe(
      base,
    );
    expect(hash(TARGET, { incoming: removalIncoming("DRAFT") })).not.toBe(base);
  });

  it("does not change for a settings change that keeps every target, nor for a DST note", () => {
    const base = hash(TARGET);
    expect(
      hash(TARGET, {
        record: { ...record, timeWarning: "START_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE" },
      }),
    ).toBe(base);
    // The hidden-day flag only takes part while the filter is on.
    expect(hash(TARGET, { respectHiddenDays: true })).not.toBe(base);
    expect(hash(TARGET, { respectHiddenDays: true })).toBe(
      hash(TARGET, { respectHiddenDays: true }),
    );
  });
});

describe("selectAbsentShiftRechecks", () => {
  const runStartedAt = at("2026-10-21T10:00:00Z");
  const row = (
    externalId: string,
    partial: Partial<{
      status: "SCHEDULED" | "CANCELLED";
      startsAt: Date;
      endsAt: Date;
      lastSeenAt: Date;
    }> = {},
  ) => ({
    externalId,
    status: "SCHEDULED" as const,
    startsAt: at("2026-10-22T09:00:00Z"),
    endsAt: at("2026-10-22T17:00:00Z"),
    lastSeenAt: at("2026-10-21T09:45:00Z"),
    ...partial,
  });

  it("re-checks unseen, non-ended, scheduled shifts inside the window only, at most 50", () => {
    const ids = selectAbsentShiftRechecks({
      mapped: [
        row("seen", { lastSeenAt: at("2026-10-21T10:05:00Z") }),
        row("unseen"),
        row("ended", { startsAt: at("2026-10-20T09:00:00Z"), endsAt: at("2026-10-20T17:00:00Z") }),
        row("cancelled", { status: "CANCELLED" }),
        row("outside", {
          startsAt: at("2026-12-01T09:00:00Z"),
          endsAt: at("2026-12-01T17:00:00Z"),
        }),
      ],
      runStartedAt,
      window: WINDOW,
      now: NOW,
    });
    expect(ids).toEqual(["unseen"]);
    const many = Array.from({ length: 60 }, (_, i) => row(`id-${i}`));
    expect(
      selectAbsentShiftRechecks({ mapped: many, runStartedAt, window: WINDOW, now: NOW }),
    ).toHaveLength(ABSENT_SHIFT_RECHECK_LIMIT);
  });
});
