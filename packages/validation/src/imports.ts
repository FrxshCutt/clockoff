import { z } from "zod";
import {
  IMPORT_FIELDS,
  IMPORT_LIMITS,
  IMPORT_PROBLEM_CODES,
  IMPORT_PROBLEM_SEVERITIES,
} from "@workmode/shared/csv/types";
import {
  emailSchema,
  nonEmptyString,
  offsetPaginationQuerySchema,
  timezoneSchema,
  uuidSchema,
} from "./common";
import {
  dateFormatSchema,
  shiftImportRowStatusSchema,
  shiftImportStatusSchema,
} from "./enumSchemas";
import {
  instantSchema,
  jsonObjectSchema,
  nullableInstantSchema,
  offsetPaginatedResponseSchema,
  queryListSchema,
} from "./primitives";
import { namedRefSchema } from "./refs";

/**
 * CSV shift import wizard (§5 imports, §6.5): upload → map columns → validate → fix rows → commit.
 * Parsing, matching and validation are the pure functions in `@workmode/shared/csv`; these schemas are the
 * HTTP contract around them.
 */

export const importFieldSchema = z.enum(IMPORT_FIELDS).meta({ id: "ImportField" });
export const importProblemCodeSchema = z
  .enum(IMPORT_PROBLEM_CODES)
  .meta({ id: "ImportProblemCode" });
export const importProblemSeveritySchema = z
  .enum(IMPORT_PROBLEM_SEVERITIES)
  .meta({ id: "ImportProblemSeverity" });

export const IMPORT_ACCEPTED_MIME_TYPES = [
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
] as const;

// ── Upload (multipart/form-data) ────────────────────────────────────────────

/**
 * Non-file fields of `POST /api/imports` (multipart/form-data). Parse with
 * `importMetadataSchema.parse(Object.fromEntries([...formData].filter(([k]) => k !== "file")))`.
 * Defaults: organisation date format and timezone (or the location's timezone when `locationId` is set).
 */
export const importMetadataSchema = z
  .object({
    dateFormat: dateFormatSchema.optional(),
    timezone: timezoneSchema.optional(),
    /** Location applied to rows without a location value. */
    locationId: uuidSchema.optional(),
  })
  .strict();
export type ImportMetadataInput = z.infer<typeof importMetadataSchema>;

/** The whole multipart form: metadata + `file` (a `File`, ≤ 5 MB, CSV). */
export const importUploadFormSchema = importMetadataSchema
  .extend({
    file: z
      .file()
      .min(1, "The file is empty")
      .max(IMPORT_LIMITS.maxFileBytes, "The file is larger than 5 MB")
      .mime([...IMPORT_ACCEPTED_MIME_TYPES]),
  })
  .strict();
export type ImportUploadFormInput = z.infer<typeof importUploadFormSchema>;

// ── Import resource ─────────────────────────────────────────────────────────

/** `{ "<csv header>": "<field>" | null }` (ShiftImport.columnMapping). */
export const columnMappingSchema = z
  .record(z.string().min(1).max(200), importFieldSchema.nullable())
  .meta({
    id: "ColumnMapping",
    description: "CSV header → import field (null = ignore the column).",
  });
export type ColumnMappingInput = z.infer<typeof columnMappingSchema>;

export const importOptionsSchema = z
  .object({
    dateFormat: dateFormatSchema,
    timezone: z.string(),
    locationId: uuidSchema.nullable(),
  })
  .meta({ id: "ImportOptions" });

export const shiftImportSchema = z
  .object({
    id: uuidSchema,
    filename: z.string(),
    fileSizeBytes: z.int().min(0),
    status: shiftImportStatusSchema,
    headers: z.array(z.string()),
    columnMapping: columnMappingSchema,
    options: importOptionsSchema,
    rowCount: z.int().min(0),
    validCount: z.int().min(0),
    warningCount: z.int().min(0),
    errorCount: z.int().min(0),
    skippedCount: z.int().min(0),
    importedCount: z.int().min(0),
    uploadedBy: namedRefSchema.nullable(),
    importedAt: nullableInstantSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .meta({ id: "ShiftImport" });
export type ShiftImport = z.infer<typeof shiftImportSchema>;

export const mappingSuggestionSchema = z
  .object({
    mapping: columnMappingSchema,
    /** `{ header: 0..1 }` — 1 exact, 0.9 alias, 0.6 partial, 0 unmapped. */
    confidence: z.record(z.string(), z.number().min(0).max(1)),
    /** Headers whose suggested field needs explicit confirmation. */
    needsConfirmation: z.array(z.string()),
  })
  .meta({ id: "MappingSuggestion" });

/** `POST /api/imports` → 201 */
export const createImportResponseSchema = z
  .object({
    import: shiftImportSchema,
    suggestion: mappingSuggestionSchema,
    /** First rows keyed by header, for the mapping preview. */
    sampleRows: z.array(z.record(z.string(), z.string())).max(20),
  })
  .meta({ id: "CreateImportResponse" });
export type CreateImportResponse = z.infer<typeof createImportResponseSchema>;

export const importResponseSchema = z
  .object({
    import: shiftImportSchema,
    /** The upload-time mapping suggestion, repeated while the import has not been committed. */
    suggestion: mappingSuggestionSchema.optional(),
  })
  .meta({ id: "ImportResponse" });
export type ImportResponse = z.infer<typeof importResponseSchema>;

/** `GET /api/imports` — recent imports, newest first. */
export const importQuerySchema = offsetPaginationQuerySchema.extend({
  status: queryListSchema(shiftImportStatusSchema).optional(),
});
export type ImportQuery = z.infer<typeof importQuerySchema>;

export const listImportsResponseSchema = offsetPaginatedResponseSchema(shiftImportSchema).meta({
  id: "ListImportsResponse",
});
export type ListImportsResponse = z.infer<typeof listImportsResponseSchema>;

// ── Mapping ─────────────────────────────────────────────────────────────────

/**
 * `POST /api/imports/:id/mapping`. Structural checks only (each field used at most once). Whether the
 * mapping is complete (date/start_time/end_time + an employee identifier) is the handler's job via
 * `checkMapping` → IMPORT_MAPPING_INCOMPLETE with the MappingCheck as details.
 */
export const importMappingSchema = z
  .object({
    mapping: columnMappingSchema,
    options: z
      .object({
        dateFormat: dateFormatSchema.optional(),
        timezone: timezoneSchema.optional(),
        locationId: uuidSchema.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Map<string, string>();
    for (const [header, field] of Object.entries(value.mapping)) {
      if (field === null) continue;
      const previous = seen.get(field);
      if (previous !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["mapping", header],
          message: `"${field}" is already mapped from "${previous}"`,
        });
      } else {
        seen.set(field, header);
      }
    }
  });
export type ImportMappingInput = z.infer<typeof importMappingSchema>;

// ── Validation & rows ───────────────────────────────────────────────────────

export const importSummarySchema = z
  .object({
    total: z.int().min(0),
    valid: z.int().min(0),
    warning: z.int().min(0),
    error: z.int().min(0),
    skipped: z.int().min(0),
    imported: z.int().min(0),
    /** True when commit would succeed (no unresolved ERROR rows). */
    readyToCommit: z.boolean(),
  })
  .meta({ id: "ImportSummary" });
export type ImportSummaryResponse = z.infer<typeof importSummarySchema>;

/** `POST /api/imports/:id/validate` → import + summary. */
export const validateImportResponseSchema = z
  .object({ import: shiftImportSchema, summary: importSummarySchema })
  .meta({ id: "ValidateImportResponse" });
export type ValidateImportResponse = z.infer<typeof validateImportResponseSchema>;

export const importProblemSchema = z
  .object({
    code: importProblemCodeSchema,
    message: z.string(),
    field: importFieldSchema.optional(),
    severity: importProblemSeveritySchema,
    details: jsonObjectSchema.optional(),
  })
  .meta({ id: "ImportProblem" });

/** Mirrors `ParsedShiftRow`: fields are only present when their cell parsed cleanly. */
export const parsedShiftRowSchema = z
  .object({
    employeeName: z.string().optional(),
    employeeExternalId: z.string().optional(),
    email: z.string().optional(),
    date: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    startsAt: instantSchema.optional(),
    endsAt: instantSchema.optional(),
    timezone: z.string(),
    overnight: z.boolean(),
    locationName: z.string().optional(),
    departmentName: z.string().optional(),
    role: z.string().optional(),
    breakMinutes: z.int().min(0).optional(),
  })
  .meta({ id: "ParsedShiftRow" });

export const importRowSchema = z
  .object({
    id: uuidSchema,
    /** Spreadsheet row number (the header is row 1). */
    rowNumber: z.int().min(1),
    status: shiftImportRowStatusSchema,
    raw: z.record(z.string(), z.string()),
    parsed: parsedShiftRowSchema.nullable(),
    problems: z.array(importProblemSchema),
    matchedEmployee: z
      .object({ id: uuidSchema, firstName: z.string(), lastName: z.string() })
      .nullable(),
    /** Set when the row resolution will create a new employee at commit. */
    createEmployee: z
      .object({ firstName: z.string(), lastName: z.string(), email: z.string().nullable() })
      .nullable(),
    createdShiftId: uuidSchema.nullable(),
  })
  .meta({ id: "ImportRow" });
export type ImportRow = z.infer<typeof importRowSchema>;

/** `GET /api/imports/:id/rows?status&page&pageSize` */
export const importRowsQuerySchema = offsetPaginationQuerySchema.extend({
  status: queryListSchema(shiftImportRowStatusSchema).optional(),
});
export type ImportRowsQuery = z.infer<typeof importRowsQuerySchema>;

export const listImportRowsResponseSchema = offsetPaginatedResponseSchema(importRowSchema).meta({
  id: "ListImportRowsResponse",
});
export type ListImportRowsResponse = z.infer<typeof listImportRowsResponseSchema>;

export const importRowParamsSchema = z.object({ id: uuidSchema, rowId: uuidSchema }).strict();
export type ImportRowParams = z.infer<typeof importRowParamsSchema>;

/** New employee created at commit for an unmatched row. */
export const importCreateEmployeeSchema = z
  .object({
    firstName: nonEmptyString(100),
    lastName: nonEmptyString(100),
    email: emailSchema.optional(),
    externalEmployeeId: nonEmptyString(100).optional(),
    jobTitle: nonEmptyString(120).optional(),
    primaryLocationId: uuidSchema.optional(),
  })
  .strict();

export const IMPORT_LOCATION_ACTIONS = ["CREATE", "IGNORE"] as const;
export type ImportLocationAction = (typeof IMPORT_LOCATION_ACTIONS)[number];
export const importLocationActionSchema = z
  .enum(IMPORT_LOCATION_ACTIONS)
  .meta({ id: "ImportLocationAction" });

/**
 * `PATCH /api/imports/:id/rows/:rowId` — exactly one resolution: match an existing employee (`null`
 * clears the match), create a new employee (created immediately and matched to the row), skip / un-skip
 * the row, or resolve an UNKNOWN_LOCATION (`CREATE` the location, or `IGNORE` it and import the row
 * without a location). The row is re-validated.
 */
export const updateImportRowSchema = z
  .union([
    z.object({ matchedEmployeeId: uuidSchema.nullable() }).strict(),
    z.object({ createEmployee: importCreateEmployeeSchema }).strict(),
    z.object({ skip: z.boolean() }).strict(),
    z.object({ locationAction: importLocationActionSchema }).strict(),
  ])
  .meta({ id: "UpdateImportRowInput" });
export type UpdateImportRowInput = z.infer<typeof updateImportRowSchema>;

export const importRowResponseSchema = z
  .object({ row: importRowSchema, summary: importSummarySchema })
  .meta({ id: "ImportRowResponse" });
export type ImportRowResponse = z.infer<typeof importRowResponseSchema>;

// ── Commit ──────────────────────────────────────────────────────────────────

/**
 * `POST /api/imports/:id/commit`. Rows with ERROR status block the commit (IMPORT_HAS_ERRORS) unless
 * skipped or `skipErrors` is true (then they are left as ERROR and not imported); WARNING rows are
 * imported unless `includeWarnings` is false (then they are skipped).
 */
export const commitImportSchema = z
  .object({
    includeWarnings: z.boolean().default(true),
    skipErrors: z.boolean().default(false),
  })
  .strict();
export type CommitImportInput = z.infer<typeof commitImportSchema>;

export const commitImportResponseSchema = z
  .object({
    import: shiftImportSchema,
    shiftsCreated: z.int().min(0),
    employeesCreated: z.int().min(0),
    rowsSkipped: z.int().min(0),
  })
  .meta({ id: "CommitImportResponse" });
export type CommitImportResponse = z.infer<typeof commitImportResponseSchema>;
