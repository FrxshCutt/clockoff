import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkMapping,
  detectHeaders,
  matchRows,
  normaliseRows,
  parseCsv,
  suggestMapping,
  summarise,
  toErrorsCsv,
  validateRows,
  type EmployeeCandidate,
} from "./csvImport";
import { generateTemplateCsv, IMPORT_TEMPLATE_ROWS } from "./template";
import { IMPORT_FIELDS } from "./types";

/** Employees the template rows refer to. */
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
    email: "amira.khan@example.com",
    externalEmployeeId: "E1044",
  },
];

describe("generateTemplateCsv", () => {
  it("has the canonical headers, CRLF line endings and one line per example row", () => {
    const csv = generateTemplateCsv();
    expect(csv.startsWith(IMPORT_FIELDS.join(",") + "\r\n")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")).toHaveLength(IMPORT_TEMPLATE_ROWS.length + 2); // header + rows + final ""
  });

  it.each(["DMY", "MDY", "YMD"] as const)(
    "goes through the full import pipeline with zero problems (date format %s)",
    (dateFormat) => {
      const csv = generateTemplateCsv();

      const detected = detectHeaders(csv);
      expect(detected).toMatchObject({ delimiter: ",", hasHeaderRow: true });
      expect(detected.headers).toEqual([...IMPORT_FIELDS]);

      const suggestion = suggestMapping(detected.headers);
      expect(suggestion.needsConfirmation).toEqual([]);
      expect(Object.values(suggestion.confidence).every((c) => c === 1)).toBe(true);
      expect(checkMapping(suggestion.mapping).complete).toBe(true);

      const parsed = parseCsv(csv, {
        delimiter: detected.delimiter,
        hasHeaderRow: detected.hasHeaderRow,
      });
      expect(parsed.errors).toEqual([]);
      expect(parsed.rows).toHaveLength(IMPORT_TEMPLATE_ROWS.length);

      const normalised = normaliseRows(parsed.records, suggestion.mapping, {
        dateFormat,
        timezone: "Europe/London",
      });
      const matched = matchRows(normalised, EMPLOYEES);
      const validated = validateRows(matched, {
        existingShifts: [],
        knownLocations: ["High Street", "Station Road"],
        // With `now`, past shifts would warn: the template's dates are years ahead of this review.
        now: "2026-10-06T00:00:00.000Z",
      });

      expect(validated.map((r) => r.problems)).toEqual([[], [], []]);
      expect(validated.map((r) => r.status)).toEqual(["VALID", "VALID", "VALID"]);
      expect(validated.map((r) => r.employeeId)).toEqual(["jane", "john", "amira"]);
      expect(validated.map((r) => [r.parsed.startsAt, r.parsed.endsAt])).toEqual([
        ["2030-03-05T09:00:00.000Z", "2030-03-05T17:00:00.000Z"],
        ["2030-03-05T14:00:00.000Z", "2030-03-05T22:00:00.000Z"], // 2pm–10pm
        ["2030-03-06T07:30:00.000Z", "2030-03-06T15:30:00.000Z"],
      ]);
      expect(validated[0]!.parsed.breakMinutes).toBe(30);
      expect(summarise(validated)).toMatchObject({ total: 3, valid: 3, importable: 3, error: 0 });
      expect(toErrorsCsv(validated)).toBe("");
    },
  );

  it("still has zero problems after a round trip through Excel (BOM, semicolons, d/m/y dates)", () => {
    // What "Save As CSV UTF-8" produces in a European locale after the dates were reformatted.
    const resaved =
      "﻿" +
      generateTemplateCsv()
        .replace(/,/g, ";")
        .replace(/"Smith; John"/, '"Smith, John"')
        .replace(/(\d{4})-(\d{2})-(\d{2})/g, "$3/$2/$1");
    const detected = detectHeaders(resaved);
    expect(detected).toMatchObject({ delimiter: ";", hasHeaderRow: true });
    expect(detected.headers).toEqual([...IMPORT_FIELDS]);
    const parsed = parseCsv(resaved, { delimiter: detected.delimiter });
    expect(parsed.errors).toEqual([]);
    const { mapping } = suggestMapping(detected.headers);
    const validated = validateRows(
      matchRows(
        normaliseRows(parsed.records, mapping, { dateFormat: "DMY", timezone: "Europe/London" }),
        EMPLOYEES,
      ),
      { existingShifts: [], knownLocations: ["High Street", "Station Road"] },
    );
    expect(validated.map((r) => r.problems)).toEqual([[], [], []]);
    expect(validated.map((r) => r.parsed.date)).toEqual(["2030-03-05", "2030-03-05", "2030-03-06"]);
  });

  it("matches the committed template in docs/templates byte for byte", () => {
    const file = readFileSync(
      resolve(import.meta.dirname, "../../../../docs/templates/shift-import-template.csv"),
      "utf8",
    );
    expect(file).toBe(generateTemplateCsv());
    // docs/CSV_IMPORT.md prints the same template.
    const docs = readFileSync(
      resolve(import.meta.dirname, "../../../../docs/CSV_IMPORT.md"),
      "utf8",
    );
    expect(docs).toContain("```csv\n" + generateTemplateCsv().replace(/\r\n/g, "\n") + "```");
  });
});
