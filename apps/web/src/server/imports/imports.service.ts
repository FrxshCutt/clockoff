import { Prisma, prisma, type ActivityEvent } from "@clockoff/db";
import {
  IMPORT_LIMITS,
  checkMapping,
  createImportProblem,
  detectHeaders,
  importFileErrorToAppError,
  importShiftWindow,
  matchRows,
  normaliseRows,
  parseCsv,
  suggestMapping,
  summarise,
  toErrorsCsv,
  validateRows,
  type ColumnMapping,
  type CsvRow,
  type ImportRowStatus,
  type MappingSuggestion,
  type NormalisedRow,
  type ValidatedRow,
} from "@clockoff/shared/csv/csvImport";
import { AppError } from "@clockoff/shared/errors";
import { minutesBetween } from "@clockoff/shared/time/time";
import type { CreateEmployeeInput } from "@clockoff/validation/employees";
import type {
  CommitImportInput,
  CommitImportResponse,
  CreateImportResponse,
  ImportMappingInput,
  ImportQuery,
  ImportResponse,
  ImportRowResponse,
  ImportRowsQuery,
  ListImportRowsResponse,
  ListImportsResponse,
  UpdateImportRowInput,
  ValidateImportResponse,
} from "@clockoff/validation/imports";
import { SHIFT_LIMITS } from "@clockoff/validation/shifts";
import { errorSummary, logger, stackFrames } from "@/lib/logger";
import { publishActivity, recordActivity } from "@/server/activity/recordActivity";
import { audit, toJsonValue, type AuditEntry } from "@/server/audit/audit";
import { createEmployee } from "@/server/employees";
import { publishEvent } from "@/server/events";
import { centredBreak } from "@/server/shifts/shifts.rules";
import { publishScheduleChangedForShifts } from "@/server/shifts/shifts.events";
import { requirePermission, type ManagerContext } from "@/server/tenancy";
import {
  MAX_MAPPING_HEADER_LENGTH,
  locationKey,
  readHeaders,
  readMapping,
  readOptions,
  readParsed,
  readProblems,
  readRaw,
  readResolution,
  stripResolution,
  toImportDto,
  toImportRowDto,
  toSummary,
  type ImportOptionsStored,
  type ImportRecord,
  type ImportRowRecord,
  type RowResolution,
  type StoredParsedRow,
} from "./imports.mappers";
import {
  findActiveEmployee,
  findImport,
  findImportRow,
  findLocation,
  listActiveEmployeeIds,
  listEmployeeCandidates,
  listExistingShifts,
  listImportRows,
  listImports as listImportRecords,
  listLocations,
  pageImportRows,
} from "./imports.repository";
import { readImportUpload } from "./imports.upload";

/**
 * CSV shift import wizard (§5, §6.5): upload → mapping → validate → fix rows → commit.
 *
 * All parsing, header mapping, employee matching and row validation is the pure `@clockoff/shared/csv`
 * module; this service persists its results and applies the manager's row-level fixes
 * ({@link RowResolution}) on top. Validation is re-runnable and is what every row fix goes through, so a
 * fix to one row (e.g. skipping one of two overlapping rows) updates its siblings as well.
 *
 * Commit creates one `Shift` (source CSV_IMPORT) per VALID / WARNING row in one transaction, with a
 * single centred scheduled break when the row carried `break_minutes`. `department` / `role` cells are
 * informational: kept on the row's `parsed` data, never written to the shift.
 *
 * Status machine: UPLOADED → MAPPED → VALIDATED → IMPORTED, or FAILED when the commit transaction itself
 * fails (nothing written; terminal). Every write outside its allowed states answers IMPORT_INVALID_STATE.
 */

const TRANSACTION_OPTIONS = { timeout: 120_000, maxWait: 10_000 } as const;
const ROW_WRITE_CHUNK = 100;
const ROW_CREATE_CHUNK = 500;
const SHIFT_CREATE_CHUNK = 50;

/** Problems produced by employee matching; replaced when a manager pins the employee for a row. */
const MATCH_PROBLEM_CODES: ReadonlySet<string> = new Set([
  "EMPLOYEE_NOT_FOUND",
  "MULTIPLE_MATCHES",
  "EMPLOYEE_IDENTIFIER_MISMATCH",
]);

type ImportStatus = ImportRecord["status"];

// ── helpers ─────────────────────────────────────────────────────────────────

function fallbackFor(ctx: ManagerContext): {
  dateFormat: ImportOptionsStored["dateFormat"];
  timezone: string;
} {
  return { dateFormat: ctx.organisation.dateFormat, timezone: ctx.organisation.timezone };
}

async function requireImport(ctx: ManagerContext, importId: string): Promise<ImportRecord> {
  const record = await findImport(ctx.organisation.id, importId);
  if (!record) throw new AppError("NOT_FOUND", "Import not found");
  return record;
}

function assertImportStatus(
  record: ImportRecord,
  allowed: readonly ImportStatus[],
  hint: string,
): void {
  if (allowed.includes(record.status)) return;
  throw new AppError("IMPORT_INVALID_STATE", hint, {
    details: { status: record.status, allowed: [...allowed] },
  });
}

async function requireLocation(organisationId: string, locationId: string) {
  const location = await findLocation(organisationId, locationId);
  if (!location) throw new AppError("NOT_FOUND", "Location not found");
  return location;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function json(value: unknown): Prisma.InputJsonValue {
  return toJsonValue(value) ?? {};
}

/**
 * `suggestMapping` for the stored headers. Headers longer than the schema's key limit cannot be mapped
 * and are left out so the suggestion is always a valid `ColumnMapping` payload.
 */
function suggestionFor(headers: readonly string[]): MappingSuggestion {
  const suggestion = suggestMapping(headers);
  const tooLong = headers.filter((h) => h.length > MAX_MAPPING_HEADER_LENGTH);
  if (tooLong.length === 0) return suggestion;
  const mapping: ColumnMapping = { ...suggestion.mapping };
  const confidence = { ...suggestion.confidence };
  for (const header of tooLong) {
    delete mapping[header];
    delete confidence[header];
  }
  return {
    mapping,
    confidence,
    needsConfirmation: suggestion.needsConfirmation.filter(
      (h) => h.length <= MAX_MAPPING_HEADER_LENGTH,
    ),
  };
}

function importResponse(ctx: ManagerContext, record: ImportRecord): ImportResponse {
  const dto = toImportDto(record, fallbackFor(ctx));
  return record.status === "IMPORTED"
    ? { import: dto }
    : { import: dto, suggestion: suggestionFor(dto.headers) };
}

// ── reads ───────────────────────────────────────────────────────────────────

/** `GET /api/imports` */
export async function listImports(
  ctx: ManagerContext,
  query: ImportQuery,
): Promise<ListImportsResponse> {
  const { items, total } = await listImportRecords(ctx.organisation.id, {
    statuses: query.status,
    page: query.page,
    pageSize: query.pageSize,
  });
  return {
    items: items.map((record) => toImportDto(record, fallbackFor(ctx))),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

/** `GET /api/imports/:id` */
export async function getImport(ctx: ManagerContext, importId: string): Promise<ImportResponse> {
  return importResponse(ctx, await requireImport(ctx, importId));
}

/** `GET /api/imports/:id/rows?status&page&pageSize` */
export async function listImportRowsPage(
  ctx: ManagerContext,
  importId: string,
  query: ImportRowsQuery,
): Promise<ListImportRowsResponse> {
  const record = await requireImport(ctx, importId);
  const { items, total } = await pageImportRows(record.id, {
    statuses: query.status,
    page: query.page,
    pageSize: query.pageSize,
  });
  const headers = readHeaders(record.headers);
  return {
    items: items.map((row) => toImportRowDto(row, headers)),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

// ── upload ──────────────────────────────────────────────────────────────────

/** `POST /api/imports` (multipart/form-data) → 201 `{ import, suggestion, sampleRows }`. */
export async function uploadImport(
  ctx: ManagerContext,
  req: Request,
): Promise<CreateImportResponse> {
  const organisationId = ctx.organisation.id;
  const upload = await readImportUpload(req);
  const location = upload.metadata.locationId
    ? await requireLocation(organisationId, upload.metadata.locationId)
    : null;
  const options: ImportOptionsStored = {
    dateFormat: upload.metadata.dateFormat ?? ctx.organisation.dateFormat,
    timezone: upload.metadata.timezone ?? location?.timezone ?? ctx.organisation.timezone,
    locationId: location?.id ?? null,
  };

  const detected = detectHeaders(upload.text);
  if (detected.headers.length === 0) {
    throw new AppError("INVALID_CSV", "The file is empty or is not a plain-text CSV.");
  }
  const parsed = parseCsv(upload.text, {
    delimiter: detected.delimiter,
    hasHeaderRow: detected.hasHeaderRow,
  });
  if (parsed.errors.length > 0) throw importFileErrorToAppError(parsed.errors);
  const suggestion = suggestionFor(parsed.headers);

  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.shiftImport.create({
      data: {
        organisationId,
        uploadedById: ctx.user.id,
        filename: upload.file.name,
        fileSizeBytes: upload.file.size,
        status: "UPLOADED",
        columnMapping: json(suggestion.mapping),
        options: json(options),
        headers: parsed.headers,
        rowCount: parsed.records.length,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    for (const chunk of chunks(parsed.records, ROW_CREATE_CHUNK)) {
      await tx.shiftImportRow.createMany({
        data: chunk.map((row) => ({
          importId: created.id,
          rowNumber: row.rowNumber,
          raw: row.values,
          status: "ERROR" as const,
          problems: toJsonValue(row.problems) ?? [],
        })),
      });
    }
    await audit(
      ctx,
      {
        action: "import.uploaded",
        entityType: "ShiftImport",
        entityId: created.id,
        after: {
          filename: created.filename,
          fileSizeBytes: created.fileSizeBytes,
          rowCount: created.rowCount,
          headers: parsed.headers,
          options,
          needsConfirmation: suggestion.needsConfirmation,
        },
      },
      tx,
    );
    return created;
  }, TRANSACTION_OPTIONS);

  return {
    import: toImportDto(record, fallbackFor(ctx)),
    suggestion,
    sampleRows: parsed.rows.slice(0, IMPORT_LIMITS.sampleRows),
  };
}

// ── mapping ─────────────────────────────────────────────────────────────────

/** `POST /api/imports/:id/mapping` → status MAPPED. */
export async function saveImportMapping(
  ctx: ManagerContext,
  importId: string,
  input: ImportMappingInput,
): Promise<ImportResponse> {
  const organisationId = ctx.organisation.id;
  const record = await requireImport(ctx, importId);
  assertImportStatus(
    record,
    ["UPLOADED", "MAPPED", "VALIDATED"],
    "The column mapping can no longer be changed for this import",
  );

  const headers = readHeaders(record.headers);
  const known = new Set(headers);
  const unknown = Object.keys(input.mapping).filter((header) => !known.has(header));
  if (unknown.length > 0) {
    throw new AppError("VALIDATION_ERROR", "The mapping names columns the file does not have", {
      details: {
        source: "body",
        formErrors: [],
        fieldErrors: { mapping: unknown.map((header) => `Unknown column "${header}"`) },
      },
    });
  }
  const mapping: ColumnMapping = {};
  for (const header of headers) {
    if (header.length > MAX_MAPPING_HEADER_LENGTH) continue;
    mapping[header] = input.mapping[header] ?? null;
  }
  const check = checkMapping(mapping);
  if (!check.complete) {
    throw new AppError(
      "IMPORT_MAPPING_INCOMPLETE",
      "Map a date, start time, end time and at least one employee identifier column",
      { details: check },
    );
  }

  const current = readOptions(record.options, fallbackFor(ctx));
  let locationId = current.locationId;
  if (input.options?.locationId !== undefined) {
    locationId =
      input.options.locationId === null
        ? null
        : (await requireLocation(organisationId, input.options.locationId)).id;
  }
  const options: ImportOptionsStored = {
    dateFormat: input.options?.dateFormat ?? current.dateFormat,
    timezone: input.options?.timezone ?? current.timezone,
    locationId,
  };

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.shiftImport.update({
      where: { id: record.id },
      data: {
        columnMapping: json(mapping),
        options: json(options),
        status: "MAPPED",
        validCount: 0,
        warningCount: 0,
        errorCount: 0,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    await audit(
      ctx,
      {
        action: "import.mapped",
        entityType: "ShiftImport",
        entityId: record.id,
        before: { columnMapping: readMapping(record.columnMapping), options: current },
        after: { columnMapping: mapping, options },
      },
      tx,
    );
    return row;
  });
  return importResponse(ctx, updated);
}

// ── validation ──────────────────────────────────────────────────────────────

interface ValidationRun {
  /** Resolutions to apply instead of the stored ones (row id → resolution), e.g. the fix being made. */
  overrides?: ReadonlyMap<string, RowResolution>;
  /** Audit entry written in the same transaction as the row results. */
  auditEntry: Pick<AuditEntry, "action" | "before" | "after">;
}

/**
 * Normalises, matches and validates every stored row against the import's mapping and options, applies
 * the manager's resolutions and persists the outcome. Idempotent: running it twice yields the same rows.
 */
async function runValidation(
  ctx: ManagerContext,
  record: ImportRecord,
  run: ValidationRun,
): Promise<ImportRecord> {
  const organisationId = ctx.organisation.id;
  const now = new Date();
  const mapping = readMapping(record.columnMapping);
  const check = checkMapping(mapping);
  if (!check.complete) {
    throw new AppError(
      "IMPORT_MAPPING_INCOMPLETE",
      "Map a date, start time, end time and at least one employee identifier column",
      { details: check },
    );
  }
  const options = readOptions(record.options, fallbackFor(ctx));
  const defaultLocation = options.locationId
    ? await findLocation(organisationId, options.locationId)
    : null;

  const stored = await listImportRows(record.id);
  const resolutions = stored.map(
    (row) => run.overrides?.get(row.id) ?? readResolution(readParsed(row.parsed)),
  );
  // Structural problems found while parsing the file (extra cells) are the only ones kept from before.
  const csvRows: CsvRow[] = stored.map((row) => ({
    rowNumber: row.rowNumber,
    values: readRaw(row.raw),
    problems: readProblems(row.problems).filter((p) => p.code === "INVALID_CSV"),
  }));

  const normalised = normaliseRows(csvRows, mapping, {
    dateFormat: options.dateFormat,
    timezone: options.timezone,
    defaultLocationName: defaultLocation?.name ?? null,
  });
  normalised.forEach((row, index) => {
    if (resolutions[index]?.ignoreLocation) delete row.parsed.locationName;
  });

  const candidates = await listEmployeeCandidates(organisationId);
  const candidateIds = new Set(candidates.map((c) => c.id));
  const matched: NormalisedRow[] = matchRows(normalised, candidates).map((row, index) => {
    const pinned = resolutions[index]?.employeeId;
    if (pinned === undefined) return row;
    const problems = row.problems.filter((p) => !MATCH_PROBLEM_CODES.has(p.code));
    if (candidateIds.has(pinned)) return { ...row, employeeId: pinned, problems };
    return {
      ...row,
      employeeId: null,
      problems: [
        ...problems,
        createImportProblem(
          "EMPLOYEE_NOT_FOUND",
          "The employee chosen for this row is no longer active; pick another employee.",
          { field: "employee_name", details: { pinnedEmployeeId: pinned } },
        ),
      ],
    };
  });

  // Skipped rows are not imported, so they take no part in overlap / duplicate checks either.
  const forValidation = matched.map((row, index) =>
    resolutions[index]?.skipped ? { ...row, employeeId: null } : row,
  );
  const window = importShiftWindow(forValidation);
  const existingShifts = window
    ? await listExistingShifts(
        organisationId,
        window.employeeIds,
        new Date(window.from),
        new Date(window.to),
      )
    : [];
  const locations = await listLocations(organisationId);
  const validated = validateRows(forValidation, {
    existingShifts,
    knownLocations: locations.map((l) => l.name),
    minShiftMinutes: SHIFT_LIMITS.minDurationMinutes,
    maxShiftMinutes: SHIFT_LIMITS.maxDurationMinutes,
    now,
  });
  const final: ValidatedRow[] = validated.map((row, index) =>
    resolutions[index]?.skipped
      ? { ...row, employeeId: matched[index]?.employeeId ?? null, status: "SKIPPED" }
      : row,
  );
  const summary = summarise(final);

  return prisma.$transaction(async (tx) => {
    const writes = final.map((row, index) => ({
      row,
      id: stored[index]!.id,
      resolution: resolutions[index] ?? {},
    }));
    for (const chunk of chunks(writes, ROW_WRITE_CHUNK)) {
      await Promise.all(
        chunk.map(({ row, id, resolution }) => {
          const parsed: StoredParsedRow =
            Object.keys(resolution).length > 0 ? { ...row.parsed, resolution } : { ...row.parsed };
          return tx.shiftImportRow.update({
            where: { id },
            data: {
              parsed: json(parsed),
              problems: toJsonValue(row.problems) ?? [],
              status: row.status,
              matchedEmployeeId: row.employeeId ?? null,
            },
          });
        }),
      );
    }
    const updated = await tx.shiftImport.update({
      where: { id: record.id },
      data: {
        status: "VALIDATED",
        rowCount: final.length,
        validCount: summary.valid,
        warningCount: summary.warning,
        errorCount: summary.error,
        importedCount: 0,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    await audit(
      ctx,
      {
        action: run.auditEntry.action,
        entityType: "ShiftImport",
        entityId: record.id,
        ...(run.auditEntry.before !== undefined ? { before: run.auditEntry.before } : {}),
        after: {
          ...(typeof run.auditEntry.after === "object" && run.auditEntry.after !== null
            ? (run.auditEntry.after as Record<string, unknown>)
            : {}),
          summary: {
            total: summary.total,
            valid: summary.valid,
            warning: summary.warning,
            error: summary.error,
            skipped: summary.skipped,
            problemCounts: summary.problemCounts,
          },
        },
      },
      tx,
    );
    return updated;
  }, TRANSACTION_OPTIONS);
}

/** `POST /api/imports/:id/validate` → status VALIDATED. Re-runnable. */
export async function validateImport(
  ctx: ManagerContext,
  importId: string,
): Promise<ValidateImportResponse> {
  const record = await requireImport(ctx, importId);
  if (record.status === "UPLOADED") {
    throw new AppError(
      "IMPORT_MAPPING_INCOMPLETE",
      "Confirm the column mapping before validating",
      {
        details: { ...checkMapping(readMapping(record.columnMapping)), confirmed: false },
      },
    );
  }
  assertImportStatus(record, ["MAPPED", "VALIDATED"], "This import has already been committed");
  const updated = await runValidation(ctx, record, { auditEntry: { action: "import.validated" } });
  return { import: toImportDto(updated, fallbackFor(ctx)), summary: toSummary(updated) };
}

// ── row fixes ───────────────────────────────────────────────────────────────

function describeResolutionInput(input: UpdateImportRowInput): Record<string, unknown> {
  if ("matchedEmployeeId" in input) return { matchedEmployeeId: input.matchedEmployeeId };
  if ("createEmployee" in input) {
    return { createEmployee: { hasEmail: input.createEmployee.email !== undefined } };
  }
  if ("skip" in input) return { skip: input.skip };
  return { locationAction: input.locationAction };
}

/**
 * `PATCH /api/imports/:id/rows/:rowId` — applies one fix (pin / clear the employee, create an employee,
 * skip / un-skip, create or ignore an unknown location) and re-validates the whole import so the row and
 * every row it interacts with (overlaps, duplicates) are current.
 */
export async function updateImportRow(
  ctx: ManagerContext,
  importId: string,
  rowId: string,
  input: UpdateImportRowInput,
): Promise<ImportRowResponse> {
  const organisationId = ctx.organisation.id;
  const record = await requireImport(ctx, importId);
  assertImportStatus(record, ["VALIDATED"], "Validate the import before resolving rows");
  const row = await findImportRow(record.id, rowId);
  if (!row) throw new AppError("NOT_FOUND", "Import row not found");
  const parsed = readParsed(row.parsed);
  const resolution = readResolution(parsed);
  const extra: Record<string, unknown> = {};

  if ("matchedEmployeeId" in input) {
    if (input.matchedEmployeeId === null) {
      delete resolution.employeeId;
    } else {
      const employee = await findActiveEmployee(organisationId, input.matchedEmployeeId);
      if (!employee) throw new AppError("EMPLOYEE_NOT_FOUND", "Employee not found");
      resolution.employeeId = employee.id;
    }
  } else if ("createEmployee" in input) {
    // Creating people is an employees:write action even when done from the import wizard.
    requirePermission(ctx, "employees:write");
    const details = input.createEmployee;
    const employeeInput: CreateEmployeeInput = {
      firstName: details.firstName,
      lastName: details.lastName,
      ...(details.email !== undefined ? { email: details.email } : {}),
      ...(details.externalEmployeeId !== undefined
        ? { externalEmployeeId: details.externalEmployeeId }
        : {}),
      ...(details.jobTitle !== undefined ? { jobTitle: details.jobTitle } : {}),
      ...(details.primaryLocationId !== undefined
        ? { primaryLocationId: details.primaryLocationId }
        : {}),
    };
    const employee = await createEmployee(ctx, employeeInput);
    resolution.employeeId = employee.id;
    resolution.createdEmployeeId = employee.id;
    extra.createdEmployeeId = employee.id;
  } else if ("skip" in input) {
    if (input.skip) resolution.skipped = true;
    else delete resolution.skipped;
  } else {
    const name = parsed?.locationName;
    if (name === undefined) {
      throw new AppError("VALIDATION_ERROR", "This row has no location to resolve", {
        details: {
          source: "body",
          formErrors: ["This row has no location value"],
          fieldErrors: {},
        },
      });
    }
    if (input.locationAction === "CREATE") {
      const existing = (await listLocations(organisationId)).find(
        (l) => locationKey(l.name) === locationKey(name),
      );
      if (existing) {
        extra.locationId = existing.id;
      } else {
        const created = await prisma.$transaction(async (tx) => {
          const location = await tx.location.create({ data: { organisationId, name } });
          await audit(
            ctx,
            {
              action: "location.created",
              entityType: "Location",
              entityId: location.id,
              after: { name: location.name, createdFromImportId: record.id },
            },
            tx,
          );
          return location;
        });
        extra.locationId = created.id;
        extra.locationCreated = true;
      }
      delete resolution.ignoreLocation;
    } else {
      resolution.ignoreLocation = true;
    }
  }

  const updated = await runValidation(ctx, record, {
    overrides: new Map([[row.id, resolution]]),
    auditEntry: {
      action: "import.row_resolved",
      before: { rowNumber: row.rowNumber, status: row.status, resolution: readResolution(parsed) },
      after: {
        rowNumber: row.rowNumber,
        input: describeResolutionInput(input),
        resolution,
        ...extra,
      },
    },
  });
  const fresh = await findImportRow(record.id, row.id);
  if (!fresh) throw new AppError("NOT_FOUND", "Import row not found");
  return { row: toImportRowDto(fresh, readHeaders(record.headers)), summary: toSummary(updated) };
}

// ── commit ──────────────────────────────────────────────────────────────────

/**
 * Closes an import whose commit transaction failed. Nothing of the commit was written (it rolled back),
 * so the rows keep their validated statuses; the status alone tells the wizard to start over. Never
 * throws — the original error is what the caller reports.
 */
async function markImportFailed(
  ctx: ManagerContext,
  record: ImportRecord,
  err: unknown,
): Promise<void> {
  const code = err instanceof AppError ? err.code : "INTERNAL_ERROR";
  try {
    await prisma.$transaction(async (tx) => {
      const result = await tx.shiftImport.updateMany({
        where: { id: record.id, organisationId: ctx.organisation.id, status: "VALIDATED" },
        data: { status: "FAILED" },
      });
      if (result.count === 0) return;
      await audit(
        ctx,
        {
          action: "import.failed",
          entityType: "ShiftImport",
          entityId: record.id,
          before: { status: record.status },
          after: { status: "FAILED", code },
        },
        tx,
      );
    });
  } catch (markErr) {
    logger.error(
      { error: errorSummary(markErr), stack: stackFrames(markErr), importId: record.id },
      "could not mark a failed import",
    );
  }
}

interface ShiftPlan {
  row: ImportRowRecord;
  employeeId: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  locationId: string | null;
  breaks: Array<{ offsetMinutesFromStart: number; durationMinutes: number }>;
}

/**
 * `POST /api/imports/:id/commit` → creates the shifts. ERROR rows block the commit (IMPORT_HAS_ERRORS)
 * unless `skipErrors`; WARNING rows are imported unless `includeWarnings` is false.
 */
export async function commitImport(
  ctx: ManagerContext,
  importId: string,
  input: CommitImportInput,
): Promise<CommitImportResponse> {
  const organisationId = ctx.organisation.id;
  const now = new Date();
  const record = await requireImport(ctx, importId);
  assertImportStatus(record, ["VALIDATED"], "Validate the import before committing it");

  const rows = await listImportRows(record.id);
  const errorRows = rows.filter((r) => r.status === "ERROR");
  if (errorRows.length > 0 && !input.skipErrors) {
    throw new AppError(
      "IMPORT_HAS_ERRORS",
      `${errorRows.length} row${errorRows.length === 1 ? "" : "s"} still ${errorRows.length === 1 ? "has" : "have"} errors; fix or skip them, or commit with skipErrors`,
      { details: { errorCount: errorRows.length } },
    );
  }
  const toImport = rows.filter(
    (r) => r.status === "VALID" || (r.status === "WARNING" && input.includeWarnings),
  );
  const toSkip = rows.filter((r) => r.status === "WARNING" && !input.includeWarnings);
  if (toImport.length === 0) {
    throw new AppError("IMPORT_INVALID_STATE", "There are no rows to import", {
      details: { status: record.status, reason: "NOTHING_TO_IMPORT" },
    });
  }

  const locationIdByKey = new Map(
    (await listLocations(organisationId)).map((l) => [locationKey(l.name), l.id]),
  );
  const plans: ShiftPlan[] = toImport.map((row) => {
    const parsed = readParsed(row.parsed);
    if (!parsed?.startsAt || !parsed.endsAt || !row.matchedEmployeeId) {
      throw new AppError(
        "IMPORT_INVALID_STATE",
        "A row is no longer ready; validate the import again",
        {
          details: { status: record.status, rowNumber: row.rowNumber },
        },
      );
    }
    const startsAt = new Date(parsed.startsAt);
    const endsAt = new Date(parsed.endsAt);
    const resolution = readResolution(parsed);
    const locationId =
      parsed.locationName !== undefined && !resolution.ignoreLocation
        ? (locationIdByKey.get(locationKey(parsed.locationName)) ?? null)
        : null;
    const brk = centredBreak(minutesBetween(startsAt, endsAt), parsed.breakMinutes);
    return {
      row,
      employeeId: row.matchedEmployeeId,
      startsAt,
      endsAt,
      timezone: parsed.timezone,
      locationId,
      breaks: brk ? [brk] : [],
    };
  });
  // Matching ran against ACTIVE employees at validation time; someone deactivated since must not get shifts.
  const activeIds = await listActiveEmployeeIds(organisationId, [
    ...new Set(plans.map((p) => p.employeeId)),
  ]);
  const notActive = plans.filter((p) => !activeIds.has(p.employeeId));
  if (notActive.length > 0) {
    throw new AppError(
      "IMPORT_INVALID_STATE",
      "An employee in this import is no longer active; validate the import again",
      {
        details: {
          status: record.status,
          reason: "EMPLOYEE_NOT_ACTIVE",
          rowNumbers: notActive.map((p) => p.row.rowNumber),
        },
      },
    );
  }
  const employeesCreated = new Set(
    rows
      .map((r) => readResolution(readParsed(r.parsed)).createdEmployeeId)
      .filter((id) => id !== undefined),
  ).size;

  const { created, updated, event } = await prisma
    .$transaction(async (tx) => {
      const created: Array<{ id: string; employeeId: string }> = [];
      for (const chunk of chunks(plans, SHIFT_CREATE_CHUNK)) {
        const shifts = await Promise.all(
          chunk.map((plan) =>
            tx.shift.create({
              data: {
                organisationId,
                employeeId: plan.employeeId,
                locationId: plan.locationId,
                startsAt: plan.startsAt,
                endsAt: plan.endsAt,
                timezone: plan.timezone,
                status: "SCHEDULED",
                source: "CSV_IMPORT",
                scheduledBreaks: { create: plan.breaks },
              },
              select: { id: true, employeeId: true },
            }),
          ),
        );
        await Promise.all(
          chunk.map((plan, i) =>
            tx.shiftImportRow.update({
              where: { id: plan.row.id },
              data: { status: "IMPORTED", createdShiftId: shifts[i]!.id },
            }),
          ),
        );
        created.push(...shifts);
      }
      if (toSkip.length > 0) {
        await tx.shiftImportRow.updateMany({
          where: { id: { in: toSkip.map((r) => r.id) } },
          data: { status: "SKIPPED" },
        });
      }
      const updated = await tx.shiftImport.update({
        where: { id: record.id },
        data: {
          status: "IMPORTED",
          importedAt: now,
          importedCount: created.length,
          validCount: 0,
          warningCount: 0,
          errorCount: errorRows.length,
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });
      const skippedTotal = rows.length - created.length - errorRows.length;
      const { event } = await recordActivity(
        {
          organisationId,
          actorType: "MANAGER",
          actorUserId: ctx.user.id,
          type: "IMPORT_COMPLETED",
          occurredAt: now,
          metadata: {
            importId: record.id,
            shiftsCreated: created.length,
            rowsSkipped: skippedTotal,
            rowsWithErrors: errorRows.length,
            employeesCreated,
            employeeCount: new Set(created.map((c) => c.employeeId)).size,
          },
        },
        { db: tx, publish: false },
      );
      await audit(
        ctx,
        {
          action: "import.committed",
          entityType: "ShiftImport",
          entityId: record.id,
          after: {
            shiftsCreated: created.length,
            rowsSkipped: skippedTotal,
            rowsWithErrors: errorRows.length,
            employeesCreated,
            includeWarnings: input.includeWarnings,
            skipErrors: input.skipErrors,
            shiftIds: created.map((c) => c.id),
          },
        },
        tx,
      );
      return { created, updated, event: event as ActivityEvent };
    }, TRANSACTION_OPTIONS)
    .catch(async (err: unknown) => {
      // The transaction rolled back, so no shift exists; close the import rather than leave it VALIDATED.
      await markImportFailed(ctx, record, err);
      throw err;
    });

  publishActivity(event);
  publishScheduleChangedForShifts(organisationId, created, "IMPORTED");
  publishEvent({
    type: "import.completed",
    organisationId,
    payload: { importId: record.id, shiftsCreated: created.length },
  });
  return {
    import: toImportDto(updated, fallbackFor(ctx)),
    shiftsCreated: created.length,
    employeesCreated,
    rowsSkipped: rows.length - created.length - errorRows.length,
  };
}

// ── errors CSV ──────────────────────────────────────────────────────────────

function attachmentName(filename: string): string {
  const base = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base === "" ? "import" : base}-errors.csv`;
}

/** `GET /api/imports/:id/errors.csv` → every row with at least one problem, as a CSV attachment. */
export async function exportImportErrorsCsv(
  ctx: ManagerContext,
  importId: string,
): Promise<Response> {
  const record = await requireImport(ctx, importId);
  const options = readOptions(record.options, fallbackFor(ctx));
  const headers = readHeaders(record.headers);
  const rows = await listImportRows(record.id);
  const problemRows: ValidatedRow[] = rows.flatMap((row) => {
    const problems = readProblems(row.problems);
    if (problems.length === 0) return [];
    const parsed = readParsed(row.parsed);
    return [
      {
        rowNumber: row.rowNumber,
        raw: readRaw(row.raw, headers),
        parsed: parsed ? stripResolution(parsed) : { timezone: options.timezone, overnight: false },
        problems,
        employeeId: row.matchedEmployeeId,
        // IMPORTED rows with warnings are listed under their final status; the CSV prints it verbatim.
        status: row.status as ImportRowStatus,
      },
    ];
  });
  const csv = toErrorsCsv(problemRows);
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${attachmentName(record.filename)}"`,
      "cache-control": "no-store",
    },
  });
}
