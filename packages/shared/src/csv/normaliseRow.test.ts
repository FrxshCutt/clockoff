import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { normaliseRow, normaliseRows, parseBreakMinutes, normaliseEmail } from "./normaliseRow";
import type { ColumnMapping, ImportField, ImportProblem, NormaliseRowOptions } from "./types";

const MAPPING: ColumnMapping = {
  Name: "employee_name",
  ID: "employee_id",
  Email: "email",
  Date: "date",
  Start: "start_time",
  End: "end_time",
  Site: "location",
  Dept: "department",
  Role: "role",
  Break: "break_minutes",
  Notes: null,
};
const LONDON: NormaliseRowOptions = { dateFormat: "DMY", timezone: "Europe/London" };
const codes = (problems: ImportProblem[]) => problems.map((p) => p.code);

describe("normaliseRow", () => {
  it("parses a full row into typed values and UTC instants", () => {
    const { parsed, problems } = normaliseRow(
      {
        Name: " Jane  Smith ",
        ID: "E1042",
        Email: "Jane.Smith@Example.com",
        Date: "05/03/2026",
        Start: "9am",
        End: "17:30",
        Site: "High Street",
        Dept: "Front of house",
        Role: "Barista",
        Break: "30 mins",
        Notes: "ignored",
      },
      MAPPING,
      LONDON,
    );
    expect(problems).toEqual([]);
    expect(parsed).toEqual({
      employeeName: "Jane Smith",
      employeeExternalId: "E1042",
      email: "jane.smith@example.com",
      date: "2026-03-05",
      startTime: "09:00",
      endTime: "17:30",
      startsAt: "2026-03-05T09:00:00.000Z",
      endsAt: "2026-03-05T17:30:00.000Z",
      timezone: "Europe/London",
      overnight: false,
      locationName: "High Street",
      departmentName: "Front of house",
      role: "Barista",
      breakMinutes: 30,
    });
  });

  it("converts BST local times to UTC", () => {
    const { parsed } = normaliseRow(
      { Name: "Jane Smith", Date: "2026-06-01", Start: "09:00", End: "17:00" },
      MAPPING,
      LONDON,
    );
    expect(parsed.startsAt).toBe("2026-06-01T08:00:00.000Z");
    expect(parsed.endsAt).toBe("2026-06-01T16:00:00.000Z");
  });

  it("treats end ≤ start as an overnight shift with a warning", () => {
    const { parsed, problems } = normaliseRow(
      { Name: "Jane Smith", Date: "2026-03-05", Start: "22:00", End: "06:00" },
      MAPPING,
      LONDON,
    );
    expect(parsed.overnight).toBe(true);
    expect(parsed.startsAt).toBe("2026-03-05T22:00:00.000Z");
    expect(parsed.endsAt).toBe("2026-03-06T06:00:00.000Z");
    expect(problems).toEqual([
      expect.objectContaining({ code: "OVERNIGHT_SHIFT", severity: "WARNING", field: "end_time" }),
    ]);

    const equal = normaliseRow(
      { Name: "Jane Smith", Date: "2026-03-05", Start: "09:00", End: "09:00" },
      MAPPING,
      LONDON,
    );
    expect(equal.parsed.overnight).toBe(true);
    expect(equal.parsed.endsAt).toBe("2026-03-06T09:00:00.000Z");
  });

  it("accepts 24:00 as an end time but not a start time", () => {
    const ok = normaliseRow(
      { Name: "Jane Smith", Date: "2026-03-05", Start: "16:00", End: "24:00" },
      MAPPING,
      LONDON,
    );
    expect(ok.problems).toEqual([]);
    expect(ok.parsed.endsAt).toBe("2026-03-06T00:00:00.000Z");
    const bad = normaliseRow(
      { Name: "Jane Smith", Date: "2026-03-05", Start: "24:00", End: "08:00" },
      MAPPING,
      LONDON,
    );
    expect(codes(bad.problems)).toEqual(["INVALID_TIME"]);
    expect(bad.parsed.startTime).toBeUndefined();
    expect(bad.parsed.startsAt).toBeUndefined();
    const badDateToo = normaliseRow(
      { Name: "Jane Smith", Date: "nope", Start: "24:00", End: "08:00" },
      MAPPING,
      LONDON,
    );
    expect(codes(badDateToo.problems)).toEqual(["INVALID_DATE", "INVALID_TIME"]);
  });

  it.each([
    ["9am", "5pm", "09:00", "17:00"],
    ["9:30pm", "11:45 PM", "21:30", "23:45"],
    ["0900", "1730", "09:00", "17:30"],
    ["21.30", "23.00", "21:30", "23:00"],
    ["9", "17", "09:00", "17:00"],
  ])("accepts time variants %s – %s", (start, end, startTime, endTime) => {
    const { parsed, problems } = normaliseRow(
      { Name: "Jane", Date: "2026-03-05", Start: start, End: end },
      MAPPING,
      LONDON,
    );
    expect(problems).toEqual([]);
    expect(parsed).toMatchObject({ startTime, endTime, overnight: false });
  });

  it("treats a 12-hour overnight pair (10pm – 6am) as overnight", () => {
    const { parsed, problems } = normaliseRow(
      { Name: "Jane", Date: "05/03/2026", Start: "10pm", End: "6am" },
      MAPPING,
      LONDON,
    );
    expect(codes(problems)).toEqual(["OVERNIGHT_SHIFT"]);
    expect(problems[0]!.details).toEqual({ endDate: "2026-03-06" });
    expect(parsed).toMatchObject({
      startsAt: "2026-03-05T22:00:00.000Z",
      endsAt: "2026-03-06T06:00:00.000Z",
      overnight: true,
    });
  });

  it("computes overnight instants across a timezone other than London", () => {
    const { parsed } = normaliseRow(
      { Name: "Jane", Date: "07/01/2026", Start: "22:00", End: "06:00" },
      MAPPING,
      {
        dateFormat: "MDY",
        timezone: "America/New_York",
      },
    );
    expect(parsed).toMatchObject({
      date: "2026-07-01",
      startsAt: "2026-07-02T02:00:00.000Z",
      endsAt: "2026-07-02T10:00:00.000Z",
    });
  });

  it("reports every missing required field, including a missing employee identifier", () => {
    const { problems, parsed } = normaliseRow({ Notes: "x" }, MAPPING, LONDON);
    expect(problems).toHaveLength(4);
    expect(problems.map((p) => p.field)).toEqual([
      "date",
      "start_time",
      "end_time",
      "employee_name",
    ]);
    expect(
      problems.every((p) => p.code === "MISSING_REQUIRED_FIELD" && p.severity === "ERROR"),
    ).toBe(true);
    expect(parsed.startsAt).toBeUndefined();
  });

  it("distinguishes an unmapped column from an empty cell", () => {
    const unmapped = normaliseRow(
      { Name: "Jane", Start: "09:00", End: "17:00" },
      { Name: "employee_name", Start: "start_time", End: "end_time" },
      LONDON,
    );
    expect(unmapped.problems[0]!.message).toMatch(/No column is mapped to Date/);
    const empty = normaliseRow(
      { Name: "Jane", Date: "", Start: "09:00", End: "17:00" },
      MAPPING,
      LONDON,
    );
    expect(empty.problems[0]!.message).toMatch(/Date is empty/);
  });

  it("does not require a name when an ID or email identifies the employee", () => {
    expect(
      normaliseRow({ ID: "E1", Date: "2026-03-05", Start: "09:00", End: "17:00" }, MAPPING, LONDON)
        .problems,
    ).toEqual([]);
    expect(
      normaliseRow(
        { Email: "a@b.co", Date: "2026-03-05", Start: "09:00", End: "17:00" },
        MAPPING,
        LONDON,
      ).problems,
    ).toEqual([]);
  });

  it("reports invalid dates and times per field and leaves instants undefined", () => {
    const { parsed, problems } = normaliseRow(
      { Name: "Jane", Date: "31/02/2026", Start: "25:00", End: "5pm" },
      MAPPING,
      LONDON,
    );
    expect(problems).toEqual([
      expect.objectContaining({ code: "INVALID_DATE", field: "date", severity: "ERROR" }),
      expect.objectContaining({ code: "INVALID_TIME", field: "start_time", severity: "ERROR" }),
    ]);
    expect(parsed.endTime).toBe("17:00");
    expect(parsed.startsAt).toBeUndefined();
    expect(parsed.endsAt).toBeUndefined();
  });

  it("honours the organisation's date format", () => {
    const mdy = normaliseRow(
      { Name: "Jane", Date: "03/04/2026", Start: "09:00", End: "17:00" },
      MAPPING,
      { ...LONDON, dateFormat: "MDY" },
    );
    expect(mdy.parsed.date).toBe("2026-03-04");
    const dmy = normaliseRow(
      { Name: "Jane", Date: "03/04/2026", Start: "09:00", End: "17:00" },
      MAPPING,
      LONDON,
    );
    expect(dmy.parsed.date).toBe("2026-04-03");
  });

  it("warns about malformed emails and drops them from matching", () => {
    const { parsed, problems } = normaliseRow(
      { Name: "Jane", Email: "not-an-email", Date: "2026-03-05", Start: "09:00", End: "17:00" },
      MAPPING,
      LONDON,
    );
    expect(parsed.email).toBeUndefined();
    expect(problems).toEqual([
      expect.objectContaining({ code: "INVALID_EMAIL", severity: "WARNING", field: "email" }),
    ]);
  });

  it("rejects breaks over 240 minutes or that do not fit in the shift", () => {
    const long = normaliseRow(
      { Name: "Jane", Date: "2026-03-05", Start: "06:00", End: "18:00", Break: "300" },
      MAPPING,
      LONDON,
    );
    expect(long.problems).toEqual([
      expect.objectContaining({
        code: "INVALID_BREAK_MINUTES",
        details: { breakMinutes: 300, maxBreakMinutes: 240 },
      }),
    ]);
    expect(long.parsed.breakMinutes).toBeUndefined();
    const noFit = normaliseRow(
      { Name: "Jane", Date: "2026-03-05", Start: "09:00", End: "10:00", Break: "60" },
      MAPPING,
      LONDON,
    );
    expect(noFit.problems).toEqual([
      expect.objectContaining({
        code: "INVALID_BREAK_MINUTES",
        details: { breakMinutes: 60, shiftMinutes: 60 },
      }),
    ]);
    const fits = normaliseRow(
      { Name: "Jane", Date: "2026-03-05", Start: "09:00", End: "10:00", Break: "0" },
      MAPPING,
      LONDON,
    );
    expect(fits.problems).toEqual([]);
    expect(fits.parsed.breakMinutes).toBe(0);
  });

  it("rejects non-numeric break minutes", () => {
    const { parsed, problems } = normaliseRow(
      { Name: "Jane", Date: "2026-03-05", Start: "09:00", End: "17:00", Break: "half an hour" },
      MAPPING,
      LONDON,
    );
    expect(parsed.breakMinutes).toBeUndefined();
    expect(problems).toEqual([
      expect.objectContaining({
        code: "INVALID_BREAK_MINUTES",
        severity: "ERROR",
        field: "break_minutes",
      }),
    ]);
    expect(parseBreakMinutes("")).toBeUndefined();
    expect(parseBreakMinutes("45")).toBe(45);
    expect(parseBreakMinutes("20m")).toBe(20);
    expect(parseBreakMinutes("-5")).toBeNull();
    expect(parseBreakMinutes("1.5")).toBeNull();
    expect(normaliseEmail(" A@B.COM ")).toBe("a@b.com");
    expect(normaliseEmail("nope")).toBeNull();
  });

  it("applies the default location only when the row has none", () => {
    const opts = { ...LONDON, defaultLocationName: "Head Office" };
    expect(
      normaliseRow(
        { Name: "Jane", Date: "2026-03-05", Start: "09:00", End: "17:00" },
        MAPPING,
        opts,
      ).parsed.locationName,
    ).toBe("Head Office");
    expect(
      normaliseRow(
        { Name: "Jane", Date: "2026-03-05", Start: "09:00", End: "17:00", Site: "Shop" },
        MAPPING,
        opts,
      ).parsed.locationName,
    ).toBe("Shop");
    expect(
      normaliseRow(
        { Name: "Jane", Date: "2026-03-05", Start: "09:00", End: "17:00" },
        MAPPING,
        LONDON,
      ).parsed.locationName,
    ).toBeUndefined();
  });

  it("warns when a local time falls into the spring-forward gap", () => {
    const { parsed, problems } = normaliseRow(
      { Name: "Jane", Date: "2026-03-29", Start: "01:30", End: "09:00" },
      MAPPING,
      LONDON,
    );
    expect(problems).toEqual([
      expect.objectContaining({
        code: "DST_ADJUSTED_TIME",
        severity: "WARNING",
        field: "start_time",
      }),
    ]);
    expect(parsed.startsAt).toBe("2026-03-29T01:30:00.000Z"); // 02:30 BST
  });

  it("warns when a local time happens twice at the autumn clock change", () => {
    const { parsed, problems } = normaliseRow(
      { Name: "Jane", Date: "2026-10-24", Start: "22:00", End: "01:30" },
      MAPPING,
      LONDON,
    );
    expect(codes(problems)).toEqual(["OVERNIGHT_SHIFT", "DST_AMBIGUOUS_TIME"]);
    expect(problems[1]).toMatchObject({ severity: "WARNING", field: "end_time" });
    expect(parsed.startsAt).toBe("2026-10-24T21:00:00.000Z"); // 22:00 BST
    expect(parsed.endsAt).toBe("2026-10-25T00:30:00.000Z"); // first 01:30 (BST)
  });

  it("throws AppError(INVALID_TIMEZONE) for a bad timezone option", () => {
    expect(() =>
      normaliseRow({ Name: "Jane" }, MAPPING, { dateFormat: "DMY", timezone: "Mars/Olympus" }),
    ).toThrowError(AppError);
    try {
      normaliseRow({ Name: "Jane" }, MAPPING, { dateFormat: "DMY", timezone: "Mars/Olympus" });
    } catch (e) {
      expect((e as AppError).code).toBe("INVALID_TIMEZONE");
    }
  });

  it("uses the first header mapped to a field when the mapping has duplicates", () => {
    const mapping: ColumnMapping = {
      Name: "employee_name",
      A: "date",
      B: "date",
      Start: "start_time",
      End: "end_time",
    };
    const { parsed } = normaliseRow(
      { Name: "Jane", A: "2026-03-05", B: "2026-03-06", Start: "09:00", End: "17:00" },
      mapping,
      LONDON,
    );
    expect(parsed.date).toBe("2026-03-05");
  });

  it("reads only the row's own cells, so odd header names neither crash nor leak", () => {
    // A mapping naming headers the row does not have must not read Object.prototype members.
    const mapping: ColumnMapping = Object.fromEntries<ImportField | null>([
      ["toString", "employee_name"],
      ["constructor", "email"],
      ["Date", "date"],
      ["Start", "start_time"],
      ["End", "end_time"],
    ]);
    const { parsed, problems } = normaliseRow(
      { Date: "2026-03-05", Start: "09:00", End: "17:00" },
      mapping,
      LONDON,
    );
    expect(parsed.employeeName).toBeUndefined();
    expect(parsed.email).toBeUndefined();
    expect(codes(problems)).toEqual(["MISSING_REQUIRED_FIELD"]);
    // A real "__proto__" column (own property, as parseCsv and JSON.parse create it) is read normally.
    const raw = JSON.parse(
      '{"__proto__":"Jane Smith","Date":"2026-03-05","Start":"09:00","End":"17:00"}',
    ) as Record<string, string>;
    const protoMapping = JSON.parse(
      '{"__proto__":"employee_name","Date":"date","Start":"start_time","End":"end_time"}',
    ) as ColumnMapping;
    expect(normaliseRow(raw, protoMapping, LONDON)).toMatchObject({
      parsed: { employeeName: "Jane Smith", startsAt: "2026-03-05T09:00:00.000Z" },
      problems: [],
    });
  });
});

describe("normaliseRows", () => {
  it("carries structural row problems through and keeps row numbers and raw values", () => {
    const rows = normaliseRows(
      [
        {
          rowNumber: 2,
          values: { Name: "Jane Smith", Date: "2026-03-05", Start: "09:00", End: "17:00" },
          problems: [],
        },
        {
          rowNumber: 4,
          values: { Name: "John", Date: "bad", Start: "09:00", End: "17:00" },
          problems: [{ code: "INVALID_CSV", message: "ragged", severity: "WARNING" }],
        },
      ],
      MAPPING,
      LONDON,
    );
    expect(rows[0]).toMatchObject({ rowNumber: 2, raw: { Name: "Jane Smith" }, problems: [] });
    expect(rows[0]!.employeeId).toBeUndefined();
    expect(rows[0]!.parsed.startsAt).toBe("2026-03-05T09:00:00.000Z");
    expect(rows[1]!.rowNumber).toBe(4);
    expect(codes(rows[1]!.problems)).toEqual(["INVALID_CSV", "INVALID_DATE"]);
  });
});
