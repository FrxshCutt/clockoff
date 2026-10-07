import { randomUUID } from "node:crypto";
import { prisma } from "@clockoff/db";
import {
  commitImportResponseSchema,
  createImportResponseSchema,
  importResponseSchema,
  importRowResponseSchema,
  listImportRowsResponseSchema,
  listImportsResponseSchema,
  validateImportResponseSchema,
  type CommitImportResponse,
  type CreateImportResponse,
  type ImportResponse,
  type ImportRow,
  type ImportRowResponse,
  type ListImportRowsResponse,
  type ListImportsResponse,
  type ValidateImportResponse,
} from "@clockoff/validation/imports";
import { describe, expect, it, vi } from "vitest";
import { POST as commitRoute } from "@/app/api/imports/[id]/commit/route";
import { GET as errorsCsvRoute } from "@/app/api/imports/[id]/errors.csv/route";
import { POST as mappingRoute } from "@/app/api/imports/[id]/mapping/route";
import { GET as getImportRoute } from "@/app/api/imports/[id]/route";
import { PATCH as patchRowRoute } from "@/app/api/imports/[id]/rows/[rowId]/route";
import { GET as listRowsRoute } from "@/app/api/imports/[id]/rows/route";
import { POST as validateRoute } from "@/app/api/imports/[id]/validate/route";
import { GET as listImportsRoute, POST as uploadRoute } from "@/app/api/imports/route";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import {
  callRoute,
  createTestOrg,
  loginAs,
  type CookieJar,
  type ErrorBody,
  type TestOrg,
} from "../helpers";

/**
 * Test seam (this file only): when `failAuditAction` names an audit action, writing that entry throws —
 * used to make the commit transaction fail from the inside so the real rollback path runs. Pass-through
 * when unset.
 */
const seam = vi.hoisted(() => ({ failAuditAction: null as string | null }));
vi.mock("@/server/audit/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/audit/audit")>();
  return {
    ...actual,
    audit: async (...args: Parameters<typeof actual.audit>) => {
      if (seam.failAuditAction !== null && args[1].action === seam.failAuditAction) {
        throw new Error(`simulated failure writing ${args[1].action}`);
      }
      return actual.audit(...args);
    },
  };
});

/**
 * CSV import wizard end to end: upload → mapping → validate → fix rows → commit → errors.csv, plus the
 * upload limits. Dates are in 2027 so no row is "in the past"; the organisation is Europe/London / DMY.
 */

interface FilePart {
  name: string;
  filename: string;
  type: string;
  content: string;
}
interface FieldPart {
  name: string;
  value: string;
}

/** Builds a multipart/form-data body by hand (the harness sends string bodies verbatim). */
function multipart(parts: ReadonlyArray<FilePart | FieldPart>): {
  body: string;
  contentType: string;
} {
  const boundary = `----clockoff${randomUUID().replace(/-/g, "")}`;
  let body = "";
  for (const part of parts) {
    body += `--${boundary}\r\n`;
    if ("filename" in part) {
      body += `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`;
      if (part.type !== "") body += `Content-Type: ${part.type}\r\n`;
      body += `\r\n${part.content}\r\n`;
    } else {
      body += `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`;
    }
  }
  body += `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

interface UploadOptions {
  filename?: string;
  type?: string;
  fields?: Record<string, string>;
}

async function upload(jar: CookieJar, csv: string, options: UploadOptions = {}) {
  const parts: Array<FilePart | FieldPart> = Object.entries(options.fields ?? {}).map(
    ([name, value]) => ({
      name,
      value,
    }),
  );
  parts.push({
    name: "file",
    filename: options.filename ?? "rota.csv",
    type: options.type ?? "text/csv",
    content: csv,
  });
  const { body, contentType } = multipart(parts);
  return callRoute<CreateImportResponse & ErrorBody>(uploadRoute, {
    method: "POST",
    path: "/api/imports",
    jar,
    body,
    headers: { "content-type": contentType },
  });
}

async function uploadOk(jar: CookieJar, csv: string, options: UploadOptions = {}) {
  const res = await upload(jar, csv, options);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(() => createImportResponseSchema.parse(res.body)).not.toThrow();
  return res.body;
}

async function saveMapping(jar: CookieJar, id: string, body: unknown, expectStatus = 200) {
  const res = await callRoute<ImportResponse & ErrorBody>(mappingRoute, {
    method: "POST",
    path: `/api/imports/${id}/mapping`,
    params: { id },
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
  return res.body;
}

async function validate(jar: CookieJar, id: string, expectStatus = 200) {
  const res = await callRoute<ValidateImportResponse & ErrorBody>(validateRoute, {
    method: "POST",
    path: `/api/imports/${id}/validate`,
    params: { id },
    jar,
    body: {},
  });
  expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
  return res.body;
}

async function listRows(jar: CookieJar, id: string, query: Record<string, string | number> = {}) {
  const res = await callRoute<ListImportRowsResponse>(listRowsRoute, {
    path: `/api/imports/${id}/rows`,
    params: { id },
    query,
    jar,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(() => listImportRowsResponseSchema.parse(res.body)).not.toThrow();
  return res.body;
}

async function patchRow(
  jar: CookieJar,
  id: string,
  rowId: string,
  body: unknown,
  expectStatus = 200,
) {
  const res = await callRoute<ImportRowResponse & ErrorBody>(patchRowRoute, {
    method: "PATCH",
    path: `/api/imports/${id}/rows/${rowId}`,
    params: { id, rowId },
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
  return res.body;
}

async function commit(jar: CookieJar, id: string, body: unknown = {}, expectStatus = 200) {
  const res = await callRoute<CommitImportResponse & ErrorBody>(commitRoute, {
    method: "POST",
    path: `/api/imports/${id}/commit`,
    params: { id },
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
  return res.body;
}

function rowByNumber(rows: readonly ImportRow[], rowNumber: number): ImportRow {
  const row = rows.find((r) => r.rowNumber === rowNumber);
  if (!row) throw new Error(`row ${rowNumber} missing`);
  return row;
}

function codes(row: ImportRow): string[] {
  return row.problems.map((p) => p.code);
}

function collectEvents(organisationId: string, type: string) {
  const seen: RealtimeEvent[] = [];
  const unsubscribe = getEventBus().subscribe(organisationId, (e) => {
    if (e.type === type) seen.push(e);
  });
  return { seen, unsubscribe };
}

async function setup() {
  const org = await createTestOrg({ firstLocationName: "High Street", timezone: "Europe/London" });
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  const organisationId = org.organisation.id;
  const jane = await prisma.employee.create({
    data: {
      organisationId,
      firstName: "Jane",
      lastName: "Smith",
      externalEmployeeId: "E1042",
      email: "jane.smith@example.test",
    },
  });
  const john = await prisma.employee.create({
    data: { organisationId, firstName: "John", lastName: "Smith", externalEmployeeId: "E1043" },
  });
  const otherJohn = await prisma.employee.create({
    data: { organisationId, firstName: "John", lastName: "Smith", externalEmployeeId: "E1099" },
  });
  const amira = await prisma.employee.create({
    data: {
      organisationId,
      firstName: "Amira",
      lastName: "Khan",
      email: "amira.khan@example.test",
    },
  });
  return { org, jar, jane, john, otherJohn, amira };
}

/** Excel-style export: UTF-8 BOM, semicolons, CRLF. Row numbers are spreadsheet rows (header = 1). */
const ROTA_CSV =
  "﻿" +
  [
    "Staff;Payroll Number;Email;Date;Shift Start;Finish;Site;Break (mins)",
    "Jane Smith;E1042;;01/03/2027;09:00;17:00;High Street;30", // row 2: overlaps row 6
    "John Smith;;;01/03/2027;2pm;10pm;High Street;", // row 3: two John Smiths
    "Sam Lee;;;01/03/2027;09:00;17:00;High Street;", // row 4: not an employee
    ";;amira.khan@example.test;01/03/2027;22:00;06:00;Station Road;45", // row 5: overnight, unknown location
    "Jane Smith;E1042;;01/03/2027;16:00;20:00;High Street;", // row 6: overlaps row 2
  ].join("\r\n") +
  "\r\n";

describe("CSV import wizard", () => {
  it("runs end to end: upload, map, validate, fix rows, commit, errors.csv", async () => {
    const { org, jar, jane, john, amira } = await setup();
    const organisationId = org.organisation.id;

    // 1. Upload
    const uploaded = await uploadOk(jar, ROTA_CSV);
    const importId = uploaded.import.id;
    expect(uploaded.import.status).toBe("UPLOADED");
    expect(uploaded.import.rowCount).toBe(5);
    expect(uploaded.import.filename).toBe("rota.csv");
    expect(uploaded.import.headers).toEqual([
      "Staff",
      "Payroll Number",
      "Email",
      "Date",
      "Shift Start",
      "Finish",
      "Site",
      "Break (mins)",
    ]);
    expect(uploaded.import.options).toEqual({
      dateFormat: "DMY",
      timezone: "Europe/London",
      locationId: null,
    });
    expect(uploaded.import.uploadedBy?.id).toBe(org.owner.id);
    expect(uploaded.suggestion.mapping).toEqual({
      Staff: "employee_name",
      "Payroll Number": "employee_id",
      Email: "email",
      Date: "date",
      "Shift Start": "start_time",
      Finish: "end_time",
      Site: "location",
      "Break (mins)": "break_minutes",
    });
    expect(uploaded.suggestion.needsConfirmation).toEqual([]);
    expect(uploaded.sampleRows).toHaveLength(5);
    expect(uploaded.sampleRows[0]).toMatchObject({
      Staff: "Jane Smith",
      "Payroll Number": "E1042",
    });
    expect(uploaded.import.columnMapping).toEqual(uploaded.suggestion.mapping);
    expect(
      await prisma.auditLog.count({
        where: { organisationId, action: "import.uploaded", entityId: importId },
      }),
    ).toBe(1);

    // Rows exist as ERROR placeholders until validated.
    const placeholders = await listRows(jar, importId);
    expect(placeholders.total).toBe(5);
    expect(placeholders.items.every((r) => r.status === "ERROR" && r.parsed === null)).toBe(true);

    // GET repeats the suggestion while the import is open; the list contains it.
    const got = await callRoute<ImportResponse>(getImportRoute, {
      path: `/api/imports/${importId}`,
      params: { id: importId },
      jar,
    });
    expect(got.status).toBe(200);
    expect(() => importResponseSchema.parse(got.body)).not.toThrow();
    expect(got.body.suggestion?.mapping.Staff).toBe("employee_name");
    const list = await callRoute<ListImportsResponse>(listImportsRoute, {
      path: "/api/imports",
      jar,
    });
    expect(list.status).toBe(200);
    expect(() => listImportsResponseSchema.parse(list.body)).not.toThrow();
    expect(list.body.items.map((i) => i.id)).toContain(importId);
    expect(list.body.total).toBe(1);

    // 2. Mapping: validating first is refused; incomplete / unknown mappings are refused.
    const tooEarly = await validate(jar, importId, 400);
    expect(tooEarly.error.code).toBe("IMPORT_MAPPING_INCOMPLETE");
    const incomplete = await saveMapping(
      jar,
      importId,
      { mapping: { Staff: "employee_name" } },
      400,
    );
    expect(incomplete.error.code).toBe("IMPORT_MAPPING_INCOMPLETE");
    expect((incomplete.error.details as { missingRequired: string[] }).missingRequired).toEqual([
      "date",
      "start_time",
      "end_time",
    ]);
    const unknown = await saveMapping(
      jar,
      importId,
      { mapping: { ...uploaded.suggestion.mapping, Nope: "role" } },
      400,
    );
    expect(unknown.error.code).toBe("VALIDATION_ERROR");
    const mapped = await saveMapping(jar, importId, { mapping: uploaded.suggestion.mapping });
    expect(mapped.import.status).toBe("MAPPED");
    expect(mapped.suggestion).toBeDefined();

    // 3. Validate
    const validated = await validate(jar, importId);
    expect(() => validateImportResponseSchema.parse(validated)).not.toThrow();
    expect(validated.import.status).toBe("VALIDATED");
    expect(validated.summary).toEqual({
      total: 5,
      valid: 0,
      warning: 1,
      error: 4,
      skipped: 0,
      imported: 0,
      readyToCommit: false,
    });
    expect(validated.import.skippedCount).toBe(0);

    const all = await listRows(jar, importId, { pageSize: 50 });
    expect(all.items.map((r) => r.rowNumber)).toEqual([2, 3, 4, 5, 6]);
    const row2 = rowByNumber(all.items, 2);
    expect(row2.status).toBe("ERROR");
    expect(codes(row2)).toEqual(["OVERLAPPING_SHIFT"]);
    expect(row2.matchedEmployee?.id).toBe(jane.id);
    expect(row2.parsed).toMatchObject({
      date: "2027-03-01",
      startTime: "09:00",
      endTime: "17:00",
      startsAt: "2027-03-01T09:00:00.000Z",
      endsAt: "2027-03-01T17:00:00.000Z",
      timezone: "Europe/London",
      overnight: false,
      locationName: "High Street",
      breakMinutes: 30,
    });
    expect(row2.parsed).not.toHaveProperty("resolution");
    const row3 = rowByNumber(all.items, 3);
    expect(codes(row3)).toEqual(["MULTIPLE_MATCHES"]);
    expect(row3.parsed?.startTime).toBe("14:00");
    expect(row3.parsed?.endTime).toBe("22:00");
    const row4 = rowByNumber(all.items, 4);
    expect(codes(row4)).toEqual(["EMPLOYEE_NOT_FOUND"]);
    expect(row4.matchedEmployee).toBeNull();
    const row5 = rowByNumber(all.items, 5);
    expect(row5.status).toBe("WARNING");
    expect(codes(row5).sort()).toEqual(["OVERNIGHT_SHIFT", "UNKNOWN_LOCATION"]);
    expect(row5.matchedEmployee?.id).toBe(amira.id);
    expect(row5.parsed?.endsAt).toBe("2027-03-02T06:00:00.000Z");
    const row6 = rowByNumber(all.items, 6);
    expect(codes(row6)).toEqual(["OVERLAPPING_SHIFT"]);

    const errorsOnly = await listRows(jar, importId, { status: "ERROR" });
    expect(errorsOnly.total).toBe(4);
    expect(errorsOnly.items.map((r) => r.rowNumber)).toEqual([2, 3, 4, 6]);
    const paged = await listRows(jar, importId, { page: 2, pageSize: 2 });
    expect(paged.items.map((r) => r.rowNumber)).toEqual([4, 5]);
    expect(paged.totalPages).toBe(3);

    // Commit is blocked while errors remain.
    const blocked = await commit(jar, importId, {}, 409);
    expect(blocked.error.code).toBe("IMPORT_HAS_ERRORS");
    expect(blocked.error.details).toEqual({ errorCount: 4 });

    // 4. Fix rows: pick the right John, create Sam Lee, create the location, skip the overlapping row.
    const picked = await patchRow(jar, importId, row3.id, { matchedEmployeeId: john.id });
    expect(() => importRowResponseSchema.parse(picked)).not.toThrow();
    expect(picked.row.status).toBe("VALID");
    expect(picked.row.matchedEmployee?.id).toBe(john.id);
    expect(picked.row.problems).toEqual([]);
    expect(picked.summary.error).toBe(3);

    const created = await patchRow(jar, importId, row4.id, {
      createEmployee: { firstName: "Sam", lastName: "Lee", email: "sam.lee@example.test" },
    });
    expect(created.row.status).toBe("VALID");
    expect(created.row.createEmployee).toEqual({
      firstName: "Sam",
      lastName: "Lee",
      email: "sam.lee@example.test",
    });
    const sam = await prisma.employee.findFirstOrThrow({
      where: { organisationId, lastName: "Lee" },
    });
    expect(created.row.matchedEmployee?.id).toBe(sam.id);
    expect(created.summary.error).toBe(2);

    const located = await patchRow(jar, importId, row5.id, { locationAction: "CREATE" });
    expect(located.row.status).toBe("WARNING");
    expect(codes(located.row)).toEqual(["OVERNIGHT_SHIFT"]);
    const stationRoad = await prisma.location.findFirstOrThrow({
      where: { organisationId, name: "Station Road" },
    });
    expect(
      await prisma.auditLog.count({
        where: { organisationId, action: "location.created", entityId: stationRoad.id },
      }),
    ).toBe(1);

    const skipped = await patchRow(jar, importId, row6.id, { skip: true });
    expect(skipped.row.status).toBe("SKIPPED");
    expect(skipped.summary).toEqual({
      total: 5,
      valid: 3,
      warning: 1,
      error: 0,
      skipped: 1,
      imported: 0,
      readyToCommit: true,
    });
    // The sibling it overlapped is clean again (the whole import was re-validated).
    const afterFixes = await listRows(jar, importId, { pageSize: 50 });
    expect(rowByNumber(afterFixes.items, 2).status).toBe("VALID");
    expect(rowByNumber(afterFixes.items, 2).problems).toEqual([]);
    expect(rowByNumber(afterFixes.items, 6).status).toBe("SKIPPED");
    expect(rowByNumber(afterFixes.items, 6).matchedEmployee?.id).toBe(jane.id);

    // Re-running validation keeps every fix.
    const revalidated = await validate(jar, importId);
    expect(revalidated.summary).toMatchObject({ valid: 3, warning: 1, error: 0, skipped: 1 });

    // Errors CSV lists rows with problems: only the warning row now. The manually skipped row has no
    // problem of its own any more (its overlap vanished once it stopped taking part in validation), so
    // `toErrorsCsv` leaves it out.
    const csv = await callRoute<string>(errorsCsvRoute, {
      path: `/api/imports/${importId}/errors.csv`,
      params: { id: importId },
      jar,
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="rota-errors.csv"');
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]).toBe(
      "row_number,status,problems,Staff,Payroll Number,Email,Date,Shift Start,Finish,Site,Break (mins)",
    );
    expect(lines.slice(1).map((l) => l.split(",").slice(0, 2).join(","))).toEqual(["5,WARNING"]);
    expect(lines[1]).toContain("WARNING OVERNIGHT_SHIFT (end_time)");

    // 5. Commit
    const schedule = collectEvents(organisationId, "SCHEDULE_CHANGED");
    const completed = collectEvents(organisationId, "import.completed");
    const result = await commit(jar, importId);
    schedule.unsubscribe();
    completed.unsubscribe();
    expect(() => commitImportResponseSchema.parse(result)).not.toThrow();
    expect(result).toMatchObject({ shiftsCreated: 4, employeesCreated: 1, rowsSkipped: 1 });
    expect(result.import.status).toBe("IMPORTED");
    expect(result.import.importedCount).toBe(4);
    expect(result.import.skippedCount).toBe(1);
    expect(result.import.errorCount).toBe(0);
    expect(result.import.importedAt).not.toBeNull();

    const shifts = await prisma.shift.findMany({
      where: { organisationId },
      include: { scheduledBreaks: true },
      orderBy: [{ startsAt: "asc" }, { employeeId: "asc" }],
    });
    expect(shifts).toHaveLength(4);
    expect(shifts.every((s) => s.source === "CSV_IMPORT" && s.status === "SCHEDULED")).toBe(true);
    const janeShift = shifts.find((s) => s.employeeId === jane.id);
    expect(janeShift?.startsAt.toISOString()).toBe("2027-03-01T09:00:00.000Z");
    expect(janeShift?.endsAt.toISOString()).toBe("2027-03-01T17:00:00.000Z");
    expect(janeShift?.timezone).toBe("Europe/London");
    expect(janeShift?.locationId).toBe(
      (await prisma.location.findFirstOrThrow({ where: { organisationId, name: "High Street" } }))
        .id,
    );
    // break_minutes → one break centred in the shift: (480 - 30) / 2 = 225
    expect(
      janeShift?.scheduledBreaks.map((b) => ({
        o: b.offsetMinutesFromStart,
        d: b.durationMinutes,
      })),
    ).toEqual([{ o: 225, d: 30 }]);
    const amiraShift = shifts.find((s) => s.employeeId === amira.id);
    expect(amiraShift?.endsAt.toISOString()).toBe("2027-03-02T06:00:00.000Z");
    expect(amiraShift?.locationId).toBe(stationRoad.id);
    expect(shifts.find((s) => s.employeeId === sam.id)).toBeDefined();
    expect(shifts.find((s) => s.employeeId === john.id)?.startsAt.toISOString()).toBe(
      "2027-03-01T14:00:00.000Z",
    );

    const finalRows = await listRows(jar, importId, { pageSize: 50 });
    expect(finalRows.items.map((r) => [r.rowNumber, r.status])).toEqual([
      [2, "IMPORTED"],
      [3, "IMPORTED"],
      [4, "IMPORTED"],
      [5, "IMPORTED"],
      [6, "SKIPPED"],
    ]);
    expect(
      finalRows.items
        .filter((r) => r.status === "IMPORTED")
        .every((r) => r.createdShiftId !== null),
    ).toBe(true);
    expect(rowByNumber(finalRows.items, 2).createdShiftId).toBe(janeShift?.id);

    const activity = await prisma.activityEvent.findFirst({
      where: { organisationId, type: "IMPORT_COMPLETED" },
    });
    expect(activity?.actorType).toBe("MANAGER");
    expect(activity?.actorUserId).toBe(org.owner.id);
    expect(activity?.metadata).toMatchObject({
      importId,
      shiftsCreated: 4,
      rowsSkipped: 1,
      employeesCreated: 1,
    });
    expect(
      await prisma.auditLog.count({
        where: { organisationId, action: "import.committed", entityId: importId },
      }),
    ).toBe(1);
    expect(schedule.seen.map((e) => e.employeeId).sort()).toEqual(
      [amira.id, jane.id, john.id, sam.id].sort(),
    );
    expect(
      schedule.seen.every((e) => (e.payload as { reason: string }).reason === "IMPORTED"),
    ).toBe(true);
    expect(completed.seen).toHaveLength(1);
    expect(completed.seen[0]?.payload).toEqual({ importId, shiftsCreated: 4 });

    // Committed imports are read-only.
    expect((await commit(jar, importId, {}, 409)).error.code).toBe("IMPORT_INVALID_STATE");
    expect(
      (await saveMapping(jar, importId, { mapping: uploaded.suggestion.mapping }, 409)).error.code,
    ).toBe("IMPORT_INVALID_STATE");
    expect((await validate(jar, importId, 409)).error.code).toBe("IMPORT_INVALID_STATE");
    expect((await patchRow(jar, importId, row6.id, { skip: false }, 409)).error.code).toBe(
      "IMPORT_INVALID_STATE",
    );
    const closed = await callRoute<ImportResponse>(getImportRoute, {
      path: `/api/imports/${importId}`,
      params: { id: importId },
      jar,
    });
    expect(closed.body.suggestion).toBeUndefined();
    // The errors CSV still works after commit and shows final statuses.
    const csvAfter = await callRoute<string>(errorsCsvRoute, {
      path: `/api/imports/${importId}/errors.csv`,
      params: { id: importId },
      jar,
    });
    expect(csvAfter.body).toContain("\r\n5,IMPORTED,");
  });

  it("commits with skipErrors (errors stay) and without warnings (warnings are skipped)", async () => {
    const { org, jar, jane, amira } = await setup();
    const csv = [
      "employee_id,email,date,start_time,end_time,location",
      "E1042,,2027-03-03,09:00,17:00,High Street",
      "NOPE,,2027-03-03,09:00,17:00,High Street",
      ",amira.khan@example.test,2027-03-03,22:00,06:00,High Street",
    ].join("\n");
    const uploaded = await uploadOk(jar, csv, { filename: "shifts.txt", type: "text/plain" });
    const id = uploaded.import.id;
    await saveMapping(jar, id, { mapping: uploaded.suggestion.mapping });
    const validated = await validate(jar, id);
    expect(validated.summary).toMatchObject({ valid: 1, warning: 1, error: 1 });

    const result = await commit(jar, id, { skipErrors: true, includeWarnings: false });
    expect(result).toMatchObject({ shiftsCreated: 1, employeesCreated: 0, rowsSkipped: 1 });
    expect(result.import).toMatchObject({
      status: "IMPORTED",
      importedCount: 1,
      errorCount: 1,
      skippedCount: 1,
    });
    const shifts = await prisma.shift.findMany({ where: { organisationId: org.organisation.id } });
    expect(shifts.map((s) => s.employeeId)).toEqual([jane.id]);
    expect(shifts.some((s) => s.employeeId === amira.id)).toBe(false);
    const rows = await listRows(jar, id, { pageSize: 50 });
    expect(rows.items.map((r) => r.status)).toEqual(["IMPORTED", "ERROR", "SKIPPED"]);
  });

  it("refuses a commit that would create nothing", async () => {
    const { jar } = await setup();
    const csv = ["employee_id,date,start_time,end_time", "NOPE,2027-03-03,09:00,17:00"].join("\n");
    const uploaded = await uploadOk(jar, csv);
    await saveMapping(jar, uploaded.import.id, { mapping: uploaded.suggestion.mapping });
    await validate(jar, uploaded.import.id);
    const res = await commit(jar, uploaded.import.id, { skipErrors: true }, 409);
    expect(res.error.code).toBe("IMPORT_INVALID_STATE");
    expect((res.error.details as { reason: string }).reason).toBe("NOTHING_TO_IMPORT");
  });

  it("stores upload options (date format, timezone, default location) and uses them when validating", async () => {
    const { org, jar, jane } = await setup();
    const location = await prisma.location.findFirstOrThrow({
      where: { organisationId: org.organisation.id },
    });
    const csv = ["employee_id,date,start_time,end_time", "E1042,03/04/2027,09:00,17:00"].join("\n");
    const uploaded = await uploadOk(jar, csv, {
      fields: { dateFormat: "MDY", timezone: "America/New_York", locationId: location.id },
    });
    expect(uploaded.import.options).toEqual({
      dateFormat: "MDY",
      timezone: "America/New_York",
      locationId: location.id,
    });
    await saveMapping(jar, uploaded.import.id, { mapping: uploaded.suggestion.mapping });
    const validated = await validate(jar, uploaded.import.id);
    expect(validated.summary).toMatchObject({ valid: 1, error: 0, warning: 0 });
    const rows = await listRows(jar, uploaded.import.id);
    // MDY: 03/04/2027 is 4 March; 09:00 New York (EST) is 14:00Z; the location fills the empty cell.
    expect(rows.items[0]?.parsed).toMatchObject({
      date: "2027-03-04",
      startsAt: "2027-03-04T14:00:00.000Z",
      timezone: "America/New_York",
      locationName: "High Street",
    });
    expect(rows.items[0]?.matchedEmployee?.id).toBe(jane.id);

    // The mapping step can change the options; an unknown location is a 404.
    const remapped = await saveMapping(jar, uploaded.import.id, {
      mapping: uploaded.suggestion.mapping,
      options: { dateFormat: "DMY", locationId: null },
    });
    expect(remapped.import.options).toEqual({
      dateFormat: "DMY",
      timezone: "America/New_York",
      locationId: null,
    });
    expect(remapped.import.status).toBe("MAPPED");
    const missing = await saveMapping(
      jar,
      uploaded.import.id,
      { mapping: uploaded.suggestion.mapping, options: { locationId: randomUUID() } },
      404,
    );
    expect(missing.error.code).toBe("NOT_FOUND");
    const badUpload = await upload(jar, csv, { fields: { locationId: randomUUID() } });
    expect(badUpload.status).toBe(404);
  });

  it("flags generic headers for confirmation", async () => {
    const { jar } = await setup();
    const csv = ["ID,Name,Day,In,Out", "E1042,Jane Smith,2027-03-03,09:00,17:00"].join("\n");
    const uploaded = await uploadOk(jar, csv);
    expect(uploaded.suggestion.mapping).toEqual({
      ID: "employee_id",
      Name: "employee_name",
      Day: "date",
      In: "start_time",
      Out: "end_time",
    });
    expect(uploaded.suggestion.needsConfirmation).toEqual(
      expect.arrayContaining(["ID", "Name", "Day", "In", "Out"]),
    );
  });

  it("re-validation respects a pinned employee who has since been deactivated", async () => {
    const { org, jar, john } = await setup();
    const csv = [
      "employee_name,date,start_time,end_time",
      "John Smith,2027-03-03,09:00,17:00",
    ].join("\n");
    const uploaded = await uploadOk(jar, csv);
    const id = uploaded.import.id;
    await saveMapping(jar, id, { mapping: uploaded.suggestion.mapping });
    await validate(jar, id);
    const rows = await listRows(jar, id);
    const row = rows.items[0]!;
    expect(codes(row)).toEqual(["MULTIPLE_MATCHES"]);
    const fixed = await patchRow(jar, id, row.id, { matchedEmployeeId: john.id });
    expect(fixed.row.status).toBe("VALID");
    await prisma.employee.update({
      where: { id: john.id },
      data: { employmentStatus: "INACTIVE" },
    });
    const again = await validate(jar, id);
    expect(again.summary.error).toBe(1);
    const after = await listRows(jar, id);
    expect(codes(after.items[0]!)).toEqual(["EMPLOYEE_NOT_FOUND"]);
    // Clearing the pin returns the row to automatic matching (now unambiguous: one active John).
    const cleared = await patchRow(jar, id, row.id, { matchedEmployeeId: null });
    expect(cleared.row.matchedEmployee?.id).toBe(
      (
        await prisma.employee.findFirstOrThrow({
          where: { organisationId: org.organisation.id, externalEmployeeId: "E1099" },
        })
      ).id,
    );
    // Pinning an employee from nowhere is a 404.
    const nobody = await patchRow(jar, id, row.id, { matchedEmployeeId: randomUUID() }, 404);
    expect(nobody.error.code).toBe("EMPLOYEE_NOT_FOUND");
    // IGNORE on a row without a location is a validation error.
    const noLocation = await patchRow(jar, id, row.id, { locationAction: "IGNORE" }, 400);
    expect(noLocation.error.code).toBe("VALIDATION_ERROR");
  });

  it("imports a row without a location when the unknown location is ignored", async () => {
    const { jar, jane } = await setup();
    const csv = [
      "employee_id,date,start_time,end_time,location",
      "E1042,2027-03-03,09:00,17:00,Nowhere",
    ].join("\n");
    const uploaded = await uploadOk(jar, csv);
    const id = uploaded.import.id;
    await saveMapping(jar, id, { mapping: uploaded.suggestion.mapping });
    await validate(jar, id);
    const rows = await listRows(jar, id);
    expect(codes(rows.items[0]!)).toEqual(["UNKNOWN_LOCATION"]);
    const ignored = await patchRow(jar, id, rows.items[0]!.id, { locationAction: "IGNORE" });
    expect(ignored.row.status).toBe("VALID");
    expect(ignored.row.parsed?.locationName).toBeUndefined();
    const result = await commit(jar, id);
    expect(result.shiftsCreated).toBe(1);
    const shift = await prisma.shift.findFirstOrThrow({ where: { employeeId: jane.id } });
    expect(shift.locationId).toBeNull();
  });

  it("refuses to commit when a matched employee was deactivated after validation", async () => {
    const { jar, jane } = await setup();
    const csv = ["employee_id,date,start_time,end_time", "E1042,2027-03-03,09:00,17:00"].join("\n");
    const uploaded = await uploadOk(jar, csv);
    const id = uploaded.import.id;
    await saveMapping(jar, id, { mapping: uploaded.suggestion.mapping });
    await validate(jar, id);
    await prisma.employee.update({
      where: { id: jane.id },
      data: { employmentStatus: "INACTIVE" },
    });
    const res = await commit(jar, id, {}, 409);
    expect(res.error.code).toBe("IMPORT_INVALID_STATE");
    expect(res.error.details).toMatchObject({ reason: "EMPLOYEE_NOT_ACTIVE", rowNumbers: [2] });
    expect(await prisma.shift.count({ where: { employeeId: jane.id } })).toBe(0);
    // Validating again surfaces the problem on the row; the import is still open.
    const again = await validate(jar, id);
    expect(again.summary.error).toBe(1);
    expect(again.import.status).toBe("VALIDATED");
  });

  it("marks the import FAILED when the commit transaction fails, and FAILED is terminal", async () => {
    const { org, jar, jane } = await setup();
    const organisationId = org.organisation.id;
    const csv = ["employee_id,date,start_time,end_time", "E1042,2027-03-03,09:00,17:00"].join("\n");
    const uploaded = await uploadOk(jar, csv);
    const id = uploaded.import.id;
    await saveMapping(jar, id, { mapping: uploaded.suggestion.mapping });
    await validate(jar, id);
    // The shifts are created inside the transaction before the audit entry; failing the audit write rolls
    // every one of them back.
    seam.failAuditAction = "import.committed";
    try {
      const res = await commit(jar, id, {}, 500);
      expect(res.error.code).toBe("INTERNAL_ERROR");
    } finally {
      seam.failAuditAction = null;
    }
    const record = await prisma.shiftImport.findUniqueOrThrow({ where: { id } });
    expect(record.status).toBe("FAILED");
    expect(record.importedCount).toBe(0);
    expect(record.importedAt).toBeNull();
    expect(await prisma.shift.count({ where: { employeeId: jane.id } })).toBe(0);
    const failed = await prisma.auditLog.findFirstOrThrow({
      where: { organisationId, action: "import.failed", entityId: id },
    });
    expect(failed.after).toMatchObject({ status: "FAILED", code: "INTERNAL_ERROR" });
    // Rows keep their validated statuses, the status is reported as is, and every write is refused.
    const got = await callRoute<ImportResponse>(getImportRoute, {
      path: `/api/imports/${id}`,
      params: { id },
      jar,
    });
    expect(got.body.import.status).toBe("FAILED");
    const rows = await listRows(jar, id);
    expect(rows.items.map((r) => r.status)).toEqual(["VALID"]);
    expect((await commit(jar, id, {}, 409)).error.code).toBe("IMPORT_INVALID_STATE");
    expect((await validate(jar, id, 409)).error.code).toBe("IMPORT_INVALID_STATE");
    expect(
      (await saveMapping(jar, id, { mapping: uploaded.suggestion.mapping }, 409)).error.code,
    ).toBe("IMPORT_INVALID_STATE");
    expect((await patchRow(jar, id, rows.items[0]!.id, { skip: true }, 409)).error.code).toBe(
      "IMPORT_INVALID_STATE",
    );
  });
});

describe("CSV import upload limits", () => {
  it("rejects files over 5 MB with PAYLOAD_TOO_LARGE", async () => {
    const { org, jar } = await setup();
    const big = "employee_id,date,start_time,end_time\n" + "x".repeat(5 * 1024 * 1024);
    const res = await upload(jar, big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    const huge = "employee_id,date,start_time,end_time\n" + "x".repeat(6 * 1024 * 1024);
    const res2 = await upload(jar, huge);
    expect(res2.status).toBe(413);
    expect(await prisma.shiftImport.count({ where: { organisationId: org.organisation.id } })).toBe(
      0,
    );
  });

  it("rejects unsupported content types and non-multipart bodies", async () => {
    const { jar } = await setup();
    const csv = "employee_id,date,start_time,end_time\nE1042,2027-03-03,09:00,17:00\n";
    const pdf = await upload(jar, csv, { type: "application/pdf" });
    expect(pdf.status).toBe(415);
    expect(pdf.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    const json = await callRoute<ErrorBody>(uploadRoute, {
      method: "POST",
      path: "/api/imports",
      jar,
      body: { file: csv },
    });
    expect(json.status).toBe(415);
    expect(json.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    // Excel-flavoured and plain-text CSVs are accepted when the file name says .csv.
    const excel = await upload(jar, csv, { type: "application/vnd.ms-excel" });
    expect(excel.status).toBe(201);
    const plain = await upload(jar, csv, { type: "text/plain", filename: "rota.csv" });
    expect(plain.status).toBe(201);
    const noType = await upload(jar, csv, { type: "" });
    expect(noType.status).toBe(201);
    // A spreadsheet renamed to .csv (NUL bytes) and a wrong extension are INVALID_CSV.
    const xlsx = await upload(jar, csv, { filename: "rota.xlsx" });
    expect(xlsx.status).toBe(400);
    expect(xlsx.body.error.code).toBe("INVALID_CSV");
    const binary = await upload(jar, "PK\u0003\u0004\u0000\u0000binary");
    expect(binary.status).toBe(400);
    expect(binary.body.error.code).toBe("INVALID_CSV");
  });

  it("rejects files with more than 5,000 rows, empty files and uploads without a file", async () => {
    const { jar } = await setup();
    const rows = Array.from({ length: 5001 }, (_, i) => `E${i},2027-03-03,09:00,17:00`);
    const res = await upload(jar, ["employee_id,date,start_time,end_time", ...rows].join("\n"));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CSV");
    expect(
      (res.body.error.details as { problems: Array<{ code: string }> }).problems[0]?.code,
    ).toBe("TOO_MANY_ROWS");

    const headerOnly = await upload(jar, "employee_id,date,start_time,end_time\n");
    expect(headerOnly.status).toBe(400);
    expect(headerOnly.body.error.code).toBe("INVALID_CSV");

    const { body, contentType } = multipart([{ name: "dateFormat", value: "DMY" }]);
    const noFile = await callRoute<ErrorBody>(uploadRoute, {
      method: "POST",
      path: "/api/imports",
      jar,
      body,
      headers: { "content-type": contentType },
    });
    expect(noFile.status).toBe(400);
    expect(noFile.body.error.code).toBe("VALIDATION_ERROR");

    const badField = await upload(
      jar,
      "employee_id,date,start_time,end_time\nE1,2027-03-03,09:00,17:00\n",
      {
        fields: { dateFormat: "YYY" },
      },
    );
    expect(badField.status).toBe(400);
    expect(badField.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires a signed-in manager with a CSRF token", async () => {
    const { jar } = await setup();
    const csv = "employee_id,date,start_time,end_time\nE1042,2027-03-03,09:00,17:00\n";
    const { body, contentType } = multipart([
      { name: "file", filename: "rota.csv", type: "text/csv", content: csv },
    ]);
    const anonymous = await callRoute<ErrorBody>(uploadRoute, {
      method: "POST",
      path: "/api/imports",
      body,
      headers: { "content-type": contentType },
    });
    expect(anonymous.status).toBe(401);
    const noCsrf = await callRoute<ErrorBody>(uploadRoute, {
      method: "POST",
      path: "/api/imports",
      jar,
      csrf: false,
      body,
      headers: { "content-type": contentType },
    });
    expect(noCsrf.status).toBe(403);
    const list = await callRoute<ErrorBody>(listImportsRoute, { path: "/api/imports" });
    expect(list.status).toBe(401);
  });
});

export type { TestOrg };
