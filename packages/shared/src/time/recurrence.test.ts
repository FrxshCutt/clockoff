import { RRule } from "rrule";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import {
  DEFAULT_RECURRENCE_MAX,
  RECURRENCE_MAX_SPAN_DAYS,
  expandRecurrence,
  expandShiftSeries,
  formatRecurrenceRule,
  recurrenceUntilFromLocalDate,
  validateRecurrenceRule,
  type ExpandRecurrenceInput,
  type ExpandShiftSeriesInput,
} from "./recurrence";
import { buildShiftInstants } from "./shift";
import { instantToLocal, localToInstant, wallClockMinutesBetween } from "./zone";

const LONDON = "Europe/London";
const NEW_YORK = "America/New_York";
const SYDNEY = "Australia/Sydney";
const DAY_MS = 86_400_000;

const utc = (iso: string): Date => new Date(iso);
const at = (date: string, time: string, timezone: string): Date => localToInstant({ date, time, timezone }).instant;
const isoList = (xs: ReadonlyArray<{ startsAt: Date }>): string[] => xs.map((x) => x.startsAt.toISOString());
const localTimes = (xs: ReadonlyArray<{ startsAt: Date }>, tz: string): string[] =>
  xs.map((x) => {
    const l = instantToLocal(x.startsAt, tz);
    return `${l.date} ${l.time}`;
  });

function expectAppError(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable("expected an AppError");
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
  }
}

describe("validateRecurrenceRule", () => {
  it.each<[string, string]>([
    ["FREQ=DAILY", "FREQ=DAILY"],
    ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", "FREQ=WEEKLY;BYDAY=MO,WE,FR"],
    ["rrule:freq=weekly;byday=fr,mo,we", "FREQ=WEEKLY;BYDAY=MO,WE,FR"],
    ["FREQ=WEEKLY;BYDAY=MO,MO,TU", "FREQ=WEEKLY;BYDAY=MO,TU"],
    ["FREQ=WEEKLY;INTERVAL=1", "FREQ=WEEKLY"],
    ["WKST=SU;BYDAY=TU,TH;INTERVAL=2;FREQ=WEEKLY", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU"],
    ["FREQ=WEEKLY;WKST=MO", "FREQ=WEEKLY"],
    ["FREQ=MONTHLY;BYDAY=+1MO", "FREQ=MONTHLY;BYDAY=1MO"],
    ["FREQ=MONTHLY;BYDAY=-1FR", "FREQ=MONTHLY;BYDAY=-1FR"],
    ["FREQ=MONTHLY;BYMONTHDAY=15,1,-1", "FREQ=MONTHLY;BYMONTHDAY=-1,1,15"],
    ["FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"],
    ["FREQ=DAILY;COUNT=10;BYMONTH=12,1", "FREQ=DAILY;COUNT=10;BYMONTH=1,12"],
    [" FREQ=DAILY ; BYDAY=SA ", "FREQ=DAILY;BYDAY=SA"],
    ["FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=29", "FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=29"],
  ])("accepts %j → %j", (rule, normalised) => {
    const r = validateRecurrenceRule(rule);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.normalised).toBe(normalised);
    // the canonical form is a fixed point
    expect(validateRecurrenceRule(normalised).normalised).toBe(normalised);
  });

  it.each<[string, string]>([
    ["", "empty"],
    ["   ", "empty"],
    ["BYDAY=MO", "FREQ is required"],
    ["FREQ=HOURLY", "at most daily"],
    ["FREQ=MINUTELY", "at most daily"],
    ["FREQ=YEARLY", "INTERVAL=12"],
    ["FREQ=FORTNIGHTLY", "Unknown FREQ"],
    ["FREQ=DAILY;UNTIL=20261231T000000Z", "UNTIL"],
    ["DTSTART:20261006T090000Z\nRRULE:FREQ=DAILY", "single RRULE line"],
    ["FREQ=DAILY;DTSTART=20261006T090000Z", "DTSTART"],
    ["FREQ=DAILY;TZID=Europe/London", "TZID"],
    ["FREQ=DAILY;BYHOUR=9", "BYHOUR"],
    ["FREQ=DAILY;BYMINUTE=30", "BYMINUTE"],
    ["FREQ=MONTHLY;BYYEARDAY=100", "BYYEARDAY"],
    ["FREQ=MONTHLY;BYWEEKNO=10", "BYWEEKNO"],
    ["FREQ=DAILY;FOO=1", "Unknown RRULE property FOO"],
    ["FREQ=DAILY;FREQ=WEEKLY", "more than once"],
    ["FREQ=DAILY;;BYDAY=MO", "empty part"],
    ["FREQ=DAILY;", "empty part"],
    ["FREQ=DAILY;BYDAY", "expected KEY=VALUE"],
    ["FREQ=DAILY;INTERVAL=0", "INTERVAL must be 1.."],
    ["FREQ=DAILY;INTERVAL=367", "INTERVAL must be 1.."],
    ["FREQ=DAILY;INTERVAL=-1", "INTERVAL must be a positive integer"],
    ["FREQ=DAILY;COUNT=0", "COUNT must be 1.."],
    ["FREQ=DAILY;COUNT=10001", "COUNT must be 1.."],
    ["FREQ=WEEKLY;BYDAY=XX", "Invalid BYDAY"],
    ["FREQ=WEEKLY;BYDAY=1MO", "only allowed with FREQ=MONTHLY"],
    ["FREQ=DAILY;BYDAY=-1FR", "only allowed with FREQ=MONTHLY"],
    ["FREQ=MONTHLY;BYDAY=6MO", "ordinal must be ±1..5"],
    ["FREQ=MONTHLY;BYDAY=0MO", "ordinal must be ±1..5"],
    ["FREQ=WEEKLY;BYMONTHDAY=1", "not allowed with FREQ=WEEKLY"],
    ["FREQ=MONTHLY;BYMONTHDAY=32", "±1..31"],
    ["FREQ=MONTHLY;BYMONTHDAY=0", "±1..31"],
    ["FREQ=MONTHLY;BYMONTHDAY=1.5", "non-integer"],
    ["FREQ=DAILY;BYMONTH=13", "1..12"],
    ["FREQ=DAILY;BYMONTH=-1", "must not be negative"],
    ["FREQ=MONTHLY;BYSETPOS=1", "BYSETPOS requires another BY* part"],
    ["FREQ=MONTHLY;BYDAY=MO;BYSETPOS=400", "±1..366"],
    ["FREQ=WEEKLY;WKST=XX", "Invalid WKST"],
    ["FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30,31", "31 February"],
    ["FREQ=DAILY;BYMONTH=4,6,9,11;BYMONTHDAY=31,-31", "31 February"],
    [`FREQ=DAILY;BYDAY=${"MO,".repeat(200)}MO`, "too long"],
  ])("rejects %j (%s)", (rule, message) => {
    const r = validateRecurrenceRule(rule);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(message);
    expect(r.normalised).toBeUndefined();
  });

  it("rejects non-strings without throwing", () => {
    expect(validateRecurrenceRule(42 as unknown as string)).toEqual({ ok: false, error: "Rule must be a string" });
  });

  it("returns the parsed structure and formatRecurrenceRule round-trips it", () => {
    const r = validateRecurrenceRule("FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR,1MO;BYMONTH=3,1;WKST=SU");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frequency).toBe("MONTHLY");
    expect(r.parsed).toEqual({
      freq: "MONTHLY",
      interval: 2,
      count: null,
      byMonth: [1, 3],
      byMonthDay: [],
      byDay: [
        { weekday: 1, ordinal: 1 },
        { weekday: 5, ordinal: -1 },
      ],
      bySetPos: [],
      wkst: 7,
    });
    expect(formatRecurrenceRule(r.parsed)).toBe(r.normalised);
  });
});

describe("expandRecurrence — DST keeps the local wall-clock", () => {
  it("weekly 09:00 London stays 09:00 local across spring-forward (GMT → BST)", () => {
    const occ = expandRecurrence({
      rule: "FREQ=WEEKLY",
      firstStartsAt: at("2026-03-16", "09:00", LONDON),
      durationMinutes: 360,
      timezone: LONDON,
      until: utc("2026-04-14T00:00:00Z"),
    });
    expect(isoList(occ)).toEqual([
      "2026-03-16T09:00:00.000Z",
      "2026-03-23T09:00:00.000Z",
      "2026-03-30T08:00:00.000Z",
      "2026-04-06T08:00:00.000Z",
      "2026-04-13T08:00:00.000Z",
    ]);
    expect(localTimes(occ, LONDON).map((s) => s.slice(11))).toEqual(["09:00", "09:00", "09:00", "09:00", "09:00"]);
    expect(occ.map((o) => o.localDate)).toEqual(["2026-03-16", "2026-03-23", "2026-03-30", "2026-04-06", "2026-04-13"]);
    for (const o of occ) {
      expect(o.endsAt.getTime() - o.startsAt.getTime()).toBe(360 * 60_000);
      expect(o.warnings).toEqual([]);
    }
    expect(occ.map((o) => o.isAnchor)).toEqual([true, false, false, false, false]);
  });

  it("weekly 09:00 London stays 09:00 local across fall-back (BST → GMT)", () => {
    const occ = expandRecurrence({
      rule: "FREQ=WEEKLY",
      firstStartsAt: at("2026-10-19", "09:00", LONDON),
      durationMinutes: 480,
      timezone: LONDON,
      until: utc("2026-11-03T00:00:00Z"),
    });
    expect(isoList(occ)).toEqual(["2026-10-19T08:00:00.000Z", "2026-10-26T09:00:00.000Z", "2026-11-02T09:00:00.000Z"]);
  });

  it("weekly Mon/Wed/Fri 09:00 New York across 2026-03-08", () => {
    const occ = expandRecurrence({
      rule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      firstStartsAt: at("2026-03-04", "09:00", NEW_YORK),
      durationMinutes: 480,
      timezone: NEW_YORK,
      until: utc("2026-03-14T00:00:00Z"),
    });
    expect(isoList(occ)).toEqual([
      "2026-03-04T14:00:00.000Z", // Wed, EST
      "2026-03-06T14:00:00.000Z", // Fri, EST
      "2026-03-09T13:00:00.000Z", // Mon, EDT
      "2026-03-11T13:00:00.000Z",
      "2026-03-13T13:00:00.000Z",
    ]);
  });

  it("weekly Sunday 09:00 Sydney across DST end (2026-04-05) and start (2026-10-04)", () => {
    const april = expandRecurrence({
      rule: "FREQ=WEEKLY",
      firstStartsAt: at("2026-03-29", "09:00", SYDNEY),
      durationMinutes: 240,
      timezone: SYDNEY,
      until: utc("2026-04-13T00:00:00Z"),
    });
    expect(isoList(april)).toEqual(["2026-03-28T22:00:00.000Z", "2026-04-04T23:00:00.000Z", "2026-04-11T23:00:00.000Z"]);

    const october = expandRecurrence({
      rule: "FREQ=WEEKLY",
      firstStartsAt: at("2026-09-27", "09:00", SYDNEY),
      durationMinutes: 240,
      timezone: SYDNEY,
      until: utc("2026-10-05T00:00:00Z"),
    });
    expect(isoList(october)).toEqual(["2026-09-26T23:00:00.000Z", "2026-10-03T22:00:00.000Z"]);
  });

  it("overnight 22:00–06:00 daily series is 7h on the spring night and 9h on the fall night (like buildShiftInstants)", () => {
    const spring = expandRecurrence({
      rule: "FREQ=DAILY",
      firstStartsAt: at("2026-03-27", "22:00", LONDON),
      durationMinutes: 480,
      timezone: LONDON,
      until: utc("2026-03-31T00:00:00Z"),
    });
    expect(spring.map((o) => (o.endsAt.getTime() - o.startsAt.getTime()) / 60_000)).toEqual([480, 420, 480, 480]);

    const fall = expandRecurrence({
      rule: "FREQ=DAILY",
      firstStartsAt: at("2026-10-23", "22:00", LONDON),
      durationMinutes: 480,
      timezone: LONDON,
      until: utc("2026-10-27T00:00:00Z"),
    });
    expect(fall.map((o) => (o.endsAt.getTime() - o.startsAt.getTime()) / 60_000)).toEqual([480, 540, 480, 480]);

    const manual = buildShiftInstants({ date: "2026-10-24", startTime: "22:00", endTime: "06:00", timezone: LONDON });
    expect(fall[1]!.startsAt).toEqual(manual.startsAt);
    expect(fall[1]!.endsAt).toEqual(manual.endsAt);
  });

  it("a 02:30 daily New York series moves the nonexistent 2026-03-08 start to 03:30 EDT with a warning", () => {
    const occ = expandRecurrence({
      rule: "FREQ=DAILY",
      firstStartsAt: at("2026-03-07", "02:30", NEW_YORK),
      durationMinutes: 480,
      timezone: NEW_YORK,
      until: utc("2026-03-10T00:00:00Z"),
    });
    expect(isoList(occ)).toEqual(["2026-03-07T07:30:00.000Z", "2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
    expect(localTimes(occ, NEW_YORK)).toEqual(["2026-03-07 02:30", "2026-03-08 03:30", "2026-03-09 02:30"]);
    expect(occ.map((o) => o.warnings)).toEqual([[], ["START_NONEXISTENT_LOCAL_TIME_SHIFTED"], []]);
    // 02:30 + 8h wall-clock = 10:30 EDT, so the shifted occurrence is 7h long
    expect(occ[1]!.endsAt.toISOString()).toBe("2026-03-08T14:30:00.000Z");
    expect(occ[1]!.localDate).toBe("2026-03-08");
  });

  it("a 01:30 daily London series takes the first (BST) 01:30 on 2026-10-25 with a warning", () => {
    const occ = expandRecurrence({
      rule: "FREQ=DAILY",
      firstStartsAt: at("2026-10-24", "01:30", LONDON),
      durationMinutes: 20,
      timezone: LONDON,
      until: utc("2026-10-27T00:00:00Z"),
    });
    expect(isoList(occ)).toEqual(["2026-10-24T00:30:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
    expect(occ[1]!.warnings).toEqual([
      "START_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE",
      "END_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE",
    ]);
  });

  it("keeps the anchor exact even when it is the second occurrence of an ambiguous time", () => {
    const secondOneThirty = utc("2026-10-25T01:30:00Z"); // 01:30 GMT, after the clocks went back
    const occ = expandRecurrence({
      rule: "FREQ=DAILY",
      firstStartsAt: secondOneThirty,
      durationMinutes: 60,
      timezone: LONDON,
      until: utc("2026-10-27T00:00:00Z"),
    });
    expect(isoList(occ)).toEqual(["2026-10-25T01:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
    expect(occ[0]!.warnings).toEqual([]);
  });

  it("a shift shorter than the gap whose end lands before its shifted start keeps its absolute length", () => {
    const occ = expandRecurrence({
      rule: "FREQ=DAILY",
      firstStartsAt: at("2026-03-28", "01:30", LONDON),
      durationMinutes: 40,
      timezone: LONDON,
      until: utc("2026-03-30T00:00:00Z"),
    });
    expect(occ).toHaveLength(2);
    expect(occ[1]!.startsAt.toISOString()).toBe("2026-03-29T01:30:00.000Z"); // 02:30 BST
    expect(occ[1]!.endsAt.toISOString()).toBe("2026-03-29T02:10:00.000Z");
    expect(occ[1]!.warnings).toEqual(["START_NONEXISTENT_LOCAL_TIME_SHIFTED"]);
  });
});

describe("expandRecurrence — rule semantics", () => {
  const base = (over: Partial<ExpandRecurrenceInput>): ExpandRecurrenceInput => ({
    rule: "FREQ=DAILY",
    firstStartsAt: utc("2026-10-07T09:00:00Z"), // Wed
    durationMinutes: 60,
    timezone: "UTC",
    until: utc("2026-11-01T00:00:00Z"),
    ...over,
  });

  it("always returns the anchor first, even when its weekday is not in BYDAY (RFC 5545 DTSTART)", () => {
    const occ = expandRecurrence(base({ rule: "FREQ=WEEKLY;BYDAY=MO,FR", until: utc("2026-10-17T00:00:00Z") }));
    expect(isoList(occ)).toEqual([
      "2026-10-07T09:00:00.000Z",
      "2026-10-09T09:00:00.000Z",
      "2026-10-12T09:00:00.000Z",
      "2026-10-16T09:00:00.000Z",
    ]);
    expect(occ[0]!.isAnchor).toBe(true);
  });

  it("weekdays-only daily rule", () => {
    const occ = expandRecurrence(base({ rule: "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", until: utc("2026-10-14T00:00:00Z") }));
    expect(occ.map((o) => o.localDate)).toEqual(["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"]);
  });

  it("fortnightly with INTERVAL=2 honours the week phase of the anchor", () => {
    const occ = expandRecurrence(base({ rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", until: utc("2026-11-03T00:00:00Z") }));
    expect(occ.map((o) => o.localDate)).toEqual(["2026-10-07", "2026-10-19", "2026-10-21", "2026-11-02"]);
  });

  it("WKST changes which weeks an INTERVAL=2 rule hits", () => {
    // Anchor Wed 7 Oct. WKST=MO: the anchor's week is Mon 5–Sun 11 Oct (so Sun 11 is in), next period Mon 19 Oct.
    // WKST=SU: weeks start Sun 4 Oct → the anchor's week ends Sat 10 Oct; next period starts Sun 18 Oct.
    const mo = expandRecurrence(base({ rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,SU", until: utc("2026-10-26T00:00:00Z") }));
    const su = expandRecurrence(
      base({ rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,SU;WKST=SU", until: utc("2026-10-26T00:00:00Z") }),
    );
    expect(mo.map((o) => o.localDate)).toEqual(["2026-10-07", "2026-10-11", "2026-10-21", "2026-10-25"]);
    expect(su.map((o) => o.localDate)).toEqual(["2026-10-07", "2026-10-18", "2026-10-21"]);
  });

  it("monthly default uses the anchor's day of month and skips months without it", () => {
    const occ = expandRecurrence(
      base({ rule: "FREQ=MONTHLY", firstStartsAt: utc("2026-01-31T09:00:00Z"), until: utc("2026-09-01T00:00:00Z") }),
    );
    expect(occ.map((o) => o.localDate)).toEqual(["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-08-31"]);
  });

  it("monthly last day of the month, last Friday, first Monday, last weekday", () => {
    const window = { firstStartsAt: utc("2026-10-01T09:00:00Z"), until: utc("2027-01-01T00:00:00Z") };
    const dates = (rule: string): string[] => expandRecurrence(base({ rule, ...window })).map((o) => o.localDate);
    expect(dates("FREQ=MONTHLY;BYMONTHDAY=-1")).toEqual(["2026-10-01", "2026-10-31", "2026-11-30", "2026-12-31"]);
    expect(dates("FREQ=MONTHLY;BYDAY=-1FR")).toEqual(["2026-10-01", "2026-10-30", "2026-11-27", "2026-12-25"]);
    expect(dates("FREQ=MONTHLY;BYDAY=1MO")).toEqual(["2026-10-01", "2026-10-05", "2026-11-02", "2026-12-07"]);
    expect(dates("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1")).toEqual([
      "2026-10-01",
      "2026-10-30",
      "2026-11-30",
      "2026-12-31",
    ]);
  });

  it("BYDAY mixing plain and ordinal weekdays is a union (RFC 5545)", () => {
    const occ = expandRecurrence(
      base({
        rule: "FREQ=MONTHLY;BYDAY=1MO,SA",
        firstStartsAt: utc("2026-11-01T09:00:00Z"),
        until: utc("2026-12-01T00:00:00Z"),
      }),
    );
    expect(occ.map((o) => o.localDate)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-07",
      "2026-11-14",
      "2026-11-21",
      "2026-11-28",
    ]);
  });

  it("WEEKLY BYSETPOS picks within the whole week (first working day of each week)", () => {
    const occ = expandRecurrence(
      base({
        rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1",
        firstStartsAt: utc("2026-10-05T09:00:00Z"),
        until: utc("2026-10-27T00:00:00Z"),
      }),
    );
    expect(occ.map((o) => o.localDate)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  });

  it("COUNT includes the anchor", () => {
    const occ = expandRecurrence(base({ rule: "FREQ=DAILY;COUNT=3" }));
    expect(occ.map((o) => o.localDate)).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(expandRecurrence(base({ rule: "FREQ=DAILY;COUNT=1" }))).toHaveLength(1);
  });

  it("max truncates (default 400) and is validated", () => {
    expect(expandRecurrence(base({ max: 5 }))).toHaveLength(5);
    const long = expandRecurrence(base({ until: utc("2028-06-01T00:00:00Z") }));
    expect(long).toHaveLength(DEFAULT_RECURRENCE_MAX);
    expectAppError(() => expandRecurrence(base({ max: 0 })), "VALIDATION_ERROR");
    expectAppError(() => expandRecurrence(base({ max: 5001 })), "VALIDATION_ERROR");
    expectAppError(() => expandRecurrence(base({ max: 1.5 })), "VALIDATION_ERROR");
  });

  it("until is exclusive and an until at/before the anchor yields nothing", () => {
    const occ = expandRecurrence(base({ until: utc("2026-10-09T09:00:00Z") }));
    expect(occ.map((o) => o.localDate)).toEqual(["2026-10-07", "2026-10-08"]);
    expect(expandRecurrence(base({ until: utc("2026-10-07T09:00:00Z") }))).toEqual([]);
    expect(expandRecurrence(base({ until: utc("2026-10-01T00:00:00Z") }))).toEqual([]);
  });

  it("recurrenceUntilFromLocalDate makes an inclusive local last date", () => {
    const until = recurrenceUntilFromLocalDate("2026-10-09", LONDON);
    expect(until.toISOString()).toBe("2026-10-09T23:00:00.000Z");
    const occ = expandRecurrence({
      rule: "FREQ=DAILY",
      firstStartsAt: at("2026-10-07", "23:30", LONDON),
      durationMinutes: 60,
      timezone: LONDON,
      until,
    });
    expect(occ.map((o) => o.localDate)).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
  });

  it("rules that never match return just the anchor, quickly (no unbounded iteration)", () => {
    const started = Date.now();
    const tenYears = { until: utc("2036-10-01T00:00:00Z") };
    // The first Monday is always day 1–7, so it is never the 20th.
    expect(expandRecurrence(base({ rule: "FREQ=MONTHLY;BYDAY=1MO;BYMONTHDAY=20", ...tenYears }))).toHaveLength(1);
    // Every 7 days from a Wednesday never lands on a Tuesday.
    expect(expandRecurrence(base({ rule: "FREQ=DAILY;INTERVAL=7;BYDAY=TU", ...tenYears }))).toHaveLength(1);
    // A month has at most five Mondays, never a tenth.
    expect(expandRecurrence(base({ rule: "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=10", ...tenYears }))).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("rejects windows longer than RECURRENCE_MAX_SPAN_DAYS", () => {
    const first = utc("2026-10-07T09:00:00Z");
    expect(() =>
      expandRecurrence(base({ firstStartsAt: first, until: new Date(first.getTime() + RECURRENCE_MAX_SPAN_DAYS * DAY_MS) })),
    ).not.toThrow();
    expectAppError(
      () => expandRecurrence(base({ until: new Date(first.getTime() + (RECURRENCE_MAX_SPAN_DAYS + 1) * DAY_MS) })),
      "VALIDATION_ERROR",
    );
  });

  it("validates its inputs", () => {
    expectAppError(() => expandRecurrence(base({ rule: "FREQ=HOURLY" })), "INVALID_RECURRENCE");
    expectAppError(() => expandRecurrence(base({ rule: "FREQ=DAILY;UNTIL=20270101" })), "INVALID_RECURRENCE");
    expectAppError(() => expandRecurrence(base({ timezone: "Mars/Base" })), "INVALID_TIMEZONE");
    expectAppError(() => expandRecurrence(base({ firstStartsAt: new Date(Number.NaN) })), "VALIDATION_ERROR");
    expectAppError(() => expandRecurrence(base({ until: new Date(Number.NaN) })), "VALIDATION_ERROR");
    expectAppError(() => expandRecurrence(base({ durationMinutes: 0 })), "VALIDATION_ERROR");
    expectAppError(() => expandRecurrence(base({ durationMinutes: Number.NaN })), "VALIDATION_ERROR");
  });
});

describe("expandRecurrence agrees with the rrule package (UTC, productive rules)", () => {
  // rrule (python-dateutil semantics) is used as an oracle. Excluded on purpose: BYDAY mixing plain and ordinal
  // weekdays (dateutil intersects them; RFC 5545 and this module take the union) and WEEKLY+BYSETPOS (dateutil
  // starts the anchor's week at DTSTART rather than at WKST).
  const RULES = [
    "FREQ=DAILY",
    "FREQ=DAILY;INTERVAL=3",
    "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR",
    "FREQ=DAILY;INTERVAL=2;BYDAY=SA,SU",
    "FREQ=DAILY;BYMONTH=1,6,12",
    "FREQ=DAILY;BYMONTHDAY=1,15,-1",
    "FREQ=DAILY;BYDAY=MO;BYSETPOS=1",
    "FREQ=WEEKLY",
    "FREQ=WEEKLY;INTERVAL=2",
    "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU",
    "FREQ=WEEKLY;INTERVAL=3;BYDAY=SA,SU;WKST=WE",
    "FREQ=WEEKLY;BYDAY=FR;BYMONTH=3,4,10",
    "FREQ=MONTHLY",
    "FREQ=MONTHLY;INTERVAL=2",
    "FREQ=MONTHLY;INTERVAL=12",
    "FREQ=MONTHLY;BYMONTHDAY=1,15",
    "FREQ=MONTHLY;BYMONTHDAY=-1",
    "FREQ=MONTHLY;BYMONTHDAY=31",
    "FREQ=MONTHLY;BYMONTHDAY=-3,29",
    "FREQ=MONTHLY;BYDAY=1MO",
    "FREQ=MONTHLY;BYDAY=-1FR",
    "FREQ=MONTHLY;BYDAY=2TU,4TU",
    "FREQ=MONTHLY;BYDAY=5WE",
    "FREQ=MONTHLY;BYDAY=SA,SU",
    "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13",
    "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,-1",
    "FREQ=MONTHLY;BYMONTHDAY=1,2,3,4,5,6,7;BYSETPOS=2",
    "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10",
    "FREQ=MONTHLY;BYMONTHDAY=10;BYMONTH=1,4,7,10",
    "FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=29",
  ];
  const ANCHORS = [
    "2026-01-01T09:00:00Z",
    "2026-01-31T09:00:00Z",
    "2026-02-28T09:00:00Z",
    "2026-03-29T09:00:00Z",
    "2026-05-04T09:00:00Z",
    "2026-06-30T07:15:00Z",
    "2026-08-19T23:59:00Z",
    "2026-10-31T00:00:00Z",
    "2026-12-31T09:00:00Z",
    "2028-02-29T09:00:00Z",
  ];

  it.each(RULES)("%s", (rule) => {
    for (const anchorIso of ANCHORS) {
      const anchor = utc(anchorIso);
      const until = new Date(anchor.getTime() + 500 * DAY_MS);
      const ours = expandRecurrence({ rule, firstStartsAt: anchor, durationMinutes: 60, timezone: "UTC", until, max: 5000 });
      expect(ours[0]!.startsAt.toISOString()).toBe(anchorIso.replace("Z", ".000Z"));

      const oracle = new RRule({ ...RRule.parseString(rule), dtstart: anchor })
        .all((d) => d.getTime() < until.getTime())
        .filter((d) => d.getTime() > anchor.getTime())
        .map((d) => d.toISOString());
      expect(isoList(ours.slice(1)), `${rule} from ${anchorIso}`).toEqual(oracle);
    }
  });

  it("COUNT matches rrule when the anchor itself matches the rule", () => {
    for (const rule of ["FREQ=WEEKLY;BYDAY=MO,TH;COUNT=7", "FREQ=MONTHLY;BYDAY=1MO;COUNT=5", "FREQ=DAILY;INTERVAL=4;COUNT=9"]) {
      const anchor = utc("2026-05-04T09:00:00Z"); // first Monday of May
      const until = utc("2028-01-01T00:00:00Z");
      const ours = expandRecurrence({ rule, firstStartsAt: anchor, durationMinutes: 60, timezone: "UTC", until });
      const oracle = new RRule({ ...RRule.parseString(rule), dtstart: anchor }).all().map((d) => d.toISOString());
      expect(isoList(ours), rule).toEqual(oracle);
    }
  });
});

describe("expandShiftSeries — typed form", () => {
  const series = (over: Partial<ExpandShiftSeriesInput>): ExpandShiftSeriesInput => ({
    date: "2026-10-05",
    startTime: "09:00",
    endTime: "17:00",
    timezone: LONDON,
    rule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    untilDate: "2026-10-16",
    ...over,
  });
  const localRanges = (xs: ReadonlyArray<{ startsAt: Date; endsAt: Date }>, tz: string): string[] =>
    xs.map((x) => `${instantToLocal(x.startsAt, tz).date} ${instantToLocal(x.startsAt, tz).time}-${instantToLocal(x.endsAt, tz).time}`);

  it("expands a typed weekly series with an inclusive untilDate", () => {
    const occ = expandShiftSeries(series({}));
    expect(localRanges(occ, LONDON)).toEqual([
      "2026-10-05 09:00-17:00",
      "2026-10-07 09:00-17:00",
      "2026-10-09 09:00-17:00",
      "2026-10-12 09:00-17:00",
      "2026-10-14 09:00-17:00",
      "2026-10-16 09:00-17:00",
    ]);
    expect(occ.map((o) => o.isAnchor)).toEqual([true, false, false, false, false, false]);
    expect(occ.map((o) => o.localDate)).toEqual([
      "2026-10-05",
      "2026-10-07",
      "2026-10-09",
      "2026-10-12",
      "2026-10-14",
      "2026-10-16",
    ]);
  });

  it("element 0 is exactly buildShiftInstants for the typed first shift (overnight on the fall-back night)", () => {
    const typed = { date: "2026-10-24", startTime: "22:00", endTime: "06:00", timezone: LONDON };
    const occ = expandShiftSeries({ ...typed, rule: "FREQ=WEEKLY", untilDate: "2026-11-07" });
    const manual = buildShiftInstants(typed);
    expect(occ[0]).toEqual({
      startsAt: manual.startsAt,
      endsAt: manual.endsAt,
      localDate: "2026-10-24",
      isAnchor: true,
      warnings: [],
    });
    expect(occ.map((o) => (o.endsAt.getTime() - o.startsAt.getTime()) / 60_000)).toEqual([540, 480, 480]);
    expect(localRanges(occ, LONDON)).toEqual([
      "2026-10-24 22:00-06:00",
      "2026-10-31 22:00-06:00",
      "2026-11-07 22:00-06:00",
    ]);
  });

  it("keeps the typed start time when the FIRST shift falls in the spring-forward gap", () => {
    // London 2026-03-29 01:30 does not exist: the first shift is created at 02:30 BST, but the series is a 01:30 series.
    const occ = expandShiftSeries(
      series({ date: "2026-03-29", startTime: "01:30", endTime: "09:30", rule: "FREQ=DAILY", untilDate: "2026-04-01" }),
    );
    expect(localRanges(occ, LONDON)).toEqual([
      "2026-03-29 02:30-09:30",
      "2026-03-30 01:30-09:30",
      "2026-03-31 01:30-09:30",
      "2026-04-01 01:30-09:30",
    ]);
    expect(occ[0]!.warnings).toEqual(["START_NONEXISTENT_LOCAL_TIME_SHIFTED"]);
    expect(occ.slice(1).every((o) => o.warnings.length === 0)).toBe(true);

    // The instant-based API cannot know the typed time, so it would repeat the shifted 02:30 — why
    // expandShiftSeries exists.
    const first = buildShiftInstants({ date: "2026-03-29", startTime: "01:30", endTime: "09:30", timezone: LONDON });
    const viaInstant = expandRecurrence({
      rule: "FREQ=DAILY",
      firstStartsAt: first.startsAt,
      durationMinutes: wallClockMinutesBetween(first.startsAt, first.endsAt, LONDON),
      timezone: LONDON,
      until: recurrenceUntilFromLocalDate("2026-04-01", LONDON),
    });
    expect(localRanges(viaInstant, LONDON)[1]).toBe("2026-03-30 02:30-09:30");
  });

  it("an overnight daily series keeps 22:00 → 06:00 local through both 2026 London transitions", () => {
    const occ = expandShiftSeries(
      series({ date: "2026-01-01", startTime: "22:00", endTime: "06:00", rule: "FREQ=DAILY", untilDate: "2026-12-31" }),
    );
    expect(occ).toHaveLength(365);
    const lengths = new Map<string, number>();
    for (const o of occ) {
      expect(instantToLocal(o.startsAt, LONDON).time).toBe("22:00");
      expect(instantToLocal(o.endsAt, LONDON).time).toBe("06:00");
      expect(o.warnings).toEqual([]);
      lengths.set(o.localDate, (o.endsAt.getTime() - o.startsAt.getTime()) / 60_000);
    }
    expect(lengths.get("2026-03-28")).toBe(420);
    expect(lengths.get("2026-10-24")).toBe(540);
    expect([...lengths.values()].filter((m) => m !== 480)).toEqual([420, 540]);
  });

  it.each([LONDON, NEW_YORK, SYDNEY, "America/Santiago", "Australia/Lord_Howe"])(
    "a daily 09:00 series in %s starts at 09:00 local on every day of 2026",
    (tz) => {
      const occ = expandShiftSeries(
        series({ date: "2026-01-01", timezone: tz, rule: "FREQ=DAILY", untilDate: "2026-12-31" }),
      );
      expect(occ).toHaveLength(365);
      expect(new Set(occ.map((o) => instantToLocal(o.startsAt, tz).time))).toEqual(new Set(["09:00"]));
      expect(new Set(occ.map((o) => instantToLocal(o.endsAt, tz).time))).toEqual(new Set(["17:00"]));
      expect(new Set(occ.map((o) => o.localDate)).size).toBe(365);
      expect(occ.every((o) => o.warnings.length === 0)).toBe(true);
    },
  );

  it("a monthly first-Monday 09:00 London series moves between 09:00Z (GMT) and 08:00Z (BST)", () => {
    const occ = expandShiftSeries(series({ date: "2026-01-05", rule: "FREQ=MONTHLY;BYDAY=1MO", untilDate: "2026-12-31" }));
    expect(occ.map((o) => `${o.localDate} ${o.startsAt.toISOString().slice(11, 16)}`)).toEqual([
      "2026-01-05 09:00",
      "2026-02-02 09:00",
      "2026-03-02 09:00",
      "2026-04-06 08:00",
      "2026-05-04 08:00",
      "2026-06-01 08:00",
      "2026-07-06 08:00",
      "2026-08-03 08:00",
      "2026-09-07 08:00",
      "2026-10-05 08:00",
      "2026-11-02 09:00",
      "2026-12-07 09:00",
    ]);
  });

  it("Santiago's skipped midnight: a 00:30 series is moved to 01:30 on 2026-09-06 only", () => {
    const tz = "America/Santiago";
    const occ = expandShiftSeries(
      series({ date: "2026-09-05", startTime: "00:30", endTime: "08:30", timezone: tz, rule: "FREQ=DAILY", untilDate: "2026-09-07" }),
    );
    expect(localRanges(occ, tz)).toEqual(["2026-09-05 00:30-08:30", "2026-09-06 01:30-08:30", "2026-09-07 00:30-08:30"]);
    expect(occ[1]!.warnings).toEqual(["START_NONEXISTENT_LOCAL_TIME_SHIFTED"]);
  });

  it("agrees with expandRecurrence whenever the first shift's start exists", () => {
    for (const rule of ["FREQ=DAILY", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SA", "FREQ=MONTHLY;BYMONTHDAY=-1", "FREQ=DAILY;COUNT=40"]) {
      for (const tz of [LONDON, NEW_YORK, SYDNEY]) {
        const typed = { date: "2026-02-10", startTime: "21:00", endTime: "05:30", timezone: tz };
        const first = buildShiftInstants(typed);
        const a = expandShiftSeries({ ...typed, rule, untilDate: "2026-12-31" });
        const b = expandRecurrence({
          rule,
          firstStartsAt: first.startsAt,
          durationMinutes: wallClockMinutesBetween(first.startsAt, first.endsAt, tz),
          timezone: tz,
          until: recurrenceUntilFromLocalDate("2026-12-31", tz),
        });
        expect(a, `${rule} ${tz}`).toEqual(b);
      }
    }
  });

  it("COUNT includes the first shift; max truncates", () => {
    expect(expandShiftSeries(series({ rule: "FREQ=DAILY;COUNT=3", untilDate: "2027-01-01" }))).toHaveLength(3);
    expect(expandShiftSeries(series({ rule: "FREQ=DAILY", untilDate: "2027-01-01", max: 10 }))).toHaveLength(10);
    expect(expandShiftSeries(series({ rule: "FREQ=DAILY", untilDate: "2030-01-01" }))).toHaveLength(DEFAULT_RECURRENCE_MAX);
  });

  it("returns [] when untilDate is before the first shift's date, and the first shift alone when equal", () => {
    expect(expandShiftSeries(series({ untilDate: "2026-10-04" }))).toEqual([]);
    expect(expandShiftSeries(series({ untilDate: "2026-10-05" }))).toHaveLength(1);
  });

  it.each<[Partial<ExpandShiftSeriesInput>, string, Record<string, unknown>]>([
    [{ date: "2026-02-30" }, "VALIDATION_ERROR", { field: "date" }],
    [{ startTime: "9am" }, "VALIDATION_ERROR", { field: "startTime" }],
    [{ endTime: "24:00" }, "VALIDATION_ERROR", { field: "endTime" }],
    [{ untilDate: "2026-13-01" }, "VALIDATION_ERROR", { field: "untilDate" }],
    [{ untilDate: "2036-10-15" }, "VALIDATION_ERROR", { field: "untilDate" }], // 3663 days > RECURRENCE_MAX_SPAN_DAYS
    [{ max: 0 }, "VALIDATION_ERROR", { field: "max" }],
    [{ rule: "FREQ=YEARLY" }, "INVALID_RECURRENCE", {}],
    [{ timezone: "Mars/Base" }, "INVALID_TIMEZONE", {}],
    [
      { date: "2026-03-29", startTime: "01:30", endTime: "02:15", rule: "FREQ=DAILY" },
      "VALIDATION_ERROR",
      { reason: "SHIFT_END_NOT_AFTER_START" },
    ],
  ])("rejects %j with %s", (over, code, details) => {
    try {
      expandShiftSeries(series(over));
      expect.unreachable("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(code);
      expect((e as AppError).details ?? {}).toMatchObject(details);
    }
  });
});
