import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import {
  detectHeaderRow,
  detectHeaders,
  importFileErrorToAppError,
  looksLikeData,
  normaliseHeaders,
  parseCsv,
  validateImportFile,
} from "./parseCsv";
import { IMPORT_LIMITS } from "./types";

const HEADER = "employee_name,date,start_time,end_time";
const BOM = "\uFEFF";

describe("parseCsv", () => {
  it("handles a BOM and CRLF line endings", () => {
    const text = `${BOM}${HEADER}\r\nJane Smith,2026-03-05,09:00,17:00\r\n`;
    const result = parseCsv(text);
    expect(result.errors).toEqual([]);
    expect(result.headers).toEqual(["employee_name", "date", "start_time", "end_time"]);
    expect(result.records).toEqual([
      {
        rowNumber: 2,
        values: {
          employee_name: "Jane Smith",
          date: "2026-03-05",
          start_time: "09:00",
          end_time: "17:00",
        },
        problems: [],
      },
    ]);
    expect(result.delimiter).toBe(",");
  });

  it("returns the §6.5 `rows` shape alongside numbered `records`", () => {
    const result = parseCsv(
      `${HEADER}\nJane Smith,2026-03-05,09:00,17:00\nJohn Smith,2026-03-05,10:00,18:00\n`,
    );
    expect(result.rows).toEqual([
      { employee_name: "Jane Smith", date: "2026-03-05", start_time: "09:00", end_time: "17:00" },
      { employee_name: "John Smith", date: "2026-03-05", start_time: "10:00", end_time: "18:00" },
    ]);
    expect(result.rows[1]).toBe(result.records[1]!.values);
    expect(result.records.map((r) => r.rowNumber)).toEqual([2, 3]);
  });

  it("handles mixed and old-Mac line endings without merging rows", () => {
    const result = parseCsv(
      `${HEADER}\r\nJane Smith,2026-03-05,09:00,17:00\nJohn Smith,2026-03-05,10:00,18:00\rAmira Khan,2026-03-05,11:00,19:00`,
    );
    expect(result.rows.map((r) => r.employee_name)).toEqual([
      "Jane Smith",
      "John Smith",
      "Amira Khan",
    ]);
    expect(result.records.map((r) => r.rowNumber)).toEqual([2, 3, 4]);
  });

  it("auto-detects a semicolon delimiter (including two-column files with a trailing newline)", () => {
    const result = parseCsv("name;date;start;end\nJane Smith;05/03/2026;09:00;17:00\n");
    expect(result.delimiter).toBe(";");
    expect(result.rows[0]).toEqual({
      name: "Jane Smith",
      date: "05/03/2026",
      start: "09:00",
      end: "17:00",
    });
    expect(parseCsv("a;b\n1;2\n").delimiter).toBe(";");
    expect(parseCsv("a;b\n\n1;2\n\n\n").rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("auto-detects tab and pipe delimiters", () => {
    expect(parseCsv("a\tb\n1\t2\n").rows).toEqual([{ a: "1", b: "2" }]);
    expect(parseCsv("a|b\n1|2\n").rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("does not split on commas inside quoted semicolon-separated cells", () => {
    const result = parseCsv('name;date\n"Smith, Jane";05/03/2026\n"Lee, Sam";06/03/2026\n');
    expect(result.delimiter).toBe(";");
    expect(result.rows.map((r) => r.name)).toEqual(["Smith, Jane", "Lee, Sam"]);
  });

  it("keeps quoted commas inside a cell", () => {
    const result = parseCsv(`${HEADER}\n"Smith, Jane",2026-03-05,"09:00",17:00\n`);
    expect(result.rows[0]!.employee_name).toBe("Smith, Jane");
    expect(result.records[0]!.problems).toEqual([]);
  });

  it("keeps escaped quotes and quoted line breaks in one row, with spreadsheet row numbers", () => {
    const result = parseCsv(
      `${HEADER},notes\n"Jane ""JJ"" Smith",2026-03-05,09:00,17:00,"line one\nline two"\nJohn Smith,2026-03-05,10:00,18:00,\n`,
    );
    expect(result.rows[0]!.employee_name).toBe('Jane "JJ" Smith');
    expect(result.rows[0]!.notes).toBe("line one\nline two");
    expect(result.records.map((r) => r.rowNumber)).toEqual([2, 3]);
  });

  it("skips blank lines but keeps spreadsheet row numbers", () => {
    const result = parseCsv(
      `${HEADER}\n\nJane Smith,2026-03-05,09:00,17:00\n   \nJohn Smith,2026-03-05,10:00,18:00\n`,
    );
    expect(result.records.map((r) => r.rowNumber)).toEqual([3, 5]);
  });

  it("skips separator-only lines (Excel blank rows)", () => {
    const result = parseCsv(`${HEADER}\n,,,\nJane Smith,2026-03-05,09:00,17:00\n`);
    expect(result.records.map((r) => r.rowNumber)).toEqual([3]);
  });

  it("trims cells and pads short rows with empty strings", () => {
    const result = parseCsv(`${HEADER}\n  Jane Smith ,2026-03-05\n`);
    expect(result.rows[0]).toEqual({
      employee_name: "Jane Smith",
      date: "2026-03-05",
      start_time: "",
      end_time: "",
    });
  });

  it("flags rows with more non-empty cells than headers and keeps the extra values", () => {
    const result = parseCsv(`${HEADER}\nSmith, Jane,2026-03-05,09:00,17:00\n`);
    const record = result.records[0]!;
    expect(record.values).toEqual({
      employee_name: "Smith",
      date: "Jane",
      start_time: "2026-03-05",
      end_time: "09:00",
      "Column 5": "17:00",
    });
    // The cells may be shifted, so the row is an error rather than a warning that would still import.
    expect(record.problems).toEqual([
      expect.objectContaining({
        code: "INVALID_CSV",
        severity: "ERROR",
        details: { extraCells: 1 },
      }),
    ]);
  });

  it("ignores trailing empty cells (Excel padding)", () => {
    const result = parseCsv(`${HEADER},,\nJane Smith,2026-03-05,09:00,17:00,,\n`);
    expect(result.headers).toEqual([
      "employee_name",
      "date",
      "start_time",
      "end_time",
      "Column 5",
      "Column 6",
    ]);
    expect(result.records[0]!.problems).toEqual([]);
  });

  it("rejects the whole file on an unterminated quote instead of silently swallowing later rows", () => {
    const text = [
      HEADER,
      "Jane Smith,2026-03-05,09:00,17:00",
      '"Bob Jones,2026-03-05,09:00,17:00',
      "Sam Lee,2026-03-05,09:00,17:00",
      "Al Day,2026-03-05,09:00,17:00",
      "",
    ].join("\n");
    const result = parseCsv(text);
    expect(result.rows).toEqual([]);
    expect(result.records).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "INVALID_CSV",
        severity: "ERROR",
        message: expect.stringMatching(/^Row 3: a cell opens a quote/),
        details: { rowNumber: 3, reason: "MissingQuotes" },
      }),
    ]);
    expect(importFileErrorToAppError(result.errors).code).toBe("INVALID_CSV");
  });

  it("rejects the whole file on a malformed quoted cell", () => {
    const result = parseCsv(
      `${HEADER}\n"Ja"ne Smith,2026-03-05,09:00,17:00\nSam Lee,2026-03-05,09:00,17:00\n`,
    );
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "INVALID_CSV",
        details: { rowNumber: 2, reason: "InvalidQuotes" },
      }),
    ]);
  });

  it("keeps a stray quote inside an unquoted cell as text (RFC 4180 leniency, no rows lost)", () => {
    const result = parseCsv(
      `${HEADER}\nJa "JJ" ne,2026-03-05,09:00,17:00\nSam Lee,2026-03-05,09:00,17:00\n`,
    );
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.employee_name)).toEqual(['Ja "JJ" ne', "Sam Lee"]);
  });

  it("rejects binary files (an .xlsx renamed to .csv, or UTF-16 text)", () => {
    const xlsx = "PK\u0003\u0004\u0014\u0000\u0006\u0000[Content_Types].xml";
    expect(parseCsv(xlsx).errors).toEqual([
      expect.objectContaining({
        code: "INVALID_CSV",
        message: expect.stringMatching(/not a plain-text CSV/),
      }),
    ]);
    const utf16 = "e\u0000m\u0000p\u0000,\u0000d\u0000\n\u0000";
    expect(parseCsv(utf16).errors[0]!.code).toBe("INVALID_CSV");
    expect(parseCsv(utf16).rows).toEqual([]);
    expect(detectHeaders(xlsx)).toEqual({
      headers: [],
      sampleRows: [],
      delimiter: ",",
      hasHeaderRow: false,
    });
  });

  it("honours Excel's sep= directive and does not count it as a row", () => {
    const text = `${BOM}sep=;\r\nName;Date;Start;End\r\n"Smith, Jane";05/03/2026;09:00;17:00\r\n`;
    const result = parseCsv(text);
    expect(result.errors).toEqual([]);
    expect(result.delimiter).toBe(";");
    expect(result.headers).toEqual(["Name", "Date", "Start", "End"]);
    expect(result.records).toEqual([
      {
        rowNumber: 2,
        values: { Name: "Smith, Jane", Date: "05/03/2026", Start: "09:00", End: "17:00" },
        problems: [],
      },
    ]);
    expect(detectHeaders(text)).toMatchObject({
      headers: ["Name", "Date", "Start", "End"],
      delimiter: ";",
      hasHeaderRow: true,
    });
    // A forced delimiter still wins over the directive.
    expect(parseCsv("sep=,\na|b\n1|2\n", { delimiter: "|" }).rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("detects the delimiter even when cells contain the other candidates", () => {
    // Semicolon file with commas in names and decimal-comma values.
    const semi =
      'Name;Date;Start;End;Break\n"Smith, Jane";05/03/2026;09:00;17:00;0,5\nLee, Sam;05/03/2026;09:00;17:00;30\n';
    expect(parseCsv(semi).delimiter).toBe(";");
    expect(parseCsv(semi).rows.map((r) => r.Name)).toEqual(["Smith, Jane", "Lee, Sam"]);
    // Comma file with semicolons inside a quoted note.
    const comma =
      'Name,Date,Start,End,Notes\nJane,05/03/2026,09:00,17:00,"a;b;c;d"\nBob,05/03/2026,09:00,17:00,x\n';
    expect(parseCsv(comma).delimiter).toBe(",");
    // Tab file with unquoted commas in names.
    const tab = "Name\tDate\tStart\tEnd\nSmith, Jane\t05/03/2026\t09:00\t17:00\n";
    expect(parseCsv(tab).rows[0]!.Name).toBe("Smith, Jane");
    // Trailing delimiters on every data row (some exporters) are padding, not data.
    const trailing =
      "Name;Date;Start;End\nJane;05/03/2026;09:00;17:00;\nBob;05/03/2026;09:00;17:00;\n";
    expect(parseCsv(trailing).delimiter).toBe(";");
    expect(parseCsv(trailing).records.every((r) => r.problems.length === 0)).toBe(true);
  });

  it("names blank headers and de-duplicates repeated ones", () => {
    expect(normaliseHeaders(["Date", "", "Start", "Start", " Start "])).toEqual([
      "Date",
      "Column 2",
      "Start",
      "Start (2)",
      "Start (3)",
    ]);
  });

  it("never generates a header name the file already uses (no cell is overwritten)", () => {
    expect(normaliseHeaders(["Start", "Start", "Start (2)"])).toEqual([
      "Start",
      "Start (3)",
      "Start (2)",
    ]);
    expect(normaliseHeaders(["", "Column 1", "Column 1"])).toEqual([
      "Column 1 (2)",
      "Column 1",
      "Column 1 (3)",
    ]);
    const result = parseCsv("Start,Start,Start (2),,Column 4\n1,2,3,4,5\n");
    expect(result.headers).toEqual(["Start", "Start (3)", "Start (2)", "Column 4 (2)", "Column 4"]);
    expect(result.rows).toEqual([
      { Start: "1", "Start (3)": "2", "Start (2)": "3", "Column 4 (2)": "4", "Column 4": "5" },
    ]);
  });

  it("names extra cells so they never overwrite a real column", () => {
    const result = parseCsv("Column 3,date\nx,y,z\n");
    expect(result.records[0]!.values).toEqual({ "Column 3": "x", date: "y", "Column 3 (2)": "z" });
    expect(result.records[0]!.problems.map((p) => p.code)).toEqual(["INVALID_CSV"]);
  });

  it("keeps a __proto__ header as an ordinary own column", () => {
    const result = parseCsv("__proto__,constructor,date\nJane Smith,x,2026-03-05\n");
    const values = result.rows[0]!;
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.keys(values)).toEqual(["__proto__", "constructor", "date"]);
    expect(values["__proto__"]).toBe("Jane Smith");
    expect(values["constructor"]).toBe("x");
  });

  it("rejects files with more than maxRows data rows", () => {
    const lines = [HEADER];
    for (let i = 0; i < 3; i++) lines.push(`Jane Smith,2026-03-05,09:00,17:00`);
    const result = parseCsv(lines.join("\n"), { maxRows: 2 });
    expect(result.rows).toEqual([]);
    expect(result.records).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "TOO_MANY_ROWS",
        severity: "ERROR",
        details: { maxRows: 2 },
      }),
    ]);
    expect(parseCsv(lines.join("\n"), { maxRows: 3 }).errors).toEqual([]);
  });

  it("defaults to the 5,000-row limit (blank lines and the header do not count)", () => {
    expect(IMPORT_LIMITS.maxRows).toBe(5000);
    const exactly = [
      HEADER,
      ...Array.from({ length: 5000 }, () => "Jane Smith,2026-03-05,09:00,17:00"),
      "",
      "",
    ].join("\n");
    const ok = parseCsv(exactly);
    expect(ok.errors).toEqual([]);
    expect(ok.rows).toHaveLength(5000);
    const tooMany = parseCsv(`${exactly}\nJane Smith,2026-03-05,09:00,17:00\n`);
    expect(tooMany.rows).toEqual([]);
    expect(tooMany.errors[0]).toMatchObject({
      code: "TOO_MANY_ROWS",
      message: expect.stringMatching(/more than 5,000 rows/),
    });
  });

  it("reports empty files and header-only files", () => {
    expect(parseCsv("").errors).toEqual([
      expect.objectContaining({ code: "INVALID_CSV", message: "The file is empty." }),
    ]);
    expect(parseCsv(BOM).errors).toEqual([expect.objectContaining({ code: "INVALID_CSV" })]);
    expect(parseCsv("  \n\n").errors).toEqual([expect.objectContaining({ code: "INVALID_CSV" })]);
    const headerOnly = parseCsv(`${HEADER}\n`);
    expect(headerOnly.headers).toEqual(["employee_name", "date", "start_time", "end_time"]);
    expect(headerOnly.errors).toEqual([
      expect.objectContaining({
        code: "INVALID_CSV",
        message: expect.stringMatching(/no data rows/),
      }),
    ]);
  });

  it("supports files without a header row using positional column names", () => {
    const result = parseCsv(
      "Jane Smith,2026-03-05,09:00,17:00\nJohn Smith,2026-03-05,10:00,18:00\n",
      { hasHeaderRow: false },
    );
    expect(result.headers).toEqual(["Column 1", "Column 2", "Column 3", "Column 4"]);
    expect(result.records.map((r) => r.rowNumber)).toEqual([1, 2]);
    expect(result.rows[0]!["Column 1"]).toBe("Jane Smith");
  });

  it("honours a forced delimiter", () => {
    const result = parseCsv("a|b,c\n1|2,3\n", { delimiter: "|" });
    expect(result.rows[0]).toEqual({ a: "1", "b,c": "2,3" });
  });
});

describe("detectHeaders", () => {
  it("detects a header row and returns up to five sample rows", () => {
    const lines = ["Staff,Date,Shift Start,Finish"];
    for (let i = 1; i <= 8; i++) lines.push(`Person ${i},2026-03-0${i},09:00,17:00`);
    const result = detectHeaders(lines.join("\r\n"));
    expect(result.hasHeaderRow).toBe(true);
    expect(result.headers).toEqual(["Staff", "Date", "Shift Start", "Finish"]);
    expect(result.sampleRows).toHaveLength(5);
    expect(result.sampleRows[0]).toEqual(["Person 1", "2026-03-01", "09:00", "17:00"]);
    expect(result.delimiter).toBe(",");
  });

  it("strips a BOM from the first header", () => {
    const result = detectHeaders(
      `${BOM}Name;Date;Start;End\r\nJane Smith;05/03/2026;09:00;17:00\r\n`,
    );
    expect(result.headers).toEqual(["Name", "Date", "Start", "End"]);
    expect(result.delimiter).toBe(";");
  });

  it("detects the absence of a header row when the first line looks like data", () => {
    const result = detectHeaders(
      "Jane Smith,2026-03-05,09:00,17:00\nJohn Smith,2026-03-05,10:00,18:00\n",
    );
    expect(result.hasHeaderRow).toBe(false);
    expect(result.headers).toEqual(["Column 1", "Column 2", "Column 3", "Column 4"]);
    expect(result.sampleRows[0]).toEqual(["Jane Smith", "2026-03-05", "09:00", "17:00"]);
  });

  it("does not mistake a data row for a header because a cell happens to be an alias", () => {
    // "Office" is a location alias, but the row also contains a date and times.
    expect(
      detectHeaderRow(
        ["Jane Smith", "2026-03-05", "09:00", "17:00", "Office"],
        ["John", "2026-03-05", "09:00", "17:00", "Office"],
      ),
    ).toBe(false);
  });

  it("treats an unrecognised but non-data first line as a header", () => {
    const result = detectHeaders("Who,When,Begins,Stops\nJane Smith,2026-03-05,09:00,17:00\n");
    expect(result.hasHeaderRow).toBe(true);
    expect(result.headers).toEqual(["Who", "When", "Begins", "Stops"]);
    expect(detectHeaderRow(["Foo", "Bar"], ["Jane", "2026-03-05"])).toBe(true);
    expect(detectHeaderRow(["Jane", "Smith"], ["John", "Smith"])).toBe(false);
  });

  it("pads and truncates sample rows to the header count", () => {
    const result = detectHeaders(
      "Name,Date,Start,End\nJane Smith,2026-03-05\nJohn,2026-03-05,09:00,17:00,extra\n",
    );
    expect(result.sampleRows).toEqual([
      ["Jane Smith", "2026-03-05", "", ""],
      ["John", "2026-03-05", "09:00", "17:00"],
    ]);
  });

  it("reports the delimiter and handles empty input", () => {
    expect(detectHeaders("a;b\n1;2\n").delimiter).toBe(";");
    expect(detectHeaders("a\tb\n1\t2\n").delimiter).toBe("\t");
    expect(detectHeaders("")).toEqual({
      headers: [],
      sampleRows: [],
      delimiter: ",",
      hasHeaderRow: false,
    });
  });

  it("recognises data-like cells", () => {
    expect(looksLikeData("2026-03-05")).toBe(true);
    expect(looksLikeData("05/03/2026")).toBe(true);
    expect(looksLikeData("09:00")).toBe(true);
    expect(looksLikeData("9am")).toBe(true);
    expect(looksLikeData("jane@example.com")).toBe(true);
    expect(looksLikeData("30")).toBe(true);
    expect(looksLikeData("Jane Smith")).toBe(false);
    expect(looksLikeData("Start Time")).toBe(false);
    expect(looksLikeData("")).toBe(false);
  });
});

describe("validateImportFile", () => {
  it("accepts .csv/.txt/.tsv files up to 5 MB", () => {
    expect(validateImportFile({ name: "rota.csv", size: 1024 })).toEqual([]);
    expect(validateImportFile({ name: "ROTA.CSV", size: IMPORT_LIMITS.maxFileBytes })).toEqual([]);
    expect(validateImportFile({ name: "export.txt", size: 10 })).toEqual([]);
    expect(validateImportFile({ name: "export.tsv", size: 10 })).toEqual([]);
  });

  it("rejects oversized, empty and non-CSV files", () => {
    expect(validateImportFile({ name: "rota.csv", size: IMPORT_LIMITS.maxFileBytes + 1 })).toEqual([
      expect.objectContaining({
        code: "FILE_TOO_LARGE",
        severity: "ERROR",
        message: expect.stringMatching(/limit is 5 MB/),
      }),
    ]);
    expect(validateImportFile({ name: "rota.csv", size: 0 })).toEqual([
      expect.objectContaining({ code: "INVALID_CSV" }),
    ]);
    expect(validateImportFile({ name: "rota.xlsx", size: 10 })).toEqual([
      expect.objectContaining({ code: "INVALID_CSV" }),
    ]);
  });

  it("maps file problems to the API error envelope", () => {
    const tooBig = importFileErrorToAppError(
      validateImportFile({ name: "rota.csv", size: 6 * 1024 * 1024 }),
    );
    expect(tooBig).toBeInstanceOf(AppError);
    expect(tooBig.code).toBe("PAYLOAD_TOO_LARGE");
    expect(tooBig.status).toBe(413);

    const parsed = parseCsv("");
    const invalid = importFileErrorToAppError(parsed.errors);
    expect(invalid.code).toBe("INVALID_CSV");
    expect(invalid.status).toBe(400);
    expect(invalid.toBody()).toEqual({
      error: {
        code: "INVALID_CSV",
        message: "The file is empty.",
        details: { problems: parsed.errors },
      },
    });

    const rows = parseCsv(
      `${HEADER}\nJane Smith,2026-03-05,09:00,17:00\nJane Smith,2026-03-06,09:00,17:00\n`,
      { maxRows: 1 },
    );
    expect(importFileErrorToAppError(rows.errors).code).toBe("INVALID_CSV");
    expect(importFileErrorToAppError([]).code).toBe("INVALID_CSV");
  });
});
