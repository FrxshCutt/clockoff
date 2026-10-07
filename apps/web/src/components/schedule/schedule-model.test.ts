import type { Shift } from "@clockoff/validation/shifts";
import { describe, expect, it } from "vitest";
import {
  assignLanes,
  computeRange,
  employeeRows,
  findConflicts,
  formatLocalDay,
  formatRangeHeading,
  futureSeriesShifts,
  hourTicks,
  jsDateToLocalDate,
  localDateToJsDate,
  navigateDate,
  parseScheduleParams,
  placeShiftsOnDays,
  planShiftMove,
  scheduleParamsToSearch,
  seriesIdOf,
  shiftLocalTimes,
  shiftTimeLabel,
  todayIn,
  visibleShifts,
  weekStartDate,
} from "./schedule-model";

const LONDON = "Europe/London";
const EMPLOYEE_A = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";
const EMPLOYEE_B = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a11";
const LOCATION = "7f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a12";

let counter = 0;
function makeShift(overrides: Partial<Shift> & { startsAt: string; endsAt: string }): Shift {
  counter += 1;
  const id = overrides.id ?? `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  return {
    id,
    employee: {
      id: EMPLOYEE_A,
      firstName: "Jane",
      lastName: "Smith",
      jobTitle: "Barista",
      primaryLocation: null,
      inviteStatus: "CONNECTED",
    },
    location: { id: LOCATION, name: "High Street" },
    timezone: LONDON,
    durationMinutes: Math.round(
      (Date.parse(overrides.endsAt) - Date.parse(overrides.startsAt)) / 60_000,
    ),
    status: "SCHEDULED",
    source: "MANUAL",
    externalShiftId: null,
    notes: null,
    recurrenceRule: null,
    parentRecurrenceId: null,
    version: 1,
    scheduledBreaks: [],
    isOvernight: false,
    localDate: "2026-10-06",
    localStartTime: "09:00",
    localEndTime: "15:00",
    displayRange: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("schedule URL params", () => {
  it("parses the query with safe fallbacks", () => {
    const params = parseScheduleParams(
      {
        view: "day",
        date: "2026-10-07",
        location: LOCATION,
        employee: "not-a-uuid",
        cancelled: "0",
      },
      "2026-10-06",
    );
    expect(params).toEqual({
      view: "day",
      date: "2026-10-07",
      locationId: LOCATION,
      employeeId: null,
      showCancelled: false,
    });
    expect(parseScheduleParams({ view: "month", date: "2026-02-30" }, "2026-10-06")).toEqual({
      view: "week",
      date: "2026-10-06",
      locationId: null,
      employeeId: null,
      showCancelled: true,
    });
    expect(
      parseScheduleParams({ view: ["employee", "day"], cancelled: "false" }, "2026-10-06").view,
    ).toBe("employee");
  });

  it("round-trips through the search string and omits defaults", () => {
    const params = parseScheduleParams(
      { view: "day", date: "2026-10-07", employee: EMPLOYEE_A, cancelled: "0" },
      "2026-10-06",
    );
    const search = scheduleParamsToSearch(params, "2026-10-06");
    expect(search).toBe(`?view=day&date=2026-10-07&employee=${EMPLOYEE_A}&cancelled=0`);
    expect(
      parseScheduleParams(Object.fromEntries(new URLSearchParams(search)), "2026-10-06"),
    ).toEqual(params);
    expect(
      scheduleParamsToSearch(
        {
          view: "week",
          date: "2026-10-06",
          locationId: null,
          employeeId: null,
          showCancelled: true,
        },
        "2026-10-06",
      ),
    ).toBe("");
  });
});

describe("ranges and navigation", () => {
  it("computes the local week in the organisation's timezone (Monday or Sunday start)", () => {
    // 2026-10-07 is a Wednesday.
    expect(weekStartDate("2026-10-07", LONDON, "MONDAY")).toBe("2026-10-05");
    expect(weekStartDate("2026-10-07", LONDON, "SUNDAY")).toBe("2026-10-04");
    expect(weekStartDate("2026-10-05", LONDON, "MONDAY")).toBe("2026-10-05");
    expect(weekStartDate("2026-10-04", LONDON, "SUNDAY")).toBe("2026-10-04");

    const week = computeRange("week", "2026-10-07", LONDON, undefined);
    expect(week.days).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(week.startDate).toBe("2026-10-05");
    expect(week.endDate).toBe("2026-10-11");
    // Query window starts a day early (overnight continuations) and ends at the exclusive local midnight after the last day (BST).
    expect(week.from.toISOString()).toBe("2026-10-03T23:00:00.000Z");
    expect(week.to.toISOString()).toBe("2026-10-11T23:00:00.000Z");
  });

  it("uses a single day for the day view and steps by day/week", () => {
    const day = computeRange("day", "2026-10-07", LONDON, "MONDAY");
    expect(day.days).toEqual(["2026-10-07"]);
    expect(navigateDate("day", "2026-10-31", 1)).toBe("2026-11-01");
    expect(navigateDate("week", "2026-10-07", -1)).toBe("2026-09-30");
    expect(navigateDate("employee", "2026-12-28", 1)).toBe("2027-01-04");
  });

  it("formats headings and day labels", () => {
    expect(formatRangeHeading({ startDate: "2026-10-05", endDate: "2026-10-11" })).toBe(
      "5 – 11 Oct 2026",
    );
    expect(formatRangeHeading({ startDate: "2026-09-28", endDate: "2026-10-04" })).toBe(
      "28 Sep – 4 Oct 2026",
    );
    expect(formatRangeHeading({ startDate: "2026-12-28", endDate: "2027-01-03" })).toBe(
      "28 Dec 2026 – 3 Jan 2027",
    );
    expect(formatRangeHeading({ startDate: "2026-10-07", endDate: "2026-10-07" })).toBe(
      "Wed 7 Oct 2026",
    );
    expect(formatLocalDay("2026-10-07", "short")).toBe("Wed 7");
    expect(formatLocalDay("2026-10-07")).toBe("Wed 7 Oct");
    expect(hourTicks(6).map((t) => t.label)).toEqual(["00", "06", "12", "18", "24"]);
    expect(hourTicks(6)[2]?.percent).toBe(50);
  });

  it("converts local dates to browser dates and back, and knows today in a zone", () => {
    expect(jsDateToLocalDate(localDateToJsDate("2026-03-01"))).toBe("2026-03-01");
    expect(todayIn("Pacific/Auckland", new Date("2026-10-06T20:00:00.000Z"))).toBe("2026-10-07");
    expect(todayIn(LONDON, new Date("2026-10-06T20:00:00.000Z"))).toBe("2026-10-06");
  });
});

describe("week grid layout", () => {
  it("places a same-day shift on one day with a start–end label", () => {
    const shift = makeShift({
      startsAt: "2026-10-06T08:00:00.000Z",
      endsAt: "2026-10-06T14:00:00.000Z",
    }); // 09:00–15:00 BST
    const byDay = placeShiftsOnDays([shift], ["2026-10-06", "2026-10-07"], LONDON);
    expect(byDay.get("2026-10-06")).toHaveLength(1);
    expect(byDay.get("2026-10-07")).toHaveLength(0);
    const chip = byDay.get("2026-10-06")![0]!;
    expect(chip).toMatchObject({
      kind: "start",
      label: "09:00–15:00",
      startMinutes: 9 * 60,
      endMinutes: 15 * 60,
      overnight: false,
      dayOffset: 0,
    });
  });

  it("splits an overnight shift into a start chip with a (+1) suffix and a continuation chip", () => {
    const shift = makeShift({
      startsAt: "2026-10-06T21:00:00.000Z",
      endsAt: "2026-10-07T05:00:00.000Z",
    }); // 22:00 → 06:00 BST
    const byDay = placeShiftsOnDays([shift], ["2026-10-06", "2026-10-07"], LONDON);
    expect(byDay.get("2026-10-06")![0]).toMatchObject({
      kind: "start",
      label: "22:00 → 06:00 (+1)",
      startMinutes: 22 * 60,
      endMinutes: 24 * 60,
      overnight: true,
      dayOffset: 1,
    });
    expect(byDay.get("2026-10-07")![0]).toMatchObject({
      kind: "continuation",
      label: "→ 06:00",
      startMinutes: 0,
      endMinutes: 6 * 60,
      key: `${shift.id}:2026-10-07`,
    });
  });

  it("does not draw a zero-length continuation for a shift ending exactly at midnight", () => {
    const shift = makeShift({
      startsAt: "2026-10-06T19:00:00.000Z",
      endsAt: "2026-10-06T23:00:00.000Z",
    }); // 20:00–00:00 BST
    const byDay = placeShiftsOnDays([shift], ["2026-10-06", "2026-10-07"], LONDON);
    expect(byDay.get("2026-10-06")![0]).toMatchObject({
      label: "20:00 → 00:00 (+1)",
      endMinutes: 24 * 60,
    });
    expect(byDay.get("2026-10-07")).toHaveLength(0);
  });

  it("only emits chips for visible days and keeps the display timezone's dates", () => {
    const shift = makeShift({
      startsAt: "2026-10-06T21:00:00.000Z",
      endsAt: "2026-10-07T05:00:00.000Z",
    });
    const onlyNext = placeShiftsOnDays([shift], ["2026-10-07"], LONDON);
    expect(onlyNext.get("2026-10-07")![0]?.kind).toBe("continuation");
    // Viewed from Auckland the same instants are a daytime shift on the 7th.
    const akl = placeShiftsOnDays([shift], ["2026-10-07"], "Pacific/Auckland");
    expect(akl.get("2026-10-07")![0]).toMatchObject({
      kind: "start",
      label: "10:00–18:00",
      overnight: false,
    });
  });

  it("handles the autumn clock change by wall-clock minutes", () => {
    const shift = makeShift({
      startsAt: "2026-10-24T21:00:00.000Z",
      endsAt: "2026-10-25T06:00:00.000Z",
    }); // 22:00 BST → 06:00 GMT (9h)
    const times = shiftLocalTimes(shift, LONDON);
    expect(times).toEqual({
      startDate: "2026-10-24",
      startTime: "22:00",
      endDate: "2026-10-25",
      endTime: "06:00",
      dayOffset: 1,
    });
    expect(shiftTimeLabel(times)).toBe("22:00 → 06:00 (+1)");
  });

  it("assigns overlapping chips to separate lanes and reuses free ones", () => {
    const items = [
      { id: "a", startMinutes: 540, endMinutes: 900 },
      { id: "b", startMinutes: 600, endMinutes: 720 },
      { id: "c", startMinutes: 900, endMinutes: 1020 }, // touches a → same lane as a
      { id: "d", startMinutes: 660, endMinutes: 780 },
    ];
    const { lanes, laneCount } = assignLanes(items);
    const laneOf = (id: string) => lanes.find((l) => l.item.id === id)?.lane;
    expect(laneOf("a")).toBe(0);
    expect(laneOf("b")).toBe(1);
    expect(laneOf("d")).toBe(2);
    expect(laneOf("c")).toBe(0);
    expect(laneCount).toBe(3);
    expect(assignLanes([]).laneCount).toBe(1);
  });

  it("lists distinct employees sorted by name and filters cancelled shifts", () => {
    const a = makeShift({
      startsAt: "2026-10-06T08:00:00.000Z",
      endsAt: "2026-10-06T14:00:00.000Z",
    });
    const b = makeShift({
      startsAt: "2026-10-06T08:00:00.000Z",
      endsAt: "2026-10-06T14:00:00.000Z",
      status: "CANCELLED",
      employee: {
        id: EMPLOYEE_B,
        firstName: "Amira",
        lastName: "Khan",
        jobTitle: null,
        primaryLocation: null,
        inviteStatus: "INVITED",
      },
    });
    expect(employeeRows([a, b, a]).map((r) => r.name)).toEqual(["Amira Khan", "Jane Smith"]);
    expect(visibleShifts([a, b], { showCancelled: false })).toEqual([a]);
    expect(visibleShifts([a, b], { showCancelled: true })).toHaveLength(2);
  });
});

describe("conflicts", () => {
  it("flags overlapping shifts of the same employee, half-open, ignoring cancelled ones", () => {
    const a = makeShift({
      id: "00000000-0000-4000-8000-00000000000a",
      startsAt: "2026-10-06T08:00:00.000Z",
      endsAt: "2026-10-06T14:00:00.000Z",
    });
    const b = makeShift({
      id: "00000000-0000-4000-8000-00000000000b",
      startsAt: "2026-10-06T13:00:00.000Z",
      endsAt: "2026-10-06T17:00:00.000Z",
    });
    const touching = makeShift({
      id: "00000000-0000-4000-8000-00000000000c",
      startsAt: "2026-10-06T17:00:00.000Z",
      endsAt: "2026-10-06T20:00:00.000Z",
    });
    const cancelled = makeShift({
      id: "00000000-0000-4000-8000-00000000000d",
      startsAt: "2026-10-06T09:00:00.000Z",
      endsAt: "2026-10-06T10:00:00.000Z",
      status: "CANCELLED",
    });
    const other = makeShift({
      id: "00000000-0000-4000-8000-00000000000e",
      startsAt: "2026-10-06T09:00:00.000Z",
      endsAt: "2026-10-06T10:00:00.000Z",
      employee: {
        id: EMPLOYEE_B,
        firstName: "Amira",
        lastName: "Khan",
        jobTitle: null,
        primaryLocation: null,
        inviteStatus: "INVITED",
      },
    });
    const conflicts = findConflicts([a, b, touching, cancelled, other]);
    expect(conflicts.get(a.id)?.map((s) => s.id)).toEqual([b.id]);
    expect(conflicts.get(b.id)?.map((s) => s.id)).toEqual([a.id]);
    expect(conflicts.has(touching.id)).toBe(false);
    expect(conflicts.has(cancelled.id)).toBe(false);
    expect(conflicts.has(other.id)).toBe(false);
  });
});

describe("drag and drop", () => {
  it("moves a shift by whole days keeping its wall-clock times in its own timezone", () => {
    const shift = makeShift({
      startsAt: "2026-10-06T08:00:00.000Z",
      endsAt: "2026-10-06T14:00:00.000Z",
      version: 3,
    }); // 09:00–15:00 BST
    const plan = planShiftMove(shift, "2026-10-06", "2026-10-09");
    expect(plan?.deltaDays).toBe(3);
    expect(plan?.patch).toEqual({
      date: "2026-10-09",
      startTime: "09:00",
      endTime: "15:00",
      timezone: LONDON,
      expectedVersion: 3,
    });
    expect(plan?.optimistic?.startsAt).toBe("2026-10-09T08:00:00.000Z");
    expect(plan?.optimistic?.endsAt).toBe("2026-10-09T14:00:00.000Z");
    expect(plan?.optimistic?.durationMinutes).toBe(360);
    // The derived fields the API echoes follow the move too, so the drawer never shows the old date mid-flight.
    expect(plan?.optimistic).toMatchObject({
      localDate: "2026-10-09",
      localStartTime: "09:00",
      localEndTime: "15:00",
      isOvernight: false,
      version: 3,
    });
    expect(plan?.optimistic?.displayRange).toMatch(/9 Oct, 09:00–15:00$/);
  });

  it("keeps local times across a clock change (duration follows the wall clock)", () => {
    const shift = makeShift({
      startsAt: "2026-10-23T08:00:00.000Z",
      endsAt: "2026-10-23T14:00:00.000Z",
    }); // Fri 09:00–15:00 BST
    const plan = planShiftMove(shift, "2026-10-23", "2026-10-26"); // Monday after clocks go back
    expect(plan?.patch).toMatchObject({ date: "2026-10-26", startTime: "09:00", endTime: "15:00" });
    expect(plan?.optimistic?.startsAt).toBe("2026-10-26T09:00:00.000Z"); // 09:00 GMT
    expect(plan?.optimistic?.durationMinutes).toBe(360);
  });

  it("moves backwards and across month boundaries, and does nothing for the same day", () => {
    const shift = makeShift({
      startsAt: "2026-11-01T09:00:00.000Z",
      endsAt: "2026-11-01T15:00:00.000Z",
    }); // 09:00 GMT
    expect(planShiftMove(shift, "2026-11-01", "2026-10-31")?.patch.date).toBe("2026-10-31");
    expect(planShiftMove(shift, "2026-11-01", "2026-11-01")).toBeNull();
  });

  it("moves an overnight shift by the drop delta measured on the start day", () => {
    const shift = makeShift({
      startsAt: "2026-10-06T21:00:00.000Z",
      endsAt: "2026-10-07T05:00:00.000Z",
    }); // 22:00 → 06:00
    const plan = planShiftMove(shift, "2026-10-06", "2026-10-08");
    expect(plan?.patch).toMatchObject({ date: "2026-10-08", startTime: "22:00", endTime: "06:00" });
    expect(plan?.optimistic?.endsAt).toBe("2026-10-09T05:00:00.000Z");
    expect(plan?.optimistic).toMatchObject({
      localDate: "2026-10-08",
      localStartTime: "22:00",
      localEndTime: "06:00",
      isOvernight: true,
    });
    expect(plan?.optimistic?.displayRange).toMatch(/22:00–06:00 \(\+1\)$/);
  });
});

describe("series", () => {
  it("identifies a series by its anchor and collects this and future members", () => {
    const anchor = makeShift({
      id: "00000000-0000-4000-8000-0000000000a0",
      startsAt: "2026-10-05T08:00:00.000Z",
      endsAt: "2026-10-05T14:00:00.000Z",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
    });
    const second = makeShift({
      id: "00000000-0000-4000-8000-0000000000a1",
      startsAt: "2026-10-12T08:00:00.000Z",
      endsAt: "2026-10-12T14:00:00.000Z",
      parentRecurrenceId: anchor.id,
    });
    const third = makeShift({
      id: "00000000-0000-4000-8000-0000000000a2",
      startsAt: "2026-10-19T08:00:00.000Z",
      endsAt: "2026-10-19T14:00:00.000Z",
      parentRecurrenceId: anchor.id,
    });
    const unrelated = makeShift({
      startsAt: "2026-10-13T08:00:00.000Z",
      endsAt: "2026-10-13T14:00:00.000Z",
    });
    expect(seriesIdOf(anchor)).toBe(anchor.id);
    expect(seriesIdOf(second)).toBe(anchor.id);
    expect(seriesIdOf(unrelated)).toBeNull();
    expect(
      futureSeriesShifts(second, [third, unrelated, anchor, second, second]).map((s) => s.id),
    ).toEqual([second.id, third.id]);
    expect(futureSeriesShifts(unrelated, [anchor, second])).toEqual([unrelated]);
  });
});
