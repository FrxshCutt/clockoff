import { describe, expect, it } from "vitest";
import {
  indexCandidates,
  matchEmployee,
  matchRows,
  nameKey,
  normaliseName,
  splitName,
  suggestedEmployee,
  type EmployeeCandidate,
} from "./matchEmployee";
import type { NormalisedRow } from "./types";

const jane: EmployeeCandidate = {
  id: "jane",
  firstName: "Jane",
  lastName: "Smith",
  email: "jane.smith@example.com",
  externalEmployeeId: "E1042",
};
const john: EmployeeCandidate = {
  id: "john",
  firstName: "John",
  lastName: "Smith",
  email: "john@example.com",
  externalEmployeeId: "E1043",
};
const otherJane: EmployeeCandidate = {
  id: "jane2",
  firstName: "Jane",
  lastName: "Smith",
  email: null,
  externalEmployeeId: null,
};
const amira: EmployeeCandidate = {
  id: "amira",
  firstName: "Amira",
  lastName: "Khan",
  email: "Amira.Khan@Example.com",
  externalEmployeeId: "E1044",
};
const ALL = [jane, john, otherJane, amira];

describe("matchEmployee", () => {
  it("matches by external employee id first (case/whitespace-insensitive)", () => {
    expect(matchEmployee({ employeeExternalId: " e1043 " }, ALL)).toEqual({
      employeeId: "john",
      matchedBy: "external_id",
      warnings: [],
    });
  });

  it("lets the external id win over a conflicting name, with a warning", () => {
    const r = matchEmployee({ employeeExternalId: "E1044", employeeName: "John Smith" }, ALL);
    expect(r.employeeId).toBe("amira");
    if (r.employeeId !== null) {
      expect(r.matchedBy).toBe("external_id");
      expect(r.warnings).toEqual([
        expect.objectContaining({
          code: "EMPLOYEE_IDENTIFIER_MISMATCH",
          severity: "WARNING",
          field: "employee_name",
        }),
      ]);
    }
  });

  it("lets the external id win over a conflicting email, and email win over a conflicting name", () => {
    const byId = matchEmployee(
      { employeeExternalId: "E1042", email: "john@example.com", employeeName: "Amira Khan" },
      ALL,
    );
    expect(byId).toMatchObject({ employeeId: "jane", matchedBy: "external_id" });
    if (byId.employeeId !== null)
      expect(byId.warnings.map((w) => w.field)).toEqual(["email", "employee_name"]);
    const byEmail = matchEmployee({ email: "JOHN@example.com", employeeName: "Amira Khan" }, ALL);
    expect(byEmail).toMatchObject({ employeeId: "john", matchedBy: "email" });
  });

  it("does not warn when a lower-priority identifier agrees, or is a name that matches nobody", () => {
    expect(
      matchEmployee({ employeeExternalId: "E1044", employeeName: "Amira Khan" }, ALL),
    ).toMatchObject({ employeeId: "amira", warnings: [] });
    // Names differ between systems (nicknames, middle names), so an unknown name is not a contradiction.
    expect(
      matchEmployee({ employeeExternalId: "E1044", employeeName: "Mira Khan" }, ALL),
    ).toMatchObject({ employeeId: "amira", warnings: [] });
    expect(
      matchEmployee(
        { employeeExternalId: "E1044", email: "AMIRA.KHAN@example.com", employeeName: "Mira" },
        ALL,
      ),
    ).toMatchObject({ employeeId: "amira", warnings: [] });
  });

  it("warns when the row's email matches nobody but the matched employee has another email on file", () => {
    // A mistyped ID would otherwise put Bob's shift on Jane's rota without a word.
    const r = matchEmployee({ employeeExternalId: "E1042", email: "bob.jones@example.com" }, ALL);
    expect(r).toMatchObject({ employeeId: "jane", matchedBy: "external_id" });
    if (r.employeeId !== null) {
      expect(r.warnings).toEqual([
        expect.objectContaining({
          code: "EMPLOYEE_IDENTIFIER_MISMATCH",
          severity: "WARNING",
          field: "email",
          details: { matchedBy: "external_id", conflicting: "email", conflictingIds: [] },
        }),
      ]);
      expect(r.warnings[0]!.message).toMatch(/not the email recorded for them/);
    }
    // No email on file: nothing to contradict.
    expect(
      matchEmployee({ employeeExternalId: "E1043", email: "john.smith@example.com" }, [
        { ...john, email: null },
      ]),
    ).toMatchObject({ employeeId: "john", warnings: [] });
  });

  it("falls back to email (case-insensitive) when the id is unknown and the employee has no id on file", () => {
    const noId: EmployeeCandidate = { ...amira, externalEmployeeId: null };
    const r = matchEmployee({ employeeExternalId: "E9999", email: "amira.khan@example.com" }, [
      jane,
      noId,
    ]);
    expect(r.employeeId).toBe("amira");
    if (r.employeeId !== null) {
      expect(r.matchedBy).toBe("email");
      expect(r.warnings).toEqual([
        expect.objectContaining({
          code: "EMPLOYEE_IDENTIFIER_MISMATCH",
          severity: "WARNING",
          field: "employee_id",
          details: { matchedBy: "email", unmatched: "external_id" },
        }),
      ]);
    }
    // Same for a name fallback when the employee has neither an ID nor an email on file.
    expect(
      matchEmployee({ employeeExternalId: "E9999", employeeName: "Jane Smith" }, [otherJane]),
    ).toMatchObject({ employeeId: "jane2", matchedBy: "name" });
  });

  it("never falls back to a weaker identifier that contradicts the employee's recorded id or email", () => {
    // E9999 belongs to nobody; the name matches Jane, but Jane's ID is E1042: probably another Jane Smith.
    const byName = matchEmployee({ employeeExternalId: "E9999", employeeName: "Jane Smith" }, [
      jane,
      john,
    ]);
    expect(byName.employeeId).toBeNull();
    if (byName.employeeId === null) {
      expect(byName.candidates).toEqual(["jane"]);
      expect(byName.problem).toMatchObject({
        code: "EMPLOYEE_NOT_FOUND",
        severity: "ERROR",
        field: "employee_id",
        details: {
          conflictingEmployeeIds: ["jane"],
          matchedBy: "name",
          unmatched: "external_id",
          suggestedEmployee: { firstName: "Jane", lastName: "Smith", externalEmployeeId: "E9999" },
        },
      });
      expect(byName.problem.message).toMatch(/whose employee ID is "E1042"/);
    }
    // An unknown email that contradicts the recorded email blocks a name match too.
    const byEmail = matchEmployee(
      { email: "jane.personal@example.com", employeeName: "Jane Smith" },
      [jane, john],
    );
    expect(byEmail).toMatchObject({
      employeeId: null,
      problem: { code: "EMPLOYEE_NOT_FOUND", field: "email" },
    });
    // ...and an unknown ID that contradicts the recorded ID blocks an email match.
    expect(
      matchEmployee({ employeeExternalId: "E9999", email: "amira.khan@example.com" }, ALL),
    ).toMatchObject({ employeeId: null, problem: { code: "EMPLOYEE_NOT_FOUND" } });
  });

  it("matches by exact full name, ignoring case and whitespace, and accepts 'Last, First'", () => {
    expect(matchEmployee({ employeeName: "  amira   KHAN " }, ALL)).toMatchObject({
      employeeId: "amira",
      matchedBy: "name",
    });
    expect(matchEmployee({ employeeName: "Khan, Amira" }, ALL)).toMatchObject({
      employeeId: "amira",
      matchedBy: "name",
    });
    expect(matchEmployee({ employeeName: "KHAN ,  amira" }, ALL)).toMatchObject({
      employeeId: "amira",
      matchedBy: "name",
    });
  });

  it("matches names regardless of tabs, non-breaking spaces and case", () => {
    expect(matchEmployee({ employeeName: "AMIRA\tkhan" }, ALL)).toMatchObject({
      employeeId: "amira",
    });
    expect(matchEmployee({ employeeName: "Amira\u00A0Khan" }, ALL)).toMatchObject({
      employeeId: "amira",
    });
    const spaced = { id: "mj", firstName: " Mary  Jane ", lastName: "Watson " };
    expect(matchEmployee({ employeeName: "mary jane watson" }, [spaced])).toMatchObject({
      employeeId: "mj",
    });
    expect(matchEmployee({ employeeName: "Watson, Mary Jane" }, [spaced])).toMatchObject({
      employeeId: "mj",
    });
  });

  it("does not fuzzy-match names", () => {
    expect(matchEmployee({ employeeName: "Amira" }, ALL).employeeId).toBeNull();
    expect(matchEmployee({ employeeName: "A. Khan" }, ALL).employeeId).toBeNull();
    expect(matchEmployee({ employeeName: "Khan Amira" }, ALL).employeeId).toBeNull();
  });

  it("returns MULTIPLE_MATCHES with candidate ids when a name matches several employees", () => {
    const r = matchEmployee({ employeeName: "Jane Smith" }, ALL);
    expect(r.employeeId).toBeNull();
    if (r.employeeId === null) {
      expect(r.problem).toMatchObject({
        code: "MULTIPLE_MATCHES",
        severity: "ERROR",
        field: "employee_name",
      });
      expect(r.candidates).toEqual(["jane", "jane2"]);
      expect(r.problem.details).toMatchObject({ candidateIds: ["jane", "jane2"] });
    }
  });

  it("does not fall through an ambiguous higher-priority signal", () => {
    const shared = [
      { id: "a", firstName: "A", lastName: "One", email: "shared@example.com" },
      { id: "b", firstName: "B", lastName: "Two", email: "shared@example.com" },
    ];
    const r = matchEmployee({ email: "shared@example.com", employeeName: "A One" }, shared);
    expect(r.employeeId).toBeNull();
    if (r.employeeId === null) expect(r.problem.code).toBe("MULTIPLE_MATCHES");
  });

  it("resolves an ambiguous name when the id is present and unique", () => {
    expect(
      matchEmployee({ employeeExternalId: "E1042", employeeName: "Jane Smith" }, ALL),
    ).toMatchObject({ employeeId: "jane", warnings: [] });
  });

  it("returns EMPLOYEE_NOT_FOUND with a suggested employee for the create option", () => {
    const r = matchEmployee(
      { employeeName: "Lee, Sam", email: "sam.lee@example.com", employeeExternalId: "E2000" },
      ALL,
    );
    expect(r.employeeId).toBeNull();
    if (r.employeeId === null) {
      expect(r.problem.code).toBe("EMPLOYEE_NOT_FOUND");
      expect(r.problem.severity).toBe("ERROR");
      expect(r.problem.details).toEqual({
        suggestedEmployee: {
          firstName: "Sam",
          lastName: "Lee",
          email: "sam.lee@example.com",
          externalEmployeeId: "E2000",
        },
      });
    }
  });

  it("handles a row with no identifiers at all", () => {
    const r = matchEmployee({}, ALL);
    expect(r.employeeId).toBeNull();
    if (r.employeeId === null) expect(r.problem.code).toBe("EMPLOYEE_NOT_FOUND");
  });

  it("gives the same answers with a prepared candidate index", () => {
    const index = indexCandidates(ALL);
    for (const input of [
      { employeeExternalId: "e1043" },
      { employeeName: "Jane Smith" },
      { email: "AMIRA.KHAN@example.com" },
      { employeeName: "Nobody" },
    ]) {
      expect(matchEmployee(input, index)).toEqual(matchEmployee(input, ALL));
    }
  });

  it("ignores candidates with missing ids/emails", () => {
    expect(matchEmployee({ employeeExternalId: "" }, [otherJane]).employeeId).toBeNull();
    expect(matchEmployee({ email: "x@y.z" }, [otherJane]).employeeId).toBeNull();
  });
});

describe("name helpers", () => {
  it("normalise, key and split names", () => {
    expect(normaliseName("  Jane   SMITH ")).toBe("jane smith");
    expect(nameKey("Smith, Jane")).toBe("jane smith");
    expect(nameKey("Jane Smith")).toBe("jane smith");
    expect(splitName("Jane Smith")).toEqual({ firstName: "Jane", lastName: "Smith" });
    expect(splitName("Jane Anne Smith")).toEqual({ firstName: "Jane", lastName: "Anne Smith" });
    expect(splitName("Smith, Jane Anne")).toEqual({ firstName: "Jane Anne", lastName: "Smith" });
    expect(splitName("Cher")).toEqual({ firstName: "Cher", lastName: "" });
    expect(suggestedEmployee({ employeeName: "Jane Smith" })).toEqual({
      firstName: "Jane",
      lastName: "Smith",
    });
    expect(suggestedEmployee({})).toEqual({ firstName: "", lastName: "" });
  });
});

describe("matchRows", () => {
  const row = (rowNumber: number, parsed: NormalisedRow["parsed"]): NormalisedRow => ({
    rowNumber,
    raw: {},
    parsed,
    problems: [],
  });

  it("does not add EMPLOYEE_NOT_FOUND when the identifier is already reported missing", () => {
    const missing: NormalisedRow = {
      rowNumber: 2,
      raw: {},
      parsed: { timezone: "Europe/London", overnight: false },
      problems: [
        { code: "MISSING_REQUIRED_FIELD", message: "x", field: "employee_name", severity: "ERROR" },
      ],
    };
    const invalidEmailOnly: NormalisedRow = {
      rowNumber: 3,
      raw: {},
      parsed: { timezone: "Europe/London", overnight: false },
      problems: [{ code: "INVALID_EMAIL", message: "x", field: "email", severity: "WARNING" }],
    };
    const out = matchRows([missing, invalidEmailOnly], ALL);
    expect(out[0]!.problems.map((p) => p.code)).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(out[0]!.employeeId).toBeNull();
    expect(out[1]!.problems.map((p) => p.code)).toEqual(["INVALID_EMAIL", "EMPLOYEE_NOT_FOUND"]);
  });

  it("sets employeeId and appends problems without mutating the input", () => {
    const input = [
      row(2, { timezone: "Europe/London", overnight: false, employeeExternalId: "E1042" }),
      row(3, { timezone: "Europe/London", overnight: false, employeeName: "Jane Smith" }),
      row(4, { timezone: "Europe/London", overnight: false, employeeName: "Nobody" }),
    ];
    const out = matchRows(input, ALL);
    expect(out.map((r) => r.employeeId)).toEqual(["jane", null, null]);
    expect(out[1]!.problems.map((p) => p.code)).toEqual(["MULTIPLE_MATCHES"]);
    expect(out[2]!.problems.map((p) => p.code)).toEqual(["EMPLOYEE_NOT_FOUND"]);
    expect(input[0]!.employeeId).toBeUndefined();
    expect(input[1]!.problems).toEqual([]);
  });
});
