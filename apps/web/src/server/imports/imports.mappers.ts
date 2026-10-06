import type { Prisma } from "@workmode/db";
import {
  IMPORT_FIELDS,
  IMPORT_PROBLEM_CODES,
  IMPORT_PROBLEM_SEVERITIES,
  type ColumnMapping,
  type ImportField,
  type ImportProblem,
  type ImportProblemCode,
  type ImportProblemSeverity,
  type ParsedShiftRow,
} from "@workmode/shared/csv/csvImport";
import { DATE_FORMATS, type DateFormat } from "@workmode/shared/enums";
import type { ImportRow, ImportSummaryResponse, ShiftImport } from "@workmode/validation/imports";

/**
 * Storage shapes of the CSV import (`ShiftImport` / `ShiftImportRow` JSON columns) and their API DTOs.
 *
 * - `ShiftImport.columnMapping`  `{ "<header>": "<field>" | null }` (shared `ColumnMapping`).
 * - `ShiftImport.options`        `{ dateFormat, timezone, locationId }` — the parsing options in force.
 * - `ShiftImport.headers`        `string[]` as parsed from the file (unique; blanks become "Column N").
 * - `ShiftImportRow.raw`         `{ "<header>": "<cell>" }`.
 * - `ShiftImportRow.parsed`      the shared `ParsedShiftRow` plus a private `resolution` key holding the
 *                                manager's fixes (see {@link RowResolution}); null until validated.
 * - `ShiftImportRow.problems`    `ImportProblem[]` (structural INVALID_CSV problems from upload are kept
 *                                across re-validations; everything else is recomputed).
 *
 * Counts: the database stores row/valid/warning/error/imported counts; `skippedCount` is derived
 * (`rowCount - valid - warning - error - imported`) once the import has been validated.
 */

/** Longest CSV header that can be a `columnMapping` key (mirrors `columnMappingSchema`). */
export const MAX_MAPPING_HEADER_LENGTH = 200;

/**
 * A manager's row-level decisions, kept across re-validations so fixing one row never undoes another:
 * `skipped` (do not import), `employeeId` (pinned match, wins over automatic matching), `ignoreLocation`
 * (import without a location, silencing UNKNOWN_LOCATION), `createdEmployeeId` (the employee this row
 * created, for the "new" label).
 */
export interface RowResolution {
  skipped?: boolean;
  employeeId?: string;
  ignoreLocation?: boolean;
  createdEmployeeId?: string;
}

export type StoredParsedRow = ParsedShiftRow & { resolution?: RowResolution };

export interface ImportOptionsStored {
  dateFormat: DateFormat;
  timezone: string;
  locationId: string | null;
}

export const importInclude = {
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.ShiftImportInclude;
export type ImportRecord = Prisma.ShiftImportGetPayload<{ include: typeof importInclude }>;

export const importRowInclude = {
  matchedEmployee: { select: { id: true, firstName: true, lastName: true, email: true } },
} satisfies Prisma.ShiftImportRowInclude;
export type ImportRowRecord = Prisma.ShiftImportRowGetPayload<{ include: typeof importRowInclude }>;

// ── JSON readers (defensive: a column written by an older version must never break a response) ──────

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const FIELD_SET: ReadonlySet<string> = new Set(IMPORT_FIELDS);
const CODE_SET: ReadonlySet<string> = new Set(IMPORT_PROBLEM_CODES);
const SEVERITY_SET: ReadonlySet<string> = new Set(IMPORT_PROBLEM_SEVERITIES);
const DATE_FORMAT_SET: ReadonlySet<string> = new Set(DATE_FORMATS);

export function readHeaders(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Raw cells keyed by header. JSONB does not keep object key order, so when the import's `headers` are
 * given the cells are returned in file order (extra "Column N" cells, if any, follow in name order).
 */
export function readRaw(value: Prisma.JsonValue, headers?: readonly string[]): Record<string, string> {
  const record = asRecord(value);
  const out: Record<string, string> = {};
  const cell = (header: string): string => {
    const v = record[header];
    return typeof v === "string" ? v : "";
  };
  if (headers) {
    for (const header of headers) if (Object.hasOwn(record, header)) out[header] = cell(header);
    const extras = Object.keys(record)
      .filter((header) => !Object.hasOwn(out, header))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    for (const header of extras) out[header] = cell(header);
    return out;
  }
  for (const header of Object.keys(record)) out[header] = cell(header);
  return out;
}

export function readMapping(value: Prisma.JsonValue): ColumnMapping {
  const out: ColumnMapping = {};
  for (const [header, field] of Object.entries(asRecord(value))) {
    if (field === null) out[header] = null;
    else if (typeof field === "string" && FIELD_SET.has(field)) out[header] = field as ImportField;
  }
  return out;
}

export function readOptions(
  value: Prisma.JsonValue,
  fallback: { dateFormat: DateFormat; timezone: string },
): ImportOptionsStored {
  const record = asRecord(value);
  const dateFormat =
    typeof record.dateFormat === "string" && DATE_FORMAT_SET.has(record.dateFormat)
      ? (record.dateFormat as DateFormat)
      : fallback.dateFormat;
  const timezone =
    typeof record.timezone === "string" && record.timezone !== "" ? record.timezone : fallback.timezone;
  const locationId = typeof record.locationId === "string" ? record.locationId : null;
  return { dateFormat, timezone, locationId };
}

export function readProblems(value: Prisma.JsonValue): ImportProblem[] {
  if (!Array.isArray(value)) return [];
  const out: ImportProblem[] = [];
  for (const item of value) {
    const record = asRecord(item as Prisma.JsonValue);
    if (typeof record.code !== "string" || !CODE_SET.has(record.code)) continue;
    if (typeof record.message !== "string") continue;
    const severity =
      typeof record.severity === "string" && SEVERITY_SET.has(record.severity)
        ? (record.severity as ImportProblemSeverity)
        : "ERROR";
    const problem: ImportProblem = { code: record.code as ImportProblemCode, message: record.message, severity };
    if (typeof record.field === "string" && FIELD_SET.has(record.field)) problem.field = record.field as ImportField;
    if (record.details !== null && typeof record.details === "object" && !Array.isArray(record.details)) {
      problem.details = record.details as Record<string, unknown>;
    }
    out.push(problem);
  }
  return out;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readParsed(value: Prisma.JsonValue | null): StoredParsedRow | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.timezone !== "string") return null;
  const parsed: StoredParsedRow = { timezone: record.timezone, overnight: record.overnight === true };
  const employeeName = optionalString(record.employeeName);
  if (employeeName !== undefined) parsed.employeeName = employeeName;
  const employeeExternalId = optionalString(record.employeeExternalId);
  if (employeeExternalId !== undefined) parsed.employeeExternalId = employeeExternalId;
  const email = optionalString(record.email);
  if (email !== undefined) parsed.email = email;
  const date = optionalString(record.date);
  if (date !== undefined) parsed.date = date;
  const startTime = optionalString(record.startTime);
  if (startTime !== undefined) parsed.startTime = startTime;
  const endTime = optionalString(record.endTime);
  if (endTime !== undefined) parsed.endTime = endTime;
  const startsAt = optionalString(record.startsAt);
  if (startsAt !== undefined) parsed.startsAt = startsAt;
  const endsAt = optionalString(record.endsAt);
  if (endsAt !== undefined) parsed.endsAt = endsAt;
  const locationName = optionalString(record.locationName);
  if (locationName !== undefined) parsed.locationName = locationName;
  const departmentName = optionalString(record.departmentName);
  if (departmentName !== undefined) parsed.departmentName = departmentName;
  const role = optionalString(record.role);
  if (role !== undefined) parsed.role = role;
  if (typeof record.breakMinutes === "number" && Number.isInteger(record.breakMinutes) && record.breakMinutes >= 0) {
    parsed.breakMinutes = record.breakMinutes;
  }
  const resolution = readResolutionRecord(record.resolution);
  if (resolution !== undefined) parsed.resolution = resolution;
  return parsed;
}

function readResolutionRecord(value: unknown): RowResolution | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const out: RowResolution = {};
  if (record.skipped === true) out.skipped = true;
  if (typeof record.employeeId === "string") out.employeeId = record.employeeId;
  if (record.ignoreLocation === true) out.ignoreLocation = true;
  if (typeof record.createdEmployeeId === "string") out.createdEmployeeId = record.createdEmployeeId;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function readResolution(parsed: StoredParsedRow | null): RowResolution {
  return parsed?.resolution ? { ...parsed.resolution } : {};
}

/** The shared `ParsedShiftRow` without the private `resolution` key. */
export function stripResolution(parsed: StoredParsedRow): ParsedShiftRow {
  const { resolution: _resolution, ...rest } = parsed;
  return rest;
}

/** Case-, width- and whitespace-insensitive key for location names (same rule as `validateRows`). */
export function locationKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// ── DTOs ────────────────────────────────────────────────────────────────────────────────────────

function hasBeenValidated(status: ImportRecord["status"]): boolean {
  return status === "VALIDATED" || status === "IMPORTED";
}

export function skippedCountOf(record: ImportRecord): number {
  if (!hasBeenValidated(record.status)) return 0;
  return Math.max(
    0,
    record.rowCount - record.validCount - record.warningCount - record.errorCount - record.importedCount,
  );
}

export function toImportDto(
  record: ImportRecord,
  fallback: { dateFormat: DateFormat; timezone: string },
): ShiftImport {
  return {
    id: record.id,
    filename: record.filename,
    fileSizeBytes: record.fileSizeBytes,
    status: record.status,
    headers: readHeaders(record.headers),
    columnMapping: readMapping(record.columnMapping),
    options: readOptions(record.options, fallback),
    rowCount: record.rowCount,
    validCount: record.validCount,
    warningCount: record.warningCount,
    errorCount: record.errorCount,
    skippedCount: skippedCountOf(record),
    importedCount: record.importedCount,
    uploadedBy: record.uploadedBy ? { id: record.uploadedBy.id, name: record.uploadedBy.name } : null,
    importedAt: record.importedAt ? record.importedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toSummary(record: ImportRecord): ImportSummaryResponse {
  return {
    total: record.rowCount,
    valid: record.validCount,
    warning: record.warningCount,
    error: record.errorCount,
    skipped: skippedCountOf(record),
    imported: record.importedCount,
    readyToCommit:
      record.status === "VALIDATED" &&
      record.errorCount === 0 &&
      record.validCount + record.warningCount > 0,
  };
}

export function toImportRowDto(record: ImportRowRecord, headers?: readonly string[]): ImportRow {
  const parsed = readParsed(record.parsed);
  const resolution = readResolution(parsed);
  const matched = record.matchedEmployee;
  const createdHere =
    matched !== null && resolution.createdEmployeeId !== undefined && matched.id === resolution.createdEmployeeId;
  return {
    id: record.id,
    rowNumber: record.rowNumber,
    status: record.status,
    raw: readRaw(record.raw, headers),
    parsed: parsed ? stripResolution(parsed) : null,
    problems: readProblems(record.problems),
    matchedEmployee: matched
      ? { id: matched.id, firstName: matched.firstName, lastName: matched.lastName }
      : null,
    createEmployee:
      createdHere && matched
        ? { firstName: matched.firstName, lastName: matched.lastName, email: matched.email }
        : null,
    createdShiftId: record.createdShiftId,
  };
}
