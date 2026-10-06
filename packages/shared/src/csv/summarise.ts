/**
 * Import summary counts, the downloadable "problem rows" CSV, and the lists behind the wizard's
 * "create location" / "create employee" resolution options.
 */
import Papa from "papaparse";
import { nameKey, suggestedEmployee, type SuggestedEmployee } from "./matchEmployee";
import type { ImportProblem, ImportProblemCode, ValidatedRow } from "./types";

export interface ImportSummary {
  total: number;
  valid: number;
  warning: number;
  error: number;
  skipped: number;
  /** Rows the import will create shifts for: VALID + WARNING. */
  importable: number;
  /** Occurrences of each problem code across all rows (a row can contribute several). */
  problemCounts: Partial<Record<ImportProblemCode, number>>;
}

/** Counts per status (maps onto ShiftImport.validCount / warningCount / errorCount / rowCount). */
export function summarise(rows: readonly ValidatedRow[]): ImportSummary {
  const summary: ImportSummary = {
    total: rows.length,
    valid: 0,
    warning: 0,
    error: 0,
    skipped: 0,
    importable: 0,
    problemCounts: {},
  };
  for (const row of rows) {
    switch (row.status) {
      case "VALID":
        summary.valid++;
        break;
      case "WARNING":
        summary.warning++;
        break;
      case "ERROR":
        summary.error++;
        break;
      case "SKIPPED":
        summary.skipped++;
        break;
      default: {
        const unreachable: never = row.status;
        throw new Error(`Unhandled import row status: ${String(unreachable)}`);
      }
    }
    for (const p of row.problems) {
      summary.problemCounts[p.code] = (summary.problemCounts[p.code] ?? 0) + 1;
    }
  }
  summary.importable = summary.valid + summary.warning;
  return summary;
}

/** "SEVERITY CODE (field): message" joined with " | " — one cell per row in the errors CSV. */
export function formatProblems(problems: readonly ImportProblem[]): string {
  return problems
    .map((p) => `${p.severity} ${p.code}${p.field ? ` (${p.field})` : ""}: ${p.message}`)
    .join(" | ");
}

/**
 * Cells starting with a character that makes a spreadsheet read them as a formula: = + - @ tab CR, and
 * their full-width forms (which CJK-locale spreadsheets also accept). Papa's built-in `escapeFormulae: true`
 * pattern ends in `.*$` without the `s` flag, so it misses multi-line cells such as `"=1+\n1"`; this
 * pattern checks the first character only.
 */
const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

/**
 * CSV of every row that has at least one problem (ERROR, WARNING or SKIPPED): row number, status, the
 * problems, then the original columns in their original order. Empty string when there are no problem rows.
 *
 * Cells (headers included) starting with = + - @ tab or CR are prefixed with an apostrophe so a spreadsheet
 * never evaluates uploaded content as a formula (CSV injection).
 */
export function toErrorsCsv(rows: readonly ValidatedRow[]): string {
  const problemRows = rows.filter((r) => r.problems.length > 0);
  if (problemRows.length === 0) return "";

  const originalHeaders: string[] = [];
  const seen = new Set<string>();
  for (const row of problemRows) {
    for (const h of Object.keys(row.raw)) {
      if (!seen.has(h)) {
        seen.add(h);
        originalHeaders.push(h);
      }
    }
  }

  const fields = ["row_number", "status", "problems", ...originalHeaders];
  const data = problemRows.map((row) => [
    String(row.rowNumber),
    row.status,
    formatProblems(row.problems),
    ...originalHeaders.map((h) => (Object.hasOwn(row.raw, h) ? (row.raw[h] ?? "") : "")),
  ]);
  return (
    Papa.unparse({ fields, data }, { newline: "\r\n", escapeFormulae: FORMULA_START }) + "\r\n"
  );
}

export interface UnknownLocation {
  /** The name as first written in the file. */
  name: string;
  rowNumbers: number[];
}

/** Distinct UNKNOWN_LOCATION names (case/whitespace-insensitive), for the "create these locations" option. */
export function unknownLocations(rows: readonly ValidatedRow[]): UnknownLocation[] {
  const byKey = new Map<string, UnknownLocation>();
  for (const row of rows) {
    if (!row.problems.some((p) => p.code === "UNKNOWN_LOCATION")) continue;
    const name = row.parsed.locationName;
    if (name === undefined) continue;
    const key = name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    const entry = byKey.get(key);
    if (entry) entry.rowNumbers.push(row.rowNumber);
    else byKey.set(key, { name, rowNumbers: [row.rowNumber] });
  }
  return [...byKey.values()];
}

export interface EmployeeToCreate {
  /** Pre-filled values for the "create employee" form (name split from 'First Last' or 'Last, First'). */
  suggested: SuggestedEmployee;
  rowNumbers: number[];
}

/**
 * Distinct people behind EMPLOYEE_NOT_FOUND rows, for the "create employee" option. Rows are grouped by
 * employee ID, else email, else name; rows with no usable identifier are left out.
 */
export function employeesToCreate(rows: readonly ValidatedRow[]): EmployeeToCreate[] {
  const byKey = new Map<string, EmployeeToCreate>();
  for (const row of rows) {
    if (!row.problems.some((p) => p.code === "EMPLOYEE_NOT_FOUND")) continue;
    const { employeeExternalId, email, employeeName } = row.parsed;
    const key =
      employeeExternalId !== undefined
        ? `id:${employeeExternalId.trim().toLowerCase()}`
        : email !== undefined
          ? `email:${email}`
          : employeeName !== undefined
            ? `name:${nameKey(employeeName)}`
            : null;
    if (key === null) continue;
    const entry = byKey.get(key);
    if (entry) entry.rowNumbers.push(row.rowNumber);
    else byKey.set(key, { suggested: suggestedEmployee(row.parsed), rowNumbers: [row.rowNumber] });
  }
  return [...byKey.values()];
}
