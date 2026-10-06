/**
 * CSV shift import (§6.5) — public surface (`@workmode/shared/csv/csvImport`, also re-exported by the
 * package barrel). Pure functions, no I/O; the API layer wires them together:
 *
 *   validateImportFile({ name, size })                         upload checks (5 MB, extension)
 *   detectHeaders(text) → suggestMapping(headers)              mapping step (manager confirms)
 *   parseCsv(text, { delimiter, hasHeaderRow })                rows (≤ 5000) + file-level errors
 *   normaliseRows(records, mapping, { dateFormat, timezone })  typed values + UTC instants
 *   matchRows(rows, employees)                                 employee id → email → name
 *   importShiftWindow(rows) → load existing shifts             (DB query by the caller)
 *   validateRows(rows, { existingShifts, knownLocations })     overlaps, duplicates, lengths, locations
 *   summarise(rows) / toErrorsCsv(rows) / unknownLocations(rows) / employeesToCreate(rows)
 *
 * The list below is explicit (no `export *`) so helper names inside csv/ can never collide with other
 * modules in the package barrel. Internal helpers remain importable from their own files for tests.
 */
export {
  IMPORT_LIMITS,
  IMPORT_FIELDS,
  REQUIRED_IMPORT_FIELDS,
  EMPLOYEE_IDENTIFIER_FIELDS,
  IMPORT_FIELD_INFO,
  IMPORT_PROBLEM_CODES,
  IMPORT_PROBLEM_SEVERITIES,
  IMPORT_PROBLEM_INFO,
  problem as createImportProblem,
} from "./types";
export type {
  ImportField,
  ImportFieldRequirement,
  ImportFieldInfo,
  ImportProblemCode,
  ImportProblemSeverity,
  ImportProblemInfo,
  ImportProblem,
  ImportProblemOptions,
  ColumnMapping,
  NormaliseRowOptions,
  ParsedShiftRow,
  NormalisedRow,
  ImportRowStatus,
  ValidatedRow,
} from "./types";

export {
  FIELD_ALIASES,
  MAPPING_CONFIDENCE,
  MAPPING_CONFIDENCE_THRESHOLD,
  scoreHeader,
  suggestMapping,
  checkMapping,
  invertMapping,
} from "./headerMapping";
export type { HeaderScore, MappingSuggestion, MappingCheck } from "./headerMapping";

export {
  IMPORT_MIN_YEAR,
  IMPORT_MAX_YEAR,
  parseImportDate,
  parseImportTime,
} from "./parseDateTime";
export type { DateParseResult, TimeParseResult } from "./parseDateTime";

export {
  CSV_DELIMITERS,
  IMPORT_FILE_EXTENSIONS,
  detectHeaders,
  parseCsv,
  validateImportFile,
  importFileErrorToAppError,
} from "./parseCsv";
export type {
  CsvDelimiter,
  DetectHeadersResult,
  CsvRow,
  ParseCsvOptions,
  ParseCsvResult,
  ImportFileInfo,
} from "./parseCsv";

export { normaliseRow, normaliseRows } from "./normaliseRow";
export type { NormaliseRowResult } from "./normaliseRow";

export { matchEmployee, matchRows, indexCandidates } from "./matchEmployee";
export type {
  EmployeeCandidate,
  CandidateIndex,
  MatchSignal,
  SuggestedEmployee,
  MatchEmployeeResult,
  MatchInput,
} from "./matchEmployee";

export { validateRows, importShiftWindow, importRowStatus } from "./validateRows";
export type { ImportExistingShift, ValidateRowsContext, ImportShiftWindow } from "./validateRows";

export { summarise, toErrorsCsv, unknownLocations, employeesToCreate } from "./summarise";
export type { ImportSummary, UnknownLocation, EmployeeToCreate } from "./summarise";

export { IMPORT_TEMPLATE_ROWS, generateTemplateCsv } from "./template";
