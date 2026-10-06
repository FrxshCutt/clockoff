import { describe, expect, it } from "vitest";
import {
  importRowStatus,
  importShiftWindow,
  intervalsOverlap,
  validateRows,
  type ImportExistingShift,
} from "./validateRows";
import type { ImportProblem, NormalisedRow } from "./types";

function row(
  rowNumber: number,
  employeeId: string | null,
  startsAt: string | undefined,
  endsAt: string | undefined,
  extra: Partial<NormalisedRow> & { parsedExtra?: Partial<NormalisedRow["parsed"]> } = {},
): NormalisedRow {
  const { parsedExtra, ...rest } = extra;
  const parsed: NormalisedRow["parsed"] = {
    timezone: "Europe/London",
    overnight: false,
    ...parsedExtra,
  };
  if (startsAt !== undefined) parsed.startsAt = startsAt;
  if (endsAt !== undefined) parsed.endsAt = endsAt;
  return { rowNumber, raw: {}, parsed, problems: [], employeeId, ...rest };
}

const codes = (problems: ImportProblem[]) => problems.map((p) => p.code);
const CTX = { existingShifts: [] as ImportExistingShift[], knownLocations: ["High Street"] };

describe("intervalsOverlap", () => {
  it("uses half-open intervals so touching shifts do not overlap", () => {
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false);
    expect(intervalsOverlap(0, 10, 9, 20)).toBe(true);
    expect(intervalsOverlap(5, 6, 0, 10)).toBe(true);
    expect(intervalsOverlap(10, 20, 0, 10)).toBe(false);
  });
});

describe("validateRows", () => {
  it("marks clean rows VALID and does not mutate the input", () => {
    const input = [
      row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z", {
        parsedExtra: { locationName: "high  street" },
      }),
    ];
    const out = validateRows(input, CTX);
    expect(out[0]!.status).toBe("VALID");
    expect(out[0]!.problems).toEqual([]);
    expect(input[0]).not.toHaveProperty("status");
  });

  it("flags overlapping shifts within the file for the same employee only", () => {
    const out = validateRows(
      [
        row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z"),
        row(3, "jane", "2026-03-05T16:00:00.000Z", "2026-03-05T20:00:00.000Z"),
        row(4, "john", "2026-03-05T16:00:00.000Z", "2026-03-05T20:00:00.000Z"),
        row(5, "jane", "2026-03-05T20:00:00.000Z", "2026-03-05T23:00:00.000Z"), // touches row 3: fine
      ],
      CTX,
    );
    expect(out.map((r) => r.status)).toEqual(["ERROR", "ERROR", "VALID", "VALID"]);
    expect(out[0]!.problems).toEqual([
      expect.objectContaining({ code: "OVERLAPPING_SHIFT", details: { conflictingRow: 3 } }),
    ]);
    expect(out[1]!.problems).toEqual([
      expect.objectContaining({ code: "OVERLAPPING_SHIFT", details: { conflictingRow: 2 } }),
    ]);
  });

  it("flags overlaps against existing database shifts", () => {
    const existing: ImportExistingShift[] = [
      {
        id: "s1",
        employeeId: "jane",
        startsAt: "2026-03-05T12:00:00.000Z",
        endsAt: "2026-03-05T20:00:00.000Z",
      },
    ];
    const out = validateRows(
      [
        row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T13:00:00.000Z"),
        row(3, "jane", "2026-03-05T20:00:00.000Z", "2026-03-05T22:00:00.000Z"),
        row(4, "john", "2026-03-05T09:00:00.000Z", "2026-03-05T13:00:00.000Z"),
      ],
      { ...CTX, existingShifts: existing },
    );
    expect(out.map((r) => r.status)).toEqual(["ERROR", "VALID", "VALID"]);
    expect(out[0]!.problems).toEqual([
      expect.objectContaining({
        code: "OVERLAPPING_SHIFT",
        severity: "ERROR",
        details: { existingShiftId: "s1" },
      }),
    ]);
  });

  it("accepts Date instances for existing shifts", () => {
    const existing: ImportExistingShift[] = [
      {
        employeeId: "jane",
        startsAt: new Date("2026-03-05T09:00:00Z"),
        endsAt: new Date("2026-03-05T17:00:00Z"),
      },
    ];
    const out = validateRows(
      [row(2, "jane", "2026-03-05T10:00:00.000Z", "2026-03-05T11:00:00.000Z")],
      { ...CTX, existingShifts: existing },
    );
    expect(codes(out[0]!.problems)).toEqual(["OVERLAPPING_SHIFT"]);
  });

  it("skips rows identical to an existing shift instead of reporting an overlap", () => {
    const existing: ImportExistingShift[] = [
      {
        id: "s1",
        employeeId: "jane",
        startsAt: "2026-03-05T09:00:00.000Z",
        endsAt: "2026-03-05T17:00:00.000Z",
      },
    ];
    const out = validateRows(
      [
        row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z", {
          parsedExtra: { locationName: "Nowhere" },
        }),
        row(3, "jane", "2026-03-05T18:00:00.000Z", "2026-03-05T20:00:00.000Z"),
      ],
      { ...CTX, existingShifts: existing },
    );
    expect(out[0]!.status).toBe("SKIPPED");
    expect(out[0]!.problems).toEqual([
      expect.objectContaining({
        code: "DUPLICATE_SHIFT",
        severity: "WARNING",
        details: { existingShiftId: "s1" },
      }),
    ]);
    expect(out[1]!.status).toBe("VALID");
  });

  it("skips in-file duplicates after the first occurrence", () => {
    const out = validateRows(
      [
        row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z"),
        row(3, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z"),
        row(4, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z"),
      ],
      CTX,
    );
    expect(out.map((r) => r.status)).toEqual(["VALID", "SKIPPED", "SKIPPED"]);
    expect(out[1]!.problems).toEqual([
      expect.objectContaining({ code: "DUPLICATE_SHIFT", details: { duplicateOfRow: 2 } }),
    ]);
    expect(out[2]!.problems[0]!.details).toEqual({ duplicateOfRow: 2 });
  });

  it("treats equal-time rows with different details as a conflict, not a duplicate to skip", () => {
    const at = (rowNumber: number, parsedExtra: Partial<NormalisedRow["parsed"]>): NormalisedRow =>
      row(rowNumber, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z", {
        parsedExtra,
      });
    const ctx = { ...CTX, knownLocations: ["High Street", "Station Road"] };

    // Different location: which one is right would be a guess, so both rows are errors.
    const conflict = validateRows(
      [at(2, { locationName: "High Street" }), at(3, { locationName: "Station Road" })],
      ctx,
    );
    expect(conflict.map((r) => r.status)).toEqual(["ERROR", "ERROR"]);
    expect(conflict[0]!.problems).toEqual([
      expect.objectContaining({
        code: "OVERLAPPING_SHIFT",
        details: { conflictingRow: 3, sameTimes: true },
        message: expect.stringMatching(/^Same employee and times as row 3/),
      }),
    ]);
    expect(conflict[1]!.problems[0]!.details).toEqual({ conflictingRow: 2, sameTimes: true });

    // Different break or role: also a conflict.
    expect(
      validateRows([at(2, { breakMinutes: 30 }), at(3, {})], ctx).map((r) => r.status),
    ).toEqual(["ERROR", "ERROR"]);
    expect(
      validateRows([at(2, { role: "Barista" }), at(3, { role: "Chef" })], ctx).map((r) => r.status),
    ).toEqual(["ERROR", "ERROR"]);

    // Case/whitespace differences and "0" vs no break are the same shift: a true duplicate, skipped.
    const same = validateRows(
      [
        at(2, { locationName: "High Street", role: "Barista", breakMinutes: 0 }),
        at(3, { locationName: " high  STREET ", role: "barista" }),
      ],
      ctx,
    );
    expect(same.map((r) => r.status)).toEqual(["VALID", "SKIPPED"]);
    expect(same[1]!.problems).toEqual([
      expect.objectContaining({ code: "DUPLICATE_SHIFT", details: { duplicateOfRow: 2 } }),
    ]);
  });

  it("keeps the clean occurrence when an earlier identical row has its own error", () => {
    const out = validateRows(
      [
        row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z", {
          problems: [{ code: "INVALID_CSV", message: "ragged", severity: "ERROR" }],
        }),
        row(3, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z"),
      ],
      CTX,
    );
    expect(out.map((r) => r.status)).toEqual(["ERROR", "VALID"]);
    expect(codes(out[0]!.problems)).toEqual(["INVALID_CSV", "DUPLICATE_SHIFT"]);
    expect(out[0]!.problems[1]!.details).toEqual({ duplicateOfRow: 3 });
  });

  it("warns about unknown locations (case/whitespace-insensitive match)", () => {
    const out = validateRows(
      [
        row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z", {
          parsedExtra: { locationName: "Station Road" },
        }),
        row(3, "john", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z", {
          parsedExtra: { locationName: "HIGH STREET" },
        }),
        row(4, "amira", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z"),
      ],
      CTX,
    );
    expect(out.map((r) => r.status)).toEqual(["WARNING", "VALID", "VALID"]);
    expect(out[0]!.problems).toEqual([
      expect.objectContaining({
        code: "UNKNOWN_LOCATION",
        severity: "WARNING",
        field: "location",
        details: { locationName: "Station Road" },
      }),
    ]);
  });

  it("rejects shifts shorter than the minimum", () => {
    const rows = [row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T09:10:00.000Z")];
    const out = validateRows(rows, CTX);
    expect(out[0]!.status).toBe("ERROR");
    expect(out[0]!.problems).toEqual([
      expect.objectContaining({
        code: "SHIFT_TOO_SHORT",
        details: { minutes: 10, minShiftMinutes: 15 },
      }),
    ]);
    expect(validateRows(rows, { ...CTX, minShiftMinutes: 10 })[0]!.status).toBe("VALID");
    expect(
      validateRows(
        [row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T09:15:00.000Z")],
        CTX,
      )[0]!.status,
    ).toBe("VALID");
  });

  it("rejects shifts longer than 24 hours (e.g. an overnight shift across the autumn clock change)", () => {
    const rows = [row(2, "jane", "2026-10-24T08:00:00.000Z", "2026-10-25T09:00:00.000Z")]; // 25 hours
    const out = validateRows(rows, CTX);
    expect(out[0]!.status).toBe("ERROR");
    expect(out[0]!.problems).toEqual([
      expect.objectContaining({
        code: "SHIFT_TOO_LONG",
        details: { minutes: 1500, maxShiftMinutes: 1440 },
      }),
    ]);
    expect(
      validateRows(
        [row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-06T09:00:00.000Z")],
        CTX,
      )[0]!.status,
    ).toBe("VALID");
    expect(validateRows(rows, { ...CTX, maxShiftMinutes: 1500 })[0]!.status).toBe("VALID");
  });

  it("detects within-file overlaps across midnight for overnight shifts", () => {
    const out = validateRows(
      [
        row(2, "amira", "2026-03-05T22:00:00.000Z", "2026-03-06T06:00:00.000Z", {
          parsedExtra: { overnight: true },
        }),
        row(3, "amira", "2026-03-06T05:00:00.000Z", "2026-03-06T13:00:00.000Z"),
        row(4, "amira", "2026-03-06T13:00:00.000Z", "2026-03-06T17:00:00.000Z"),
      ],
      CTX,
    );
    expect(out.map((r) => r.status)).toEqual(["ERROR", "ERROR", "VALID"]);
  });

  it("reports each conflicting row when one shift overlaps several", () => {
    const out = validateRows(
      [
        row(2, "jane", "2026-03-05T08:00:00.000Z", "2026-03-05T20:00:00.000Z"),
        row(3, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T10:00:00.000Z"),
        row(4, "jane", "2026-03-05T18:00:00.000Z", "2026-03-05T19:00:00.000Z"),
      ],
      CTX,
    );
    expect(out[0]!.problems.map((p) => p.details)).toEqual([
      { conflictingRow: 3 },
      { conflictingRow: 4 },
    ]);
    expect(out[1]!.problems.map((p) => p.details)).toEqual([{ conflictingRow: 2 }]);
    expect(out[2]!.problems.map((p) => p.details)).toEqual([{ conflictingRow: 2 }]);
  });

  it("warns about shifts that already ended when `now` is provided", () => {
    const rows = [row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z")];
    expect(validateRows(rows, { ...CTX, now: "2026-03-06T00:00:00.000Z" })[0]!.problems).toEqual([
      expect.objectContaining({ code: "SHIFT_IN_PAST" }),
    ]);
    expect(validateRows(rows, { ...CTX, now: "2026-03-05T16:00:00.000Z" })[0]!.problems).toEqual(
      [],
    );
    expect(validateRows(rows, CTX)[0]!.problems).toEqual([]);
  });

  it("leaves rows without an employee or instants to their existing problems", () => {
    const unmatched = row(2, null, "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z", {
      problems: [{ code: "EMPLOYEE_NOT_FOUND", message: "x", severity: "ERROR" }],
    });
    const unparsed = row(3, "jane", undefined, undefined, {
      problems: [{ code: "INVALID_DATE", message: "x", severity: "ERROR" }],
    });
    const out = validateRows([unmatched, unparsed], CTX);
    expect(out.map((r) => r.status)).toEqual(["ERROR", "ERROR"]);
    expect(codes(out[0]!.problems)).toEqual(["EMPLOYEE_NOT_FOUND"]);
    expect(codes(out[1]!.problems)).toEqual(["INVALID_DATE"]);
  });

  it("still checks overlaps for rows that carry unrelated errors", () => {
    const out = validateRows(
      [
        row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z", {
          problems: [{ code: "INVALID_BREAK_MINUTES", message: "x", severity: "ERROR" }],
        }),
        row(3, "jane", "2026-03-05T16:00:00.000Z", "2026-03-05T18:00:00.000Z"),
      ],
      CTX,
    );
    expect(codes(out[0]!.problems)).toEqual(["INVALID_BREAK_MINUTES", "OVERLAPPING_SHIFT"]);
    expect(codes(out[1]!.problems)).toEqual(["OVERLAPPING_SHIFT"]);
  });

  it("derives status with ERROR > SKIPPED > WARNING > VALID precedence", () => {
    const w: ImportProblem = { code: "OVERNIGHT_SHIFT", message: "", severity: "WARNING" };
    const d: ImportProblem = { code: "DUPLICATE_SHIFT", message: "", severity: "WARNING" };
    const e: ImportProblem = { code: "INVALID_DATE", message: "", severity: "ERROR" };
    expect(importRowStatus([])).toBe("VALID");
    expect(importRowStatus([w])).toBe("WARNING");
    expect(importRowStatus([w, d])).toBe("SKIPPED");
    expect(importRowStatus([w, d, e])).toBe("ERROR");
  });
});

describe("importShiftWindow", () => {
  it("returns the employees and the time span to load existing shifts for", () => {
    const window = importShiftWindow([
      row(2, "jane", "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z"),
      row(3, "john", "2026-03-04T22:00:00.000Z", "2026-03-05T06:00:00.000Z"),
      row(4, "jane", "2026-03-07T09:00:00.000Z", "2026-03-07T17:00:00.000Z"),
      row(5, null, "2026-01-01T09:00:00.000Z", "2026-01-01T17:00:00.000Z"),
      row(6, "amira", undefined, undefined),
    ]);
    expect(window).toEqual({
      employeeIds: ["jane", "john"],
      from: "2026-03-04T22:00:00.000Z",
      to: "2026-03-07T17:00:00.000Z",
    });
  });

  it("returns null when no row can be checked", () => {
    expect(importShiftWindow([])).toBeNull();
    expect(
      importShiftWindow([row(2, null, "2026-03-05T09:00:00.000Z", "2026-03-05T17:00:00.000Z")]),
    ).toBeNull();
  });
});
