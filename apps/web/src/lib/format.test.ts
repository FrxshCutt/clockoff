import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatDate,
  formatDateTime,
  formatDateTimeLong,
  formatDurationMinutes,
  formatRelativeTime,
  formatTime,
  formatTimeZoneLabel,
  formatTimeZoneOffset,
  getInitials,
  humanizeEnum,
  toDate,
} from "./format";

// 2026-10-06T13:05:09Z is 14:05:09 in London (BST, UTC+1) and 09:05:09 in New York (EDT, UTC-4).
const INSTANT = "2026-10-06T13:05:09.000Z";

describe("toDate", () => {
  it("accepts ISO strings, epoch ms and Dates, and rejects invalid input", () => {
    expect(toDate(INSTANT)?.toISOString()).toBe(INSTANT);
    expect(toDate(Date.parse(INSTANT))?.toISOString()).toBe(INSTANT);
    const original = new Date(INSTANT);
    const copy = toDate(original);
    expect(copy).not.toBe(original);
    expect(copy?.getTime()).toBe(original.getTime());
    expect(toDate("not a date")).toBeNull();
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
  });
});

describe("formatDate / formatTime", () => {
  it("orders the date per the organisation's preference, in the given zone", () => {
    expect(formatDate(INSTANT, { timeZone: "Europe/London", dateFormat: "DMY" })).toBe("06/10/2026");
    expect(formatDate(INSTANT, { timeZone: "Europe/London", dateFormat: "MDY" })).toBe("10/06/2026");
    expect(formatDate(INSTANT, { timeZone: "Europe/London", dateFormat: "YMD" })).toBe("2026-10-06");
    expect(formatDate(INSTANT, { timeZone: "UTC" })).toBe("06/10/2026");
  });

  it("converts the UTC instant to the zone (date can change across midnight)", () => {
    expect(formatDate("2026-10-06T23:30:00Z", { timeZone: "Asia/Tokyo", dateFormat: "YMD" })).toBe("2026-10-07");
    expect(formatDate("2026-10-06T01:30:00Z", { timeZone: "America/New_York", dateFormat: "YMD" })).toBe("2026-10-05");
  });

  it("formats 24h and 12h times", () => {
    expect(formatTime(INSTANT, { timeZone: "Europe/London" })).toBe("14:05");
    expect(formatTime(INSTANT, { timeZone: "America/New_York" })).toBe("09:05");
    expect(formatTime(INSTANT, { timeZone: "Europe/London", hour12: true }).replace(/\s/g, " ")).toMatch(/^2:05 pm$/i);
  });

  it("combines date and time, and renders a dash for missing values", () => {
    expect(formatDateTime(INSTANT, { timeZone: "Europe/London" })).toBe("06/10/2026, 14:05");
    expect(formatDate(null)).toBe("—");
    expect(formatTime("garbage")).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTimeLong(null)).toBe("—");
  });

  it("produces an unambiguous long form for tooltips", () => {
    const long = formatDateTimeLong(INSTANT, { timeZone: "Europe/London" });
    expect(long).toContain("Tuesday");
    expect(long).toContain("October 2026");
    expect(long).toContain("14:05:09");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse(INSTANT);
  it.each([
    [now - 10_000, "just now"],
    [now + 30_000, "just now"],
    [now - 5 * 60_000, "5 minutes ago"],
    [now + 2 * 60 * 60_000, "in 2 hours"],
    [now - 24 * 60 * 60_000, "yesterday"],
    [now - 3 * 7 * 24 * 60 * 60_000, "3 weeks ago"],
    [now - 400 * 24 * 60 * 60_000, "last year"],
  ])("%s → %s", (value, expected) => {
    expect(formatRelativeTime(value, now)).toBe(expected);
  });

  it("handles 45–60 seconds as a minute", () => {
    expect(formatRelativeTime(now - 50_000, now)).toBe("1 minute ago");
  });

  it("renders a dash for invalid input", () => {
    expect(formatRelativeTime("nope", now)).toBe("—");
  });
});

describe("small formatters", () => {
  it("formats durations", () => {
    expect(formatDurationMinutes(45)).toBe("45 min");
    expect(formatDurationMinutes(90)).toBe("1 h 30 min");
    expect(formatDurationMinutes(120)).toBe("2 h");
    expect(formatDurationMinutes(0)).toBe("0 min");
    expect(formatDurationMinutes(-1)).toBe("—");
    expect(formatDurationMinutes(Number.NaN)).toBe("—");
  });

  it("pluralises counts", () => {
    expect(formatCount(1, "employee")).toBe("1 employee");
    expect(formatCount(1200, "employee")).toBe("1,200 employees");
    expect(formatCount(2, "person", "people")).toBe("2 people");
  });

  it("humanises enum values", () => {
    expect(humanizeEnum("SETUP_INCOMPLETE")).toBe("Setup incomplete");
    expect(humanizeEnum("WHEN_I_WORK")).toBe("When i work");
    expect(humanizeEnum("")).toBe("");
  });

  it("builds initials", () => {
    expect(getInitials("Ada Lovelace")).toBe("AL");
    expect(getInitials("  mary   ann  smith ")).toBe("MS");
    expect(getInitials("cher")).toBe("C");
    expect(getInitials("")).toBe("?");
    expect(getInitials(null)).toBe("?");
  });

  it("labels time zones with their DST-aware offset", () => {
    expect(formatTimeZoneOffset("Europe/London", INSTANT)).toBe("GMT+1");
    expect(formatTimeZoneOffset("Europe/London", "2026-01-15T12:00:00Z")).toBe("GMT");
    expect(formatTimeZoneOffset("Not/AZone", INSTANT)).toBe("");
    expect(formatTimeZoneLabel("America/New_York", INSTANT)).toBe("America / New York (GMT-4)");
    expect(formatTimeZoneLabel("Not/AZone", INSTANT)).toBe("Not / AZone");
  });
});
