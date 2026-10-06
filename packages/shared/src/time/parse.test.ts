import { describe, expect, it } from "vitest";
import {
  calendarToUtcMs,
  daysInMonth,
  formatLocalDate,
  formatLocalTime,
  isValidCalendarDate,
  isValidLocalDate,
  isValidLocalTime,
  parseDateString,
  parseTimeString,
  splitLocalDate,
  splitLocalTime,
} from "./parse";

describe("parseTimeString", () => {
  it.each<[string, string | null]>([
    // canonical and near-canonical 24h forms
    ["09:00", "09:00"],
    ["9:00", "09:00"],
    ["21:30", "21:30"],
    ["00:00", "00:00"],
    ["23:59", "23:59"],
    [" 7:05 ", "07:05"],
    ["09:00:00", "09:00"],
    ["17:45:59", "17:45"],
    // dot separator
    ["21.30", "21:30"],
    ["9.05", "09:05"],
    // compact
    ["0930", "09:30"],
    ["930", "09:30"],
    ["1730", "17:30"],
    ["2359", "23:59"],
    ["0000", "00:00"],
    // 12-hour clock
    ["9am", "09:00"],
    ["9 am", "09:00"],
    ["9AM", "09:00"],
    ["9:30pm", "21:30"],
    ["9.30 pm", "21:30"],
    ["9:30 p.m.", "21:30"],
    ["12am", "00:00"],
    ["12pm", "12:00"],
    ["12:15am", "00:15"],
    ["11:59pm", "23:59"],
    ["1pm", "13:00"],
    ["12:00 a.m.", "00:00"],
    ["12:00 PM", "12:00"],
    ["12:59am", "00:59"],
    ["09:30 PM", "21:30"],
    ["9:30:00 PM", "21:30"], // Excel / en-US export
    ["11:59:59 pm", "23:59"],
    ["9:30\u202FPM", "21:30"], // narrow no-break space, as ICU's toLocaleTimeString emits
    ["930pm", "21:30"],
    ["1230am", "00:30"],
    ["1230 PM", "12:30"],
    ["9 a. m.", "09:00"],
    // rejected
    ["24:00", null],
    ["09:60", null],
    ["25:00", null],
    ["2400", null],
    ["9", null],
    ["13pm", null],
    ["0am", null],
    ["09:00:60", null],
    ["", null],
    ["   ", null],
    ["nine", null],
    ["09-00", null],
    ["9:0", null],
    ["12345", null],
    ["0:30am", null],
    ["00:30 AM", null],
    ["12:60pm", null],
    ["9:30:60 pm", null],
    ["960pm", null],
    ["noon", null],
    ["12 noon", null],
    ["9:30 xm", null],
    ["9:30 pm pm", null],
  ])("parseTimeString(%j) → %j", (input, expected) => {
    expect(parseTimeString(input)).toBe(expected);
  });

  it("returns null for non-strings at runtime", () => {
    expect(parseTimeString(undefined as unknown as string)).toBeNull();
    expect(parseTimeString(930 as unknown as string)).toBeNull();
  });
});

describe("parseDateString", () => {
  it.each<[string, string]>([
    ["2026-10-06", "2026-10-06"],
    [" 2026-10-06 ", "2026-10-06"],
    ["2028-02-29", "2028-02-29"],
  ])("accepts ISO %j for every format", (input, expected) => {
    expect(parseDateString(input, "DMY")).toBe(expected);
    expect(parseDateString(input, "MDY")).toBe(expected);
    expect(parseDateString(input, "YMD")).toBe(expected);
  });

  it.each<[string, string | null]>([
    ["06/10/2026", "2026-10-06"],
    ["6/10/2026", "2026-10-06"],
    ["6/1/26", "2026-01-06"],
    ["06-10-2026", "2026-10-06"],
    ["06.10.2026", "2026-10-06"],
    ["31/12/2026", "2026-12-31"],
    ["29/02/2028", "2028-02-29"],
    ["31/02/2026", null],
    ["29/02/2026", null],
    ["30/04/2026", "2026-04-30"],
    ["31/04/2026", null],
    ["00/10/2026", null],
    ["06/13/2026", null],
    ["06/10/26", "2026-10-06"],
    ["06/10/202", null],
    ["06/10/1899", null],
    ["06/10/3000", null],
    ["06/10-2026", null],
    ["2026/10/06", "2026-10-06"], // year first is unambiguous in every format
    ["2026.3.5", "2026-03-05"],
    ["2026-6-1", "2026-06-01"],
    ["31/06/2026", null],
    ["29/02/2100", null], // 2100 is not a leap year
    ["29/02/2000", "2000-02-29"], // 2000 is
    ["32/01/2026", null],
    ["10/06", null],
    ["", null],
    ["tomorrow", null],
  ])("DMY: parseDateString(%j) → %j", (input, expected) => {
    expect(parseDateString(input, "DMY")).toBe(expected);
  });

  it.each<[string, string | null]>([
    ["10/06/2026", "2026-10-06"],
    ["10/6/26", "2026-10-06"],
    ["10-06-2026", "2026-10-06"],
    ["10.06.2026", "2026-10-06"],
    ["02/31/2026", null],
    ["02/29/2028", "2028-02-29"],
    ["13/06/2026", null],
    ["2026/10/06", "2026-10-06"],
    ["2026/02/30", null],
    ["04/31/2026", null],
  ])("MDY: parseDateString(%j) → %j", (input, expected) => {
    expect(parseDateString(input, "MDY")).toBe(expected);
  });

  it.each<[string, string | null]>([
    ["2026/10/06", "2026-10-06"],
    ["2026/10/6", "2026-10-06"],
    ["2026.10.06", "2026-10-06"],
    ["2026-10-6", "2026-10-06"],
    ["2026/02/31", null],
    ["26/10/06", null],
    ["06/10/2026", null],
    ["2026/13/01", null],
    ["2026/10/006", null],
    ["2026/10/2026", null],
  ])("YMD: parseDateString(%j) → %j", (input, expected) => {
    expect(parseDateString(input, "YMD")).toBe(expected);
  });

  it("rejects ISO strings with impossible dates or out-of-range years", () => {
    expect(parseDateString("2026-02-30", "DMY")).toBeNull();
    expect(parseDateString("1899-12-31", "DMY")).toBeNull();
    expect(parseDateString("3000-01-01", "DMY")).toBeNull();
  });
});

describe("calendar helpers", () => {
  it("daysInMonth knows leap years", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
    expect(daysInMonth(2026, 13)).toBe(0);
  });

  it("isValidCalendarDate / isValidLocalDate / isValidLocalTime", () => {
    expect(isValidCalendarDate(2026, 2, 28)).toBe(true);
    expect(isValidCalendarDate(2026, 2, 29)).toBe(false);
    expect(isValidCalendarDate(2026, 0, 1)).toBe(false);
    expect(isValidCalendarDate(2026.5, 1, 1)).toBe(false);
    expect(isValidLocalDate("2026-10-06")).toBe(true);
    expect(isValidLocalDate("2026-10-6")).toBe(false);
    expect(isValidLocalDate("2026-02-30")).toBe(false);
    expect(isValidLocalDate(20261006)).toBe(false);
    expect(isValidLocalTime("09:00")).toBe(true);
    expect(isValidLocalTime("23:59")).toBe(true);
    expect(isValidLocalTime("24:00")).toBe(false);
    expect(isValidLocalTime("9:00")).toBe(false);
    expect(isValidLocalTime("09:00:00")).toBe(false);
  });

  it("calendarToUtcMs keeps years 0–99 (Date.UTC would map them to 1900–1999) and rolls over like Date.UTC", () => {
    expect(new Date(calendarToUtcMs(26, 10, 6, 9, 30)).toISOString()).toBe(
      "0026-10-06T09:30:00.000Z",
    );
    expect(new Date(calendarToUtcMs(0, 2, 29)).toISOString()).toBe("0000-02-29T00:00:00.000Z"); // year 0 is leap
    expect(new Date(calendarToUtcMs(99, 12, 32)).toISOString()).toBe("0100-01-01T00:00:00.000Z");
    expect(calendarToUtcMs(2026, 10, 6, 9, 30, 15)).toBe(Date.UTC(2026, 9, 6, 9, 30, 15));
    expect(calendarToUtcMs(2026, 3, 0)).toBe(Date.UTC(2026, 1, 28));
  });

  it("split / format round-trip", () => {
    expect(splitLocalDate("2026-10-06")).toEqual({ year: 2026, month: 10, day: 6 });
    expect(splitLocalTime("07:05")).toEqual({ hour: 7, minute: 5 });
    expect(formatLocalDate(2026, 1, 9)).toBe("2026-01-09");
    expect(formatLocalTime(7, 5)).toBe("07:05");
    expect(() => splitLocalDate("2026-02-30")).toThrow(TypeError);
    expect(() => splitLocalTime("7:05")).toThrow(TypeError);
  });
});
