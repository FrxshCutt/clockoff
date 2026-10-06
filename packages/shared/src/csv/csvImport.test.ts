/** End-to-end: the pipeline the API runs, on a realistic export. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkMapping,
  detectHeaders,
  employeesToCreate,
  importShiftWindow,
  matchRows,
  normaliseRows,
  parseCsv,
  suggestMapping,
  summarise,
  toErrorsCsv,
  unknownLocations,
  validateRows,
  type EmployeeCandidate,
  type ImportExistingShift,
} from "./csvImport";

const FILE = [
  "\uFEFFStaff;Payroll Number;Email;Date;Shift Start;Finish;Site;Break (mins);Notes",
  "Jane Smith;E1042;;05/03/2026;09:00;17:00;High Street;30;",
  "Smith, John;;;05/03/2026;2pm;10pm;High Street;;late",
  ";;amira.khan@example.com;05/03/2026;22:00;06:00;Station Road;45;",
  "Jane Smith;E1042;;05/03/2026;16:00;20:00;High Street;;overlaps row 2",
  "Sam Lee;;;05/03/2026;09:00;17:00;High Street;;not an employee",
  "Jane Smith;;;31/02/2026;09:00;17:00;High Street;;bad date",
  "John Smith;E1043;;06/03/2026;09:00;17:00;High Street;;already in the database",
  "Jane Smith;E1042;;06/03/2026;09:00;09:10;High Street;;too short",
  "",
].join("\r\n");

const EMPLOYEES: EmployeeCandidate[] = [
  {
    id: "jane",
    firstName: "Jane",
    lastName: "Smith",
    email: "jane.smith@example.com",
    externalEmployeeId: "E1042",
  },
  { id: "john", firstName: "John", lastName: "Smith", email: null, externalEmployeeId: "E1043" },
  {
    id: "amira",
    firstName: "Amira",
    lastName: "Khan",
    email: "Amira.Khan@example.com",
    externalEmployeeId: "E1044",
  },
];
const EXISTING: ImportExistingShift[] = [
  {
    id: "s1",
    employeeId: "john",
    startsAt: "2026-03-06T09:00:00.000Z",
    endsAt: "2026-03-06T17:00:00.000Z",
  },
];

describe("CSV import pipeline", () => {
  it("detects, maps, parses, matches, validates and summarises", () => {
    const detected = detectHeaders(FILE);
    expect(detected.delimiter).toBe(";");
    expect(detected.hasHeaderRow).toBe(true);
    expect(detected.headers[0]).toBe("Staff");

    const { mapping } = suggestMapping(detected.headers);
    expect(mapping).toEqual({
      Staff: "employee_name",
      "Payroll Number": "employee_id",
      Email: "email",
      Date: "date",
      "Shift Start": "start_time",
      Finish: "end_time",
      Site: "location",
      "Break (mins)": "break_minutes",
      Notes: null,
    });
    expect(checkMapping(mapping).complete).toBe(true);

    const parsed = parseCsv(FILE, {
      delimiter: detected.delimiter,
      hasHeaderRow: detected.hasHeaderRow,
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(8);

    const normalised = normaliseRows(parsed.records, mapping, {
      dateFormat: "DMY",
      timezone: "Europe/London",
    });
    const matched = matchRows(normalised, EMPLOYEES);
    expect(importShiftWindow(matched)).toEqual({
      employeeIds: ["jane", "john", "amira"],
      from: "2026-03-05T09:00:00.000Z",
      to: "2026-03-06T17:00:00.000Z",
    });
    const validated = validateRows(matched, {
      existingShifts: EXISTING,
      knownLocations: ["High Street"],
    });

    const byRow = Object.fromEntries(validated.map((r) => [r.rowNumber, r]));
    expect(byRow[2]).toMatchObject({ employeeId: "jane", status: "ERROR" }); // overlaps row 5
    expect(byRow[2]!.problems.map((p) => p.code)).toEqual(["OVERLAPPING_SHIFT"]);
    expect(byRow[2]!.parsed).toMatchObject({
      startsAt: "2026-03-05T09:00:00.000Z",
      endsAt: "2026-03-05T17:00:00.000Z",
      breakMinutes: 30,
    });
    expect(byRow[3]).toMatchObject({ employeeId: "john", status: "VALID" });
    expect(byRow[3]!.parsed).toMatchObject({ startTime: "14:00", endTime: "22:00" });
    expect(byRow[4]).toMatchObject({ employeeId: "amira", status: "WARNING" });
    expect(byRow[4]!.problems.map((p) => p.code).sort()).toEqual([
      "OVERNIGHT_SHIFT",
      "UNKNOWN_LOCATION",
    ]);
    expect(byRow[5]).toMatchObject({ employeeId: "jane", status: "ERROR" });
    expect(byRow[5]!.problems).toEqual([
      expect.objectContaining({ code: "OVERLAPPING_SHIFT", details: { conflictingRow: 2 } }),
    ]);
    expect(byRow[6]).toMatchObject({ employeeId: null, status: "ERROR" });
    expect(byRow[6]!.problems[0]).toMatchObject({
      code: "EMPLOYEE_NOT_FOUND",
      details: { suggestedEmployee: { firstName: "Sam", lastName: "Lee" } },
    });
    expect(byRow[7]!.problems.map((p) => p.code)).toEqual(["INVALID_DATE"]);
    expect(byRow[8]).toMatchObject({ employeeId: "john", status: "SKIPPED" });
    expect(byRow[9]!.problems.map((p) => p.code)).toEqual(["SHIFT_TOO_SHORT"]);

    expect(summarise(validated)).toEqual({
      total: 8,
      valid: 1,
      warning: 1,
      error: 5,
      skipped: 1,
      importable: 2,
      problemCounts: {
        OVERLAPPING_SHIFT: 2,
        OVERNIGHT_SHIFT: 1,
        UNKNOWN_LOCATION: 1,
        EMPLOYEE_NOT_FOUND: 1,
        INVALID_DATE: 1,
        DUPLICATE_SHIFT: 1,
        SHIFT_TOO_SHORT: 1,
      },
    });

    const errorsCsv = toErrorsCsv(validated);
    const lines = errorsCsv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "row_number,status,problems,Staff,Payroll Number,Email,Date,Shift Start,Finish,Site,Break (mins),Notes",
    );
    expect(lines).toHaveLength(1 + 7); // every row except the clean one
    expect(lines[1]!.startsWith("2,ERROR,")).toBe(true);

    // docs/CSV_IMPORT.md shows this file and the first lines of its errors CSV in the worked example.
    const docs = readFileSync(
      resolve(import.meta.dirname, "../../../../docs/CSV_IMPORT.md"),
      "utf8",
    );
    for (const line of FILE.replace("﻿", "")
      .split("\r\n")
      .filter((l) => l !== "")) {
      expect(docs).toContain(`\n${line}\n`);
    }
    expect(docs).toContain(`\n${lines[0]}\n${lines[1]}\n`);

    expect(unknownLocations(validated)).toEqual([{ name: "Station Road", rowNumbers: [4] }]);
    expect(employeesToCreate(validated)).toEqual([
      { suggested: { firstName: "Sam", lastName: "Lee" }, rowNumbers: [6] },
    ]);
  });

  it("runs the whole pipeline on a full 5,000-row file", () => {
    const employees: EmployeeCandidate[] = Array.from({ length: 200 }, (_, i) => ({
      id: `emp-${i}`,
      firstName: `First${i}`,
      lastName: `Last${i}`,
      email: `person${i}@example.com`,
      externalEmployeeId: `E${1000 + i}`,
    }));
    const lines = ["employee_id,date,start_time,end_time,location"];
    for (let r = 0; r < 5000; r++) {
      const emp = r % 200;
      const day = 1 + Math.floor(r / 200); // 25 days, one shift per employee per day
      lines.push(`E${1000 + emp},${String(day).padStart(2, "0")}/11/2026,09:00,17:00,High Street`);
    }
    const text = lines.join("\r\n");
    const detected = detectHeaders(text);
    const { mapping } = suggestMapping(detected.headers);
    const parsed = parseCsv(text);
    expect(parsed.errors).toEqual([]);
    const matched = matchRows(
      normaliseRows(parsed.records, mapping, { dateFormat: "DMY", timezone: "Europe/London" }),
      employees,
    );
    const existing: ImportExistingShift[] = employees.map((e) => ({
      employeeId: e.id,
      startsAt: "2026-11-01T09:00:00.000Z",
      endsAt: "2026-11-01T17:00:00.000Z",
    }));
    const validated = validateRows(matched, {
      existingShifts: existing,
      knownLocations: ["High Street"],
    });
    expect(summarise(validated)).toMatchObject({
      total: 5000,
      valid: 4800,
      skipped: 200,
      error: 0,
      warning: 0,
      importable: 4800,
    });
  });
});
