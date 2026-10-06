/**
 * §6.4 acceptance checks through the public entry point (`@workmode/shared/time/time`, also re-exported by the
 * package barrel). Detailed cases live next to each module; this file pins the exported surface and the
 * headline DST scenarios.
 */
import { describe, expect, it } from "vitest";
import * as time from "./time";

describe("time entry point", () => {
  it.each([
    "isValidTimeZone",
    "localToInstant",
    "buildShiftInstants",
    "instantToLocal",
    "formatShiftRange",
    "parseTimeString",
    "parseDateString",
    "startOfLocalDay",
    "endOfLocalDay",
    "localDateRange",
    "addLocalDays",
    "weekStart",
    "toDeviceDateComponents",
    "minutesBetween",
    "roundUpToMinute",
    "overlaps",
    "nowUtc",
    "systemClock",
    "fixedClock",
    "expandRecurrence",
    "expandShiftSeries",
    "validateRecurrenceRule",
    "recurrenceUntilFromLocalDate",
    "wallClockMinutesBetween",
  ])("exports %s", (name) => {
    expect(typeof (time as Record<string, unknown>)[name]).toBe("function");
  });
});

describe("§6.4 DST scenarios", () => {
  it("spring-forward: a nonexistent local time moves forward by the gap with a warning", () => {
    // The spec phrases this as "02:30 → 03:30". That is the US/Sydney gap (02:00–03:00). Europe/London's gap on
    // 2026-03-29 is 01:00–02:00 (01:00 GMT → 02:00 BST), so the London equivalent is 01:30 → 02:30, and 02:30
    // itself is a normal BST time.
    const ny = time.localToInstant({ date: "2026-03-08", time: "02:30", timezone: "America/New_York" });
    expect(ny).toEqual({
      instant: new Date("2026-03-08T07:30:00.000Z"),
      warning: "NONEXISTENT_LOCAL_TIME_SHIFTED",
      normalisedLocalTime: "03:30",
    });
    const london = time.localToInstant({ date: "2026-03-29", time: "01:30", timezone: "Europe/London" });
    expect(london).toEqual({
      instant: new Date("2026-03-29T01:30:00.000Z"),
      warning: "NONEXISTENT_LOCAL_TIME_SHIFTED",
      normalisedLocalTime: "02:30",
    });
    expect(time.localToInstant({ date: "2026-03-29", time: "02:30", timezone: "Europe/London" })).toEqual({
      instant: new Date("2026-03-29T01:30:00.000Z"),
    });
  });

  it("fall-back: Europe/London 2026-10-25 01:30 takes the first occurrence (BST, 00:30Z)", () => {
    expect(time.localToInstant({ date: "2026-10-25", time: "01:30", timezone: "Europe/London" })).toEqual({
      instant: new Date("2026-10-25T00:30:00.000Z"),
      warning: "AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE",
    });
  });

  it("overnight 22:00→06:00 is 7h on the spring-forward night and 9h on the fall-back night", () => {
    const spring = time.buildShiftInstants({
      date: "2026-03-28",
      startTime: "22:00",
      endTime: "06:00",
      timezone: "Europe/London",
    });
    const fall = time.buildShiftInstants({
      date: "2026-10-24",
      startTime: "22:00",
      endTime: "06:00",
      timezone: "Europe/London",
    });
    expect(time.minutesBetween(spring.startsAt, spring.endsAt)).toBe(7 * 60);
    expect(time.minutesBetween(fall.startsAt, fall.endsAt)).toBe(9 * 60);
    expect(spring.isOvernight && fall.isOvernight).toBe(true);
    expect(time.formatShiftRange(fall.startsAt, fall.endsAt, "Europe/London")).toBe("Sat 24 Oct, 22:00–06:00 (+1)");
  });

  it("a weekly 09:00 series keeps 09:00 local across the spring-forward boundary", () => {
    const first = time.localToInstant({ date: "2026-03-23", time: "09:00", timezone: "Europe/London" }).instant;
    const occ = time.expandRecurrence({
      rule: "FREQ=WEEKLY;BYDAY=MO",
      firstStartsAt: first,
      durationMinutes: 480,
      timezone: "Europe/London",
      until: time.recurrenceUntilFromLocalDate("2026-04-06", "Europe/London"),
    });
    expect(occ.map((o) => time.instantToLocal(o.startsAt, "Europe/London").time)).toEqual(["09:00", "09:00", "09:00"]);
    expect(occ.map((o) => o.startsAt.toISOString())).toEqual([
      "2026-03-23T09:00:00.000Z",
      "2026-03-30T08:00:00.000Z",
      "2026-04-06T08:00:00.000Z",
    ]);
  });

  it("nowUtc reads an injected clock", () => {
    const clock: time.Clock = () => new Date("2026-10-06T09:00:00Z");
    expect(time.nowUtc(clock).toISOString()).toBe("2026-10-06T09:00:00.000Z");
  });
});
