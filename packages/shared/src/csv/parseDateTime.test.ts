import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  parseImportDate,
  parseImportTime,
  toUtcInstant,
  isValidTimezone,
} from "./parseDateTime";

describe("parseImportDate", () => {
  it("reads ISO year-first dates under any organisation format", () => {
    for (const fmt of ["DMY", "MDY", "YMD"] as const) {
      expect(parseImportDate("2026-03-05", fmt)).toEqual({ ok: true, isoDate: "2026-03-05" });
      expect(parseImportDate("2026/03/05", fmt)).toEqual({ ok: true, isoDate: "2026-03-05" });
      expect(parseImportDate("2026.3.5", fmt)).toEqual({ ok: true, isoDate: "2026-03-05" });
    }
  });

  it("resolves the 03/04/2026 ambiguity by the organisation's date format, never by guessing", () => {
    expect(parseImportDate("03/04/2026", "DMY")).toEqual({ ok: true, isoDate: "2026-04-03" });
    expect(parseImportDate("03/04/2026", "MDY")).toEqual({ ok: true, isoDate: "2026-03-04" });
    const ymd = parseImportDate("03/04/2026", "YMD");
    expect(ymd.ok).toBe(false);
    if (!ymd.ok) expect(ymd.message).toMatch(/YYYY-MM-DD/);
  });

  it("accepts -, . and / separators and 1-digit day/month", () => {
    expect(parseImportDate("5/3/2026", "DMY")).toEqual({ ok: true, isoDate: "2026-03-05" });
    expect(parseImportDate("05-03-2026", "DMY")).toEqual({ ok: true, isoDate: "2026-03-05" });
    expect(parseImportDate("05.03.2026", "DMY")).toEqual({ ok: true, isoDate: "2026-03-05" });
    expect(parseImportDate("3/5/2026", "MDY")).toEqual({ ok: true, isoDate: "2026-03-05" });
  });

  it("reads 2-digit years as 20xx", () => {
    expect(parseImportDate("05/03/26", "DMY")).toEqual({ ok: true, isoDate: "2026-03-05" });
  });

  it("rejects impossible calendar dates with a helpful message", () => {
    const r = parseImportDate("31/02/2026", "DMY");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/31 February 2026 is not a real date/);
    expect(parseImportDate("2026-02-30", "YMD").ok).toBe(false);
    expect(parseImportDate("29/02/2028", "DMY")).toEqual({ ok: true, isoDate: "2028-02-29" }); // leap year
  });

  it("hints at the other day/month order when the month is out of range", () => {
    const r = parseImportDate("14/03/2026", "MDY");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Month 14 is out of range.*DD\/MM\/YYYY/);
    const r2 = parseImportDate("03/14/2026", "DMY");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toMatch(/MM\/DD\/YYYY/);
  });

  it("reads textual months and ignores a leading weekday", () => {
    expect(parseImportDate("5 Mar 2026", "DMY")).toEqual({ ok: true, isoDate: "2026-03-05" });
    expect(parseImportDate("05-Mar-26", "MDY")).toEqual({ ok: true, isoDate: "2026-03-05" });
    expect(parseImportDate("March 5, 2026", "DMY")).toEqual({ ok: true, isoDate: "2026-03-05" });
    expect(parseImportDate("5 march 2026", "DMY")).toEqual({ ok: true, isoDate: "2026-03-05" });
    expect(parseImportDate("Thu 05/03/2026", "DMY")).toEqual({ ok: true, isoDate: "2026-03-05" });
    expect(parseImportDate("Thursday, 5 March 2026", "DMY")).toEqual({
      ok: true,
      isoDate: "2026-03-05",
    });
  });

  it("reads every English month name and abbreviation, including both 'Sep' and 'Sept'", () => {
    // Locale data is not used: en-GB abbreviates September as "Sept" in some ICU versions, "Sep" in others.
    const abbreviations = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    abbreviations.forEach((mon, i) => {
      const iso = `2026-${String(i + 1).padStart(2, "0")}-05`;
      expect(parseImportDate(`05-${mon}-2026`, "DMY")).toEqual({ ok: true, isoDate: iso });
      expect(parseImportDate(`${mon.toUpperCase()} 5, 2026`, "MDY")).toEqual({
        ok: true,
        isoDate: iso,
      });
    });
    for (const value of [
      "5 Sep 2026",
      "5 Sept 2026",
      "5 Sept. 2026",
      "5 September 2026",
      "Sep 5, 2026",
      "September 5th, 2026",
      "5th September 2026",
      "05/Sep/2026",
      "05-Sep-26",
      "2026-Sep-05",
      "Sat 5 Sep 2026",
    ]) {
      for (const fmt of ["DMY", "MDY", "YMD"] as const) {
        expect(parseImportDate(value, fmt)).toEqual({ ok: true, isoDate: "2026-09-05" });
      }
    }
  });

  it("rejects textual dates that are impossible, incomplete or misspelt", () => {
    expect(parseImportDate("31 Feb 2026", "DMY")).toEqual({
      ok: false,
      message: "31 February 2026 is not a real date.",
    });
    expect(parseImportDate("Mar 5", "DMY").ok).toBe(false); // no year: never assumed
    expect(parseImportDate("5 Marc 2026", "DMY").ok).toBe(false);
    expect(parseImportDate("5 Mar 2026 extra", "DMY").ok).toBe(false);
    expect(parseImportDate("Fri 5 Mar 2026", "DMY").ok).toBe(false); // 5 March 2026 is a Thursday
  });

  it("rejects mixed separators and over-long day or month groups instead of reading them", () => {
    for (const value of [
      "05/03-2026",
      "2026-03/05",
      "2026-03-0005",
      "2026-003-05",
      "123/03/2026",
    ]) {
      expect(parseImportDate(value, "DMY").ok).toBe(false);
    }
  });

  it("strips a midnight time that spreadsheets append to dates, but rejects any other time", () => {
    expect(parseImportDate("05/03/2026 00:00", "DMY")).toEqual({ ok: true, isoDate: "2026-03-05" });
    expect(parseImportDate("05/03/2026 00:00:00", "DMY")).toEqual({
      ok: true,
      isoDate: "2026-03-05",
    });
    expect(parseImportDate("2026-03-05T00:00:00.000Z", "DMY")).toEqual({
      ok: true,
      isoDate: "2026-03-05",
    });
    expect(parseImportDate("3/5/2026 12:00 AM", "MDY")).toEqual({
      ok: true,
      isoDate: "2026-03-05",
    });
    expect(parseImportDate("05/03/2026 09:00", "DMY").ok).toBe(false);
  });

  it("rejects years outside 2000–2099", () => {
    const r = parseImportDate("05/03/1999", "DMY");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Year 1999 is out of range/);
    expect(parseImportDate("0026-03-05", "YMD").ok).toBe(false);
    expect(parseImportDate("5 Mar 2150", "DMY").ok).toBe(false);
  });

  it("rejects garbage, empty cells and Excel serial numbers", () => {
    expect(parseImportDate("", "DMY").ok).toBe(false);
    expect(parseImportDate("yesterday", "DMY").ok).toBe(false);
    expect(parseImportDate("46082", "DMY").ok).toBe(false);
    expect(parseImportDate("2026-03-05T09:00:00", "DMY").ok).toBe(false);
    expect(parseImportDate("05/03/20261", "DMY").ok).toBe(false);
  });
});

describe("parseImportTime", () => {
  it.each([
    ["09:00", 540, "09:00"],
    ["9:00", 540, "09:00"],
    ["09:00:00", 540, "09:00"],
    ["9", 540, "09:00"],
    ["0900", 540, "09:00"],
    ["900", 540, "09:00"],
    ["9am", 540, "09:00"],
    ["9 AM", 540, "09:00"],
    ["9 a.m.", 540, "09:00"],
    ["9:30pm", 1290, "21:30"],
    ["9.30 pm", 1290, "21:30"],
    ["21.30", 1290, "21:30"],
    ["2130", 1290, "21:30"],
    ["12am", 0, "00:00"],
    ["12:30am", 30, "00:30"],
    ["12pm", 720, "12:00"],
    ["12:15 PM", 735, "12:15"],
    ["00:00", 0, "00:00"],
    ["17:00 hrs", 1020, "17:00"],
    ["23:59", 1439, "23:59"],
    ["24:00", 1440, "24:00"],
    ["2400", 1440, "24:00"],
  ])("parses %s", (input, minutes, hhmm) => {
    expect(parseImportTime(input)).toEqual({ ok: true, minutes, hhmm });
  });

  it.each([
    "",
    "25:00",
    "9:60",
    "13pm",
    "0am",
    "24:01",
    "noon",
    "9:3",
    "abc",
    "9:00:00:00",
    "9.5",
    "10.25.00",
  ])("rejects %s", (input) => {
    expect(parseImportTime(input).ok).toBe(false);
  });
});

describe("toUtcInstant", () => {
  it("converts local wall time in the zone to a UTC instant", () => {
    expect(toUtcInstant("2026-03-05", 540, "Europe/London").iso).toBe("2026-03-05T09:00:00.000Z"); // GMT
    expect(toUtcInstant("2026-06-01", 540, "Europe/London").iso).toBe("2026-06-01T08:00:00.000Z"); // BST
    expect(toUtcInstant("2026-06-01", 540, "America/New_York").iso).toBe(
      "2026-06-01T13:00:00.000Z",
    );
    expect(toUtcInstant("2026-06-01", 540, "UTC").iso).toBe("2026-06-01T09:00:00.000Z");
  });

  it("treats 24:00 as midnight at the start of the next day", () => {
    expect(toUtcInstant("2026-03-05", 1440, "Europe/London").iso).toBe("2026-03-06T00:00:00.000Z");
  });

  it("flags times that fall into the spring-forward gap", () => {
    const r = toUtcInstant("2026-03-29", 90, "Europe/London"); // 01:30 does not exist
    expect(r.adjusted).toBe(true);
    expect(r.ambiguous).toBe(false);
    expect(r.iso).toBe("2026-03-29T01:30:00.000Z"); // 02:30 BST
    expect(toUtcInstant("2026-03-29", 180, "Europe/London").adjusted).toBe(false);
  });

  it("flags times that happen twice at fall-back and uses the first occurrence", () => {
    const r = toUtcInstant("2026-10-25", 90, "Europe/London"); // 01:30 BST and 01:30 GMT
    expect(r.ambiguous).toBe(true);
    expect(r.adjusted).toBe(false);
    expect(r.iso).toBe("2026-10-25T00:30:00.000Z"); // 01:30 BST
    const ny = toUtcInstant("2026-11-01", 90, "America/New_York");
    expect(ny.ambiguous).toBe(true);
    expect(ny.iso).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT
    expect(toUtcInstant("2026-10-25", 180, "Europe/London")).toMatchObject({
      ambiguous: false,
      iso: "2026-10-25T03:00:00.000Z",
    });
  });

  it("adds calendar days without timezone drift", () => {
    expect(addCalendarDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("validates IANA zones", () => {
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
  });
});
