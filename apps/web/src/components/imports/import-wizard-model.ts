import type { DateFormat, ShiftImportRowStatus, ShiftImportStatus } from "@workmode/shared/enums";
import {
  EMPLOYEE_IDENTIFIER_FIELDS,
  IMPORT_FIELD_INFO,
  IMPORT_FIELDS,
  IMPORT_LIMITS,
  IMPORT_PROBLEM_INFO,
  REQUIRED_IMPORT_FIELDS,
  type ColumnMapping,
  type ImportField,
  type ImportProblemCode,
  type ImportProblemSeverity,
} from "@workmode/shared/csv/types";
import { checkMapping, type MappingCheck } from "@workmode/shared/csv/headerMapping";
import {
  IMPORT_ACCEPTED_MIME_TYPES,
  type ImportRow,
  type ImportSummaryResponse,
  type ShiftImport,
} from "@workmode/validation/imports";
import { z } from "zod";

/**
 * Pure helpers behind the CSV import wizard: the step machine, client-side file checks, mapping
 * completeness, review tabs and per-row fix detection. No React, so it is unit-tested in node.
 */

// ── Steps ───────────────────────────────────────────────────────────────────

export const IMPORT_STEPS = ["upload", "map", "validate", "review", "import", "summary"] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

export const IMPORT_STEP_META: Record<ImportStep, { label: string; title: string; description: string }> = {
  upload: {
    label: "Upload",
    title: "Upload your rota",
    description: "A CSV export from your rota software or spreadsheet. Nothing is saved until the final step.",
  },
  map: {
    label: "Map columns",
    title: "Match columns to shift fields",
    description: "We've suggested a match for each column. Confirm the ones marked and fix any that are wrong.",
  },
  validate: {
    label: "Validate",
    title: "Checking every row",
    description: "Dates, times, employees and overlaps are checked before anything is created.",
  },
  review: {
    label: "Review",
    title: "Review rows",
    description: "Fix or skip rows with problems. Warnings import as they are unless you skip them.",
  },
  import: {
    label: "Import",
    title: "Create the shifts",
    description: "Confirm what will be imported. Shifts switch Work Mode on automatically once created.",
  },
  summary: {
    label: "Done",
    title: "Import complete",
    description: "The shifts are on the schedule.",
  },
};

export function stepIndex(step: ImportStep): number {
  return IMPORT_STEPS.indexOf(step);
}

/** The step an import resumes at, from its server-side status. */
export function stepForImportStatus(status: ShiftImportStatus | null | undefined): ImportStep {
  switch (status) {
    case "UPLOADED":
      return "map";
    case "MAPPED":
      return "validate";
    case "VALIDATED":
      return "review";
    case "IMPORTED":
      return "summary";
    case "FAILED":
    case null:
    case undefined:
      return "upload";
  }
}

/**
 * Which steps the stepper may jump to for an import in `status`. Going back to earlier steps is always
 * possible until the import is committed; later steps unlock as the server advances the status.
 */
export function isStepReachable(target: ImportStep, status: ShiftImportStatus | null | undefined): boolean {
  if (target === "upload") return status !== "IMPORTED";
  if (!status || status === "FAILED") return false;
  if (status === "IMPORTED") return target === "summary";
  switch (target) {
    case "map":
      return true;
    case "validate":
      return status === "MAPPED" || status === "VALIDATED";
    case "review":
    case "import":
      return status === "VALIDATED";
    case "summary":
      return false;
  }
}

export type StepState = "complete" | "current" | "upcoming";

export function stepState(step: ImportStep, current: ImportStep): StepState {
  const a = stepIndex(step);
  const b = stepIndex(current);
  return a < b ? "complete" : a === b ? "current" : "upcoming";
}

// ── File checks ─────────────────────────────────────────────────────────────

export const IMPORT_FILE_EXTENSIONS = [".csv", ".tsv", ".txt"] as const;

/** `accept` attribute for the file input: the extensions plus every MIME type the API allows. */
export const IMPORT_FILE_ACCEPT = [...IMPORT_FILE_EXTENSIONS, ...IMPORT_ACCEPTED_MIME_TYPES].join(",");

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

export type FileCheck = { ok: true; contentType: string } | { ok: false; message: string };

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Client-side pre-check so an obviously wrong file never leaves the browser: size ≤ 5 MB, a CSV-like
 * extension, non-empty. Browsers often report no MIME type (or a spreadsheet one) for `.csv`, so the
 * accepted content type is derived from the extension when the browser's is not in the API's list.
 */
export function checkImportFile(file: FileLike): FileCheck {
  const lower = file.name.toLowerCase();
  if (!IMPORT_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { ok: false, message: "Choose a .csv file (comma, semicolon or tab separated). Excel workbooks must be saved as CSV UTF-8 first." };
  }
  if (file.size === 0) return { ok: false, message: "The file is empty." };
  if (file.size > IMPORT_LIMITS.maxFileBytes) {
    return { ok: false, message: `The file is ${formatFileSize(file.size)}; the limit is ${formatFileSize(IMPORT_LIMITS.maxFileBytes)}. Split it or remove unused columns.` };
  }
  const accepted = (IMPORT_ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type) ? file.type : lower.endsWith(".csv") ? "text/csv" : "text/plain";
  return { ok: true, contentType: accepted };
}

// ── Upload options ──────────────────────────────────────────────────────────

export interface ImportOptionsInput {
  dateFormat: DateFormat;
  /** Explicit zone, or null to let the API default (location zone, else organisation zone). */
  timezone: string | null;
  locationId: string | null;
}

/**
 * Non-file multipart fields for `POST /api/imports` (`importMetadataSchema`). Null options are omitted so
 * the API applies its documented defaults instead of receiving an empty string.
 */
export function uploadMetadataEntries(options: ImportOptionsInput): [string, string][] {
  const entries: [string, string][] = [["dateFormat", options.dateFormat]];
  if (options.timezone) entries.push(["timezone", options.timezone]);
  if (options.locationId) entries.push(["locationId", options.locationId]);
  return entries;
}

/** The zone CSV times will be read in when none is chosen explicitly: the location's, else the organisation's. */
export function effectiveImportTimezone(
  options: Pick<ImportOptionsInput, "timezone" | "locationId">,
  locations: readonly { id: string; timezone: string | null }[],
  organisationTimezone: string,
): string {
  if (options.timezone) return options.timezone;
  const location = options.locationId ? locations.find((l) => l.id === options.locationId) : undefined;
  return location?.timezone ?? organisationTimezone;
}

// ── Mapping ─────────────────────────────────────────────────────────────────

export const IGNORE_COLUMN = "__ignore__";

export interface FieldOption {
  value: ImportField | typeof IGNORE_COLUMN;
  label: string;
  requirement: "required" | "identifier" | "optional" | "ignore";
  description: string;
}

export const FIELD_OPTIONS: readonly FieldOption[] = [
  { value: IGNORE_COLUMN, label: "Ignore this column", requirement: "ignore", description: "The column is kept in the error report but not imported." },
  ...IMPORT_FIELDS.map((field) => ({
    value: field,
    label: IMPORT_FIELD_INFO[field].label,
    requirement: IMPORT_FIELD_INFO[field].requirement,
    description: IMPORT_FIELD_INFO[field].description,
  })),
];

export function isImportField(value: unknown): value is ImportField {
  return typeof value === "string" && (IMPORT_FIELDS as readonly string[]).includes(value);
}

/**
 * The field a header is mapped to, or null. Reads own properties only and ignores unknown values, so a
 * header literally called `__proto__` (allowed by the parser) can never leak `Object.prototype` into the UI.
 */
export function fieldOf(mapping: ColumnMapping, header: string): ImportField | null {
  if (!Object.prototype.hasOwnProperty.call(mapping, header)) return null;
  const value = mapping[header];
  return isImportField(value) ? value : null;
}

/**
 * The mapping the step starts from: the stored one when the manager already saved it, otherwise the upload
 * suggestion. Every header gets an entry (null = ignore) so the table and the request agree on the columns.
 */
export function initialMapping(headers: readonly string[], stored: ColumnMapping, suggested: ColumnMapping | undefined): ColumnMapping {
  const hasStored = Object.keys(stored).some((header) => fieldOf(stored, header) !== null);
  const source = hasStored ? stored : (suggested ?? {});
  return Object.fromEntries(headers.map((header) => [header, fieldOf(source, header)]));
}

/** Maps `header` to `field` (or ignore), un-mapping any other header that used the same field. */
export function setMappingField(mapping: ColumnMapping, header: string, field: ImportField | null): ColumnMapping {
  const next: [string, ImportField | null][] = Object.keys(mapping).map((h) => {
    if (h === header) return [h, field];
    const current = fieldOf(mapping, h);
    return [h, field !== null && current === field ? null : current];
  });
  return Object.fromEntries(next);
}

/**
 * Headers whose suggested field still needs an explicit confirmation: listed in `needsConfirmation`, still
 * mapped to exactly what was suggested, and not yet confirmed by the manager (changing the field counts).
 */
export function unconfirmedHeaders(
  mapping: ColumnMapping,
  suggestion: { mapping: ColumnMapping; needsConfirmation: readonly string[] } | null | undefined,
  confirmed: ReadonlySet<string>,
): string[] {
  if (!suggestion) return [];
  return suggestion.needsConfirmation.filter((header) => {
    if (confirmed.has(header)) return false;
    const current = fieldOf(mapping, header);
    return current !== null && current === fieldOf(suggestion.mapping, header);
  });
}

export type MappingConfidenceLabel = "exact" | "alias" | "partial" | "none";

/** Buckets the 0..1 confidence score the API returns per header. */
export function confidenceLabel(confidence: number | undefined): MappingConfidenceLabel {
  if (confidence === undefined || confidence <= 0) return "none";
  if (confidence >= 1) return "exact";
  if (confidence >= 0.9) return "alias";
  return "partial";
}

/** Up to `limit` distinct, non-empty sample values for a header from the upload preview rows. */
export function sampleValues(rows: readonly Record<string, string>[], header: string, limit = 3): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const value = Object.prototype.hasOwnProperty.call(row, header) ? row[header]?.trim() : undefined;
    if (!value || out.includes(value)) continue;
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

export interface MappingStatus {
  check: MappingCheck;
  /** Human list of what is still missing, e.g. ["Date", "an employee identifier"]. */
  missing: string[];
  /** Fields mapped from two columns (each needs resolving). */
  duplicated: string[];
  canContinue: boolean;
}

export function mappingStatus(mapping: ColumnMapping): MappingStatus {
  const check = checkMapping(mapping);
  const missing = check.missingRequired.map((field) => IMPORT_FIELD_INFO[field].label);
  if (check.missingIdentifier) missing.push("an employee identifier (name, ID or email)");
  return {
    check,
    missing,
    duplicated: check.duplicated.map((field) => IMPORT_FIELD_INFO[field].label),
    canContinue: check.complete,
  };
}

/** Headers that are mapped to `field` (for the duplicate indicator). */
export function headersFor(mapping: ColumnMapping, field: ImportField): string[] {
  return Object.keys(mapping).filter((header) => fieldOf(mapping, header) === field);
}

export const REQUIRED_FIELD_LIST = REQUIRED_IMPORT_FIELDS;
export const IDENTIFIER_FIELD_LIST = EMPLOYEE_IDENTIFIER_FIELDS;

/** Checklist shown next to the mapping table: each required field plus the identifier group. */
export interface MappingRequirement {
  key: string;
  label: string;
  satisfied: boolean;
  /** Header(s) currently supplying it. */
  headers: string[];
}

export function mappingRequirements(mapping: ColumnMapping): MappingRequirement[] {
  const required = REQUIRED_IMPORT_FIELDS.map((field) => {
    const headers = headersFor(mapping, field);
    return { key: field, label: IMPORT_FIELD_INFO[field].label, satisfied: headers.length === 1, headers };
  });
  const identifierHeaders = EMPLOYEE_IDENTIFIER_FIELDS.flatMap((field) => headersFor(mapping, field));
  return [
    ...required,
    { key: "identifier", label: "Employee name, ID or email", satisfied: identifierHeaders.length > 0, headers: identifierHeaders },
  ];
}

const mappingCheckDetailsSchema = z.object({
  missingRequired: z.array(z.string()).optional(),
  missingIdentifier: z.boolean().optional(),
  duplicated: z.array(z.string()).optional(),
});

/** Reads the `MappingCheck` an IMPORT_MAPPING_INCOMPLETE error carries as `details`; tolerant of other shapes. */
export function readMappingCheckDetails(details: unknown): string[] {
  const parsed = mappingCheckDetailsSchema.safeParse(details);
  if (!parsed.success) return [];
  const out: string[] = [];
  for (const field of parsed.data.missingRequired ?? []) out.push(isImportField(field) ? IMPORT_FIELD_INFO[field].label : field);
  if (parsed.data.missingIdentifier) out.push("an employee identifier (name, ID or email)");
  for (const field of parsed.data.duplicated ?? []) out.push(`${isImportField(field) ? IMPORT_FIELD_INFO[field].label : field} is mapped twice`);
  return out;
}

const fileProblemsDetailsSchema = z.object({
  problems: z.array(z.object({ code: z.string(), message: z.string() })),
});

/** The per-file problems an INVALID_CSV / PAYLOAD_TOO_LARGE answer lists in `details.problems`. */
export function readFileProblems(details: unknown): { code: string; message: string }[] {
  const parsed = fileProblemsDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data.problems : [];
}

// ── Review ──────────────────────────────────────────────────────────────────

export const REVIEW_TABS = ["VALID", "WARNING", "ERROR", "SKIPPED"] as const satisfies readonly ShiftImportRowStatus[];
export type ReviewTab = (typeof REVIEW_TABS)[number];

export const REVIEW_TAB_META: Record<ReviewTab, { label: string; empty: string }> = {
  VALID: { label: "Valid", empty: "No rows are ready to import yet." },
  WARNING: { label: "Warnings", empty: "No rows have warnings." },
  ERROR: { label: "Errors", empty: "No rows have errors." },
  SKIPPED: { label: "Skipped", empty: "No rows are skipped." },
};

export function isReviewTab(value: unknown): value is ReviewTab {
  return typeof value === "string" && (REVIEW_TABS as readonly string[]).includes(value);
}

export function reviewTabCounts(summary: ImportSummaryResponse | null | undefined): Record<ReviewTab, number> {
  return {
    VALID: summary?.valid ?? 0,
    WARNING: summary?.warning ?? 0,
    ERROR: summary?.error ?? 0,
    SKIPPED: summary?.skipped ?? 0,
  };
}

/** The tab to open first: errors if any, else warnings, else valid. */
export function defaultReviewTab(summary: ImportSummaryResponse | null | undefined): ReviewTab {
  if ((summary?.error ?? 0) > 0) return "ERROR";
  if ((summary?.warning ?? 0) > 0) return "WARNING";
  return "VALID";
}

/** Page to show after the row count on a tab changed (a fix moved rows away): never past the last page. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, page), lastPage);
}

/** The wizard's summary while the import is not committed, derived from the import's stored counts. */
export function summaryFromImport(
  record: Pick<ShiftImport, "rowCount" | "validCount" | "warningCount" | "errorCount" | "skippedCount" | "importedCount">,
): ImportSummaryResponse {
  return {
    total: record.rowCount,
    valid: record.validCount,
    warning: record.warningCount,
    error: record.errorCount,
    skipped: record.skippedCount,
    imported: record.importedCount,
    readyToCommit: record.errorCount === 0,
  };
}

/** Writes a fresh summary (validate / row-fix response) back onto the cached import so counts stay in sync. */
export function applySummaryToImport<T extends Pick<ShiftImport, "rowCount" | "validCount" | "warningCount" | "errorCount" | "skippedCount" | "importedCount">>(
  record: T,
  summary: ImportSummaryResponse,
): T {
  return {
    ...record,
    rowCount: summary.total,
    validCount: summary.valid,
    warningCount: summary.warning,
    errorCount: summary.error,
    skippedCount: summary.skipped,
    importedCount: summary.imported,
  };
}

export function problemTitle(code: ImportProblemCode): string {
  return IMPORT_PROBLEM_INFO[code]?.title ?? code.replace(/_/g, " ").toLowerCase();
}

export function problemResolution(code: ImportProblemCode): string {
  return IMPORT_PROBLEM_INFO[code]?.resolution ?? "";
}

export function problemTone(severity: ImportProblemSeverity): "danger" | "warning" {
  return severity === "ERROR" ? "danger" : "warning";
}

export interface RowFixes {
  /** MULTIPLE_MATCHES or EMPLOYEE_NOT_FOUND: pick the employee by hand. */
  chooseEmployee: boolean;
  /** EMPLOYEE_NOT_FOUND: create the employee from the row's name/email/ID. */
  createEmployee: boolean;
  /** UNKNOWN_LOCATION: create the location or import without one. */
  location: boolean;
  /** Any row that is not imported yet can be skipped (or un-skipped). */
  skip: boolean;
  unskip: boolean;
}

export function rowFixes(row: Pick<ImportRow, "status" | "problems">): RowFixes {
  const codes = new Set(row.problems.map((p) => p.code));
  const open = row.status !== "IMPORTED" && row.status !== "SKIPPED";
  return {
    chooseEmployee: open && (codes.has("MULTIPLE_MATCHES") || codes.has("EMPLOYEE_NOT_FOUND")),
    createEmployee: open && codes.has("EMPLOYEE_NOT_FOUND"),
    location: open && codes.has("UNKNOWN_LOCATION"),
    skip: open,
    unskip: row.status === "SKIPPED",
  };
}

/** `"Smith, Jane"` → Jane Smith; `"Jane Smith"` → Jane Smith; a single word becomes the last name. */
export function splitName(full: string | undefined | null): { firstName: string; lastName: string } {
  const value = (full ?? "").replace(/\s+/g, " ").trim();
  if (!value) return { firstName: "", lastName: "" };
  if (value.includes(",")) {
    const [last = "", first = ""] = value.split(",").map((part) => part.trim());
    return { firstName: first, lastName: last };
  }
  const parts = value.split(" ");
  if (parts.length === 1) return { firstName: "", lastName: parts[0] ?? "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] ?? "" };
}

export interface CreateEmployeePrefill {
  firstName: string;
  lastName: string;
  email: string;
  externalEmployeeId: string;
}

const suggestedEmployeeSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().nullable().optional(),
  externalEmployeeId: z.string().nullable().optional(),
});

/**
 * Pre-fills the "create employee" form from the row: the matcher's `details.suggestedEmployee` when the
 * EMPLOYEE_NOT_FOUND problem carries one, else the parsed name / email / ID.
 */
export function prefillCreateEmployee(row: Pick<ImportRow, "parsed" | "raw" | "problems">): CreateEmployeePrefill {
  const parsed = row.parsed;
  const name = splitName(parsed?.employeeName);
  const fallback: CreateEmployeePrefill = {
    firstName: name.firstName,
    lastName: name.lastName,
    email: parsed?.email ?? "",
    externalEmployeeId: parsed?.employeeExternalId ?? "",
  };
  const notFound = row.problems.find((p) => p.code === "EMPLOYEE_NOT_FOUND");
  const suggested = suggestedEmployeeSchema.safeParse(notFound?.details?.suggestedEmployee);
  if (!suggested.success) return fallback;
  return {
    firstName: suggested.data.firstName || fallback.firstName,
    lastName: suggested.data.lastName || fallback.lastName,
    email: suggested.data.email ?? fallback.email,
    externalEmployeeId: suggested.data.externalEmployeeId ?? fallback.externalEmployeeId,
  };
}

/** The "create employee" mini-form (strings only; empties are dropped before the request). */
export const createEmployeeFormSchema = z
  .object({
    firstName: z.string().trim().min(1, "Enter a first name").max(100, "At most 100 characters"),
    lastName: z.string().trim().min(1, "Enter a last name").max(100, "At most 100 characters"),
    email: z.string().trim().max(254, "At most 254 characters"),
    externalEmployeeId: z.string().trim().max(100, "At most 100 characters"),
    jobTitle: z.string().trim().max(120, "At most 120 characters"),
  })
  .superRefine((value, ctx) => {
    if (value.email && !z.email().safeParse(value.email).success) {
      ctx.addIssue({ code: "custom", path: ["email"], message: "Enter a valid email address" });
    }
  });
export type CreateEmployeeFormValues = z.infer<typeof createEmployeeFormSchema>;

export function createEmployeeFormDefaults(prefill: CreateEmployeePrefill): CreateEmployeeFormValues {
  return { firstName: prefill.firstName, lastName: prefill.lastName, email: prefill.email, externalEmployeeId: prefill.externalEmployeeId, jobTitle: "" };
}

/** `PATCH /api/imports/:id/rows/:rowId` body for the create-employee resolution (`importCreateEmployeeSchema`). */
export function toCreateEmployeeRowInput(values: CreateEmployeeFormValues): {
  createEmployee: { firstName: string; lastName: string; email?: string; externalEmployeeId?: string; jobTitle?: string };
} {
  const createEmployee: { firstName: string; lastName: string; email?: string; externalEmployeeId?: string; jobTitle?: string } = {
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
  };
  if (values.email.trim()) createEmployee.email = values.email.trim();
  if (values.externalEmployeeId.trim()) createEmployee.externalEmployeeId = values.externalEmployeeId.trim();
  if (values.jobTitle.trim()) createEmployee.jobTitle = values.jobTitle.trim();
  return { createEmployee };
}

/** Who the row is for, as shown in the review table. */
export function rowEmployeeLabel(row: Pick<ImportRow, "matchedEmployee" | "createEmployee" | "parsed">): { label: string; kind: "matched" | "new" | "unmatched" } {
  if (row.matchedEmployee) return { label: `${row.matchedEmployee.firstName} ${row.matchedEmployee.lastName}`.trim(), kind: "matched" };
  if (row.createEmployee) return { label: `${row.createEmployee.firstName} ${row.createEmployee.lastName}`.trim(), kind: "new" };
  const fallback = row.parsed?.employeeName ?? row.parsed?.email ?? row.parsed?.employeeExternalId ?? "—";
  return { label: fallback, kind: "unmatched" };
}

/** `09:00–17:00`, or `22:00 → 06:00 (+1)` for an overnight row; `—` when the times did not parse. */
export function rowTimeLabel(parsed: ImportRow["parsed"]): string {
  if (!parsed?.startTime || !parsed.endTime) return "—";
  return parsed.overnight ? `${parsed.startTime} → ${parsed.endTime} (+1)` : `${parsed.startTime}–${parsed.endTime}`;
}

/** The raw cell for a field when the parsed value is missing (so a bad date is still visible). */
export function rawCellFor(row: Pick<ImportRow, "raw">, mapping: ColumnMapping, field: ImportField): string | null {
  const header = headersFor(mapping, field)[0];
  if (!header || !Object.prototype.hasOwnProperty.call(row.raw, header)) return null;
  const value = row.raw[header];
  return value && value.trim() ? value : null;
}

// ── Commit ──────────────────────────────────────────────────────────────────

export interface CommitPlan {
  /** Rows that will become shifts. */
  willImport: number;
  /** Rows left out (skipped, errors skipped, warnings excluded). */
  willSkip: number;
  /** Errors remain and `skipErrors` is off → the API would answer IMPORT_HAS_ERRORS. */
  blockedByErrors: boolean;
}

export function planCommit(summary: ImportSummaryResponse, options: { includeWarnings: boolean; skipErrors: boolean }): CommitPlan {
  const warnings = options.includeWarnings ? summary.warning : 0;
  const willImport = summary.valid + warnings;
  const blockedByErrors = summary.error > 0 && !options.skipErrors;
  return {
    willImport,
    willSkip: summary.skipped + (options.includeWarnings ? 0 : summary.warning) + (options.skipErrors ? summary.error : 0),
    blockedByErrors,
  };
}

export function errorsCsvUrl(importId: string): string {
  return `/api/imports/${encodeURIComponent(importId)}/errors.csv`;
}

export const IMPORT_TEMPLATE_URL = "/templates/shift-import-template.csv";

/** `/schedule/import?import=<id>` so a half-finished import can be resumed from a reload or a link. */
export function importWizardSearch(importId: string | null): string {
  return importId ? `?import=${encodeURIComponent(importId)}` : "";
}
