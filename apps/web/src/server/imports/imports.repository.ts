import {
  prisma,
  type Prisma,
  type ShiftImportRowStatus,
  type ShiftImportStatus,
} from "@workmode/db";
import type { EmployeeCandidate, ImportExistingShift } from "@workmode/shared/csv/csvImport";
import {
  importInclude,
  importRowInclude,
  type ImportRecord,
  type ImportRowRecord,
} from "./imports.mappers";

/**
 * CSV import queries. Every function takes the `organisationId` explicitly (from the verified membership);
 * rows are reached only through their import, which is itself organisation-scoped.
 */

export type Db = Prisma.TransactionClient | typeof prisma;

export async function findImport(
  organisationId: string,
  importId: string,
  db: Db = prisma,
): Promise<ImportRecord | null> {
  return db.shiftImport.findFirst({
    where: { id: importId, organisationId },
    include: importInclude,
  });
}

export interface ListImportsFilter {
  statuses?: readonly ShiftImportStatus[] | undefined;
  page: number;
  pageSize: number;
}

export async function listImports(
  organisationId: string,
  filter: ListImportsFilter,
  db: Db = prisma,
): Promise<{ items: ImportRecord[]; total: number }> {
  const where: Prisma.ShiftImportWhereInput = {
    organisationId,
    ...(filter.statuses && filter.statuses.length > 0
      ? { status: { in: [...filter.statuses] } }
      : {}),
  };
  const [items, total] = await Promise.all([
    db.shiftImport.findMany({
      where,
      include: importInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    db.shiftImport.count({ where }),
  ]);
  return { items, total };
}

export async function findLocation(organisationId: string, locationId: string, db: Db = prisma) {
  return db.location.findFirst({
    where: { id: locationId, organisationId, deletedAt: null },
    select: { id: true, name: true, timezone: true },
  });
}

export async function listLocations(organisationId: string, db: Db = prisma) {
  return db.location.findMany({
    where: { organisationId, deletedAt: null },
    select: { id: true, name: true, timezone: true },
    orderBy: { name: "asc" },
  });
}

/** ACTIVE, non-deleted employees as `matchEmployee` candidates. */
export async function listEmployeeCandidates(
  organisationId: string,
  db: Db = prisma,
): Promise<Array<EmployeeCandidate & { id: string }>> {
  return db.employee.findMany({
    where: { organisationId, deletedAt: null, employmentStatus: "ACTIVE" },
    select: { id: true, firstName: true, lastName: true, email: true, externalEmployeeId: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function findActiveEmployee(
  organisationId: string,
  employeeId: string,
  db: Db = prisma,
) {
  return db.employee.findFirst({
    where: { id: employeeId, organisationId, deletedAt: null, employmentStatus: "ACTIVE" },
    select: { id: true, firstName: true, lastName: true },
  });
}

/** The ids among `employeeIds` that are ACTIVE and not deleted (commit re-checks the matched employees). */
export async function listActiveEmployeeIds(
  organisationId: string,
  employeeIds: readonly string[],
  db: Db = prisma,
): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const rows = await db.employee.findMany({
    where: {
      organisationId,
      id: { in: [...employeeIds] },
      deletedAt: null,
      employmentStatus: "ACTIVE",
    },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/** Every row of an import in spreadsheet order. */
export async function listImportRows(
  importId: string,
  db: Db = prisma,
): Promise<ImportRowRecord[]> {
  return db.shiftImportRow.findMany({
    where: { importId },
    include: importRowInclude,
    orderBy: { rowNumber: "asc" },
  });
}

export interface PageImportRowsFilter {
  statuses?: readonly ShiftImportRowStatus[] | undefined;
  page: number;
  pageSize: number;
}

export async function pageImportRows(
  importId: string,
  filter: PageImportRowsFilter,
  db: Db = prisma,
): Promise<{ items: ImportRowRecord[]; total: number }> {
  const where: Prisma.ShiftImportRowWhereInput = {
    importId,
    ...(filter.statuses && filter.statuses.length > 0
      ? { status: { in: [...filter.statuses] } }
      : {}),
  };
  const [items, total] = await Promise.all([
    db.shiftImportRow.findMany({
      where,
      include: importRowInclude,
      orderBy: { rowNumber: "asc" },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    db.shiftImportRow.count({ where }),
  ]);
  return { items, total };
}

export async function findImportRow(
  importId: string,
  rowId: string,
  db: Db = prisma,
): Promise<ImportRowRecord | null> {
  return db.shiftImportRow.findFirst({ where: { id: rowId, importId }, include: importRowInclude });
}

/**
 * Live shifts (not cancelled, not soft-deleted) of `employeeIds` overlapping `[from, to)` — what
 * `validateRows` compares the file against for duplicates and overlaps.
 */
export async function listExistingShifts(
  organisationId: string,
  employeeIds: readonly string[],
  from: Date,
  to: Date,
  db: Db = prisma,
): Promise<Array<ImportExistingShift & { id: string }>> {
  if (employeeIds.length === 0) return [];
  return db.shift.findMany({
    where: {
      organisationId,
      employeeId: { in: [...employeeIds] },
      deletedAt: null,
      status: { not: "CANCELLED" },
      startsAt: { lt: to },
      endsAt: { gt: from },
    },
    select: { id: true, employeeId: true, startsAt: true, endsAt: true },
  });
}
