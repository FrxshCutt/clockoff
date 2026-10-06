import { describe, expect, it } from "vitest";
import { API_ERROR_CODES, AppError, ERROR_HTTP_STATUS } from "../errors";
import { RESTRICTION_CATEGORIES } from "../enums";
import type { BreakRestrictionBehaviour } from "../enums";
import { DEVICE_STATUS_THRESHOLDS } from "../status/deriveDeviceStatus";
import { computeExpectedState } from "../workMode/computeExpectedState";
import {
  BREAK_INPUT_FIELDS,
  BREAK_REFUSAL_CODES,
  CLOCK_SKEW_ATTENTION_THRESHOLD_SECONDS,
  DEVICE_ACTIVITY_MIN_RELIABLE_INTERVAL_MINUTES,
  breakPolicyFromRecord,
  breakRefusalToAppError,
  breakRestrictionForSession,
  breakStartInstant,
  canStartBreak,
  clampBreak,
  clockSkewNeedsAttention,
  computeBreakAllowance,
  computeClockSkewSeconds,
  deviceInstantToServerTime,
  expiredBreakSessionClosures,
  isBelowDeviceActivityInterval,
  isCategoryRelaxedDuringBreak,
  parseRelaxedCategories,
  resolveBreakBehaviour,
  throwIfCannotStartBreak,
} from "./breakRules";
import type {
  BreakPolicyLike,
  BreakRefusal,
  BreakSessionLike,
  BreakTrigger,
  CanStartBreakInput,
  CanStartBreakResult,
  ShiftWindowLike,
} from "./breakRules";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures. The shift runs 09:00–15:00 UTC on 2026-10-05 (6 h). `T("hh:mm[:ss]")` is that day in UTC.
// ─────────────────────────────────────────────────────────────────────────────

function T(hms: string, day = "2026-10-05"): Date {
  const [h, m, s = "00"] = hms.split(":");
  return new Date(`${day}T${h}:${m}:${s}.000Z`);
}
function plusMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}
const MIN = 60_000;

const SHIFT: ShiftWindowLike = { id: "shift-1", startsAt: T("09:00"), endsAt: T("15:00") };

const DEFAULT_POLICY: BreakPolicyLike = {
  breaksEnabled: true,
  maxBreaksPerShift: 2,
  maxBreakDurationMinutes: 15,
  maxTotalBreakMinutes: 30,
  minGapBetweenBreaksMinutes: 60,
  minMinutesAfterShiftStart: 60,
  employeeTriggeredAllowed: true,
  scheduledBreaksAllowed: true,
  restrictionBehaviour: "RELAX_ALL",
  relaxedCategories: [],
};

function policy(overrides: Partial<BreakPolicyLike> = {}): BreakPolicyLike {
  return { ...DEFAULT_POLICY, ...overrides };
}

let seq = 0;
function ended(
  startedAt: Date,
  minutes: number,
  overrides: Partial<BreakSessionLike> = {},
): BreakSessionLike {
  const plannedEndsAt = plusMs(startedAt, minutes * MIN);
  return {
    id: `s-${++seq}`,
    shiftId: SHIFT.id,
    startedAt,
    plannedEndsAt,
    endedAt: plannedEndsAt,
    status: "ENDED",
    ...overrides,
  };
}
function active(
  startedAt: Date,
  minutes: number,
  overrides: Partial<BreakSessionLike> = {},
): BreakSessionLike {
  return {
    id: `s-${++seq}`,
    shiftId: SHIFT.id,
    startedAt,
    plannedEndsAt: plusMs(startedAt, minutes * MIN),
    endedAt: null,
    status: "ACTIVE",
    ...overrides,
  };
}

function attempt(
  now: Date,
  overrides: Partial<Omit<CanStartBreakInput, "now">> = {},
): CanStartBreakResult {
  return canStartBreak({
    policy: DEFAULT_POLICY,
    shift: SHIFT,
    existingSessions: [],
    trigger: "EMPLOYEE",
    now,
    ...overrides,
  });
}

function expectRefusal<C extends BreakRefusal["code"]>(
  result: CanStartBreakResult,
  code: C,
): Extract<BreakRefusal, { code: C }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.code).toBe(code);
  return result as Extract<BreakRefusal, { code: C }>;
}

function expectApproval(result: CanStartBreakResult) {
  if (!result.ok) throw new Error(`expected approval, got ${result.code}: ${result.message}`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("refusal codes", () => {
  it("are all ApiErrorCodes with an HTTP status", () => {
    for (const code of BREAK_REFUSAL_CODES) {
      expect(API_ERROR_CODES).toContain(code);
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("canStartBreak — policy gates", () => {
  it("refuses when breaks are disabled, for every trigger", () => {
    for (const trigger of ["EMPLOYEE", "SCHEDULED", "MANAGER"] as const) {
      const r = expectRefusal(
        attempt(T("12:00"), { policy: policy({ breaksEnabled: false }), trigger }),
        "BREAKS_DISABLED",
      );
      expect(r.details.reason).toBe("BREAKS_DISABLED");
    }
  });

  it("treats a zero max break duration as disabled", () => {
    const r = expectRefusal(
      attempt(T("12:00"), { policy: policy({ maxBreakDurationMinutes: 0 }) }),
      "BREAKS_DISABLED",
    );
    expect(r.details.reason).toBe("NO_BREAK_DURATION");
  });

  it("disabled wins over every other check (precedence)", () => {
    // Off shift, with an active break, limits exhausted — still BREAKS_DISABLED.
    const r = attempt(T("16:00"), {
      policy: policy({ breaksEnabled: false, maxBreaksPerShift: 0 }),
      existingSessions: [active(T("14:50"), 15)],
    });
    expectRefusal(r, "BREAKS_DISABLED");
  });

  it("employee trigger disabled but manager allowed", () => {
    const p = policy({ employeeTriggeredAllowed: false });
    const employee = expectRefusal(
      attempt(T("12:00"), { policy: p, trigger: "EMPLOYEE" }),
      "EMPLOYEE_BREAKS_NOT_ALLOWED",
    );
    expect(employee.details).toEqual({ trigger: "EMPLOYEE" });
    const manager = expectApproval(attempt(T("12:00"), { policy: p, trigger: "MANAGER" }));
    expect(manager.plannedEndsAt).toEqual(T("12:15"));
    // Scheduled breaks are independent of the employee flag.
    expectApproval(attempt(T("12:00"), { policy: p, trigger: "SCHEDULED" }));
  });

  it("scheduled trigger refused when scheduled breaks are not allowed", () => {
    const p = policy({ scheduledBreaksAllowed: false });
    const r = expectRefusal(
      attempt(T("12:00"), { policy: p, trigger: "SCHEDULED" }),
      "BREAKS_DISABLED",
    );
    expect(r.details.reason).toBe("SCHEDULED_BREAKS_NOT_ALLOWED");
    expectApproval(attempt(T("12:00"), { policy: p, trigger: "EMPLOYEE" }));
    expectApproval(attempt(T("12:00"), { policy: p, trigger: "MANAGER" }));
  });
});

describe("canStartBreak — requested duration", () => {
  it("defaults to maxBreakDurationMinutes", () => {
    const r = expectApproval(attempt(T("12:00")));
    expect(r.durationMinutes).toBe(15);
    expect(r.plannedEndsAt).toEqual(T("12:15"));
    expect(r.startsAt).toEqual(T("12:00"));
  });

  it("honours a shorter explicit request", () => {
    const r = expectApproval(attempt(T("12:00"), { requestedDurationMinutes: 5 }));
    expect(r.durationMinutes).toBe(5);
    expect(r.plannedEndsAt).toEqual(T("12:05"));
    expect(r.remaining).toEqual({ breaks: 1, minutes: 25 });
  });

  it("refuses a request above the per-break maximum (BREAK_TOO_LONG)", () => {
    const r = expectRefusal(
      attempt(T("12:00"), { requestedDurationMinutes: 16 }),
      "BREAK_TOO_LONG",
    );
    expect(r.details).toEqual({ requestedDurationMinutes: 16, maxBreakDurationMinutes: 15 });
    expectApproval(attempt(T("12:00"), { requestedDurationMinutes: 15 }));
  });

  it("BREAK_TOO_LONG is checked before shift bounds and limits (precedence)", () => {
    expectRefusal(attempt(T("16:00"), { requestedDurationMinutes: 99 }), "BREAK_TOO_LONG");
  });

  it("rejects non-integer or sub-minute requests with VALIDATION_ERROR", () => {
    for (const value of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = expectRefusal(
        attempt(T("12:00"), { requestedDurationMinutes: value }),
        "VALIDATION_ERROR",
      );
      expect(r.details.field).toBe("requestedDurationMinutes");
    }
  });

  it("null behaves like omitted", () => {
    expect(
      expectApproval(attempt(T("12:00"), { requestedDurationMinutes: null })).durationMinutes,
    ).toBe(15);
  });
});

describe("canStartBreak — shift bounds (nobody bypasses)", () => {
  it("before the shift starts", () => {
    for (const trigger of ["EMPLOYEE", "SCHEDULED", "MANAGER"] as const) {
      const r = expectRefusal(attempt(T("08:59:59"), { trigger }), "NOT_ON_SHIFT");
      expect(r.details).toEqual({
        reason: "SHIFT_NOT_STARTED",
        shiftStartsAt: SHIFT.startsAt,
        shiftEndsAt: SHIFT.endsAt,
      });
    }
  });

  it("at or after the shift end", () => {
    expect(
      expectRefusal(attempt(T("15:00"), { trigger: "MANAGER" }), "NOT_ON_SHIFT").details.reason,
    ).toBe("SHIFT_ENDED");
    expect(expectRefusal(attempt(T("17:00")), "NOT_ON_SHIFT").details.reason).toBe("SHIFT_ENDED");
  });

  it("break requested at 14:59 of a 15:00 shift gets exactly one minute", () => {
    const r = expectApproval(attempt(T("14:59")));
    expect(r.durationMinutes).toBe(1);
    expect(r.plannedEndsAt).toEqual(T("15:00"));
    expect(r.remaining).toEqual({ breaks: 1, minutes: 29 });
  });

  it("break requested at 14:59:01 is refused with SHIFT_ENDING", () => {
    const r = expectRefusal(attempt(T("14:59:01"), { trigger: "MANAGER" }), "NOT_ON_SHIFT");
    expect(r.details.reason).toBe("SHIFT_ENDING");
  });

  it("clamps plannedEndsAt to the shift end and counts the clamped span rounded up", () => {
    const r = expectApproval(attempt(T("14:50")));
    expect(r.plannedEndsAt).toEqual(T("15:00"));
    expect(r.durationMinutes).toBe(10);
    const r2 = expectApproval(attempt(T("14:58:30")));
    expect(r2.plannedEndsAt).toEqual(T("15:00"));
    expect(r2.durationMinutes).toBe(2); // 90 s → 2 whole minutes against the allowance
    expect(r2.remaining.minutes).toBe(28);
  });

  it("shift ends mid-break: the shift bound wins over the active session", () => {
    // Break 14:50–15:05 could never have been granted (clamp), but a stale row might exist.
    const r = attempt(T("15:01"), {
      existingSessions: [active(T("14:50"), 15)],
      trigger: "MANAGER",
    });
    expect(expectRefusal(r, "NOT_ON_SHIFT").details.reason).toBe("SHIFT_ENDED");
  });
});

describe("canStartBreak — active break", () => {
  it("refuses while an unexpired ACTIVE session exists, including for managers", () => {
    const s = active(T("11:00"), 15);
    const r = expectRefusal(
      attempt(T("11:05"), { existingSessions: [s], trigger: "MANAGER" }),
      "BREAK_ALREADY_ACTIVE",
    );
    expect(r.details).toEqual({
      reason: "BREAK_IN_PROGRESS",
      sessionId: s.id,
      startedAt: T("11:00"),
      plannedEndsAt: T("11:15"),
    });
  });

  it("an ACTIVE row whose plannedEndsAt has passed is not active (app closed / phone restarted / offline)", () => {
    const stale = active(T("10:00"), 15); // planned end 10:15, never closed
    const r = attempt(T("11:20"), { existingSessions: [stale] });
    const ok = expectApproval(r); // gap of 60 min since 10:15 has elapsed at 11:15
    expect(ok.durationMinutes).toBe(15); // 15 of the 30 total were used by the stale break
    expect(ok.remaining).toEqual({ breaks: 0, minutes: 0 });
  });

  it("an ACTIVE row with endedAt set is treated as ended", () => {
    const s = active(T("10:00"), 15, { endedAt: T("10:05") });
    const r = expectApproval(attempt(T("11:05"), { existingSessions: [s] }));
    expect(r.remaining.minutes).toBe(30 - 5 - 15);
  });

  it("exact boundary: an ACTIVE session stops blocking at exactly plannedEndsAt", () => {
    const p = policy({ minGapBetweenBreaksMinutes: 0, maxBreaksPerShift: 5 });
    const s = active(T("11:00"), 15);
    expectRefusal(
      attempt(plusMs(T("11:15"), -1), { policy: p, existingSessions: [s] }),
      "BREAK_ALREADY_ACTIVE",
    );
    expectApproval(attempt(T("11:15"), { policy: p, existingSessions: [s] }));
  });

  it("re-validating a past instant: a break recorded later blocks, even for managers (no overlaps)", () => {
    // Offline reconciliation: the device says it started at 11:00, but the server already has 11:05–11:20.
    const later = ended(T("11:05"), 15);
    for (const trigger of ["EMPLOYEE", "MANAGER"] as const) {
      const r = expectRefusal(
        attempt(T("11:00"), { existingSessions: [later], trigger }),
        "BREAK_ALREADY_ACTIVE",
      );
      expect(r.details).toEqual({
        reason: "LATER_BREAK_RECORDED",
        sessionId: later.id,
        startedAt: T("11:05"),
        plannedEndsAt: T("11:20"),
      });
      expect(r.message).toMatch(/later break/i);
    }
  });

  it("re-validating a past instant: a session that covered that instant is in progress, even if ended since", () => {
    const covering = ended(T("10:55"), 15); // 10:55–11:10, already closed by the time the server re-validates 11:00
    const r = expectRefusal(
      attempt(T("11:00"), { existingSessions: [covering], trigger: "MANAGER" }),
      "BREAK_ALREADY_ACTIVE",
    );
    expect(r.details.reason).toBe("BREAK_IN_PROGRESS");
  });

  it("reports the earliest blocking session when several exist", () => {
    const p = policy({ maxBreaksPerShift: 5 });
    const first = ended(T("11:05"), 5);
    const second = ended(T("11:30"), 5);
    const r = expectRefusal(
      attempt(T("11:00"), { policy: p, existingSessions: [second, first] }),
      "BREAK_ALREADY_ACTIVE",
    );
    expect(r.details.sessionId).toBe(first.id);
  });

  it("active wins over limits (precedence)", () => {
    const p = policy({ maxBreaksPerShift: 1 });
    expectRefusal(
      attempt(T("11:05"), { policy: p, existingSessions: [active(T("11:00"), 15)] }),
      "BREAK_ALREADY_ACTIVE",
    );
  });
});

describe("canStartBreak — limits", () => {
  it("limit reached by count", () => {
    const sessions = [ended(T("10:00"), 10), ended(T("12:00"), 10)];
    const r = expectRefusal(
      attempt(T("14:00"), { existingSessions: sessions }),
      "BREAK_LIMIT_REACHED",
    );
    expect(r.details).toEqual({
      reason: "MAX_BREAKS_PER_SHIFT",
      breaksTaken: 2,
      maxBreaksPerShift: 2,
      minutesUsed: 20,
      maxTotalBreakMinutes: 30,
    });
  });

  it("limit by count is enforced for managers too", () => {
    const sessions = [ended(T("10:00"), 10), ended(T("12:00"), 10)];
    expectRefusal(
      attempt(T("14:00"), { existingSessions: sessions, trigger: "MANAGER" }),
      "BREAK_LIMIT_REACHED",
    );
  });

  it("total allowance exhausted across two breaks", () => {
    const p = policy({ maxBreaksPerShift: 5 });
    const sessions = [ended(T("10:00"), 15), ended(T("12:00"), 15)];
    const r = expectRefusal(
      attempt(T("14:00"), { policy: p, existingSessions: sessions }),
      "BREAK_LIMIT_REACHED",
    );
    expect(r.details.reason).toBe("MAX_TOTAL_BREAK_MINUTES");
    expect(r.details.minutesUsed).toBe(30);
  });

  it("partial total allowance clamps the duration instead of refusing", () => {
    const p = policy({ maxBreaksPerShift: 5 });
    const sessions = [ended(T("10:00"), 15), ended(T("12:00"), 5)];
    const r = expectApproval(attempt(T("14:00"), { policy: p, existingSessions: sessions }));
    expect(r.durationMinutes).toBe(10);
    expect(r.plannedEndsAt).toEqual(T("14:10"));
    expect(r.remaining).toEqual({ breaks: 2, minutes: 0 });
  });

  it("an explicit request is also clamped by the remaining total", () => {
    const sessions = [ended(T("10:00"), 25)];
    const p = policy({ maxBreakDurationMinutes: 25 });
    const r = expectApproval(
      attempt(T("12:00"), { policy: p, existingSessions: sessions, requestedDurationMinutes: 15 }),
    );
    expect(r.durationMinutes).toBe(5);
  });

  it("sub-minute breaks count as a whole minute each (rounded up per session)", () => {
    const p = policy({
      maxBreaksPerShift: 5,
      maxTotalBreakMinutes: 2,
      minGapBetweenBreaksMinutes: 0,
    });
    // 1-minute breaks ended early, after 30 s and 20 s.
    const sessions = [
      ended(T("10:00:00"), 1, { endedAt: T("10:00:30") }),
      ended(T("10:05:00"), 1, { endedAt: T("10:05:20") }),
    ];
    const r = expectRefusal(
      attempt(T("12:00"), { policy: p, existingSessions: sessions }),
      "BREAK_LIMIT_REACHED",
    );
    expect(r.details.reason).toBe("MAX_TOTAL_BREAK_MINUTES");
    expect(r.details.minutesUsed).toBe(2);
  });

  it("limit wins over too-soon (precedence)", () => {
    const sessions = [ended(T("10:00"), 10), ended(T("12:00"), 10)];
    expectRefusal(attempt(T("12:15"), { existingSessions: sessions }), "BREAK_LIMIT_REACHED");
  });

  it("maxBreaksPerShift of 0 is a limit, not disabled", () => {
    expectRefusal(
      attempt(T("12:00"), { policy: policy({ maxBreaksPerShift: 0 }) }),
      "BREAK_LIMIT_REACHED",
    );
  });

  it("misconfigured total below per-break max clamps to the total", () => {
    const r = expectApproval(attempt(T("12:00"), { policy: policy({ maxTotalBreakMinutes: 10 }) }));
    expect(r.durationMinutes).toBe(10);
  });
});

describe("canStartBreak — timing", () => {
  it("break immediately after shift start is too soon", () => {
    const r = expectRefusal(attempt(T("09:00")), "BREAK_TOO_SOON");
    expect(r.details).toEqual({
      reason: "MIN_MINUTES_AFTER_SHIFT_START",
      eligibleAt: T("10:00"),
      waitMinutes: 60,
    });
  });

  it("exact boundary: eligible at start + minMinutesAfterShiftStart, not one millisecond before", () => {
    expectRefusal(attempt(plusMs(T("10:00"), -1)), "BREAK_TOO_SOON");
    expectApproval(attempt(T("10:00")));
  });

  it("waitMinutes rounds up", () => {
    const r = expectRefusal(attempt(T("09:59:01")), "BREAK_TOO_SOON");
    expect(r.details.waitMinutes).toBe(1);
  });

  it("second break before the gap has elapsed", () => {
    const first = ended(T("10:00"), 15); // ends 10:15 → next eligible 11:15
    const r = expectRefusal(attempt(T("11:00"), { existingSessions: [first] }), "BREAK_TOO_SOON");
    expect(r.details).toEqual({
      reason: "MIN_GAP_BETWEEN_BREAKS",
      eligibleAt: T("11:15"),
      waitMinutes: 15,
    });
  });

  it("exact boundary: gap measured from the actual end of the previous break", () => {
    const first = ended(T("10:00"), 15, { endedAt: T("10:05") }); // ended early → eligible 11:05
    expectRefusal(attempt(plusMs(T("11:05"), -1), { existingSessions: [first] }), "BREAK_TOO_SOON");
    expectApproval(attempt(T("11:05"), { existingSessions: [first] }));
  });

  it("expired-but-not-closed session: gap measured from plannedEndsAt", () => {
    const stale = active(T("10:00"), 15); // plannedEndsAt 10:15
    const r = expectRefusal(
      attempt(T("11:14:59"), { existingSessions: [stale] }),
      "BREAK_TOO_SOON",
    );
    expect(r.details.eligibleAt).toEqual(T("11:15"));
    expectApproval(attempt(T("11:15"), { existingSessions: [stale] }));
  });

  it("gap is measured from the latest session regardless of array order", () => {
    const sessions = [ended(T("12:00"), 5), ended(T("10:00"), 5)];
    const p = policy({ maxBreaksPerShift: 5 });
    const r = expectRefusal(
      attempt(T("12:30"), { policy: p, existingSessions: sessions }),
      "BREAK_TOO_SOON",
    );
    expect(r.details.eligibleAt).toEqual(T("13:05"));
  });

  it("min-after-start is reported before min-gap when both apply", () => {
    const p = policy({
      minMinutesAfterShiftStart: 120,
      minGapBetweenBreaksMinutes: 60,
      maxBreaksPerShift: 5,
    });
    const r = expectRefusal(
      attempt(T("10:30"), { policy: p, existingSessions: [ended(T("10:00"), 5)] }),
      "BREAK_TOO_SOON",
    );
    expect(r.details.reason).toBe("MIN_MINUTES_AFTER_SHIFT_START");
  });

  it("MANAGER bypasses min-after-start and min-gap", () => {
    expectApproval(attempt(T("09:00"), { trigger: "MANAGER" }));
    const r = expectApproval(
      attempt(T("10:16"), { trigger: "MANAGER", existingSessions: [ended(T("10:00"), 15)] }),
    );
    expect(r.remaining).toEqual({ breaks: 0, minutes: 0 });
  });

  it("SCHEDULED is subject to timing rules", () => {
    expectRefusal(attempt(T("09:00"), { trigger: "SCHEDULED" }), "BREAK_TOO_SOON");
  });

  it("zero gap and zero min-after-start allow back-to-back breaks", () => {
    const p = policy({ minGapBetweenBreaksMinutes: 0, minMinutesAfterShiftStart: 0 });
    const r = expectApproval(
      attempt(T("09:15"), { policy: p, existingSessions: [ended(T("09:00"), 15)] }),
    );
    expect(r.durationMinutes).toBe(15);
  });
});

describe("canStartBreak — session scoping and robustness", () => {
  it("ignores sessions from other shifts", () => {
    const other = ended(T("10:00"), 15, { shiftId: "shift-2" });
    const r = expectApproval(attempt(T("10:30"), { existingSessions: [other] }));
    expect(r.remaining).toEqual({ breaks: 1, minutes: 15 });
  });

  it("ENDED without endedAt is counted to plannedEndsAt", () => {
    const s = ended(T("10:00"), 10, { endedAt: null });
    const r = expectApproval(attempt(T("11:30"), { existingSessions: [s] }));
    expect(r.remaining.minutes).toBe(30 - 10 - 15);
  });

  it("a session whose endedAt precedes startedAt counts zero minutes but one break", () => {
    const s = ended(T("10:00"), 10, { endedAt: T("09:59") });
    const r = expectApproval(attempt(T("12:00"), { existingSessions: [s] }));
    expect(r.remaining).toEqual({ breaks: 0, minutes: 15 });
  });

  it("returns the behaviour snapshot for the session", () => {
    const p = policy({
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["GAMES", "SOCIAL_MEDIA", "GAMES"],
    });
    const r = expectApproval(attempt(T("12:00"), { policy: p }));
    expect(r.behaviour).toEqual({
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["SOCIAL_MEDIA", "GAMES"],
    });
  });

  it("never throws for any trigger / time combination", () => {
    const triggers: BreakTrigger[] = ["EMPLOYEE", "SCHEDULED", "MANAGER"];
    for (const trigger of triggers) {
      for (const t of ["00:00", "08:59", "09:00", "10:00", "14:59", "15:00", "23:59"]) {
        expect(() => attempt(T(t), { trigger })).not.toThrow();
      }
    }
  });
});

describe("absolute instants: timezone changes and device clocks do not matter", () => {
  it("the same instant expressed in different offsets yields identical results", () => {
    const shiftLocal: ShiftWindowLike = {
      id: "shift-1",
      startsAt: new Date("2026-10-05T11:00:00+02:00"),
      endsAt: new Date("2026-10-05T17:00:00+02:00"),
    };
    const a = attempt(new Date("2026-10-05T14:00:00+02:00"), { shift: shiftLocal });
    const b = attempt(new Date("2026-10-05T07:00:00-05:00"), { shift: SHIFT });
    expect(a).toEqual(b);
    expect(expectApproval(a).plannedEndsAt.toISOString()).toBe("2026-10-05T12:15:00.000Z");
  });

  it("plannedEndsAt is an absolute instant independent of any later evaluation", () => {
    const approval = expectApproval(attempt(T("12:00")));
    // Whatever the device's clock says, the allowance after plannedEndsAt is computed from the server instant.
    const s = active(approval.startsAt, approval.durationMinutes);
    const later = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [s], T("12:16"));
    expect(later.breaksTaken).toBe(1);
    expect(later.minutesUsed).toBe(15);
    expect(later.canStartNow).toBe(false); // gap
    expect(later.nextEligibleAt).toEqual(T("13:15"));
  });

  it("clock-skew helpers", () => {
    expect(computeClockSkewSeconds(T("12:00:10"), T("12:00:00"))).toBe(10);
    expect(computeClockSkewSeconds(T("11:59:00"), T("12:00:00"))).toBe(-60);
    expect(clockSkewNeedsAttention(null)).toBe(false);
    expect(clockSkewNeedsAttention(undefined)).toBe(false);
    expect(clockSkewNeedsAttention(Number.NaN)).toBe(false);
    expect(clockSkewNeedsAttention(0)).toBe(false);
    // Same rule as deriveDeviceStatus: strictly above the shared threshold.
    expect(CLOCK_SKEW_ATTENTION_THRESHOLD_SECONDS).toBe(DEVICE_STATUS_THRESHOLDS.clockSkewSeconds);
    expect(clockSkewNeedsAttention(CLOCK_SKEW_ATTENTION_THRESHOLD_SECONDS)).toBe(false);
    expect(clockSkewNeedsAttention(-CLOCK_SKEW_ATTENTION_THRESHOLD_SECONDS)).toBe(false);
    expect(clockSkewNeedsAttention(CLOCK_SKEW_ATTENTION_THRESHOLD_SECONDS + 1)).toBe(true);
    expect(clockSkewNeedsAttention(-CLOCK_SKEW_ATTENTION_THRESHOLD_SECONDS - 1)).toBe(true);
    expect(clockSkewNeedsAttention(30, 10)).toBe(true);
    expect(clockSkewNeedsAttention(10, 10)).toBe(false);
    expect(isBelowDeviceActivityInterval(DEVICE_ACTIVITY_MIN_RELIABLE_INTERVAL_MINUTES)).toBe(
      false,
    );
    expect(isBelowDeviceActivityInterval(14)).toBe(true);
  });

  it("deviceInstantToServerTime removes the reported skew", () => {
    // Device 90 s ahead: its 12:01:30 is the server's 12:00:00.
    const skew = computeClockSkewSeconds(T("12:01:30"), T("12:00:00"));
    expect(skew).toBe(90);
    expect(deviceInstantToServerTime(T("12:01:30"), skew)).toEqual(T("12:00:00"));
    expect(deviceInstantToServerTime(T("11:58:00"), -120)).toEqual(T("12:00:00"));
    expect(deviceInstantToServerTime(T("12:00"), Number.NaN)).toEqual(T("12:00"));
  });

  it("device clock manipulation: a clock set forward cannot start a break early", () => {
    // The phone is set 45 minutes ahead and shows 10:00 (eligible by its own reckoning). The server says 09:15.
    const deviceNow = T("10:00");
    const serverNow = T("09:15");
    const skew = computeClockSkewSeconds(deviceNow, serverNow);
    expect(clockSkewNeedsAttention(skew)).toBe(true);
    // Online: the server evaluates its own clock.
    expectRefusal(attempt(serverNow), "BREAK_TOO_SOON");
    // Offline replay: the device-reported start is converted to server time before re-validation.
    const r = expectRefusal(attempt(deviceInstantToServerTime(deviceNow, skew)), "BREAK_TOO_SOON");
    expect(r.details.eligibleAt).toEqual(T("10:00"));
  });

  it("device clock set backward cannot extend a running break", () => {
    // plannedEndsAt is fixed by the server; however late the device thinks it is, the server sees the break as over.
    const approval = expectApproval(attempt(T("12:00")));
    const s = active(approval.startsAt, approval.durationMinutes);
    const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [s], T("12:40"));
    expect(a.minutesUsed).toBe(15);
    expect(a.nextEligibleAt).toEqual(T("13:15"));
  });
});

describe("app closed / phone restart / internet loss", () => {
  it("closing the app: the break ends at plannedEndsAt with no device report", () => {
    const approval = expectApproval(attempt(T("12:00")));
    expect(approval.plannedEndsAt.toISOString()).toBe("2026-10-05T12:15:00.000Z");
    // No BREAK_ENDED ever arrives; the row is still ACTIVE.
    const row = active(approval.startsAt, approval.durationMinutes);
    const during = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [row], T("12:10"));
    expect(during).toMatchObject({ breaksTaken: 1, minutesUsed: 10, canStartNow: false });
    const after = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [row], T("12:15"));
    expect(after).toMatchObject({
      breaksTaken: 1,
      minutesUsed: 15,
      minutesRemaining: 15,
      nextEligibleAt: T("13:15"),
    });
  });

  it("phone restart mid-break: the expired row is counted to plannedEndsAt, not to the reboot", () => {
    const row = active(T("12:00"), 15);
    // Phone reboots at 12:05 and comes back at 12:40; nothing was reported in between.
    const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [row], T("12:40"));
    expect(a.minutesUsed).toBe(15);
    expect(a.canStartNow).toBe(false); // gap until 13:15
    expectApproval(attempt(T("13:15"), { existingSessions: [row] }));
  });

  it("internet loss: a break started offline is re-validated at its start instant", () => {
    // Device went offline at 11:50, started a break at 12:00 (no skew), reconnects at 12:30.
    const requestedAt = T("12:00");
    const replay = expectApproval(attempt(requestedAt, { requestedDurationMinutes: 10 }));
    expect(replay.startsAt).toEqual(requestedAt);
    expect(replay.plannedEndsAt).toEqual(T("12:10"));
    // Re-running the same replay is deterministic (idempotency is enforced by clientBreakId on the server).
    expect(attempt(requestedAt, { requestedDurationMinutes: 10 })).toEqual(replay);
  });

  it("internet loss + policy change: an offline break the new policy forbids is refused at its start instant", () => {
    // While offline the manager disabled employee-triggered breaks; the cached policy still allowed them.
    const cached = DEFAULT_POLICY;
    const current = policy({ employeeTriggeredAllowed: false });
    expectApproval(attempt(T("12:00"), { policy: cached }));
    const r = expectRefusal(
      attempt(T("12:00"), { policy: current }),
      "EMPLOYEE_BREAKS_NOT_ALLOWED",
    );
    // The server records it with endReason POLICY_CHANGED and returns this refusal + the allowance.
    expect(breakRefusalToAppError(r).toBody().error.code).toBe("EMPLOYEE_BREAKS_NOT_ALLOWED");
  });
});

describe("shift ends mid-break", () => {
  it("a shift shortened while a break runs: no new break after the new end, nothing eligible", () => {
    const shortened: ShiftWindowLike = { ...SHIFT, endsAt: T("14:10") };
    const running = active(T("14:00"), 15); // planned 14:15 under the old shift end
    expectRefusal(
      attempt(T("14:12"), { shift: shortened, existingSessions: [running], trigger: "MANAGER" }),
      "NOT_ON_SHIFT",
    );
    const a = computeBreakAllowance(DEFAULT_POLICY, shortened, [running], T("14:05"));
    expect(a.nextEligibleAt).toBeNull();
    expect(a.canStartNow).toBe(false);
  });

  it("a break started near the end is clamped and the shift end is the planned end", () => {
    const r = expectApproval(attempt(T("14:52")));
    expect(r.plannedEndsAt).toEqual(SHIFT.endsAt);
    expect(r.durationMinutes).toBe(8);
  });
});

describe("policy change mid-break", () => {
  it("the running break keeps its snapshot; the next break uses the new policy", () => {
    const oldPolicy = policy({
      restrictionBehaviour: "RELAX_ALL",
      maxBreaksPerShift: 3,
      maxTotalBreakMinutes: 45,
    });
    const newPolicy = policy({
      restrictionBehaviour: "KEEP_RESTRICTIONS",
      maxBreaksPerShift: 1,
      maxTotalBreakMinutes: 15,
    });

    const approval = expectApproval(
      canStartBreak({
        policy: oldPolicy,
        shift: SHIFT,
        existingSessions: [],
        now: T("11:00"),
        trigger: "EMPLOYEE",
      }),
    );
    const sessionRow = { ...active(T("11:00"), approval.durationMinutes), ...approval.behaviour };

    // Engine reads the snapshot, not the new policy.
    expect(breakRestrictionForSession(sessionRow)).toMatchObject({
      effectiveRestriction: "BREAK_RELAXED",
      restrictionsShouldBeActive: false,
    });
    expect(
      breakRestrictionForSession({ ...sessionRow, ...resolveBreakBehaviour(newPolicy) })
        .effectiveRestriction,
    ).toBe("WORK");

    // Allowance under the old policy vs the new one, same sessions.
    const closed = ended(T("11:00"), 15);
    expect(computeBreakAllowance(oldPolicy, SHIFT, [closed], T("12:30")).breaksRemaining).toBe(2);
    const underNew = computeBreakAllowance(newPolicy, SHIFT, [closed], T("12:30"));
    expect(underNew.breaksRemaining).toBe(0);
    expect(underNew.nextEligibleAt).toBeNull();
    expectRefusal(
      canStartBreak({
        policy: newPolicy,
        shift: SHIFT,
        existingSessions: [closed],
        now: T("12:30"),
        trigger: "EMPLOYEE",
      }),
      "BREAK_LIMIT_REACHED",
    );
  });
});

describe("clampBreak", () => {
  const p = { maxBreakDurationMinutes: 15 };
  it("defaults to the per-break max", () => {
    expect(clampBreak(p, undefined, 30)).toBe(15);
    expect(clampBreak(p, null, 30)).toBe(15);
  });
  it("takes the minimum of request, per-break max and remaining", () => {
    expect(clampBreak(p, 10, 30)).toBe(10);
    expect(clampBreak(p, 20, 30)).toBe(15);
    expect(clampBreak(p, 20, 7)).toBe(7);
    expect(clampBreak(p, 5, 7)).toBe(5);
  });
  it("floors to whole minutes and never goes negative", () => {
    expect(clampBreak(p, 4.9, 30)).toBe(4);
    expect(clampBreak(p, 10, 0)).toBe(0);
    expect(clampBreak(p, 10, -5)).toBe(0);
    expect(clampBreak(p, -3, 30)).toBe(0);
    expect(clampBreak(p, Number.NaN, 30)).toBe(0);
    expect(clampBreak({ maxBreakDurationMinutes: Number.NaN }, 10, 30)).toBe(0);
  });
});

describe("computeBreakAllowance", () => {
  it("fresh shift before the min-after-start window", () => {
    const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [], T("09:30"));
    expect(a).toEqual({
      breaksTaken: 0,
      breaksRemaining: 2,
      minutesUsed: 0,
      minutesRemaining: 30,
      nextEligibleAt: T("10:00"),
      canStartNow: false,
    });
  });

  it("eligible now: nextEligibleAt is in the past and canStartNow is true", () => {
    const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [], T("12:00"));
    expect(a.canStartNow).toBe(true);
    expect(a.nextEligibleAt).toEqual(T("10:00"));
  });

  it("after one break: gap drives nextEligibleAt", () => {
    const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [ended(T("10:00"), 10)], T("10:30"));
    expect(a.breaksTaken).toBe(1);
    expect(a.breaksRemaining).toBe(1);
    expect(a.minutesUsed).toBe(10);
    expect(a.minutesRemaining).toBe(20);
    expect(a.nextEligibleAt).toEqual(T("11:10"));
    expect(a.canStartNow).toBe(false);
  });

  it("active break: elapsed-so-far counts, nextEligibleAt assumes it runs to plannedEndsAt", () => {
    const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [active(T("11:00"), 15)], T("11:05"));
    expect(a.minutesUsed).toBe(5);
    expect(a.minutesRemaining).toBe(25);
    expect(a.nextEligibleAt).toEqual(T("12:15"));
    expect(a.canStartNow).toBe(false);
  });

  it("active break that will exhaust the total allowance → nextEligibleAt null", () => {
    const sessions = [ended(T("10:00"), 15), active(T("12:00"), 15)];
    const p = policy({ maxBreaksPerShift: 5 });
    const a = computeBreakAllowance(p, SHIFT, sessions, T("12:05"));
    expect(a.minutesUsed).toBe(20);
    expect(a.minutesRemaining).toBe(10);
    expect(a.nextEligibleAt).toBeNull();
  });

  it("limits exhausted → null and no negative remaining", () => {
    const sessions = [ended(T("10:00"), 20), ended(T("12:00"), 20)];
    const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, sessions, T("14:00"));
    expect(a.breaksRemaining).toBe(0);
    expect(a.minutesUsed).toBe(40);
    expect(a.minutesRemaining).toBe(0);
    expect(a.nextEligibleAt).toBeNull();
    expect(a.canStartNow).toBe(false);
  });

  it("nextEligibleAt is null when the gap would land inside the last minute of the shift", () => {
    const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [ended(T("13:50"), 10)], T("14:30"));
    expect(a.nextEligibleAt).toBeNull(); // 14:00 + 60 min = 15:00 → no minute left
    const b = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [ended(T("13:49"), 10)], T("14:30"));
    expect(b.nextEligibleAt).toEqual(T("14:59"));
  });

  it("disabled policies and disallowed triggers → null", () => {
    expect(
      computeBreakAllowance(policy({ breaksEnabled: false }), SHIFT, [], T("12:00")).nextEligibleAt,
    ).toBeNull();
    expect(
      computeBreakAllowance(policy({ employeeTriggeredAllowed: false }), SHIFT, [], T("12:00"))
        .nextEligibleAt,
    ).toBeNull();
    expect(
      computeBreakAllowance(
        policy({ scheduledBreaksAllowed: false }),
        SHIFT,
        [],
        T("12:00"),
        "SCHEDULED",
      ).nextEligibleAt,
    ).toBeNull();
    expect(
      computeBreakAllowance(
        policy({ employeeTriggeredAllowed: false }),
        SHIFT,
        [],
        T("12:00"),
        "MANAGER",
      ).canStartNow,
    ).toBe(true);
  });

  it("MANAGER trigger ignores timing rules for nextEligibleAt but respects an active break", () => {
    expect(
      computeBreakAllowance(DEFAULT_POLICY, SHIFT, [], T("09:30"), "MANAGER").nextEligibleAt,
    ).toEqual(T("09:00"));
    const a = computeBreakAllowance(
      DEFAULT_POLICY,
      SHIFT,
      [active(T("11:00"), 15)],
      T("11:05"),
      "MANAGER",
    );
    expect(a.nextEligibleAt).toEqual(T("11:15"));
    // After an ended break: no gap for a manager, but never before that break's end.
    const b = computeBreakAllowance(
      DEFAULT_POLICY,
      SHIFT,
      [ended(T("10:00"), 15)],
      T("10:20"),
      "MANAGER",
    );
    expect(b.nextEligibleAt).toEqual(T("10:15"));
    expect(b.canStartNow).toBe(true);
  });

  it("canStartNow agrees with nextEligibleAt across the whole shift, including after it ends", () => {
    const sessions = [ended(T("10:00"), 10)];
    for (let m = -5; m <= 6 * 60 + 5; m += 1) {
      const now = plusMs(SHIFT.startsAt, m * MIN);
      for (const trigger of ["EMPLOYEE", "MANAGER"] as const) {
        const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, sessions, now, trigger);
        const eligibleByTime =
          a.nextEligibleAt !== null && a.nextEligibleAt.getTime() <= now.getTime();
        expect(a.canStartNow, `${trigger} at +${m} min`).toBe(eligibleByTime);
      }
    }
  });

  it("nextEligibleAt is null once no break can start any more this shift", () => {
    // 14:59 is the last start instant (one whole minute must remain).
    expect(computeBreakAllowance(DEFAULT_POLICY, SHIFT, [], T("14:59")).nextEligibleAt).toEqual(
      T("10:00"),
    );
    for (const t of ["14:59:01", "15:00", "18:00"]) {
      const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [], T(t), "MANAGER");
      expect(a.nextEligibleAt, t).toBeNull();
      expect(a.canStartNow, t).toBe(false);
    }
  });

  it("a policy that grants no breaks reports nothing remaining; a disallowed trigger does not", () => {
    for (const p of [policy({ breaksEnabled: false }), policy({ maxBreakDurationMinutes: 0 })]) {
      expect(computeBreakAllowance(p, SHIFT, [ended(T("10:00"), 5)], T("12:00"))).toEqual({
        breaksTaken: 1,
        breaksRemaining: 0,
        minutesUsed: 5,
        minutesRemaining: 0,
        nextEligibleAt: null,
        canStartNow: false,
      });
    }
    // Employee-triggered breaks off: the allowance still exists for scheduled / manager breaks.
    const a = computeBreakAllowance(
      policy({ employeeTriggeredAllowed: false }),
      SHIFT,
      [],
      T("12:00"),
    );
    expect(a).toMatchObject({ breaksRemaining: 2, minutesRemaining: 30, nextEligibleAt: null });
  });

  it("expired-but-not-closed session counts as ended at plannedEndsAt", () => {
    const stale = active(T("10:00"), 15);
    const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [stale], T("13:00"));
    expect(a.minutesUsed).toBe(15);
    expect(a.nextEligibleAt).toEqual(T("11:15"));
    expect(a.canStartNow).toBe(true);
  });

  it("ignores other shifts' sessions", () => {
    const a = computeBreakAllowance(
      DEFAULT_POLICY,
      SHIFT,
      [ended(T("10:00"), 15, { shiftId: "x" })],
      T("12:00"),
    );
    expect(a.breaksTaken).toBe(0);
  });
});

describe("restriction behaviour", () => {
  it("parseRelaxedCategories normalises JSON", () => {
    expect(parseRelaxedCategories(null)).toEqual([]);
    expect(parseRelaxedCategories("GAMES")).toEqual([]);
    expect(parseRelaxedCategories(["GAMES", "nope", 3, "GAMES", "SOCIAL_MEDIA"])).toEqual([
      "SOCIAL_MEDIA",
      "GAMES",
    ]);
    expect(parseRelaxedCategories([...RESTRICTION_CATEGORIES].reverse())).toEqual([
      ...RESTRICTION_CATEGORIES,
    ]);
  });

  it("breakPolicyFromRecord parses the JSON column", () => {
    const row = {
      ...DEFAULT_POLICY,
      restrictionBehaviour: "RELAX_CATEGORIES" as const,
      relaxedCategories: ["VIDEO", "bogus"] as unknown,
    };
    expect(breakPolicyFromRecord(row).relaxedCategories).toEqual(["VIDEO"]);
    expect(breakPolicyFromRecord({ ...row, relaxedCategories: "{}" }).relaxedCategories).toEqual(
      [],
    );
  });

  it("resolveBreakBehaviour is exhaustive and only keeps categories for RELAX_CATEGORIES", () => {
    expect(
      resolveBreakBehaviour(
        policy({ restrictionBehaviour: "RELAX_ALL", relaxedCategories: ["GAMES"] }),
      ),
    ).toEqual({
      restrictionBehaviour: "RELAX_ALL",
      relaxedCategories: [],
    });
    expect(
      resolveBreakBehaviour(
        policy({ restrictionBehaviour: "KEEP_RESTRICTIONS", relaxedCategories: ["GAMES"] }),
      ),
    ).toEqual({
      restrictionBehaviour: "KEEP_RESTRICTIONS",
      relaxedCategories: [],
    });
    expect(
      resolveBreakBehaviour(
        policy({
          restrictionBehaviour: "RELAX_CATEGORIES",
          relaxedCategories: ["GAMES", "DATING"],
        }),
      ),
    ).toEqual({
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["GAMES", "DATING"],
    });
    // Accepts a raw record too.
    expect(
      resolveBreakBehaviour({
        restrictionBehaviour: "RELAX_CATEGORIES",
        relaxedCategories: ["DATING", 1],
      }),
    ).toEqual({
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["DATING"],
    });
  });

  it("breakRestrictionForSession maps every behaviour", () => {
    expect(
      breakRestrictionForSession({ restrictionBehaviour: "RELAX_ALL", relaxedCategories: [] }),
    ).toEqual({
      restrictionBehaviour: "RELAX_ALL",
      relaxedCategories: [],
      effectiveRestriction: "BREAK_RELAXED",
      restrictionsShouldBeActive: false,
      liftedCategories: [...RESTRICTION_CATEGORIES],
    });
    expect(
      breakRestrictionForSession({
        restrictionBehaviour: "KEEP_RESTRICTIONS",
        relaxedCategories: ["GAMES"],
      }),
    ).toEqual({
      restrictionBehaviour: "KEEP_RESTRICTIONS",
      relaxedCategories: [],
      effectiveRestriction: "WORK",
      restrictionsShouldBeActive: true,
      liftedCategories: [],
    });
    expect(
      breakRestrictionForSession({
        restrictionBehaviour: "RELAX_CATEGORIES",
        relaxedCategories: ["GAMES"],
      }),
    ).toEqual({
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["GAMES"],
      effectiveRestriction: "BREAK_RELAXED",
      restrictionsShouldBeActive: true,
      liftedCategories: ["GAMES"],
    });
    expect(
      breakRestrictionForSession({
        restrictionBehaviour: "RELAX_CATEGORIES",
        relaxedCategories: [],
      }),
    ).toMatchObject({ effectiveRestriction: "WORK", restrictionsShouldBeActive: true });
    // Every category listed: nothing is left to enforce, but it is still a break profile, not "off shift".
    expect(
      breakRestrictionForSession({
        restrictionBehaviour: "RELAX_CATEGORIES",
        relaxedCategories: [...RESTRICTION_CATEGORIES],
      }),
    ).toMatchObject({ effectiveRestriction: "BREAK_RELAXED", restrictionsShouldBeActive: false });
  });

  it("isCategoryRelaxedDuringBreak", () => {
    expect(
      isCategoryRelaxedDuringBreak(
        { restrictionBehaviour: "RELAX_ALL", relaxedCategories: [] },
        "GAMES",
      ),
    ).toBe(true);
    expect(
      isCategoryRelaxedDuringBreak(
        { restrictionBehaviour: "KEEP_RESTRICTIONS", relaxedCategories: [] },
        "GAMES",
      ),
    ).toBe(false);
    expect(
      isCategoryRelaxedDuringBreak(
        { restrictionBehaviour: "RELAX_CATEGORIES", relaxedCategories: ["GAMES"] },
        "GAMES",
      ),
    ).toBe(true);
    expect(
      isCategoryRelaxedDuringBreak(
        { restrictionBehaviour: "RELAX_CATEGORIES", relaxedCategories: ["GAMES"] },
        "VIDEO",
      ),
    ).toBe(false);
  });
});

describe("throwIfCannotStartBreak", () => {
  it("returns the approval when allowed", () => {
    const r = throwIfCannotStartBreak({
      policy: DEFAULT_POLICY,
      shift: SHIFT,
      existingSessions: [],
      now: T("12:00"),
      trigger: "EMPLOYEE",
    });
    expect(r.ok).toBe(true);
    expect(r.plannedEndsAt).toEqual(T("12:15"));
  });

  it("throws an AppError with the refusal's code, status, message and details", () => {
    try {
      throwIfCannotStartBreak({
        policy: DEFAULT_POLICY,
        shift: SHIFT,
        existingSessions: [],
        now: T("09:30"),
        trigger: "EMPLOYEE",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.code).toBe("BREAK_TOO_SOON");
      expect(e.status).toBe(ERROR_HTTP_STATUS.BREAK_TOO_SOON);
      expect(e.details).toEqual({
        reason: "MIN_MINUTES_AFTER_SHIFT_START",
        eligibleAt: T("10:00"),
        waitMinutes: 30,
      });
      expect(e.toBody().error.code).toBe("BREAK_TOO_SOON");
      expect(e.message).toContain("60 minutes");
    }
  });

  it("breakRefusalToAppError preserves every refusal code", () => {
    const cases: Array<[Date, Partial<CanStartBreakInput>]> = [
      [T("12:00"), { policy: policy({ breaksEnabled: false }) }],
      [T("12:00"), { policy: policy({ employeeTriggeredAllowed: false }) }],
      [T("12:00"), { requestedDurationMinutes: 0 }],
      [T("12:00"), { requestedDurationMinutes: 99 }],
      [T("16:00"), {}],
      [T("12:05"), { existingSessions: [active(T("12:00"), 15)] }],
      [T("14:00"), { existingSessions: [ended(T("10:00"), 10), ended(T("12:00"), 10)] }],
      [T("09:00"), {}],
    ];
    const seen = new Set<string>();
    for (const [now, overrides] of cases) {
      const r = attempt(now, overrides);
      if (r.ok) throw new Error("expected refusal");
      const e = breakRefusalToAppError(r);
      expect(e.code).toBe(r.code);
      expect(e.status).toBe(ERROR_HTTP_STATUS[r.code]);
      seen.add(r.code);
    }
    expect([...seen].sort()).toEqual([...BREAK_REFUSAL_CODES].sort());
  });
});

describe("invalid instants are refused, never approved", () => {
  const BAD = new Date(Number.NaN);

  it("now, shift bounds and session instants must be valid Dates (VALIDATION_ERROR, never throws)", () => {
    const cases: Array<[Partial<CanStartBreakInput> & { now?: Date }, string]> = [
      [{ now: BAD }, "now"],
      [{ shift: { ...SHIFT, startsAt: BAD } }, "shift.startsAt"],
      [{ shift: { ...SHIFT, endsAt: BAD } }, "shift.endsAt"],
      [{ existingSessions: [active(T("11:00"), 15, { startedAt: BAD })] }, "existingSessions"],
      [{ existingSessions: [active(T("11:00"), 15, { plannedEndsAt: BAD })] }, "existingSessions"],
      [{ existingSessions: [ended(T("11:00"), 15, { endedAt: BAD })] }, "existingSessions"],
      // A string where a Date belongs (e.g. an unparsed JSON cache on the device).
      [{ now: "2026-10-05T12:00:00Z" as unknown as Date }, "now"],
    ];
    for (const [overrides, field] of cases) {
      const { now = T("12:00"), ...rest } = overrides;
      let result: CanStartBreakResult | undefined;
      expect(() => (result = attempt(now, rest)), field).not.toThrow();
      const r = expectRefusal(result as CanStartBreakResult, "VALIDATION_ERROR");
      expect(r.details.field).toBe(field);
      expect(BREAK_INPUT_FIELDS).toContain(r.details.field);
    }
  });

  it("an invalid session of another shift is ignored", () => {
    const other = active(T("11:00"), 15, { shiftId: "shift-2", startedAt: BAD });
    expectApproval(attempt(T("12:00"), { existingSessions: [other] }));
  });

  it("policy gates still come first", () => {
    expectRefusal(attempt(BAD, { policy: policy({ breaksEnabled: false }) }), "BREAKS_DISABLED");
  });

  it("computeBreakAllowance and expiredBreakSessionClosures throw AppError(VALIDATION_ERROR)", () => {
    for (const fn of [
      () => computeBreakAllowance(DEFAULT_POLICY, SHIFT, [], BAD),
      () => computeBreakAllowance(DEFAULT_POLICY, { ...SHIFT, endsAt: BAD }, [], T("12:00")),
      () => expiredBreakSessionClosures(SHIFT, [active(BAD, 15)], T("12:00")),
    ]) {
      try {
        fn();
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("VALIDATION_ERROR");
        expect((err as AppError).status).toBe(400);
      }
    }
  });

  it("the approval's startsAt is a fresh Date (mutating it cannot corrupt the caller's now)", () => {
    const now = T("12:00");
    const r = expectApproval(attempt(now));
    expect(r.startsAt).toEqual(now);
    expect(r.startsAt).not.toBe(now);
  });
});

describe("effective end: a break never counts past plannedEndsAt or the shift end", () => {
  it("a late BREAK_ENDED report (endedAt after plannedEndsAt) changes nothing in the allowance", () => {
    const onTime = ended(T("10:00"), 15);
    const late = ended(T("10:00"), 15, { endedAt: T("10:40") }); // device reconnected at 10:40
    const skewed = ended(T("10:00"), 15, { endedAt: T("12:00") }); // device clock far behind
    const reference = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [onTime], T("10:45"));
    for (const s of [late, skewed]) {
      const a = computeBreakAllowance(DEFAULT_POLICY, SHIFT, [s], T("10:45"));
      expect({ ...a }).toEqual({ ...reference });
      expect(a.minutesUsed).toBe(15);
      expect(a.nextEligibleAt).toEqual(T("11:15")); // gap from 10:15, not from the late report
    }
    expectApproval(attempt(T("11:15"), { existingSessions: [skewed] }));
  });

  it("an ACTIVE break cut short by a shortened shift counts to the new shift end", () => {
    const shortened: ShiftWindowLike = { ...SHIFT, endsAt: T("14:10") };
    const running = active(T("14:00"), 15); // planned 14:15
    expect(
      computeBreakAllowance(DEFAULT_POLICY, shortened, [running], T("14:05")).minutesUsed,
    ).toBe(5);
    const after = computeBreakAllowance(DEFAULT_POLICY, shortened, [running], T("14:30"));
    expect(after.minutesUsed).toBe(10);
    expect(after.minutesRemaining).toBe(20);
    // An ENDED row whose endedAt was reported after the (new) shift end is capped too.
    const endedLate = ended(T("14:00"), 15, { endedAt: T("14:15") });
    expect(
      computeBreakAllowance(DEFAULT_POLICY, shortened, [endedLate], T("14:30")).minutesUsed,
    ).toBe(10);
  });

  it("a break whose shift was moved to end before it started counts zero minutes but one break", () => {
    const moved: ShiftWindowLike = { ...SHIFT, endsAt: T("13:00") };
    const a = computeBreakAllowance(DEFAULT_POLICY, moved, [ended(T("14:00"), 15)], T("12:00"));
    expect(a).toMatchObject({ breaksTaken: 1, minutesUsed: 0 });
  });
});

describe("expiredBreakSessionClosures", () => {
  it("closes expired ACTIVE rows at plannedEndsAt (EXPIRED), in start order", () => {
    const p = policy({ maxBreaksPerShift: 5 });
    const second = active(T("12:00"), 10);
    const first = active(T("10:00"), 15);
    const closures = expiredBreakSessionClosures(SHIFT, [second, first], T("13:00"));
    expect(closures).toEqual([
      { sessionId: first.id, endedAt: T("10:15"), endReason: "EXPIRED" },
      { sessionId: second.id, endedAt: T("12:10"), endReason: "EXPIRED" },
    ]);
    // Persisting the closures is a no-op for the rules: they already read those rows as ended there.
    const closed = [second, first].map((s) => {
      const c = closures.find((x) => x.sessionId === s.id);
      return c ? { ...s, status: "ENDED" as const, endedAt: c.endedAt } : s;
    });
    expect(computeBreakAllowance(p, SHIFT, closed, T("13:00"))).toEqual(
      computeBreakAllowance(p, SHIFT, [second, first], T("13:00")),
    );
  });

  it("closes a break cut short by a shortened shift at the shift end (SHIFT_ENDED)", () => {
    const shortened: ShiftWindowLike = { ...SHIFT, endsAt: T("14:10") };
    const running = active(T("14:00"), 15);
    expect(expiredBreakSessionClosures(shortened, [running], T("14:09"))).toEqual([]);
    expect(expiredBreakSessionClosures(shortened, [running], T("14:10"))).toEqual([
      { sessionId: running.id, endedAt: T("14:10"), endReason: "SHIFT_ENDED" },
    ]);
  });

  it("leaves running, already-ended and other shifts' sessions alone; boundary is inclusive", () => {
    const running = active(T("12:00"), 15);
    const done = ended(T("10:00"), 15);
    const otherShift = active(T("10:00"), 15, { shiftId: "shift-2" });
    expect(
      expiredBreakSessionClosures(SHIFT, [running, done, otherShift], plusMs(T("12:15"), -1)),
    ).toEqual([]);
    expect(expiredBreakSessionClosures(SHIFT, [running], T("12:15"))).toEqual([
      { sessionId: running.id, endedAt: T("12:15"), endReason: "EXPIRED" },
    ]);
  });

  it("closing first lets a new ACTIVE row be inserted without two ACTIVE rows per shift", () => {
    const stale = active(T("10:00"), 15); // never closed: app killed
    const now = T("11:20");
    const approval = expectApproval(attempt(now, { existingSessions: [stale] }));
    const closures = expiredBreakSessionClosures(SHIFT, [stale], now);
    expect(closures.map((c) => c.sessionId)).toEqual([stale.id]);
    expect(approval.plannedEndsAt).toEqual(T("11:35"));
  });
});

describe("breakStartInstant (mobile requestedAt → server-clock start)", () => {
  it("online: the device's tap time on the server clock, never after the receive time", () => {
    // Device 90 s ahead; tap reached the server 300 ms later.
    const receivedAt = T("12:00:00");
    expect(breakStartInstant(plusMs(T("12:01:30"), -300), receivedAt, 90)).toEqual(
      plusMs(receivedAt, -300),
    );
    // Skew unknown and device ahead: clamped to the receive time.
    expect(breakStartInstant(T("12:05"), receivedAt, null)).toEqual(receivedAt);
    expect(breakStartInstant(T("12:05"), receivedAt, undefined)).toEqual(receivedAt);
  });

  it("offline: the break is placed where it happened, so it is validated and counted there", () => {
    // Tapped at 12:00 device time (device 2 min behind), reconnected at 12:30 server time.
    const start = breakStartInstant(T("11:58"), T("12:30"), -120);
    expect(start).toEqual(T("12:00"));
    const r = expectApproval(attempt(start, { requestedDurationMinutes: 10 }));
    expect(r.plannedEndsAt).toEqual(T("12:10")); // already over at 12:30 → stored ENDED / EXPIRED
  });

  it("a future-dated request cannot pre-book a start; an invalid one falls back to the receive time", () => {
    expect(breakStartInstant(T("13:00"), T("12:00"), 0)).toEqual(T("12:00"));
    expect(breakStartInstant(new Date(Number.NaN), T("12:00"), 0)).toEqual(T("12:00"));
  });

  it("backdating cannot gain anything: a gap or a later break still refuses", () => {
    const first = ended(T("10:00"), 15);
    // Real time 11:00 (gap until 11:15). Claiming an earlier tap is still too soon …
    expectRefusal(
      attempt(breakStartInstant(T("10:30"), T("11:00"), 0), { existingSessions: [first] }),
      "BREAK_TOO_SOON",
    );
    // … and claiming a tap before the recorded break collides with it.
    expectRefusal(
      attempt(breakStartInstant(T("09:55"), T("11:00"), 0), {
        existingSessions: [first],
        trigger: "MANAGER",
      }),
      "BREAK_ALREADY_ACTIVE",
    );
  });
});

describe("parity with the Work Mode state machine (§6.2)", () => {
  const behaviours: Array<[BreakRestrictionBehaviour, unknown]> = [
    ["RELAX_ALL", []],
    ["RELAX_ALL", ["GAMES"]],
    ["KEEP_RESTRICTIONS", ["GAMES"]],
    ["RELAX_CATEGORIES", []],
    ["RELAX_CATEGORIES", ["GAMES", "bogus", "SOCIAL_MEDIA"]],
    ["RELAX_CATEGORIES", [...RESTRICTION_CATEGORIES]],
  ];

  it("breakRestrictionForSession matches computeExpectedState while ON_BREAK", () => {
    for (const [restrictionBehaviour, relaxedCategories] of behaviours) {
      const session = { ...active(T("12:00"), 15), restrictionBehaviour, relaxedCategories };
      const machine = computeExpectedState({
        now: T("12:05"),
        shifts: [{ ...SHIFT, status: "SCHEDULED" }],
        breakSessions: [session],
        permissionState: "APPROVED",
      });
      const label = `${restrictionBehaviour} ${JSON.stringify(relaxedCategories)}`;
      expect(machine.state, label).toBe("ON_BREAK");
      const ours = breakRestrictionForSession(session);
      expect(ours.effectiveRestriction, label).toBe(machine.effectiveRestriction);
      expect(ours.restrictionsShouldBeActive, label).toBe(machine.restrictionsShouldBeActive);
      expect(ours.liftedCategories, label).toEqual(machine.relaxation?.liftedCategories ?? []);
    }
  });

  it("the machine ends the break where the rules stop counting it (effective end)", () => {
    const shortened: ShiftWindowLike = { ...SHIFT, endsAt: T("14:10") };
    const session = { ...active(T("14:00"), 15), restrictionBehaviour: "RELAX_ALL" as const };
    const at = (t: string) =>
      computeExpectedState({
        now: T(t),
        shifts: [{ ...shortened, status: "SCHEDULED" }],
        breakSessions: [session],
        permissionState: "APPROVED",
      }).state;
    expect(at("14:09")).toBe("ON_BREAK");
    expect(at("14:10")).not.toBe("ON_BREAK");
    expect(expiredBreakSessionClosures(shortened, [session], T("14:10"))[0]?.endedAt).toEqual(
      T("14:10"),
    );
  });
});

describe("invariants over a grid of policies, histories, triggers and instants", () => {
  const policies: Array<[string, BreakPolicyLike]> = [
    ["default", DEFAULT_POLICY],
    ["no gaps", policy({ minGapBetweenBreaksMinutes: 0, minMinutesAfterShiftStart: 0 })],
    ["small total", policy({ maxBreaksPerShift: 5, maxTotalBreakMinutes: 20 })],
    ["one break", policy({ maxBreaksPerShift: 1 })],
    ["long start wait", policy({ minMinutesAfterShiftStart: 350 })],
    ["employee off", policy({ employeeTriggeredAllowed: false })],
    ["scheduled off", policy({ scheduledBreaksAllowed: false })],
    ["disabled", policy({ breaksEnabled: false })],
    ["zero total", policy({ maxTotalBreakMinutes: 0 })],
  ];
  const histories: Array<[string, BreakSessionLike[]]> = [
    ["none", []],
    ["one ended", [ended(T("10:00"), 10)]],
    ["ended early", [ended(T("10:00"), 15, { endedAt: T("10:03:20") })]],
    ["running", [active(T("12:00"), 15)]],
    ["expired unclosed", [active(T("10:00"), 15)]],
    ["late report", [ended(T("11:00"), 15, { endedAt: T("11:50") })]],
    ["near end", [ended(T("14:30"), 15)]],
    ["two ended", [ended(T("10:00"), 5), ended(T("12:00"), 5)]],
    ["other shift", [ended(T("10:00"), 15, { shiftId: "shift-2" })]],
  ];
  const triggers: BreakTrigger[] = ["EMPLOYEE", "SCHEDULED", "MANAGER"];
  // Every 7 minutes from 08:55 to 15:05, plus odd seconds, so boundaries are hit from both sides.
  const instants: Date[] = [];
  for (let ms = T("08:55").getTime(); ms <= T("15:05").getTime(); ms += 7 * MIN + 13_000) {
    instants.push(new Date(ms));
  }
  instants.push(T("14:59"), plusMs(T("14:59"), 1), T("15:00"), T("10:00"), T("11:15"));

  // Violations are collected and asserted once: tens of thousands of `expect` calls would make this slow.
  it("nextEligibleAt is exact, approvals are well-formed, and rounding is consistent", () => {
    const failures: string[] = [];
    const check = (ok: boolean, label: string, what: string) => {
      if (!ok && failures.length < 20) failures.push(`${label}: ${what}`);
    };
    let checked = 0;
    for (const [pName, p] of policies) {
      for (const [hName, sessions] of histories) {
        for (const trigger of triggers) {
          const base = { policy: p, shift: SHIFT, existingSessions: sessions, trigger };
          for (const now of instants) {
            const label = `${pName} / ${hName} / ${trigger} @ ${now.toISOString()}`;
            const a = computeBreakAllowance(p, SHIFT, sessions, now, trigger);
            const r = canStartBreak({ ...base, now });
            checked += 1;

            // canStartNow is canStartBreak, and it holds exactly when nextEligibleAt ≤ now.
            const next = a.nextEligibleAt;
            check(a.canStartNow === r.ok, label, "canStartNow differs from canStartBreak");
            check(
              r.ok === (next !== null && next.getTime() <= now.getTime()),
              label,
              `ok=${r.ok} but nextEligibleAt=${next?.toISOString() ?? "null"}`,
            );
            if (!r.ok) check(BREAK_REFUSAL_CODES.includes(r.code), label, `unknown code ${r.code}`);

            // Allowance numbers are whole and never negative.
            for (const n of [a.breaksTaken, a.breaksRemaining, a.minutesUsed, a.minutesRemaining]) {
              check(Number.isInteger(n) && n >= 0, label, `bad allowance number ${n}`);
            }

            if (next !== null && next.getTime() > now.getTime()) {
              // Earliest: refused one millisecond before, allowed exactly at it.
              check(!canStartBreak({ ...base, now: plusMs(next, -1) }).ok, label, "ok before next");
              check(canStartBreak({ ...base, now: next }).ok, label, "refused at next");
            }
            if (next === null) {
              // Null means never again this shift.
              for (const later of [plusMs(now, 30 * MIN), plusMs(now, 120 * MIN), T("14:59")]) {
                if (later.getTime() < now.getTime()) continue;
                check(
                  !canStartBreak({ ...base, now: later }).ok,
                  label,
                  `null next but ok at ${later.toISOString()}`,
                );
              }
            }

            if (r.ok) {
              // Well-formed approval.
              check(r.durationMinutes >= 1, label, "duration < 1");
              check(
                r.durationMinutes <= p.maxBreakDurationMinutes,
                label,
                "duration > per-break max",
              );
              check(r.durationMinutes <= a.minutesRemaining, label, "duration > minutes remaining");
              check(
                r.plannedEndsAt.getTime() > now.getTime(),
                label,
                "plannedEndsAt not after now",
              );
              check(r.plannedEndsAt.getTime() <= SHIFT.endsAt.getTime(), label, "past shift end");
              // Rounding consistency: once the break has run in full (row never closed), the allowance
              // reports exactly what the approval promised.
              const row = active(r.startsAt, 0, { plannedEndsAt: r.plannedEndsAt });
              const after = computeBreakAllowance(
                p,
                SHIFT,
                [...sessions, row],
                r.plannedEndsAt,
                trigger,
              );
              check(after.breaksRemaining === r.remaining.breaks, label, "remaining.breaks drift");
              check(
                after.minutesRemaining === r.remaining.minutes,
                label,
                "remaining.minutes drift",
              );
              check(
                after.minutesUsed === a.minutesUsed + r.durationMinutes,
                label,
                "minutes drift",
              );
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(10_000);
  }, 30_000);
});
