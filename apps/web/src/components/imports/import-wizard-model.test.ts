import type { ImportRow, ImportSummaryResponse, ShiftImport } from "@clockoff/validation/imports";
import { describe, expect, it } from "vitest";
import {
  IMPORT_STEPS,
  applySummaryToImport,
  checkImportFile,
  clampPage,
  confidenceLabel,
  createEmployeeFormSchema,
  defaultReviewTab,
  effectiveImportTimezone,
  errorsCsvUrl,
  fieldOf,
  formatFileSize,
  headersFor,
  importWizardSearch,
  initialMapping,
  isStepReachable,
  mappingRequirements,
  mappingStatus,
  planCommit,
  prefillCreateEmployee,
  rawCellFor,
  readFileProblems,
  readMappingCheckDetails,
  reviewTabCounts,
  rowEmployeeLabel,
  rowFixes,
  rowTimeLabel,
  sampleValues,
  setMappingField,
  splitName,
  stepForImportStatus,
  stepState,
  summaryFromImport,
  toCreateEmployeeRowInput,
  unconfirmedHeaders,
  uploadMetadataEntries,
} from "./import-wizard-model";

const IMPORT_ID = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";
const LOCATION = "7f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a11";

function makeRow(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    rowNumber: 2,
    status: "VALID",
    raw: { Staff: "Jane Smith", Date: "05/03/2026", Start: "09:00", Finish: "17:00" },
    parsed: {
      employeeName: "Jane Smith",
      date: "2026-03-05",
      startTime: "09:00",
      endTime: "17:00",
      timezone: "Europe/London",
      overnight: false,
    },
    problems: [],
    matchedEmployee: {
      id: "00000000-0000-4000-8000-0000000000aa",
      firstName: "Jane",
      lastName: "Smith",
    },
    createEmployee: null,
    createdShiftId: null,
    ...overrides,
  };
}

const summary: ImportSummaryResponse = {
  total: 10,
  valid: 5,
  warning: 2,
  error: 2,
  skipped: 1,
  imported: 0,
  readyToCommit: false,
};

describe("step machine", () => {
  it("resumes at the step matching the import status", () => {
    expect(stepForImportStatus(null)).toBe("upload");
    expect(stepForImportStatus("FAILED")).toBe("upload");
    expect(stepForImportStatus("UPLOADED")).toBe("map");
    expect(stepForImportStatus("MAPPED")).toBe("validate");
    expect(stepForImportStatus("VALIDATED")).toBe("review");
    expect(stepForImportStatus("IMPORTED")).toBe("summary");
  });

  it("only lets the stepper jump to steps the server state supports", () => {
    expect(IMPORT_STEPS.filter((s) => isStepReachable(s, null))).toEqual(["upload"]);
    expect(IMPORT_STEPS.filter((s) => isStepReachable(s, "UPLOADED"))).toEqual(["upload", "map"]);
    expect(IMPORT_STEPS.filter((s) => isStepReachable(s, "MAPPED"))).toEqual([
      "upload",
      "map",
      "validate",
    ]);
    expect(IMPORT_STEPS.filter((s) => isStepReachable(s, "VALIDATED"))).toEqual([
      "upload",
      "map",
      "validate",
      "review",
      "import",
    ]);
    expect(IMPORT_STEPS.filter((s) => isStepReachable(s, "IMPORTED"))).toEqual(["summary"]);
  });

  it("marks steps complete / current / upcoming relative to the current one", () => {
    expect(stepState("upload", "review")).toBe("complete");
    expect(stepState("review", "review")).toBe("current");
    expect(stepState("summary", "review")).toBe("upcoming");
  });

  it("builds the resumable search string", () => {
    expect(importWizardSearch(null)).toBe("");
    expect(importWizardSearch(IMPORT_ID)).toBe(`?import=${IMPORT_ID}`);
  });
});

describe("file checks", () => {
  it("accepts CSV-like files and derives a content type the API allows", () => {
    expect(checkImportFile({ name: "rota.csv", size: 1200, type: "" })).toEqual({
      ok: true,
      contentType: "text/csv",
    });
    expect(
      checkImportFile({ name: "ROTA.CSV", size: 1200, type: "application/vnd.ms-excel" }),
    ).toEqual({ ok: true, contentType: "application/vnd.ms-excel" });
    expect(checkImportFile({ name: "rota.tsv", size: 10, type: "" })).toEqual({
      ok: true,
      contentType: "text/plain",
    });
  });

  it("rejects wrong extensions, empty and oversized files", () => {
    expect(checkImportFile({ name: "rota.xlsx", size: 10, type: "" }).ok).toBe(false);
    expect(checkImportFile({ name: "rota.csv", size: 0, type: "text/csv" })).toEqual({
      ok: false,
      message: "The file is empty.",
    });
    const big = checkImportFile({ name: "rota.csv", size: 5 * 1024 * 1024 + 1, type: "text/csv" });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.message).toContain("5.0 MB");
  });

  it("formats sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(200 * 1024)).toBe("200 KB");
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

describe("upload options", () => {
  it("only sends the options that were chosen", () => {
    expect(uploadMetadataEntries({ dateFormat: "DMY", timezone: null, locationId: null })).toEqual([
      ["dateFormat", "DMY"],
    ]);
    expect(
      uploadMetadataEntries({ dateFormat: "MDY", timezone: "Europe/London", locationId: LOCATION }),
    ).toEqual([
      ["dateFormat", "MDY"],
      ["timezone", "Europe/London"],
      ["locationId", LOCATION],
    ]);
  });

  it("derives the default timezone from the location, then the organisation", () => {
    const locations = [{ id: LOCATION, timezone: "America/New_York" }];
    expect(
      effectiveImportTimezone({ timezone: null, locationId: LOCATION }, locations, "Europe/London"),
    ).toBe("America/New_York");
    expect(
      effectiveImportTimezone({ timezone: null, locationId: null }, locations, "Europe/London"),
    ).toBe("Europe/London");
    expect(
      effectiveImportTimezone(
        { timezone: "Asia/Tokyo", locationId: LOCATION },
        locations,
        "Europe/London",
      ),
    ).toBe("Asia/Tokyo");
  });
});

describe("column mapping", () => {
  const headers = ["Staff", "Date", "Start", "Finish", "Notes"];
  const suggested = {
    Staff: "employee_name",
    Date: "date",
    Start: "start_time",
    Finish: "end_time",
    Notes: null,
  } as const;

  it("starts from the suggestion, or the stored mapping once one was saved", () => {
    expect(initialMapping(headers, {}, suggested)).toEqual({
      Staff: "employee_name",
      Date: "date",
      Start: "start_time",
      Finish: "end_time",
      Notes: null,
    });
    expect(
      initialMapping(
        headers,
        {
          Staff: "employee_id",
          Date: "date",
          Start: "start_time",
          Finish: "end_time",
          Notes: null,
        },
        suggested,
      ).Staff,
    ).toBe("employee_id");
    expect(initialMapping(headers, { Staff: null }, suggested).Staff).toBe("employee_name");
    expect(initialMapping(["Only"], {}, undefined)).toEqual({ Only: null });
  });

  it("never reads prototype properties or unknown fields", () => {
    const mapping = JSON.parse(
      '{"__proto__": "date", "toString": "start_time", "Real": "bogus"}',
    ) as Record<string, never>;
    expect(fieldOf(mapping, "__proto__")).toBe("date");
    expect(fieldOf(mapping, "toString")).toBe("start_time");
    expect(fieldOf(mapping, "Real")).toBeNull();
    expect(fieldOf({}, "constructor")).toBeNull();
    expect(sampleValues([{ Start: "09:00" }], "constructor")).toEqual([]);
  });

  it("gives each field to one column", () => {
    const start = initialMapping(headers, {}, suggested);
    const moved = setMappingField(start, "Notes", "date");
    expect(moved).toEqual({
      Staff: "employee_name",
      Date: null,
      Start: "start_time",
      Finish: "end_time",
      Notes: "date",
    });
    expect(setMappingField(moved, "Notes", null).Notes).toBeNull();
  });

  it("reports what is missing and which requirements are met", () => {
    const complete = mappingStatus(initialMapping(headers, {}, suggested));
    expect(complete.canContinue).toBe(true);
    expect(complete.missing).toEqual([]);
    const partial = mappingStatus({ Staff: null, Date: "date", Start: "start_time", Finish: null });
    expect(partial.canContinue).toBe(false);
    expect(partial.missing).toEqual(["End time", "an employee identifier (name, ID or email)"]);
    const requirements = mappingRequirements({
      Staff: "employee_name",
      Date: "date",
      Start: "start_time",
      Finish: null,
    });
    expect(requirements.map((r) => [r.key, r.satisfied])).toEqual([
      ["date", true],
      ["start_time", true],
      ["end_time", false],
      ["identifier", true],
    ]);
    expect(requirements[3]?.headers).toEqual(["Staff"]);
    expect(headersFor({ A: "date", B: "date" }, "date")).toEqual(["A", "B"]);
    expect(
      mappingStatus({ A: "date", B: "date", C: "start_time", D: "end_time", E: "email" })
        .duplicated,
    ).toEqual(["Date"]);
  });

  it("tracks suggestions that still need confirming", () => {
    const suggestion = {
      mapping: { ID: "employee_id", Name: "employee_name", Date: "date" } as const,
      needsConfirmation: ["ID", "Name"],
    };
    const mapping = { ID: "employee_id", Name: "employee_name", Date: "date" } as const;
    expect(unconfirmedHeaders(mapping, suggestion, new Set())).toEqual(["ID", "Name"]);
    expect(unconfirmedHeaders(mapping, suggestion, new Set(["ID"]))).toEqual(["Name"]);
    expect(unconfirmedHeaders({ ...mapping, Name: "email" }, suggestion, new Set())).toEqual([
      "ID",
    ]); // changed = confirmed
    expect(unconfirmedHeaders({ ...mapping, ID: null }, suggestion, new Set())).toEqual(["Name"]); // ignored = nothing to confirm
    expect(unconfirmedHeaders(mapping, undefined, new Set())).toEqual([]);
  });

  it("buckets confidence scores and picks sample values", () => {
    expect(confidenceLabel(1)).toBe("exact");
    expect(confidenceLabel(0.9)).toBe("alias");
    expect(confidenceLabel(0.6)).toBe("partial");
    expect(confidenceLabel(0)).toBe("none");
    expect(confidenceLabel(undefined)).toBe("none");
    const rows = [
      { Start: " 09:00 " },
      { Start: "09:00" },
      { Start: "" },
      { Start: "17:00" },
      { Start: "22:00" },
    ];
    expect(sampleValues(rows, "Start")).toEqual(["09:00", "17:00", "22:00"]);
    expect(sampleValues(rows, "Start", 2)).toEqual(["09:00", "17:00"]);
    expect(sampleValues(rows, "Missing")).toEqual([]);
  });

  it("reads the API's mapping-check and file-problem details tolerantly", () => {
    expect(
      readMappingCheckDetails({
        missingRequired: ["end_time"],
        missingIdentifier: true,
        duplicated: ["date"],
      }),
    ).toEqual(["End time", "an employee identifier (name, ID or email)", "Date is mapped twice"]);
    expect(readMappingCheckDetails("nope")).toEqual([]);
    expect(
      readFileProblems({
        problems: [{ code: "INVALID_CSV", message: "Row 3 has an unclosed quote" }],
      }),
    ).toEqual([{ code: "INVALID_CSV", message: "Row 3 has an unclosed quote" }]);
    expect(readFileProblems(undefined)).toEqual([]);
  });
});

describe("review", () => {
  it("counts tabs and opens the most urgent one first", () => {
    expect(reviewTabCounts(summary)).toEqual({ VALID: 5, WARNING: 2, ERROR: 2, SKIPPED: 1 });
    expect(defaultReviewTab(summary)).toBe("ERROR");
    expect(defaultReviewTab({ ...summary, error: 0 })).toBe("WARNING");
    expect(defaultReviewTab({ ...summary, error: 0, warning: 0 })).toBe("VALID");
    expect(defaultReviewTab(null)).toBe("VALID");
  });

  it("clamps the page when rows move between tabs", () => {
    expect(clampPage(3, 60, 25)).toBe(3);
    expect(clampPage(3, 50, 25)).toBe(2);
    expect(clampPage(3, 0, 25)).toBe(1);
    expect(clampPage(0, 10, 25)).toBe(1);
  });

  it("derives the wizard summary from the import counts and writes it back", () => {
    const record = {
      rowCount: 10,
      validCount: 5,
      warningCount: 2,
      errorCount: 2,
      skippedCount: 1,
      importedCount: 0,
    } as ShiftImport;
    expect(summaryFromImport(record)).toEqual(summary);
    expect(summaryFromImport({ ...record, errorCount: 0 }).readyToCommit).toBe(true);
    expect(applySummaryToImport(record, { ...summary, error: 0, valid: 7 })).toMatchObject({
      errorCount: 0,
      validCount: 7,
      rowCount: 10,
    });
  });

  it("offers the fixes that match the row's problems", () => {
    expect(rowFixes(makeRow())).toEqual({
      chooseEmployee: false,
      createEmployee: false,
      location: false,
      skip: true,
      unskip: false,
    });
    expect(
      rowFixes(
        makeRow({
          status: "ERROR",
          problems: [
            { code: "EMPLOYEE_NOT_FOUND", message: "No employee matches", severity: "ERROR" },
          ],
        }),
      ),
    ).toMatchObject({ chooseEmployee: true, createEmployee: true, skip: true });
    expect(
      rowFixes(
        makeRow({
          status: "ERROR",
          problems: [{ code: "MULTIPLE_MATCHES", message: "Two match", severity: "ERROR" }],
        }),
      ),
    ).toMatchObject({ chooseEmployee: true, createEmployee: false });
    expect(
      rowFixes(
        makeRow({
          status: "WARNING",
          problems: [{ code: "UNKNOWN_LOCATION", message: "Unknown", severity: "WARNING" }],
        }),
      ),
    ).toMatchObject({ location: true });
    expect(rowFixes(makeRow({ status: "SKIPPED" }))).toEqual({
      chooseEmployee: false,
      createEmployee: false,
      location: false,
      skip: false,
      unskip: true,
    });
    expect(rowFixes(makeRow({ status: "IMPORTED" }))).toMatchObject({ skip: false, unskip: false });
  });

  it("labels the employee and times of a row", () => {
    expect(rowEmployeeLabel(makeRow())).toEqual({ label: "Jane Smith", kind: "matched" });
    expect(
      rowEmployeeLabel(
        makeRow({
          matchedEmployee: null,
          createEmployee: { firstName: "Sam", lastName: "Lee", email: null },
        }),
      ),
    ).toEqual({ label: "Sam Lee", kind: "new" });
    expect(
      rowEmployeeLabel(
        makeRow({
          matchedEmployee: null,
          parsed: { employeeName: undefined, email: "a@b.co", timezone: "UTC", overnight: false },
        }),
      ),
    ).toEqual({ label: "a@b.co", kind: "unmatched" });
    expect(rowTimeLabel(makeRow().parsed)).toBe("09:00–17:00");
    expect(
      rowTimeLabel({ startTime: "22:00", endTime: "06:00", timezone: "UTC", overnight: true }),
    ).toBe("22:00 → 06:00 (+1)");
    expect(rowTimeLabel(null)).toBe("—");
    expect(rawCellFor(makeRow(), { Date: "date", Start: "start_time" }, "date")).toBe("05/03/2026");
    expect(rawCellFor(makeRow(), { Date: "date" }, "end_time")).toBeNull();
  });

  it("pre-fills the create-employee form from the row or the matcher's suggestion", () => {
    expect(splitName("Smith, Jane")).toEqual({ firstName: "Jane", lastName: "Smith" });
    expect(splitName("Jane  Anne Smith")).toEqual({ firstName: "Jane Anne", lastName: "Smith" });
    expect(splitName("Cher")).toEqual({ firstName: "", lastName: "Cher" });
    expect(splitName("")).toEqual({ firstName: "", lastName: "" });
    expect(
      prefillCreateEmployee(
        makeRow({
          parsed: {
            employeeName: "Lee, Sam",
            email: "sam@example.com",
            employeeExternalId: "E9",
            timezone: "UTC",
            overnight: false,
          },
        }),
      ),
    ).toEqual({
      firstName: "Sam",
      lastName: "Lee",
      email: "sam@example.com",
      externalEmployeeId: "E9",
    });
    expect(
      prefillCreateEmployee(
        makeRow({
          parsed: { employeeName: "Sam Lee", timezone: "UTC", overnight: false },
          problems: [
            {
              code: "EMPLOYEE_NOT_FOUND",
              message: "x",
              severity: "ERROR",
              details: {
                suggestedEmployee: { firstName: "Samuel", lastName: "Lee", email: "s@example.com" },
              },
            },
          ],
        }),
      ),
    ).toEqual({
      firstName: "Samuel",
      lastName: "Lee",
      email: "s@example.com",
      externalEmployeeId: "",
    });
  });

  it("validates the mini-form and drops empty optional fields from the request", () => {
    expect(
      createEmployeeFormSchema.safeParse({
        firstName: "",
        lastName: "Lee",
        email: "",
        externalEmployeeId: "",
        jobTitle: "",
      }).success,
    ).toBe(false);
    expect(
      createEmployeeFormSchema.safeParse({
        firstName: "Sam",
        lastName: "Lee",
        email: "not-an-email",
        externalEmployeeId: "",
        jobTitle: "",
      }).success,
    ).toBe(false);
    expect(
      createEmployeeFormSchema.safeParse({
        firstName: "Sam",
        lastName: "Lee",
        email: "",
        externalEmployeeId: "",
        jobTitle: "",
      }).success,
    ).toBe(true);
    expect(
      toCreateEmployeeRowInput({
        firstName: " Sam ",
        lastName: "Lee",
        email: "",
        externalEmployeeId: " E9 ",
        jobTitle: "",
      }),
    ).toEqual({
      createEmployee: { firstName: "Sam", lastName: "Lee", externalEmployeeId: "E9" },
    });
    expect(
      toCreateEmployeeRowInput({
        firstName: "Sam",
        lastName: "Lee",
        email: "s@example.com",
        externalEmployeeId: "",
        jobTitle: "Chef",
      }),
    ).toEqual({
      createEmployee: {
        firstName: "Sam",
        lastName: "Lee",
        email: "s@example.com",
        jobTitle: "Chef",
      },
    });
  });
});

describe("commit", () => {
  it("plans what will be imported and when errors block the commit", () => {
    expect(planCommit(summary, { includeWarnings: true, skipErrors: false })).toEqual({
      willImport: 7,
      willSkip: 1,
      blockedByErrors: true,
    });
    expect(planCommit(summary, { includeWarnings: true, skipErrors: true })).toEqual({
      willImport: 7,
      willSkip: 3,
      blockedByErrors: false,
    });
    expect(planCommit(summary, { includeWarnings: false, skipErrors: true })).toEqual({
      willImport: 5,
      willSkip: 5,
      blockedByErrors: false,
    });
    expect(
      planCommit({ ...summary, error: 0 }, { includeWarnings: true, skipErrors: false })
        .blockedByErrors,
    ).toBe(false);
  });

  it("links to the problems CSV", () => {
    expect(errorsCsvUrl(IMPORT_ID)).toBe(`/api/imports/${IMPORT_ID}/errors.csv`);
  });
});
