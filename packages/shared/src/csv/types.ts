/**
 * CSV shift import — shared types (§6.5).
 *
 * Everything in `csv/` is pure: no I/O, no database. The API layer feeds it the CSV text, the
 * organisation's employees, existing shifts and known locations, and persists what comes back.
 */
import type { DateFormat, ShiftImportRowStatus } from "../enums";

/**
 * Hard limits. The upload endpoint enforces the file size; `parseCsv` enforces the row count;
 * `validateRows` / `normaliseRow` enforce the shift and break lengths (mirroring SHIFT_LIMITS in
 * @clockoff/validation so an import never fails at commit time for a reason it could have reported).
 */
export const IMPORT_LIMITS = {
  /** Maximum upload size: 5 MB. */
  maxFileBytes: 5 * 1024 * 1024,
  /** Maximum data rows per file (header excluded). */
  maxRows: 5000,
  /** Rows returned by `detectHeaders` for the mapping preview. */
  sampleRows: 5,
  /** Default minimum shift length (organisation-configurable via `validateRows` context). */
  minShiftMinutes: 15,
  /** Maximum shift length — the shifts API rejects anything longer than 24 hours. */
  maxShiftMinutes: 24 * 60,
  /** Longest single unpaid break accepted from a CSV (mirrors the scheduled-break limit). */
  maxBreakMinutes: 240,
} as const;

/** Columns a shift import can be mapped onto. Order is the template column order. */
export const IMPORT_FIELDS = [
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
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Fields every row must have a value for. */
export const REQUIRED_IMPORT_FIELDS = [
  "date",
  "start_time",
  "end_time",
] as const satisfies readonly ImportField[];

/** At least one of these must be mapped and non-empty so the row can be matched to an employee. */
export const EMPLOYEE_IDENTIFIER_FIELDS = [
  "employee_id",
  "email",
  "employee_name",
] as const satisfies readonly ImportField[];

export type ImportFieldRequirement = "required" | "identifier" | "optional";

export interface ImportFieldInfo {
  label: string;
  requirement: ImportFieldRequirement;
  description: string;
  example: string;
}

/** UI copy for the mapping step and the docs. */
export const IMPORT_FIELD_INFO: Record<ImportField, ImportFieldInfo> = {
  employee_name: {
    label: "Employee name",
    requirement: "identifier",
    description:
      "Full name, 'First Last' or 'Last, First'. Matched case- and whitespace-insensitively.",
    example: "Jane Smith",
  },
  employee_id: {
    label: "Employee ID",
    requirement: "identifier",
    description:
      "Your payroll / rota system identifier (matches Employee.externalEmployeeId). Highest matching priority.",
    example: "E1042",
  },
  email: {
    label: "Email",
    requirement: "identifier",
    description: "Employee email, matched case-insensitively.",
    example: "jane.smith@example.com",
  },
  date: {
    label: "Date",
    requirement: "required",
    description:
      "Shift date: YYYY-MM-DD, or DD/MM/YYYY / MM/DD/YYYY according to the organisation's date format.",
    example: "2026-03-05",
  },
  start_time: {
    label: "Start time",
    requirement: "required",
    description: "Local time in the import timezone: 09:00, 9:00, 0900, 9am, 9.30pm.",
    example: "09:00",
  },
  end_time: {
    label: "End time",
    requirement: "required",
    description:
      "Local end time. An end time at or before the start time is treated as an overnight shift (warning).",
    example: "17:00",
  },
  location: {
    label: "Location",
    requirement: "optional",
    description:
      "Location / site / store name. Unknown names produce a warning and can be created or ignored.",
    example: "High Street",
  },
  department: {
    label: "Department",
    requirement: "optional",
    description: "Department / team name. Stored as free text on the row.",
    example: "Front of house",
  },
  role: {
    label: "Role",
    requirement: "optional",
    description: "Role / position for the shift. Stored as free text on the row.",
    example: "Barista",
  },
  break_minutes: {
    label: "Break minutes",
    requirement: "optional",
    description: "Whole number of unpaid break minutes, e.g. 30 or '30 mins'.",
    example: "30",
  },
};

/**
 * Problem codes attached to rows (and, for INVALID_CSV / FILE_TOO_LARGE / TOO_MANY_ROWS, to the whole file).
 * Stable identifiers the UI maps to copy; see IMPORT_PROBLEM_INFO and docs/CSV_IMPORT.md.
 */
export const IMPORT_PROBLEM_CODES = [
  // file / structure
  "INVALID_CSV",
  "FILE_TOO_LARGE",
  "TOO_MANY_ROWS",
  // per-row parsing
  "MISSING_REQUIRED_FIELD",
  "INVALID_DATE",
  "INVALID_TIME",
  "INVALID_BREAK_MINUTES",
  "INVALID_EMAIL",
  "OVERNIGHT_SHIFT",
  "DST_ADJUSTED_TIME",
  "DST_AMBIGUOUS_TIME",
  // employee matching
  "EMPLOYEE_NOT_FOUND",
  "MULTIPLE_MATCHES",
  "EMPLOYEE_IDENTIFIER_MISMATCH",
  // cross-row / database validation
  "OVERLAPPING_SHIFT",
  "DUPLICATE_SHIFT",
  "UNKNOWN_LOCATION",
  "SHIFT_TOO_SHORT",
  "SHIFT_TOO_LONG",
  "SHIFT_IN_PAST",
] as const;
export type ImportProblemCode = (typeof IMPORT_PROBLEM_CODES)[number];

export const IMPORT_PROBLEM_SEVERITIES = ["ERROR", "WARNING"] as const;
export type ImportProblemSeverity = (typeof IMPORT_PROBLEM_SEVERITIES)[number];

export interface ImportProblemInfo {
  /** Severity the code is raised with (`problem()` uses it unless told otherwise). */
  severity: ImportProblemSeverity;
  title: string;
  /** What the manager can do about it in the wizard. */
  resolution: string;
}

export const IMPORT_PROBLEM_INFO: Record<ImportProblemCode, ImportProblemInfo> = {
  INVALID_CSV: {
    severity: "ERROR",
    title: "File could not be read",
    resolution:
      "Export the rota again as UTF-8 CSV (comma, semicolon or tab separated), check quotes and that every row has the same columns as the header, and re-upload.",
  },
  FILE_TOO_LARGE: {
    severity: "ERROR",
    title: "File too large",
    resolution:
      "CSV files can be at most 5 MB. Remove unused columns or split the file and import the parts separately.",
  },
  TOO_MANY_ROWS: {
    severity: "ERROR",
    title: "Too many rows",
    resolution: "Split the file into chunks of at most 5,000 shifts and import them one at a time.",
  },
  MISSING_REQUIRED_FIELD: {
    severity: "ERROR",
    title: "Missing required value",
    resolution:
      "Fill in the empty cell in the source file, or map a different column in the mapping step.",
  },
  INVALID_DATE: {
    severity: "ERROR",
    title: "Date not recognised",
    resolution:
      "Use YYYY-MM-DD, or check the organisation's date format (DD/MM/YYYY vs MM/DD/YYYY) in the options step.",
  },
  INVALID_TIME: {
    severity: "ERROR",
    title: "Time not recognised",
    resolution: "Use 24-hour HH:mm (09:00, 17:30) or 12-hour with am/pm (9am, 5:30pm).",
  },
  INVALID_BREAK_MINUTES: {
    severity: "ERROR",
    title: "Break minutes not valid",
    resolution:
      "Use a whole number of minutes (e.g. 30), at most 240 and shorter than the shift, or leave the cell empty.",
  },
  INVALID_EMAIL: {
    severity: "WARNING",
    title: "Email address not valid",
    resolution:
      "The email was ignored for matching; the row is matched by its employee ID or name, if it has one. Fix the email in the source file if needed.",
  },
  OVERNIGHT_SHIFT: {
    severity: "WARNING",
    title: "Overnight shift",
    resolution:
      "The end time is at or before the start time, so the shift ends on the following day. Confirm this is intended.",
  },
  DST_ADJUSTED_TIME: {
    severity: "WARNING",
    title: "Time adjusted for clock change",
    resolution:
      "The local time does not exist on this date because the clocks go forward; the next valid time was used. Check the shift times.",
  },
  DST_AMBIGUOUS_TIME: {
    severity: "WARNING",
    title: "Time happens twice (clock change)",
    resolution:
      "The clocks go back on this date so the local time occurs twice; the first occurrence (summer time) was used. Check the shift times.",
  },
  EMPLOYEE_NOT_FOUND: {
    severity: "ERROR",
    title: "Employee not found",
    resolution:
      "Create the employee from the row (the wizard pre-fills name, email and ID), fix the identifier, or skip the row.",
  },
  MULTIPLE_MATCHES: {
    severity: "ERROR",
    title: "Several employees match",
    resolution:
      "Add an employee ID or email column so the row can be matched unambiguously, or pick the employee in the wizard.",
  },
  EMPLOYEE_IDENTIFIER_MISMATCH: {
    severity: "WARNING",
    title: "Identifiers disagree",
    resolution:
      "The row's identifiers disagree: a higher-priority one (ID, then email) matched nobody, or a lower-priority one belongs to someone else or is not the email on file. The highest-priority match was used; check the row.",
  },
  OVERLAPPING_SHIFT: {
    severity: "ERROR",
    title: "Overlapping shift",
    resolution:
      "The employee already has a shift (in the database or elsewhere in this file) during this time. Adjust or remove one of them.",
  },
  DUPLICATE_SHIFT: {
    severity: "WARNING",
    title: "Duplicate shift",
    resolution:
      "The employee already has a shift with the same start and end, or an identical row appears earlier in the file, so this row is skipped. No action needed.",
  },
  UNKNOWN_LOCATION: {
    severity: "WARNING",
    title: "Unknown location",
    resolution: "Create the location, map it to an existing one, or import without a location.",
  },
  SHIFT_TOO_SHORT: {
    severity: "ERROR",
    title: "Shift too short",
    resolution:
      "Shifts must be at least the organisation's minimum length (default 15 minutes). Check the times.",
  },
  SHIFT_TOO_LONG: {
    severity: "ERROR",
    title: "Shift too long",
    resolution:
      "Shifts can be at most 24 hours. Check the start and end times, or split the shift in two.",
  },
  SHIFT_IN_PAST: {
    severity: "WARNING",
    title: "Shift already finished",
    resolution:
      "The shift ends before now. Confirm the year/date is right; past shifts are imported but never activate Work Mode.",
  },
};

/** One finding about a file or a row. Stored as-is in ShiftImportRow.problems (JSON). */
export interface ImportProblem {
  code: ImportProblemCode;
  /** Human-readable, row-specific explanation (English). */
  message: string;
  /** The import field the problem relates to, when it is specific to one. */
  field?: ImportField;
  severity: ImportProblemSeverity;
  /** Machine-readable extras (candidate ids, conflicting row numbers, suggested employee, ...). */
  details?: Record<string, unknown>;
}

/** Spec name for ImportProblem (§6.5). Prefer `ImportProblem` outside csv/ to keep the package barrel unambiguous. */
export type Problem = ImportProblem;

export interface ImportProblemOptions {
  field?: ImportField;
  severity?: ImportProblemSeverity;
  details?: Record<string, unknown>;
}

/** Builds an ImportProblem, defaulting the severity from IMPORT_PROBLEM_INFO. */
export function problem(
  code: ImportProblemCode,
  message: string,
  options: ImportProblemOptions = {},
): ImportProblem {
  const p: ImportProblem = {
    code,
    message,
    severity: options.severity ?? IMPORT_PROBLEM_INFO[code].severity,
  };
  if (options.field !== undefined) p.field = options.field;
  if (options.details !== undefined) p.details = options.details;
  return p;
}

/** `{ "<csv header>": "<field>" | null }` — the shape stored in ShiftImport.columnMapping. */
export type ColumnMapping = Record<string, ImportField | null>;

export interface NormaliseRowOptions {
  /** How ambiguous numeric dates (03/04/2026) are read. UK default is DMY. */
  dateFormat: DateFormat;
  /** IANA zone the CSV times are written in (organisation or chosen location timezone). */
  timezone: string;
  /** Applied when the row has no location value (e.g. the location picked in the wizard). */
  defaultLocationName?: string | null;
}

/** A row after parsing cells into typed values. Fields are only present when their cell parsed cleanly. */
export interface ParsedShiftRow {
  employeeName?: string;
  employeeExternalId?: string;
  email?: string;
  /** Calendar date in the import timezone, YYYY-MM-DD. */
  date?: string;
  /** Local start time, HH:mm (24h). */
  startTime?: string;
  /** Local end time, HH:mm (24h); "24:00" means midnight at the end of the day. */
  endTime?: string;
  /** UTC instant (ISO-8601, Z) — present only when date, start and end all parsed. */
  startsAt?: string;
  endsAt?: string;
  /** IANA zone used to compute the instants. */
  timezone: string;
  /** True when the end time was at or before the start time and the shift rolls into the next day. */
  overnight: boolean;
  locationName?: string;
  departmentName?: string;
  role?: string;
  breakMinutes?: number;
}

export interface NormalisedRow {
  /** Spreadsheet-style row number: the header row is 1, so the first data row is 2. */
  rowNumber: number;
  /** Original cell values keyed by CSV header, trimmed. */
  raw: Record<string, string>;
  parsed: ParsedShiftRow;
  problems: ImportProblem[];
  /** Set by `matchRows` / the caller after `matchEmployee`; null when no unambiguous match. */
  employeeId?: string | null;
}

/** Row outcome before the import runs (IMPORTED is assigned by the API once the shift is created). */
export type ImportRowStatus = Exclude<ShiftImportRowStatus, "IMPORTED">;

export interface ValidatedRow extends NormalisedRow {
  status: ImportRowStatus;
}
