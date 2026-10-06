import { describe, expect, it } from "vitest";
import {
  checkMapping,
  invertMapping,
  normaliseHeader,
  scoreHeader,
  suggestMapping,
  FIELD_ALIASES,
  MAPPING_CONFIDENCE,
  MAPPING_CONFIDENCE_THRESHOLD,
} from "./headerMapping";
import { IMPORT_FIELDS } from "./types";

describe("normaliseHeader", () => {
  it("lower-cases, strips punctuation/BOM and collapses whitespace", () => {
    expect(normaliseHeader("\uFEFF  Shift_Start (24h) ")).toBe("shift start 24h");
    expect(normaliseHeader("START-TIME")).toBe("start time");
    expect(normaliseHeader("E-Mail")).toBe("e mail");
    expect(normaliseHeader("")).toBe("");
  });
});

describe("scoreHeader", () => {
  it.each([
    ["start_time", "start_time", MAPPING_CONFIDENCE.EXACT],
    ["START TIME", "start_time", MAPPING_CONFIDENCE.EXACT],
    ["Start Time", "start_time", MAPPING_CONFIDENCE.EXACT],
    ["Shift Start", "start_time", MAPPING_CONFIDENCE.ALIAS],
    ["Start", "start_time", MAPPING_CONFIDENCE.ALIAS],
    ["start", "start_time", MAPPING_CONFIDENCE.ALIAS],
    ["shift-start", "start_time", MAPPING_CONFIDENCE.ALIAS],
    ["Start-Time", "start_time", MAPPING_CONFIDENCE.EXACT],
    ["Clock In", "start_time", MAPPING_CONFIDENCE.ALIAS],
    ["Finish", "end_time", MAPPING_CONFIDENCE.ALIAS],
    ["FINISH TIME", "end_time", MAPPING_CONFIDENCE.ALIAS],
    ["end_time", "end_time", MAPPING_CONFIDENCE.EXACT],
    ["End", "end_time", MAPPING_CONFIDENCE.ALIAS],
    ["Shift End", "end_time", MAPPING_CONFIDENCE.ALIAS],
    ["Staff", "employee_name", MAPPING_CONFIDENCE.ALIAS],
    ["Name", "employee_name", MAPPING_CONFIDENCE.ALIAS],
    ["Employee", "employee_name", MAPPING_CONFIDENCE.ALIAS],
    ["Team Member", "employee_name", MAPPING_CONFIDENCE.ALIAS],
    ["Employee Name", "employee_name", MAPPING_CONFIDENCE.EXACT],
    ["Employee ID", "employee_id", MAPPING_CONFIDENCE.EXACT],
    ["Payroll Number", "employee_id", MAPPING_CONFIDENCE.ALIAS],
    ["Email Address", "email", MAPPING_CONFIDENCE.ALIAS],
    ["E-mail", "email", MAPPING_CONFIDENCE.ALIAS],
    ["Site", "location", MAPPING_CONFIDENCE.ALIAS],
    ["Store", "location", MAPPING_CONFIDENCE.ALIAS],
    ["Branch", "location", MAPPING_CONFIDENCE.ALIAS],
    ["Location", "location", MAPPING_CONFIDENCE.EXACT],
    ["Dept", "department", MAPPING_CONFIDENCE.ALIAS],
    ["Position", "role", MAPPING_CONFIDENCE.ALIAS],
    ["Break (mins)", "break_minutes", MAPPING_CONFIDENCE.ALIAS],
    ["Unpaid Break Minutes", "break_minutes", MAPPING_CONFIDENCE.ALIAS],
    ["Date", "date", MAPPING_CONFIDENCE.EXACT],
    ["Shift Date", "date", MAPPING_CONFIDENCE.ALIAS],
  ] as const)("maps %s → %s", (header, field, confidence) => {
    expect(scoreHeader(header)).toEqual({ field, confidence });
  });

  it("partially matches when a known alias is embedded in a longer header", () => {
    expect(scoreHeader("Shift Start (24h)")).toEqual({
      field: "start_time",
      confidence: MAPPING_CONFIDENCE.PARTIAL,
    });
    expect(scoreHeader("Employee Email Address")).toEqual({
      field: "email",
      confidence: MAPPING_CONFIDENCE.PARTIAL,
    });
    expect(scoreHeader("Rota Break Minutes Unpaid")).toEqual({
      field: "break_minutes",
      confidence: MAPPING_CONFIDENCE.PARTIAL,
    });
  });

  it("leaves ambiguous and unknown headers unmapped rather than guessing", () => {
    expect(scoreHeader("End Date")).toEqual({ field: null, confidence: 0 });
    expect(scoreHeader("Break Start")).toEqual({ field: null, confidence: 0 });
    expect(scoreHeader("Shift Start Date")).toEqual({ field: null, confidence: 0 });
    expect(scoreHeader("Notes")).toEqual({ field: null, confidence: 0 });
    expect(scoreHeader("")).toEqual({ field: null, confidence: 0 });
    expect(scoreHeader("Time")).toEqual({ field: null, confidence: 0 });
  });

  it("never partially matches on generic words inside a longer header", () => {
    expect(scoreHeader("Shift ID")).toEqual({ field: null, confidence: 0 }); // not employee_id
    expect(scoreHeader("Booking Reference")).toEqual({ field: null, confidence: 0 });
    expect(scoreHeader("Notes on shift")).toEqual({ field: null, confidence: 0 }); // "on" is not start_time
    expect(scoreHeader("Pay Group")).toEqual({ field: null, confidence: 0 });
    expect(scoreHeader("Days Off")).toEqual({ field: null, confidence: 0 });
    // ...while the same words still work as a whole header.
    expect(scoreHeader("ID")).toEqual({
      field: "employee_id",
      confidence: MAPPING_CONFIDENCE.ALIAS,
    });
    expect(scoreHeader("In")).toEqual({
      field: "start_time",
      confidence: MAPPING_CONFIDENCE.ALIAS,
    });
    expect(scoreHeader("Out")).toEqual({ field: "end_time", confidence: MAPPING_CONFIDENCE.ALIAS });
  });

  it("never partially maps columns about someone or something else", () => {
    for (const header of [
      "Manager Email",
      "Supervisor Name",
      "First Name",
      "Last Name",
      "Date of Birth",
      "Paid Break",
      "Break Hours",
      "Employee Status",
      "Emergency Contact Name",
    ]) {
      expect(scoreHeader(header)).toEqual({ field: null, confidence: 0 });
    }
  });

  it("only uses aliases that are already normalised", () => {
    for (const aliases of Object.values(FIELD_ALIASES)) {
      for (const alias of aliases) expect(normaliseHeader(alias)).toBe(alias);
    }
  });
});

describe("suggestMapping", () => {
  it("maps a typical rota export", () => {
    const { mapping, confidence } = suggestMapping([
      "Staff",
      "Date",
      "Shift Start",
      "Finish",
      "Site",
      "Notes",
    ]);
    expect(mapping).toEqual({
      Staff: "employee_name",
      Date: "date",
      "Shift Start": "start_time",
      Finish: "end_time",
      Site: "location",
      Notes: null,
    });
    expect(confidence["Shift Start"]).toBe(MAPPING_CONFIDENCE.ALIAS);
    expect(confidence.Date).toBe(MAPPING_CONFIDENCE.EXACT);
    expect(confidence.Notes).toBe(0);
  });

  it("maps upper-case and snake_case variants", () => {
    const { mapping } = suggestMapping(["STAFF", "SHIFT DATE", "START TIME", "END TIME", "STORE"]);
    expect(mapping).toEqual({
      STAFF: "employee_name",
      "SHIFT DATE": "date",
      "START TIME": "start_time",
      "END TIME": "end_time",
      STORE: "location",
    });
    expect(suggestMapping(["employee_name", "start_time", "end_time"]).mapping).toEqual({
      employee_name: "employee_name",
      start_time: "start_time",
      end_time: "end_time",
    });
  });

  it("flags partial matches for confirmation and pre-selects exact/alias ones", () => {
    expect(MAPPING_CONFIDENCE_THRESHOLD).toBe(MAPPING_CONFIDENCE.ALIAS);
    const { mapping, confidence, needsConfirmation } = suggestMapping([
      "Staff Name",
      "Date (DD/MM/YYYY)",
      "Start",
      "End",
    ]);
    expect(mapping["Date (DD/MM/YYYY)"]).toBe("date");
    expect(confidence["Date (DD/MM/YYYY)"]).toBe(MAPPING_CONFIDENCE.PARTIAL);
    expect(needsConfirmation).toEqual(["Date (DD/MM/YYYY)"]);
  });

  it("flags generic one-word headers for confirmation (an 'ID' column may be the shift's own id)", () => {
    const { mapping, confidence, needsConfirmation } = suggestMapping([
      "ID",
      "Name",
      "Day",
      "In",
      "Out",
      "Team",
    ]);
    expect(mapping).toEqual({
      ID: "employee_id",
      Name: "employee_name",
      Day: "date",
      In: "start_time",
      Out: "end_time",
      Team: "department",
    });
    expect(Object.values(confidence)).toEqual(Array(6).fill(MAPPING_CONFIDENCE.ALIAS));
    expect(needsConfirmation).toEqual(["ID", "Name", "Day", "In", "Out", "Team"]);
    // A specific header takes the field; the generic one is left unmapped and needs nothing.
    expect(suggestMapping(["ID", "Employee ID", "Reference"])).toEqual({
      mapping: { ID: null, "Employee ID": "employee_id", Reference: null },
      confidence: { ID: 0, "Employee ID": 1, Reference: 0 },
      needsConfirmation: [],
    });
  });

  it("never maps an email column to the employee name, or a name column to the email", () => {
    expect(suggestMapping(["Email"]).mapping).toEqual({ Email: "email" });
    expect(suggestMapping(["Email", "Employee"]).mapping).toEqual({
      Email: "email",
      Employee: "employee_name",
    });
    expect(suggestMapping(["Employee Email", "Employee Name", "Manager Email"])).toEqual({
      mapping: {
        "Employee Email": "email",
        "Employee Name": "employee_name",
        "Manager Email": null,
      },
      confidence: { "Employee Email": 0.9, "Employee Name": 1, "Manager Email": 0 },
      needsConfirmation: [],
    });
    for (const header of ["Email", "E-mail", "Email Address", "Work Email", "Employee E-mail"]) {
      expect(scoreHeader(header).field).toBe("email");
    }
    for (const header of ["Name", "Full Name", "Employee Name", "Staff Name"]) {
      expect(scoreHeader(header).field).toBe("employee_name");
    }
  });

  it("keeps every header as an own key, even __proto__", () => {
    const { mapping, confidence } = suggestMapping(["__proto__", "Date"]);
    expect(Object.keys(mapping)).toEqual(["__proto__", "Date"]);
    expect(Object.getPrototypeOf(mapping)).toBe(Object.prototype);
    expect(Object.hasOwn(mapping, "__proto__")).toBe(true);
    expect(Object.hasOwn(confidence, "__proto__")).toBe(true);
    expect(mapping.Date).toBe("date");
  });

  it("gives each field to at most one header, preferring the higher confidence", () => {
    const { mapping, confidence, needsConfirmation } = suggestMapping(["Start", "start_time"]);
    expect(mapping).toEqual({ Start: null, start_time: "start_time" });
    expect(confidence.Start).toBe(0);
    expect(needsConfirmation).toEqual([]);
  });

  it("breaks confidence ties in header order", () => {
    const { mapping } = suggestMapping(["Start", "Shift Start"]);
    expect(mapping).toEqual({ Start: "start_time", "Shift Start": null });
  });

  it("maps the canonical template headers with full confidence", () => {
    const { mapping, confidence, needsConfirmation } = suggestMapping([...IMPORT_FIELDS]);
    for (const f of IMPORT_FIELDS) {
      expect(mapping[f]).toBe(f);
      expect(confidence[f]).toBe(1);
    }
    expect(needsConfirmation).toEqual([]);
  });
});

describe("checkMapping / invertMapping", () => {
  it("accepts a complete mapping", () => {
    const check = checkMapping({
      Name: "employee_name",
      Date: "date",
      Start: "start_time",
      End: "end_time",
      Notes: null,
    });
    expect(check).toEqual({
      complete: true,
      missingRequired: [],
      missingIdentifier: false,
      duplicated: [],
    });
  });

  it("reports missing required fields, missing identifiers and duplicates", () => {
    const check = checkMapping({
      Date: "date",
      Start: "start_time",
      "Start 2": "start_time",
      Notes: null,
    });
    expect(check.complete).toBe(false);
    expect(check.missingRequired).toEqual(["end_time"]);
    expect(check.missingIdentifier).toBe(true);
    expect(check.duplicated).toEqual(["start_time"]);
  });

  it("inverts to the first header per field", () => {
    expect(invertMapping({ A: "date", B: "date", C: null, D: "start_time" })).toEqual({
      date: "A",
      start_time: "D",
    });
  });
});
