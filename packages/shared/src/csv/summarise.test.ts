import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import {
  employeesToCreate,
  formatProblems,
  summarise,
  toErrorsCsv,
  unknownLocations,
} from "./summarise";
import type { ValidatedRow } from "./types";

const base = { parsed: { timezone: "Europe/London", overnight: false } };
const rows: ValidatedRow[] = [
  {
    ...base,
    rowNumber: 2,
    raw: { Name: "Jane Smith", Date: "2026-03-05" },
    problems: [],
    status: "VALID",
  },
  {
    ...base,
    rowNumber: 3,
    raw: { Name: "Smith, John", Date: "31/02/2026" },
    problems: [
      {
        code: "INVALID_DATE",
        message: '"31/02/2026" is not a real date.',
        field: "date",
        severity: "ERROR",
      },
    ],
    status: "ERROR",
  },
  {
    ...base,
    rowNumber: 4,
    raw: { Name: "Amira Khan", Date: "2026-03-05", Site: "Station Road" },
    problems: [
      { code: "UNKNOWN_LOCATION", message: "Unknown", field: "location", severity: "WARNING" },
      { code: "OVERNIGHT_SHIFT", message: "Overnight", severity: "WARNING" },
    ],
    status: "WARNING",
  },
  {
    ...base,
    rowNumber: 5,
    raw: { Name: "Jane Smith", Date: "2026-03-06" },
    problems: [{ code: "DUPLICATE_SHIFT", message: "dup", severity: "WARNING" }],
    status: "SKIPPED",
  },
];

describe("summarise", () => {
  it("counts statuses and problem codes", () => {
    expect(summarise(rows)).toEqual({
      total: 4,
      valid: 1,
      warning: 1,
      error: 1,
      skipped: 1,
      importable: 2,
      problemCounts: {
        INVALID_DATE: 1,
        UNKNOWN_LOCATION: 1,
        OVERNIGHT_SHIFT: 1,
        DUPLICATE_SHIFT: 1,
      },
    });
    expect(summarise([])).toEqual({
      total: 0,
      valid: 0,
      warning: 0,
      error: 0,
      skipped: 0,
      importable: 0,
      problemCounts: {},
    });
  });
});

describe("toErrorsCsv", () => {
  it("emits only rows with problems, with row number, status, problems and the original columns", () => {
    const csv = toErrorsCsv(rows);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("row_number,status,problems,Name,Date,Site");
    expect(lines[1]).toBe(
      '3,ERROR,"ERROR INVALID_DATE (date): ""31/02/2026"" is not a real date.","Smith, John",31/02/2026,',
    );
    expect(lines[2]).toBe(
      "4,WARNING,WARNING UNKNOWN_LOCATION (location): Unknown | WARNING OVERNIGHT_SHIFT: Overnight,Amira Khan,2026-03-05,Station Road",
    );
    expect(lines[3]).toBe("5,SKIPPED,WARNING DUPLICATE_SHIFT: dup,Jane Smith,2026-03-06,");
    expect(lines[4]).toBe("");
    expect(lines).toHaveLength(5);
  });

  it("returns an empty string when nothing went wrong", () => {
    expect(toErrorsCsv([rows[0]!])).toBe("");
    expect(formatProblems([])).toBe("");
  });

  it("neutralises spreadsheet formulas in uploaded values (CSV injection)", () => {
    const evil: ValidatedRow = {
      ...base,
      rowNumber: 2,
      raw: { Name: '=HYPERLINK("http://evil.example","x")', Notes: "@SUM(1)", Break: "-5" },
      problems: [
        {
          code: "INVALID_BREAK_MINUTES",
          message: "bad",
          field: "break_minutes",
          severity: "ERROR",
        },
      ],
      status: "ERROR",
    };
    const csv = toErrorsCsv([evil]);
    const parsed = Papa.parse<string[]>(csv.trim()).data;
    expect(parsed[1]!.slice(3)).toEqual([
      '\'=HYPERLINK("http://evil.example","x")',
      "'@SUM(1)",
      "'-5",
    ]);
  });

  it("also neutralises multi-line, full-width and header formulas", () => {
    // Papa's own `escapeFormulae: true` pattern does not match a cell with a line break in it.
    const evil: ValidatedRow = {
      ...base,
      rowNumber: 2,
      raw: { "=Header": "=1+\n1", Notes: "＝SUM(A1)", Plain: "Jane = boss" },
      problems: [{ code: "INVALID_DATE", message: "bad", field: "date", severity: "ERROR" }],
      status: "ERROR",
    };
    const parsed = Papa.parse<string[]>(toErrorsCsv([evil]).trim()).data;
    expect(parsed[0]!.slice(3)).toEqual(["'=Header", "Notes", "Plain"]);
    expect(parsed[1]!.slice(3)).toEqual(["'=1+\n1", "'＝SUM(A1)", "Jane = boss"]);
  });
});

describe("unknownLocations", () => {
  it("lists distinct unknown location names with their rows", () => {
    const loc = (rowNumber: number, locationName: string, warn = true): ValidatedRow => ({
      rowNumber,
      raw: {},
      parsed: { timezone: "Europe/London", overnight: false, locationName },
      problems: warn
        ? [{ code: "UNKNOWN_LOCATION", message: "", field: "location", severity: "WARNING" }]
        : [],
      status: warn ? "WARNING" : "VALID",
    });
    expect(
      unknownLocations([
        loc(2, "Station Road"),
        loc(3, "station  road"),
        loc(4, "Pier"),
        loc(5, "High Street", false),
      ]),
    ).toEqual([
      { name: "Station Road", rowNumbers: [2, 3] },
      { name: "Pier", rowNumbers: [4] },
    ]);
  });
});

describe("employeesToCreate", () => {
  it("groups EMPLOYEE_NOT_FOUND rows by id, then email, then name", () => {
    const nf = (rowNumber: number, parsed: Partial<ValidatedRow["parsed"]>): ValidatedRow => ({
      rowNumber,
      raw: {},
      parsed: { timezone: "Europe/London", overnight: false, ...parsed },
      problems: [{ code: "EMPLOYEE_NOT_FOUND", message: "", severity: "ERROR" }],
      status: "ERROR",
    });
    const result = employeesToCreate([
      nf(2, { employeeName: "Lee, Sam", employeeExternalId: "E2000" }),
      nf(3, { employeeName: "Sam Lee", employeeExternalId: "e2000 " }),
      nf(4, { employeeName: "Priya Patel", email: "priya@example.com" }),
      nf(5, { email: "priya@example.com" }),
      nf(6, { employeeName: "Tom  Jones" }),
      nf(7, { employeeName: "tom jones" }),
      nf(8, {}),
    ]);
    expect(result).toEqual([
      {
        suggested: { firstName: "Sam", lastName: "Lee", externalEmployeeId: "E2000" },
        rowNumbers: [2, 3],
      },
      {
        suggested: { firstName: "Priya", lastName: "Patel", email: "priya@example.com" },
        rowNumbers: [4, 5],
      },
      { suggested: { firstName: "Tom", lastName: "Jones" }, rowNumbers: [6, 7] },
    ]);
  });
});
