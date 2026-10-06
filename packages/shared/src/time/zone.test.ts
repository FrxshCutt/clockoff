import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import {
  addLocalDays,
  canonicalTimeZone,
  endOfLocalDay,
  floatingMsToWallClock,
  instantToLocal,
  instantToWallClock,
  isValidTimeZone,
  isValidWallClock,
  localDateOf,
  localDateRange,
  localToInstant,
  resolveWallClock,
  startOfLocalDay,
  toDeviceDateComponents,
  wallClockMinutesBetween,
  wallClockToFloatingMs,
  weekStart,
  type WallClock,
} from "./zone";

const LONDON = "Europe/London";
const NEW_YORK = "America/New_York";
const SYDNEY = "Australia/Sydney";

const utc = (iso: string): Date => new Date(iso);

describe("isValidTimeZone / canonicalTimeZone", () => {
  it.each([
    ["Europe/London", true],
    ["America/New_York", true],
    ["Australia/Sydney", true],
    ["UTC", true],
    ["Etc/UTC", true],
    ["europe/london", true],
    ["Foo/Bar", false],
    ["", false],
    ["+01:00", false],
    ["-05:00", false],
    ["local", false],
  ])("isValidTimeZone(%j) → %s", (tz, expected) => {
    expect(isValidTimeZone(tz)).toBe(expected);
  });

  it("rejects non-strings", () => {
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });

  it("gives stable answers on repeated calls (validity is cached for valid zones only)", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(isValidTimeZone("Europe/London")).toBe(true);
      expect(isValidTimeZone("Foo/Bar")).toBe(false);
      expect(isValidTimeZone("+01:00")).toBe(false);
    }
    expect(isValidTimeZone("x".repeat(65))).toBe(false);
  });

  it("canonicalises spelling and returns null for junk", () => {
    expect(canonicalTimeZone("europe/london")).toBe("Europe/London");
    expect(canonicalTimeZone("Europe/London")).toBe("Europe/London");
    expect(canonicalTimeZone("EUROPE/LONDON")).toBe("Europe/London");
    expect(canonicalTimeZone("america/new_york")).toBe("America/New_York");
    expect(canonicalTimeZone("utc")).toBe("UTC");
    expect(canonicalTimeZone("Nowhere/Town")).toBeNull();
    expect(canonicalTimeZone("+01:00")).toBeNull();
  });

  it.each([
    // ICU maps these current IANA names to legacy aliases; a correctly spelled name must come back unchanged.
    "Asia/Kolkata",
    "Europe/Kyiv",
    "Asia/Ho_Chi_Minh",
    "Asia/Kathmandu",
    "America/Argentina/Buenos_Aires",
    "Etc/UTC",
    "America/Port-au-Prince",
  ])("canonicalTimeZone keeps the valid identifier %s as given", (tz) => {
    expect(canonicalTimeZone(tz)).toBe(tz);
  });

  it("canonicalTimeZone falls back to the equivalent ICU identifier only for a mis-cased alias", () => {
    const fallback = canonicalTimeZone("asia/kolkata");
    expect(fallback === "Asia/Calcutta" || fallback === "Asia/Kolkata").toBe(true);
    // Whatever spelling comes back names the same zone.
    expect(
      localToInstant({
        date: "2026-10-06",
        time: "09:00",
        timezone: fallback!,
      }).instant.toISOString(),
    ).toBe("2026-10-06T03:30:00.000Z");
  });
});

describe("localToInstant — Europe/London DST (spring forward 2026-03-29 01:00 GMT → 02:00 BST)", () => {
  it("moves a nonexistent 01:30 forward to 02:30 BST with a warning", () => {
    const r = localToInstant({ date: "2026-03-29", time: "01:30", timezone: LONDON });
    expect(r.instant.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(r.warning).toBe("NONEXISTENT_LOCAL_TIME_SHIFTED");
    expect(r.normalisedLocalTime).toBe("02:30");
  });

  it("01:00 (the first skipped minute) becomes 02:00 BST", () => {
    const r = localToInstant({ date: "2026-03-29", time: "01:00", timezone: LONDON });
    expect(r.instant.toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(r.normalisedLocalTime).toBe("02:00");
  });

  it("02:30 exists in London on that day (02:30 BST = 01:30Z) and carries no warning", () => {
    // The spec's "02:30 → 03:30" example describes US zones; London skips 01:00–01:59.
    const r = localToInstant({ date: "2026-03-29", time: "02:30", timezone: LONDON });
    expect(r.instant.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(r.warning).toBeUndefined();
    expect(r.normalisedLocalTime).toBeUndefined();
  });

  it("times just either side of the gap resolve plainly", () => {
    expect(
      localToInstant({ date: "2026-03-29", time: "00:59", timezone: LONDON }).instant.toISOString(),
    ).toBe("2026-03-29T00:59:00.000Z");
    expect(
      localToInstant({ date: "2026-03-29", time: "02:00", timezone: LONDON }).instant.toISOString(),
    ).toBe("2026-03-29T01:00:00.000Z");
  });
});

describe("localToInstant — Europe/London DST (fall back 2026-10-25 02:00 BST → 01:00 GMT)", () => {
  it("ambiguous 01:30 takes the first occurrence (BST, 00:30Z)", () => {
    const r = localToInstant({ date: "2026-10-25", time: "01:30", timezone: LONDON });
    expect(r.instant.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(r.warning).toBe("AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE");
    expect(r.normalisedLocalTime).toBeUndefined();
  });

  it("01:00 is ambiguous too and resolves to 00:00Z", () => {
    const r = localToInstant({ date: "2026-10-25", time: "01:00", timezone: LONDON });
    expect(r.instant.toISOString()).toBe("2026-10-25T00:00:00.000Z");
    expect(r.warning).toBe("AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE");
  });

  it("00:30 (BST) and 02:00 (GMT) are unambiguous", () => {
    const before = localToInstant({ date: "2026-10-25", time: "00:30", timezone: LONDON });
    expect(before.instant.toISOString()).toBe("2026-10-24T23:30:00.000Z");
    expect(before.warning).toBeUndefined();
    const after = localToInstant({ date: "2026-10-25", time: "02:00", timezone: LONDON });
    expect(after.instant.toISOString()).toBe("2026-10-25T02:00:00.000Z");
    expect(after.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Independent oracles
// ---------------------------------------------------------------------------------------------------------

/** Day of month of the last Sunday of `month` (1–12): pure calendar arithmetic, no tz database. */
function lastSunday(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)); // day 0 of the next month
  return lastDay.getUTCDate() - lastDay.getUTCDay(); // getUTCDay: 0 = Sunday
}

/** UK offset (minutes) under the EU rule: BST from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October. */
function ukOffsetMinutes(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  const start = Date.UTC(y, 2, lastSunday(y, 3), 1);
  const end = Date.UTC(y, 9, lastSunday(y, 10), 1);
  return ms >= start && ms < end ? 60 : 0;
}

describe("Europe/London against the EU rule computed by hand (independent of the tz database)", () => {
  it("the 2026 transitions are Sunday 29 March and Sunday 25 October, both at 01:00 UTC", () => {
    expect(lastSunday(2026, 3)).toBe(29);
    expect(lastSunday(2026, 10)).toBe(25);
    expect(ukOffsetMinutes(Date.UTC(2026, 2, 29, 0, 59))).toBe(0);
    expect(ukOffsetMinutes(Date.UTC(2026, 2, 29, 1, 0))).toBe(60);
    expect(ukOffsetMinutes(Date.UTC(2026, 9, 25, 0, 59))).toBe(60);
    expect(ukOffsetMinutes(Date.UTC(2026, 9, 25, 1, 0))).toBe(0);
  });

  it.each(["2026-03-28", "2026-03-29", "2026-03-30", "2026-10-24", "2026-10-25", "2026-10-26"])(
    "every local minute of %s resolves as the rule predicts",
    (date) => {
      const [y, m, d] = date.split("-").map(Number) as [number, number, number];
      for (let minuteOfDay = 0; minuteOfDay < 1440; minuteOfDay += 1) {
        const floating = Date.UTC(y, m - 1, d, 0, minuteOfDay);
        // Candidate instants for this wall time are floating − 0 (GMT) and floating − 60 min (BST).
        const valid = [0, 60]
          .map((o) => floating - o * 60_000)
          .filter((ms) => ukOffsetMinutes(ms) === (floating - ms) / 60_000);
        const expected = valid.length > 0 ? Math.min(...valid) : floating; // gap: shift forward = read with GMT (0)
        const expectedWarning =
          valid.length === 0
            ? "NONEXISTENT_LOCAL_TIME_SHIFTED"
            : valid.length === 2
              ? "AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE"
              : undefined;
        const r = resolveWallClock(floatingMsToWallClock(floating), LONDON);
        expect([r.instant.getTime(), r.warning], `${date} minute ${minuteOfDay}`).toEqual([
          expected,
          expectedWarning,
        ]);
      }
    },
  );

  it("summarises the two days: 60 nonexistent minutes in March, 60 ambiguous minutes in October", () => {
    const count = (date: [number, number, number], warning: string): number => {
      let n = 0;
      for (let minute = 0; minute < 1440; minute += 1) {
        const wc = floatingMsToWallClock(Date.UTC(date[0], date[1] - 1, date[2], 0, minute));
        if (resolveWallClock(wc, LONDON).warning === warning) n += 1;
      }
      return n;
    };
    expect(count([2026, 3, 29], "NONEXISTENT_LOCAL_TIME_SHIFTED")).toBe(60);
    expect(count([2026, 3, 29], "AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE")).toBe(0);
    expect(count([2026, 10, 25], "AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE")).toBe(60);
    expect(count([2026, 10, 25], "NONEXISTENT_LOCAL_TIME_SHIFTED")).toBe(0);
  });
});

const intlFormatters = new Map<string, Intl.DateTimeFormat>();

/** Local wall-clock of `ms` in `tz` straight from Intl.DateTimeFormat (not Luxon), as floating ms. */
function intlFloatingMs(ms: number, tz: string): number {
  let fmt = intlFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    intlFormatters.set(tz, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

describe("resolveWallClock against a brute-force Intl oracle", () => {
  // Zones with unusual transitions: 30-minute DST (Lord Howe), +12:45/+13:45 (Chatham), midnight gaps
  // (Santiago, Havana), several transitions a year (Casablanca), plus the usual suspects.
  const ZONES = [
    LONDON,
    NEW_YORK,
    SYDNEY,
    "Australia/Lord_Howe",
    "Pacific/Chatham",
    "America/Santiago",
    "America/Havana",
    "Africa/Casablanca",
  ];
  const QUARTER = 15 * 60_000;
  const HOUR = 60 * 60_000;

  it.each(ZONES)("%s: every quarter-hour around each 2026 transition", (tz) => {
    const yearStart = Date.UTC(2026, 0, 1);
    const yearEnd = Date.UTC(2027, 0, 1);
    let previousOffset = intlFloatingMs(yearStart, tz) - yearStart;
    let transitions = 0;
    for (let t = yearStart + 3 * HOUR; t <= yearEnd; t += 3 * HOUR) {
      const offset = intlFloatingMs(t, tz) - t;
      if (offset === previousOffset) continue;
      transitions += 1;
      // Every instant in a window around the change, grouped by the wall-clock it shows.
      const instantsByWall = new Map<number, number[]>();
      for (let i = t - 48 * HOUR; i <= t + 48 * HOUR; i += QUARTER) {
        const wall = intlFloatingMs(i, tz);
        instantsByWall.set(wall, [...(instantsByWall.get(wall) ?? []), i]);
      }
      const from = Math.ceil(intlFloatingMs(t - 24 * HOUR, tz) / QUARTER) * QUARTER;
      const to = intlFloatingMs(t + 24 * HOUR, tz);
      for (let wall = from; wall <= to; wall += QUARTER) {
        const instants = instantsByWall.get(wall);
        const r = resolveWallClock(floatingMsToWallClock(wall), tz);
        if (instants) {
          expect(r.instant.getTime(), `${tz} ${new Date(wall).toISOString()}`).toBe(
            Math.min(...instants),
          );
          expect(r.warning).toBe(
            instants.length > 1 ? "AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE" : undefined,
          );
        } else {
          // Nonexistent: moved forward by the gap = the wall time read with the pre-transition offset.
          expect(r.instant.getTime(), `${tz} ${new Date(wall).toISOString()}`).toBe(
            wall - previousOffset,
          );
          expect(r.warning).toBe("NONEXISTENT_LOCAL_TIME_SHIFTED");
          expect(wallClockToFloatingMs(r.wallClock)).toBe(intlFloatingMs(r.instant.getTime(), tz));
        }
      }
      previousOffset = offset;
    }
    expect(transitions).toBeGreaterThanOrEqual(2);
  });
});

describe("localToInstant — America/New_York and Australia/Sydney spot checks", () => {
  it("New York 2026-03-08 02:30 does not exist → 03:30 EDT (07:30Z) with warning", () => {
    const r = localToInstant({ date: "2026-03-08", time: "02:30", timezone: NEW_YORK });
    expect(r.instant.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(r.warning).toBe("NONEXISTENT_LOCAL_TIME_SHIFTED");
    expect(r.normalisedLocalTime).toBe("03:30");
  });

  it("New York 2026-11-01 01:30 is ambiguous → first occurrence EDT (05:30Z)", () => {
    const r = localToInstant({ date: "2026-11-01", time: "01:30", timezone: NEW_YORK });
    expect(r.instant.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(r.warning).toBe("AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE");
  });

  it("New York summer 09:00 → 13:00Z", () => {
    const r = localToInstant({ date: "2026-07-04", time: "09:00", timezone: NEW_YORK });
    expect(r.instant.toISOString()).toBe("2026-07-04T13:00:00.000Z");
    expect(r.warning).toBeUndefined();
  });

  it("Sydney 2026-04-05 02:30 is ambiguous (DST ends) → first occurrence AEDT (+11)", () => {
    const r = localToInstant({ date: "2026-04-05", time: "02:30", timezone: SYDNEY });
    expect(r.instant.toISOString()).toBe("2026-04-04T15:30:00.000Z");
    expect(r.warning).toBe("AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE");
  });

  it("Sydney 2026-10-04 02:30 does not exist (DST starts) → 03:30 AEDT", () => {
    const r = localToInstant({ date: "2026-10-04", time: "02:30", timezone: SYDNEY });
    expect(r.instant.toISOString()).toBe("2026-10-03T16:30:00.000Z");
    expect(r.warning).toBe("NONEXISTENT_LOCAL_TIME_SHIFTED");
    expect(r.normalisedLocalTime).toBe("03:30");
  });

  it("Sydney summer 09:00 is the previous UTC day", () => {
    const r = localToInstant({ date: "2026-01-15", time: "09:00", timezone: SYDNEY });
    expect(r.instant.toISOString()).toBe("2026-01-14T22:00:00.000Z");
  });

  it("Santiago skips local midnight (2026-09-06 00:00 → 01:00): 00:30 → 01:30 -03 with warning", () => {
    const r = localToInstant({ date: "2026-09-06", time: "00:30", timezone: "America/Santiago" });
    expect(r.instant.toISOString()).toBe("2026-09-06T04:30:00.000Z");
    expect(r.warning).toBe("NONEXISTENT_LOCAL_TIME_SHIFTED");
    expect(r.normalisedLocalTime).toBe("01:30");
  });

  it("UTC is a valid zone and never warns", () => {
    const r = localToInstant({ date: "2026-03-29", time: "01:30", timezone: "UTC" });
    expect(r.instant.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(r.warning).toBeUndefined();
  });
});

describe("localToInstant — validation", () => {
  it("rejects unknown timezones with INVALID_TIMEZONE", () => {
    expect(() =>
      localToInstant({ date: "2026-10-06", time: "09:00", timezone: "Mars/Olympus" }),
    ).toThrow(AppError);
    try {
      localToInstant({ date: "2026-10-06", time: "09:00", timezone: "Mars/Olympus" });
    } catch (e) {
      expect((e as AppError).code).toBe("INVALID_TIMEZONE");
      expect((e as AppError).status).toBe(400);
    }
  });

  it.each([
    ["2026-02-30", "09:00"],
    ["2026-13-01", "09:00"],
    ["06/10/2026", "09:00"],
    ["2026-10-06", "9:00"],
    ["2026-10-06", "24:00"],
    ["2026-10-06", "09:60"],
    ["2026-10-06", "0900"],
  ])("rejects date=%s time=%s with VALIDATION_ERROR", (date, time) => {
    try {
      localToInstant({ date, time, timezone: LONDON });
      expect.unreachable("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("instantToLocal / toDeviceDateComponents", () => {
  it("renders a BST instant", () => {
    const parts = instantToLocal(utc("2026-10-06T08:00:00Z"), LONDON);
    expect(parts).toEqual({
      date: "2026-10-06",
      time: "09:00",
      offsetMinutes: 60,
      weekday: 2,
      iso: "2026-10-06T09:00:00+01:00",
    });
  });

  it("renders a negative-offset instant and the ISO weekday for Sunday", () => {
    const parts = instantToLocal(utc("2026-01-04T05:00:00Z"), NEW_YORK);
    expect(parts.date).toBe("2026-01-04");
    expect(parts.time).toBe("00:00");
    expect(parts.offsetMinutes).toBe(-300);
    expect(parts.weekday).toBe(7);
    expect(parts.iso).toBe("2026-01-04T00:00:00-05:00");
  });

  it("round-trips through localToInstant", () => {
    const original = { date: "2026-07-15", time: "13:45", timezone: SYDNEY };
    const { instant } = localToInstant(original);
    const back = instantToLocal(instant, SYDNEY);
    expect(back.date).toBe(original.date);
    expect(back.time).toBe(original.time);
    expect(back.offsetMinutes).toBe(600);
  });

  it("device components are the local wall-clock, month 1-based", () => {
    expect(toDeviceDateComponents(utc("2026-03-29T05:00:00Z"), LONDON)).toEqual({
      year: 2026,
      month: 3,
      day: 29,
      hour: 6,
      minute: 0,
      second: 0,
    });
    expect(toDeviceDateComponents(utc("2026-12-31T23:30:15Z"), SYDNEY)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
      hour: 10,
      minute: 30,
      second: 15,
    });
  });

  it("rejects invalid Dates", () => {
    expect(() => instantToLocal(new Date(Number.NaN), LONDON)).toThrow(AppError);
  });

  it.each<[string, string, WallClock]>([
    // Europe/London spring forward: the last GMT second, then 01:00Z is already 02:00 BST.
    [
      "2026-03-29T00:59:59Z",
      LONDON,
      { year: 2026, month: 3, day: 29, hour: 0, minute: 59, second: 59 },
    ],
    [
      "2026-03-29T01:00:00Z",
      LONDON,
      { year: 2026, month: 3, day: 29, hour: 2, minute: 0, second: 0 },
    ],
    // Europe/London fall back: 00:30Z (BST) and 01:30Z (GMT) are both 01:30 local.
    [
      "2026-10-25T00:30:00Z",
      LONDON,
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30, second: 0 },
    ],
    [
      "2026-10-25T01:30:00Z",
      LONDON,
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30, second: 0 },
    ],
    [
      "2026-10-25T02:00:00Z",
      LONDON,
      { year: 2026, month: 10, day: 25, hour: 2, minute: 0, second: 0 },
    ],
    // A summer instant in each of three DST-shifted zones.
    [
      "2026-07-04T13:00:00Z",
      NEW_YORK,
      { year: 2026, month: 7, day: 4, hour: 9, minute: 0, second: 0 },
    ],
    [
      "2026-01-14T22:00:00Z",
      SYDNEY,
      { year: 2026, month: 1, day: 15, hour: 9, minute: 0, second: 0 },
    ],
    [
      "2026-06-30T23:00:00Z",
      LONDON,
      { year: 2026, month: 7, day: 1, hour: 0, minute: 0, second: 0 },
    ],
    // New York spring forward (07:00Z = 03:00 EDT) and both 01:30s on the fall-back morning.
    [
      "2026-03-08T07:00:00Z",
      NEW_YORK,
      { year: 2026, month: 3, day: 8, hour: 3, minute: 0, second: 0 },
    ],
    [
      "2026-11-01T05:30:00Z",
      NEW_YORK,
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
    ],
    [
      "2026-11-01T06:30:00Z",
      NEW_YORK,
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
    ],
    // Sydney DST start (16:00Z = 03:00 AEDT on 4 Oct) and a 30-minute DST zone (Lord Howe, +10:30 → +11).
    [
      "2026-10-03T16:00:00Z",
      SYDNEY,
      { year: 2026, month: 10, day: 4, hour: 3, minute: 0, second: 0 },
    ],
    [
      "2026-10-03T15:29:00Z",
      "Australia/Lord_Howe",
      { year: 2026, month: 10, day: 4, hour: 1, minute: 59, second: 0 },
    ],
    [
      "2026-10-03T15:30:00Z",
      "Australia/Lord_Howe",
      { year: 2026, month: 10, day: 4, hour: 2, minute: 30, second: 0 },
    ],
  ])(
    "toDeviceDateComponents(%s, %s) uses the offset in force at that instant",
    (iso, tz, expected) => {
      expect(toDeviceDateComponents(utc(iso), tz)).toEqual(expected);
    },
  );

  it("toDeviceDateComponents agrees with Intl every ~2 hours through 2026 in DST zones", () => {
    for (const tz of [LONDON, NEW_YORK, SYDNEY, "America/Santiago"]) {
      for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 2 * 3_600_000 + 61_000) {
        expect(wallClockToFloatingMs(toDeviceDateComponents(new Date(ms), tz)), `${tz} ${ms}`).toBe(
          intlFloatingMs(ms, tz),
        );
      }
    }
  });

  it("device components resolve back to the same instant, except the second pass of a fall-back hour", () => {
    for (const iso of [
      "2026-03-28T22:00:00Z",
      "2026-03-29T05:00:00Z",
      "2026-10-24T21:00:00Z",
      "2026-10-25T00:30:00Z",
    ]) {
      expect(
        resolveWallClock(toDeviceDateComponents(utc(iso), LONDON), LONDON).instant.toISOString(),
      ).toBe(utc(iso).toISOString());
    }
    // 01:30 GMT shows the same components as 01:30 BST, which resolve to the first (BST) occurrence: use the
    // UTC instant, not the components, for anything that must be exact.
    expect(
      resolveWallClock(
        toDeviceDateComponents(utc("2026-10-25T01:30:00Z"), LONDON),
        LONDON,
      ).instant.toISOString(),
    ).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("year safety (years 0–99 are not remapped to 1900–1999)", () => {
  it("localToInstant / addLocalDays / instantToWallClock keep year 26", () => {
    expect(
      localToInstant({ date: "0026-10-06", time: "09:00", timezone: "UTC" }).instant.toISOString(),
    ).toBe("0026-10-06T09:00:00.000Z");
    expect(addLocalDays("0050-01-01", 1)).toBe("0050-01-02");
    expect(addLocalDays("0099-12-31", 1)).toBe("0100-01-01");
    expect(instantToWallClock(utc("0026-10-06T09:00:00Z"), "UTC")).toEqual({
      year: 26,
      month: 10,
      day: 6,
      hour: 9,
      minute: 0,
      second: 0,
    });
  });
});

describe("resolveWallClock input guard", () => {
  it.each<Partial<WallClock>>([
    { month: 13 },
    { day: 31, month: 2 },
    { hour: 24 },
    { minute: 60 },
    { second: 1.5 },
  ])("rejects %j with VALIDATION_ERROR", (over) => {
    const wc: WallClock = { year: 2026, month: 10, day: 6, hour: 9, minute: 0, second: 0, ...over };
    expect(isValidWallClock(wc)).toBe(false);
    try {
      resolveWallClock(wc, LONDON);
      expect.unreachable("expected a throw");
    } catch (e) {
      expect((e as AppError).code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("local day / week boundaries", () => {
  it("startOfLocalDay / endOfLocalDay give a 23h day on spring-forward and 25h on fall-back", () => {
    const spring = utc("2026-03-29T12:00:00Z");
    expect(startOfLocalDay(spring, LONDON).toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(endOfLocalDay(spring, LONDON).toISOString()).toBe("2026-03-29T23:00:00.000Z");

    const fall = utc("2026-10-25T12:00:00Z");
    expect(startOfLocalDay(fall, LONDON).toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(endOfLocalDay(fall, LONDON).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("startOfLocalDay / localDateRange handle a day whose midnight does not exist (America/Santiago)", () => {
    const SANTIAGO = "America/Santiago";
    expect(startOfLocalDay(utc("2026-09-06T15:00:00Z"), SANTIAGO).toISOString()).toBe(
      "2026-09-06T04:00:00.000Z",
    );
    expect(endOfLocalDay(utc("2026-09-05T15:00:00Z"), SANTIAGO).toISOString()).toBe(
      "2026-09-06T04:00:00.000Z",
    );
    const [start, end] = localDateRange("2026-09-06", "2026-09-06", SANTIAGO);
    expect(start.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-07T03:00:00.000Z"); // a 23h day
  });

  it("endOfLocalDay is exclusive: it equals the next day's startOfLocalDay", () => {
    const d = utc("2026-07-10T15:00:00Z");
    expect(endOfLocalDay(d, NEW_YORK).getTime()).toBe(
      startOfLocalDay(utc("2026-07-11T15:00:00Z"), NEW_YORK).getTime(),
    );
  });

  it("localDateRange covers inclusive local dates as a half-open instant range", () => {
    const [start, end] = localDateRange("2026-10-24", "2026-10-25", LONDON);
    expect(start.toISOString()).toBe("2026-10-23T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-26T00:00:00.000Z");

    const [s1, e1] = localDateRange("2026-01-01", "2026-01-01", SYDNEY);
    expect(s1.toISOString()).toBe("2025-12-31T13:00:00.000Z");
    expect(e1.toISOString()).toBe("2026-01-01T13:00:00.000Z");
  });

  it("localDateRange rejects reversed or malformed ranges", () => {
    expect(() => localDateRange("2026-10-25", "2026-10-24", LONDON)).toThrow(AppError);
    expect(() => localDateRange("2026-10-32", "2026-11-01", LONDON)).toThrow(AppError);
  });

  it.each([
    ["2026-02-28", 1, "2026-03-01"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-01-01", -1, "2025-12-31"],
    ["2026-10-06", 0, "2026-10-06"],
    ["2026-10-06", 30, "2026-11-05"],
  ])("addLocalDays(%s, %i) → %s", (date, n, expected) => {
    expect(addLocalDays(date, n)).toBe(expected);
  });

  it("addLocalDays rejects fractional n and bad dates", () => {
    expect(() => addLocalDays("2026-10-06", 1.5)).toThrow(AppError);
    expect(() => addLocalDays("2026-02-30", 1)).toThrow(AppError);
  });

  it("localDateOf uses the zone's calendar", () => {
    expect(localDateOf(utc("2026-10-06T23:30:00Z"), LONDON)).toBe("2026-10-07");
    expect(localDateOf(utc("2026-10-06T23:30:00Z"), NEW_YORK)).toBe("2026-10-06");
  });

  it("weekStart defaults to Monday and honours weekStartsOn", () => {
    const wed = utc("2026-10-07T10:00:00Z");
    expect(weekStart(wed, LONDON).toISOString()).toBe("2026-10-04T23:00:00.000Z"); // Mon 5 Oct 00:00 BST
    const sun = utc("2026-10-11T10:00:00Z");
    expect(weekStart(sun, LONDON).toISOString()).toBe("2026-10-04T23:00:00.000Z");
    const mon = utc("2026-10-05T10:00:00Z");
    expect(weekStart(mon, LONDON).toISOString()).toBe("2026-10-04T23:00:00.000Z");
    expect(weekStart(wed, LONDON, 7).toISOString()).toBe("2026-10-03T23:00:00.000Z"); // Sun 4 Oct
    expect(() => weekStart(wed, LONDON, 0 as never)).toThrow(AppError);
  });

  it("weekStart uses the offset of the week's first day, not of the instant", () => {
    // Sunday 29 March 13:00 BST belongs to the week starting Monday 23 March 00:00 GMT.
    expect(weekStart(utc("2026-03-29T12:00:00Z"), LONDON).toISOString()).toBe(
      "2026-03-23T00:00:00.000Z",
    );
    // Wednesday 28 October (GMT) belongs to the week starting Monday 26 October 00:00 GMT.
    expect(weekStart(utc("2026-10-28T12:00:00Z"), LONDON).toISOString()).toBe(
      "2026-10-26T00:00:00.000Z",
    );
    // Wednesday 1 April (BST) → Monday 30 March 00:00 BST.
    expect(weekStart(utc("2026-04-01T12:00:00Z"), LONDON).toISOString()).toBe(
      "2026-03-29T23:00:00.000Z",
    );
  });

  it("wallClockMinutesBetween is 0 between the two occurrences of an ambiguous time", () => {
    expect(
      wallClockMinutesBetween(utc("2026-10-25T00:30:00Z"), utc("2026-10-25T01:30:00Z"), LONDON),
    ).toBe(0);
  });

  it("wallClockMinutesBetween ignores DST", () => {
    expect(
      wallClockMinutesBetween(utc("2026-03-28T22:00:00Z"), utc("2026-03-29T05:00:00Z"), LONDON),
    ).toBe(480);
    expect(
      wallClockMinutesBetween(utc("2026-10-24T21:00:00Z"), utc("2026-10-25T06:00:00Z"), LONDON),
    ).toBe(480);
  });
});
