import { describe, expect, it } from "vitest";
import { SHIFT_IMPORT_ROW_STATUSES } from "../enums";
import {
  IMPORT_FIELD_INFO,
  IMPORT_FIELDS,
  IMPORT_LIMITS,
  IMPORT_PROBLEM_CODES,
  IMPORT_PROBLEM_INFO,
  REQUIRED_IMPORT_FIELDS,
  EMPLOYEE_IDENTIFIER_FIELDS,
  problem,
} from "./types";

describe("import field and problem catalogues", () => {
  it("lists the §6.5 fields in template order with UI copy for each", () => {
    expect(IMPORT_FIELDS).toEqual([
      "employee_name",
      "employee_id",
      "email",
      "date",
      "start_time",
      "end_time",
      "location",
      "department",
      "role",
      "break_minutes",
    ]);
    for (const f of IMPORT_FIELDS) expect(IMPORT_FIELD_INFO[f].label.length).toBeGreaterThan(0);
    for (const f of REQUIRED_IMPORT_FIELDS)
      expect(IMPORT_FIELD_INFO[f].requirement).toBe("required");
    for (const f of EMPLOYEE_IDENTIFIER_FIELDS)
      expect(IMPORT_FIELD_INFO[f].requirement).toBe("identifier");
  });

  it("includes every §6.5 problem code, each with a title and resolution", () => {
    for (const code of [
      "INVALID_DATE",
      "INVALID_TIME",
      "MISSING_REQUIRED_FIELD",
      "OVERLAPPING_SHIFT",
      "DUPLICATE_SHIFT",
      "UNKNOWN_LOCATION",
      "MULTIPLE_MATCHES",
      "EMPLOYEE_NOT_FOUND",
      "SHIFT_TOO_SHORT",
      "OVERNIGHT_SHIFT",
      "INVALID_CSV",
    ] as const) {
      expect(IMPORT_PROBLEM_CODES).toContain(code);
    }
    for (const code of IMPORT_PROBLEM_CODES) {
      expect(IMPORT_PROBLEM_INFO[code].title.length).toBeGreaterThan(0);
      expect(IMPORT_PROBLEM_INFO[code].resolution.length).toBeGreaterThan(0);
    }
    expect(new Set(IMPORT_PROBLEM_CODES).size).toBe(IMPORT_PROBLEM_CODES.length);
  });

  it("uses the spec severities: overnight/unknown location/duplicate warn, the rest of §6.5 errors", () => {
    expect(IMPORT_PROBLEM_INFO.OVERNIGHT_SHIFT.severity).toBe("WARNING");
    expect(IMPORT_PROBLEM_INFO.UNKNOWN_LOCATION.severity).toBe("WARNING");
    expect(IMPORT_PROBLEM_INFO.DUPLICATE_SHIFT.severity).toBe("WARNING");
    for (const code of [
      "MULTIPLE_MATCHES",
      "EMPLOYEE_NOT_FOUND",
      "OVERLAPPING_SHIFT",
      "INVALID_DATE",
      "INVALID_TIME",
      "MISSING_REQUIRED_FIELD",
      "SHIFT_TOO_SHORT",
    ] as const) {
      expect(IMPORT_PROBLEM_INFO[code].severity).toBe("ERROR");
    }
  });

  it("documents the limits", () => {
    expect(IMPORT_LIMITS).toMatchObject({
      maxFileBytes: 5 * 1024 * 1024,
      maxRows: 5000,
      minShiftMinutes: 15,
      maxShiftMinutes: 1440,
    });
  });

  it("row statuses before import are the Prisma statuses minus IMPORTED", () => {
    expect(SHIFT_IMPORT_ROW_STATUSES.filter((s) => s !== "IMPORTED")).toEqual([
      "VALID",
      "WARNING",
      "ERROR",
      "SKIPPED",
    ]);
  });
});

describe("problem()", () => {
  it("defaults the severity from the catalogue and omits absent optional keys", () => {
    expect(problem("OVERNIGHT_SHIFT", "m")).toEqual({
      code: "OVERNIGHT_SHIFT",
      message: "m",
      severity: "WARNING",
    });
    expect(problem("INVALID_DATE", "m", { field: "date", details: { a: 1 } })).toEqual({
      code: "INVALID_DATE",
      message: "m",
      severity: "ERROR",
      field: "date",
      details: { a: 1 },
    });
    expect(problem("INVALID_CSV", "m", { severity: "WARNING" }).severity).toBe("WARNING");
  });
});
