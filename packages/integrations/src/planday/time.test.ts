import { describe, expect, it } from "vitest";
import { PlandayError } from "./errors";
import {
  assertShiftDateMatchesStart,
  formatPlandayUtcDateTime,
  formatPlandayWallClock,
  parsePlandayDate,
  parsePlandayDateTime,
  parsePlandayEffectiveDate,
  PlandayTimeError,
  toShiftInstants,
} from "./time";

const LONDON = "Europe/London";

describe("parsePlandayDateTime", () => {
  it("reads Z and ±hh:mm values as instants, whatever the zone", () => {
    expect(parsePlandayDateTime("2026-10-21T08:00:00Z", "Not/AZone").instant.toISOString()).toBe(
      "2026-10-21T08:00:00.000Z",
    );
    expect(parsePlandayDateTime("2026-10-21T09:00:00+01:00", LONDON).instant.toISOString()).toBe(
      "2026-10-21T08:00:00.000Z",
    );
    expect(parsePlandayDateTime("2026-10-21T03:00:00-0500", LONDON).instant.toISOString()).toBe(
      "2026-10-21T08:00:00.000Z",
    );
    expect(parsePlandayDateTime("2026-10-21T08:00z", LONDON).instant.toISOString()).toBe(
      "2026-10-21T08:00:00.000Z",
    );
  });

  it("keeps fractional seconds, including .NET's seven digits", () => {
    expect(parsePlandayDateTime("2026-10-21T08:00:00.1234567Z", LONDON).instant.toISOString()).toBe(
      "2026-10-21T08:00:00.123Z",
    );
    expect(parsePlandayDateTime("2026-10-21T09:00:00.5", LONDON).instant.toISOString()).toBe(
      "2026-10-21T08:00:00.500Z",
    );
  });

  it("reads values without an offset as wall-clock time in the zone", () => {
    expect(parsePlandayDateTime("2026-10-21T09:00:00", LONDON).instant.toISOString()).toBe(
      "2026-10-21T08:00:00.000Z",
    );
    expect(parsePlandayDateTime("2026-12-01T09:00", LONDON).instant.toISOString()).toBe(
      "2026-12-01T09:00:00.000Z",
    );
  });

  it("moves a spring-forward gap time forward and takes the first fall-back occurrence", () => {
    const gap = parsePlandayDateTime("2026-03-29T01:30:00", LONDON);
    expect(gap.instant.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(gap.warning).toBe("NONEXISTENT_LOCAL_TIME_SHIFTED");
    const overlap = parsePlandayDateTime("2026-10-25T01:30:00", LONDON);
    expect(overlap.instant.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(overlap.warning).toBe("AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE");
  });

  it("refuses malformed values, impossible dates and non-IANA zones", () => {
    for (const bad of [
      "",
      "2026-10-21",
      "21/10/2026 09:00",
      "2026-02-30T09:00:00",
      "2026-10-21T24:00:00",
      "2026-10-21T09:00:00+25:00",
    ]) {
      expect(() => parsePlandayDateTime(bad, LONDON), bad).toThrow(PlandayTimeError);
    }
    expect(() => parsePlandayDateTime("2026-10-21T09:00:00", "GMT Standard Time")).toThrow(
      expect.objectContaining({ reason: "INVALID_ZONE" }),
    );
  });
});

describe("toShiftInstants", () => {
  const shift = (start: string | null, end: string | null, timeZone: string | null = LONDON) => ({
    startDateTime: start,
    endDateTime: end,
    timeZone,
  });

  it("resolves an ordinary shift in the shift's zone", () => {
    const r = toShiftInstants(shift("2026-10-21T09:00:00", "2026-10-21T17:00:00"), "UTC");
    expect(r).toEqual({
      ok: true,
      startsAt: new Date("2026-10-21T08:00:00Z"),
      endsAt: new Date("2026-10-21T16:00:00Z"),
      timezone: LONDON,
      isOvernight: false,
      localStartDate: "2026-10-21",
      timeWarning: null,
    });
  });

  it("marks overnight shifts", () => {
    const r = toShiftInstants(shift("2026-10-23T20:00:00", "2026-10-24T02:00:00"), null);
    expect(r).toMatchObject({ ok: true, isOvernight: true, localStartDate: "2026-10-23" });
  });

  it("gets the late-October DST shift right in all three encodings (9 real hours)", () => {
    const encodings = [
      ["2026-10-24T22:00:00", "2026-10-25T06:00:00"],
      ["2026-10-24T21:00:00Z", "2026-10-25T06:00:00Z"],
      ["2026-10-24T22:00:00+01:00", "2026-10-25T06:00:00+00:00"],
    ] as const;
    for (const [start, end] of encodings) {
      const r = toShiftInstants(shift(start, end), LONDON);
      expect(r, start).toMatchObject({
        ok: true,
        startsAt: new Date("2026-10-24T21:00:00Z"),
        endsAt: new Date("2026-10-25T06:00:00Z"),
        isOvernight: true,
        localStartDate: "2026-10-24",
      });
      if (r.ok) expect(r.endsAt.getTime() - r.startsAt.getTime()).toBe(9 * 3_600_000);
    }
  });

  it("reports the DST adjustment of a wall-clock start in the overlap", () => {
    const r = toShiftInstants(shift("2026-10-25T01:30:00", "2026-10-25T09:00:00"), LONDON);
    expect(r).toMatchObject({
      ok: true,
      timeWarning: "START_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE",
    });
  });

  it("falls back to the portal zone only when the shift has none", () => {
    expect(
      toShiftInstants(shift("2026-10-21T09:00:00", "2026-10-21T17:00:00", null), LONDON),
    ).toMatchObject({
      ok: true,
      timezone: LONDON,
      startsAt: new Date("2026-10-21T08:00:00Z"),
    });
    expect(
      toShiftInstants(
        shift("2026-10-21T09:00:00", "2026-10-21T17:00:00", "  "),
        "America/New_York",
      ),
    ).toMatchObject({
      ok: true,
      timezone: "America/New_York",
    });
    // A Windows id on the shift is not mapped and does not fall back (notes §10.3 rule 3).
    expect(
      toShiftInstants(
        shift("2026-10-21T09:00:00", "2026-10-21T17:00:00", "GMT Standard Time"),
        LONDON,
      ),
    ).toEqual({ ok: false, reason: "INVALID_ZONE" });
    expect(
      toShiftInstants(shift("2026-10-21T09:00:00", "2026-10-21T17:00:00", null), null),
    ).toEqual({
      ok: false,
      reason: "INVALID_ZONE",
    });
  });

  it("rejects missing, malformed, inverted, too long and too short shifts", () => {
    expect(toShiftInstants(shift(null, "2026-10-21T17:00:00"), LONDON)).toEqual({
      ok: false,
      reason: "MISSING_TIME",
    });
    expect(toShiftInstants(shift("yesterday", "2026-10-21T17:00:00"), LONDON)).toEqual({
      ok: false,
      reason: "MALFORMED_TIME",
    });
    expect(toShiftInstants(shift("2026-10-21T17:00:00", "2026-10-21T09:00:00"), LONDON)).toEqual({
      ok: false,
      reason: "END_NOT_AFTER_START",
    });
    expect(toShiftInstants(shift("2026-10-21T09:00:00", "2026-10-21T09:00:00"), LONDON)).toEqual({
      ok: false,
      reason: "END_NOT_AFTER_START",
    });
    expect(toShiftInstants(shift("2026-10-21T09:00:00", "2026-10-22T10:00:01"), LONDON)).toEqual({
      ok: false,
      reason: "TOO_LONG",
    });
    expect(toShiftInstants(shift("2026-10-21T09:00:00", "2026-10-21T09:14:59"), LONDON)).toEqual({
      ok: false,
      reason: "TOO_SHORT",
    });
  });

  it("accepts up to 25 real hours (24 h of wall clock across the fall-back)", () => {
    const r = toShiftInstants(shift("2026-10-24T08:00:00", "2026-10-25T08:00:00"), LONDON);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.endsAt.getTime() - r.startsAt.getTime()).toBe(25 * 3_600_000);
  });
});

describe("the date cross-check", () => {
  it("passes when the date is the local start date", () => {
    const times = toShiftInstants(
      {
        startDateTime: "2026-10-23T20:00:00",
        endDateTime: "2026-10-24T02:00:00",
        timeZone: LONDON,
      },
      LONDON,
    );
    expect(() => assertShiftDateMatchesStart("2026-10-23", times)).not.toThrow();
    expect(() => assertShiftDateMatchesStart(null, times)).not.toThrow();
  });

  it("catches UTC sent without Z for a shift starting just after midnight BST", () => {
    // 00:30 BST on 22 Oct is 23:30 UTC on 21 Oct; served without Z it would be read as 23:30 BST on the 21st.
    const times = toShiftInstants(
      {
        startDateTime: "2026-10-21T23:30:00",
        endDateTime: "2026-10-22T07:30:00",
        timeZone: LONDON,
      },
      LONDON,
    );
    let caught: unknown;
    try {
      assertShiftDateMatchesStart("2026-10-22", times, "/scheduling/v1.0/shifts");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlandayError);
    expect(caught).toMatchObject({
      code: "PLANDAY_INVALID_RESPONSE",
      reason: "TIME_ENCODING_MISMATCH",
      pathTemplate: "/scheduling/v1.0/shifts",
      retryable: false,
    });
  });

  it("skips shifts whose times were invalid anyway", () => {
    expect(() =>
      assertShiftDateMatchesStart("2026-10-22", { ok: false, reason: "MISSING_TIME" }),
    ).not.toThrow();
  });
});

describe("dates and query formats", () => {
  it("reads format: date values", () => {
    expect(parsePlandayDate("2026-10-30")).toBe("2026-10-30");
    expect(parsePlandayDate("2026-10-30T00:00:00")).toBe("2026-10-30");
    expect(parsePlandayDate("2026-10-30T00:00:00Z")).toBe("2026-10-30");
    expect(parsePlandayDate("2026-10-30T09:00:00")).toBeNull();
    expect(parsePlandayDate("2026-02-30")).toBeNull();
    expect(parsePlandayDate(null)).toBeNull();
  });

  it("resolves effective dates in the zone, instants as given", () => {
    expect(parsePlandayEffectiveDate("2026-10-20", LONDON)?.toISOString()).toBe(
      "2026-10-19T23:00:00.000Z",
    );
    expect(parsePlandayEffectiveDate("2026-12-30", LONDON)?.toISOString()).toBe(
      "2026-12-30T00:00:00.000Z",
    );
    expect(parsePlandayEffectiveDate("2026-10-30T00:00:00Z", LONDON)?.toISOString()).toBe(
      "2026-10-30T00:00:00.000Z",
    );
    expect(parsePlandayEffectiveDate("2026-10-30", "Not/AZone")?.toISOString()).toBe(
      "2026-10-30T00:00:00.000Z",
    );
    expect(parsePlandayEffectiveDate("", LONDON)).toBeNull();
    expect(parsePlandayEffectiveDate(undefined, LONDON)).toBeNull();
    expect(parsePlandayEffectiveDate("soon", LONDON)).toBeNull();
  });

  it("formats the documented filter shapes", () => {
    expect(formatPlandayUtcDateTime(new Date("2026-10-20T23:00:00.123Z"))).toBe(
      "2026-10-20T23:00:00Z",
    );
    expect(formatPlandayWallClock(new Date("2026-10-21T07:30:00Z"), LONDON)).toBe(
      "2026-10-21T08:30",
    );
  });
});
