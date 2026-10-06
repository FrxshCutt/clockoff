import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { buildShiftInstants, formatShiftRange } from "./shift";

const LONDON = "Europe/London";
const NEW_YORK = "America/New_York";
const SYDNEY = "Australia/Sydney";

describe("buildShiftInstants", () => {
  it("builds a plain daytime shift", () => {
    const s = buildShiftInstants({ date: "2026-10-06", startTime: "09:00", endTime: "15:00", timezone: LONDON });
    expect(s.startsAt.toISOString()).toBe("2026-10-06T08:00:00.000Z");
    expect(s.endsAt.toISOString()).toBe("2026-10-06T14:00:00.000Z");
    expect(s.isOvernight).toBe(false);
    expect(s.endDate).toBe("2026-10-06");
    expect(s.durationMinutes).toBe(360);
    expect(s.warnings).toEqual([]);
    expect(s.normalisedStartTime).toBeUndefined();
    expect(s.normalisedEndTime).toBeUndefined();
  });

  it("treats endTime <= startTime as ending on the next local day", () => {
    const s = buildShiftInstants({ date: "2026-07-10", startTime: "22:00", endTime: "06:00", timezone: LONDON });
    expect(s.isOvernight).toBe(true);
    expect(s.endDate).toBe("2026-07-11");
    expect(s.startsAt.toISOString()).toBe("2026-07-10T21:00:00.000Z");
    expect(s.endsAt.toISOString()).toBe("2026-07-11T05:00:00.000Z");
    expect(s.durationMinutes).toBe(480);
  });

  it("endTime === startTime is a 24h overnight shift", () => {
    const s = buildShiftInstants({ date: "2026-07-10", startTime: "09:00", endTime: "09:00", timezone: LONDON });
    expect(s.isOvernight).toBe(true);
    expect(s.durationMinutes).toBe(1440);
  });

  describe("overnight 22:00→06:00 across DST", () => {
    it("London spring-forward night is 7h", () => {
      const s = buildShiftInstants({ date: "2026-03-28", startTime: "22:00", endTime: "06:00", timezone: LONDON });
      expect(s.startsAt.toISOString()).toBe("2026-03-28T22:00:00.000Z");
      expect(s.endsAt.toISOString()).toBe("2026-03-29T05:00:00.000Z");
      expect(s.durationMinutes).toBe(420);
      expect(s.warnings).toEqual([]);
    });

    it("London fall-back night is 9h", () => {
      const s = buildShiftInstants({ date: "2026-10-24", startTime: "22:00", endTime: "06:00", timezone: LONDON });
      expect(s.startsAt.toISOString()).toBe("2026-10-24T21:00:00.000Z");
      expect(s.endsAt.toISOString()).toBe("2026-10-25T06:00:00.000Z");
      expect(s.durationMinutes).toBe(540);
      expect(s.warnings).toEqual([]);
    });

    it("New York spring-forward night is 7h", () => {
      const s = buildShiftInstants({ date: "2026-03-07", startTime: "22:00", endTime: "06:00", timezone: NEW_YORK });
      expect(s.startsAt.toISOString()).toBe("2026-03-08T03:00:00.000Z");
      expect(s.endsAt.toISOString()).toBe("2026-03-08T10:00:00.000Z");
      expect(s.durationMinutes).toBe(420);
    });

    it("Sydney DST-end night (April) is 9h and DST-start night (October) is 7h", () => {
      const april = buildShiftInstants({ date: "2026-04-04", startTime: "22:00", endTime: "06:00", timezone: SYDNEY });
      expect(april.startsAt.toISOString()).toBe("2026-04-04T11:00:00.000Z");
      expect(april.endsAt.toISOString()).toBe("2026-04-04T20:00:00.000Z");
      expect(april.durationMinutes).toBe(540);

      const october = buildShiftInstants({ date: "2026-10-03", startTime: "22:00", endTime: "06:00", timezone: SYDNEY });
      expect(october.startsAt.toISOString()).toBe("2026-10-03T12:00:00.000Z");
      expect(october.endsAt.toISOString()).toBe("2026-10-03T19:00:00.000Z");
      expect(october.durationMinutes).toBe(420);
    });
  });

  describe("overnight edge cases", () => {
    it("an overnight end inside the spring-forward gap moves forward (London 20:00 → 01:30 on 28/29 March)", () => {
      const s = buildShiftInstants({ date: "2026-03-28", startTime: "20:00", endTime: "01:30", timezone: LONDON });
      expect(s.isOvernight).toBe(true);
      expect(s.endDate).toBe("2026-03-29");
      expect(s.startsAt.toISOString()).toBe("2026-03-28T20:00:00.000Z");
      expect(s.endsAt.toISOString()).toBe("2026-03-29T01:30:00.000Z"); // 02:30 BST
      expect(s.warnings).toEqual(["END_NONEXISTENT_LOCAL_TIME_SHIFTED"]);
      expect(s.normalisedEndTime).toBe("02:30");
      expect(s.durationMinutes).toBe(330);
    });

    it("a shift starting in the fall-back hour starts at its first occurrence", () => {
      const s = buildShiftInstants({ date: "2026-10-25", startTime: "01:30", endTime: "09:30", timezone: LONDON });
      expect(s.startsAt.toISOString()).toBe("2026-10-25T00:30:00.000Z"); // 01:30 BST
      expect(s.endsAt.toISOString()).toBe("2026-10-25T09:30:00.000Z"); // 09:30 GMT
      expect(s.durationMinutes).toBe(540);
      expect(s.warnings).toEqual(["START_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE"]);
    });

    it("a 24h shift across the fall-back night lasts 25 real hours and keeps its local times", () => {
      const s = buildShiftInstants({ date: "2026-10-24", startTime: "09:00", endTime: "09:00", timezone: LONDON });
      expect(s.startsAt.toISOString()).toBe("2026-10-24T08:00:00.000Z");
      expect(s.endsAt.toISOString()).toBe("2026-10-25T09:00:00.000Z");
      expect(s.durationMinutes).toBe(25 * 60);
    });

    it("ending at 00:00 means midnight at the end of the start day", () => {
      const s = buildShiftInstants({ date: "2026-10-06", startTime: "18:00", endTime: "00:00", timezone: LONDON });
      expect(s.isOvernight).toBe(true);
      expect(s.endDate).toBe("2026-10-07");
      expect(s.endsAt.toISOString()).toBe("2026-10-06T23:00:00.000Z");
      expect(s.durationMinutes).toBe(360);
    });

    it("crosses month and year boundaries", () => {
      const s = buildShiftInstants({ date: "2026-12-31", startTime: "22:00", endTime: "06:00", timezone: NEW_YORK });
      expect(s.endDate).toBe("2027-01-01");
      expect(s.startsAt.toISOString()).toBe("2027-01-01T03:00:00.000Z");
      expect(s.endsAt.toISOString()).toBe("2027-01-01T11:00:00.000Z");
      expect(formatShiftRange(s.startsAt, s.endsAt, NEW_YORK, { includeYear: true })).toBe(
        "Thu 31 Dec 2026, 22:00–06:00 (+1)",
      );
    });

    it("a one-minute-apart pair is overnight only when end <= start", () => {
      expect(buildShiftInstants({ date: "2026-10-06", startTime: "09:00", endTime: "09:01", timezone: LONDON }).isOvernight).toBe(
        false,
      );
      const s = buildShiftInstants({ date: "2026-10-06", startTime: "09:01", endTime: "09:00", timezone: LONDON });
      expect(s.isOvernight).toBe(true);
      expect(s.durationMinutes).toBe(1439);
    });
  });

  it("reports a nonexistent start time and the normalised value", () => {
    const s = buildShiftInstants({ date: "2026-03-08", startTime: "02:30", endTime: "10:00", timezone: NEW_YORK });
    expect(s.warnings).toEqual(["START_NONEXISTENT_LOCAL_TIME_SHIFTED"]);
    expect(s.normalisedStartTime).toBe("03:30");
    expect(s.startsAt.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(s.durationMinutes).toBe(390);
  });

  it("reports an ambiguous end time on an overnight fall-back shift", () => {
    const s = buildShiftInstants({ date: "2026-10-24", startTime: "20:00", endTime: "01:30", timezone: LONDON });
    expect(s.warnings).toEqual(["END_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE"]);
    expect(s.endsAt.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(s.normalisedEndTime).toBeUndefined();
  });

  it("throws when DST normalisation leaves the end at or before the start", () => {
    try {
      buildShiftInstants({ date: "2026-03-29", startTime: "01:30", endTime: "02:15", timezone: LONDON });
      expect.unreachable("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("VALIDATION_ERROR");
      expect((e as AppError).details).toMatchObject({ reason: "SHIFT_END_NOT_AFTER_START" });
    }
  });

  it.each<[string, Partial<{ date: string; startTime: string; endTime: string }>]>([
    ["date", { date: "2026-02-30" }],
    ["startTime", { startTime: "9:00" }],
    ["endTime", { endTime: "24:00" }],
  ])("names the invalid field (%s) in the error details", (field, over) => {
    try {
      buildShiftInstants({ date: "2026-10-06", startTime: "09:00", endTime: "17:00", timezone: LONDON, ...over });
      expect.unreachable("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("VALIDATION_ERROR");
      expect((e as AppError).details).toMatchObject({ field });
    }
  });

  it("propagates validation errors", () => {
    expect(() =>
      buildShiftInstants({ date: "2026-02-30", startTime: "09:00", endTime: "17:00", timezone: LONDON }),
    ).toThrow(AppError);
    expect(() =>
      buildShiftInstants({ date: "2026-10-06", startTime: "9:00", endTime: "17:00", timezone: LONDON }),
    ).toThrow(AppError);
    try {
      buildShiftInstants({ date: "2026-10-06", startTime: "09:00", endTime: "17:00", timezone: "Not/AZone" });
      expect.unreachable("expected a throw");
    } catch (e) {
      expect((e as AppError).code).toBe("INVALID_TIMEZONE");
    }
  });
});

describe("formatShiftRange", () => {
  it("formats a same-day shift", () => {
    const out = formatShiftRange(
      new Date("2026-10-06T08:00:00Z"),
      new Date("2026-10-06T14:00:00Z"),
      LONDON,
    );
    expect(out).toBe("Tue 6 Oct, 09:00–15:00");
  });

  it("marks overnight shifts with (+1)", () => {
    const out = formatShiftRange(
      new Date("2026-10-24T21:00:00Z"),
      new Date("2026-10-25T06:00:00Z"),
      LONDON,
    );
    expect(out).toBe("Sat 24 Oct, 22:00–06:00 (+1)");
  });

  it("counts multi-day differences and can include the year", () => {
    const out = formatShiftRange(
      new Date("2026-10-06T08:00:00Z"),
      new Date("2026-10-08T14:00:00Z"),
      LONDON,
      { includeYear: true },
    );
    expect(out).toBe("Tue 6 Oct 2026, 09:00–15:00 (+2)");
  });

  it("renders in the requested zone", () => {
    const out = formatShiftRange(
      new Date("2026-07-04T13:00:00Z"),
      new Date("2026-07-04T21:00:00Z"),
      NEW_YORK,
    );
    expect(out).toBe("Sat 4 Jul, 09:00–17:00");
  });

  it("rejects invalid zones and instants", () => {
    expect(() => formatShiftRange(new Date(), new Date(), "Bad/Zone")).toThrow(AppError);
    expect(() => formatShiftRange(new Date(Number.NaN), new Date(), LONDON)).toThrow(AppError);
  });
});
