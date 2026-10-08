import { describe, expect, it } from "vitest";
import { overlapsWindow, splitDateRange, syncWindow } from "./window";

describe("syncWindow", () => {
  it("runs from the start of yesterday to the start of today + N days in the portal zone", () => {
    // Wednesday 21 Oct 2026, 11:30 BST.
    const w = syncWindow(new Date("2026-10-21T10:30:00Z"), "Europe/London", 28);
    expect(w.from.toISOString()).toBe("2026-10-19T23:00:00.000Z"); // 20 Oct 00:00 BST
    // 18 Nov 00:00 GMT: the window crosses the 25 Oct fall-back, so `to` is a GMT midnight.
    expect(w.to.toISOString()).toBe("2026-11-18T00:00:00.000Z");
    expect(w.queryFrom).toBe("2026-10-19");
    expect(w.queryTo).toBe("2026-11-18");
  });

  it("queries 59 dates for the 56-day maximum (window plus one day each side)", () => {
    const w = syncWindow(new Date("2026-10-21T10:30:00Z"), "Europe/London", 56);
    const days =
      (Date.parse(`${w.queryTo}T00:00:00Z`) - Date.parse(`${w.queryFrom}T00:00:00Z`)) / 86_400_000 +
      1;
    expect(days).toBe(59);
  });

  it("uses the local date, not the UTC date, near midnight", () => {
    // 00:30 BST on 21 Oct is still 20 Oct in UTC.
    const w = syncWindow(new Date("2026-10-20T23:30:00Z"), "Europe/London", 7);
    expect(w.from.toISOString()).toBe("2026-10-19T23:00:00.000Z");
    expect(w.queryFrom).toBe("2026-10-19");
  });

  it("handles the spring-forward day", () => {
    // 29 Mar 2026 is the BST change; a window starting the next day still starts at local midnight.
    const w = syncWindow(new Date("2026-03-30T12:00:00Z"), "Europe/London", 1);
    expect(w.from.toISOString()).toBe("2026-03-29T00:00:00.000Z"); // 29 Mar 00:00 GMT (23 h day)
    expect(w.to.toISOString()).toBe("2026-03-30T23:00:00.000Z"); // 31 Mar 00:00 BST
  });

  it("rejects a non-positive number of days and a non-IANA zone", () => {
    expect(() => syncWindow(new Date(), "Europe/London", 0)).toThrow(RangeError);
    expect(() => syncWindow(new Date(), "GMT Standard Time", 7)).toThrow();
  });
});

describe("overlapsWindow", () => {
  const window = { from: new Date("2026-10-20T00:00:00Z"), to: new Date("2026-10-27T00:00:00Z") };

  it("keeps shifts with endsAt > from and startsAt < to", () => {
    const at = (s: string, e: string) => ({ startsAt: new Date(s), endsAt: new Date(e) });
    expect(overlapsWindow(at("2026-10-19T22:00:00Z", "2026-10-20T02:00:00Z"), window)).toBe(true);
    expect(overlapsWindow(at("2026-10-19T16:00:00Z", "2026-10-20T00:00:00Z"), window)).toBe(false);
    expect(overlapsWindow(at("2026-10-26T22:00:00Z", "2026-10-27T06:00:00Z"), window)).toBe(true);
    expect(overlapsWindow(at("2026-10-27T00:00:00Z", "2026-10-27T08:00:00Z"), window)).toBe(false);
  });
});

describe("splitDateRange", () => {
  it("cuts an inclusive range into slices of at most N dates", () => {
    expect(splitDateRange("2026-10-19", "2026-11-18", 14)).toEqual([
      { from: "2026-10-19", to: "2026-11-01" },
      { from: "2026-11-02", to: "2026-11-15" },
      { from: "2026-11-16", to: "2026-11-18" },
    ]);
    expect(splitDateRange("2026-10-19", "2026-10-19", 14)).toEqual([
      { from: "2026-10-19", to: "2026-10-19" },
    ]);
    expect(splitDateRange("2026-10-20", "2026-10-19", 14)).toEqual([]);
    expect(() => splitDateRange("2026-10-19", "2026-10-20", 0)).toThrow(RangeError);
  });
});
