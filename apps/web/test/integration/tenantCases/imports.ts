import { randomUUID } from "node:crypto";
import { prisma } from "@workmode/db";
import { expect } from "vitest";
import { POST as commitRoute } from "@/app/api/imports/[id]/commit/route";
import { GET as errorsCsvRoute } from "@/app/api/imports/[id]/errors.csv/route";
import { POST as mappingRoute } from "@/app/api/imports/[id]/mapping/route";
import { GET as getImportRoute } from "@/app/api/imports/[id]/route";
import { PATCH as patchRowRoute } from "@/app/api/imports/[id]/rows/[rowId]/route";
import { GET as listRowsRoute } from "@/app/api/imports/[id]/rows/route";
import { POST as validateRoute } from "@/app/api/imports/[id]/validate/route";
import { POST as uploadRoute } from "@/app/api/imports/route";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

/** CSV import endpoints: org A's owner must never read, change or commit org B's imports or rows. */

const MAPPING = {
  employee_id: "employee_id",
  date: "date",
  start_time: "start_time",
  end_time: "end_time",
};

/** A validated import with one VALID row, written directly so each case is self-contained. */
async function createValidatedImportInOrg(organisationId: string) {
  const employee = await prisma.employee.create({
    data: { organisationId, firstName: "Only", lastName: "Here", externalEmployeeId: "T1" },
  });
  const record = await prisma.shiftImport.create({
    data: {
      organisationId,
      filename: "tenant.csv",
      fileSizeBytes: 64,
      status: "VALIDATED",
      headers: Object.keys(MAPPING),
      columnMapping: MAPPING,
      options: { dateFormat: "DMY", timezone: "Europe/London", locationId: null },
      rowCount: 1,
      validCount: 1,
      rows: {
        create: [
          {
            rowNumber: 2,
            raw: { employee_id: "T1", date: "03/03/2027", start_time: "09:00", end_time: "17:00" },
            parsed: {
              employeeExternalId: "T1",
              date: "2027-03-03",
              startTime: "09:00",
              endTime: "17:00",
              startsAt: "2027-03-03T09:00:00.000Z",
              endsAt: "2027-03-03T17:00:00.000Z",
              timezone: "Europe/London",
              overnight: false,
            },
            status: "VALID",
            problems: [],
            matchedEmployeeId: employee.id,
          },
        ],
      },
    },
    include: { rows: true },
  });
  return { record, row: record.rows[0]!, employee };
}

registerTenantIsolationCase({
  name: "GET /api/imports/:id of another tenant",
  build: async (_a, b) => {
    const { record } = await createValidatedImportInOrg(b.organisation.id);
    return {
      handler: getImportRoute,
      path: `/api/imports/${record.id}`,
      params: { id: record.id },
    };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "POST /api/imports/:id/mapping of another tenant",
  build: async (_a, b) => {
    const { record } = await createValidatedImportInOrg(b.organisation.id);
    return {
      handler: mappingRoute,
      method: "POST",
      path: `/api/imports/${record.id}/mapping`,
      params: { id: record.id },
      body: { mapping: MAPPING },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.shiftImport.findFirstOrThrow({
      where: { organisationId: b.organisation.id },
    });
    expect(row.status).toBe("VALIDATED");
  },
});

registerTenantIsolationCase({
  name: "POST /api/imports/:id/validate of another tenant",
  build: async (_a, b) => {
    const { record } = await createValidatedImportInOrg(b.organisation.id);
    return {
      handler: validateRoute,
      method: "POST",
      path: `/api/imports/${record.id}/validate`,
      params: { id: record.id },
      body: {},
    };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "GET /api/imports/:id/rows of another tenant",
  build: async (_a, b) => {
    const { record } = await createValidatedImportInOrg(b.organisation.id);
    return {
      handler: listRowsRoute,
      path: `/api/imports/${record.id}/rows`,
      params: { id: record.id },
    };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "PATCH /api/imports/:id/rows/:rowId of another tenant",
  build: async (_a, b) => {
    const { record, row } = await createValidatedImportInOrg(b.organisation.id);
    return {
      handler: patchRowRoute,
      method: "PATCH",
      path: `/api/imports/${record.id}/rows/${row.id}`,
      params: { id: record.id, rowId: row.id },
      body: { skip: true },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.shiftImportRow.findFirstOrThrow({
      where: { import: { organisationId: b.organisation.id } },
    });
    expect(row.status).toBe("VALID");
  },
});

registerTenantIsolationCase({
  name: "PATCH /api/imports/:id/rows/:rowId pinning another tenant's employee",
  build: async (a, b) => {
    const { record, row } = await createValidatedImportInOrg(a.organisation.id);
    const { employee } = await createValidatedImportInOrg(b.organisation.id);
    return {
      handler: patchRowRoute,
      method: "PATCH",
      path: `/api/imports/${record.id}/rows/${row.id}`,
      params: { id: record.id, rowId: row.id },
      body: { matchedEmployeeId: employee.id },
    };
  },
  expectCode: "EMPLOYEE_NOT_FOUND",
  verify: async (a, b) => {
    const row = await prisma.shiftImportRow.findFirstOrThrow({
      where: { import: { organisationId: a.organisation.id } },
    });
    const bEmployee = await prisma.employee.findFirstOrThrow({
      where: { organisationId: b.organisation.id },
    });
    expect(row.matchedEmployeeId).not.toBe(bEmployee.id);
  },
});

registerTenantIsolationCase({
  name: "POST /api/imports/:id/commit of another tenant",
  build: async (_a, b) => {
    const { record } = await createValidatedImportInOrg(b.organisation.id);
    return {
      handler: commitRoute,
      method: "POST",
      path: `/api/imports/${record.id}/commit`,
      params: { id: record.id },
      body: {},
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(await prisma.shift.count({ where: { organisationId: b.organisation.id } })).toBe(0);
    const row = await prisma.shiftImport.findFirstOrThrow({
      where: { organisationId: b.organisation.id },
    });
    expect(row.status).toBe("VALIDATED");
  },
});

registerTenantIsolationCase({
  name: "GET /api/imports/:id/errors.csv of another tenant",
  build: async (_a, b) => {
    const { record } = await createValidatedImportInOrg(b.organisation.id);
    return {
      handler: errorsCsvRoute,
      path: `/api/imports/${record.id}/errors.csv`,
      params: { id: record.id },
    };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "POST /api/imports with another tenant's location as the default",
  build: async (_a, b) => {
    const location = await prisma.location.create({
      data: { organisationId: b.organisation.id, name: `B site ${randomUUID().slice(0, 6)}` },
    });
    const boundary = `----tenant${randomUUID().replace(/-/g, "")}`;
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="locationId"\r\n\r\n${location.id}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="rota.csv"\r\nContent-Type: text/csv\r\n\r\n` +
      "employee_id,date,start_time,end_time\nE1,2027-03-03,09:00,17:00\n\r\n" +
      `--${boundary}--\r\n`;
    return {
      handler: uploadRoute,
      method: "POST",
      path: "/api/imports",
      body,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a, b) => {
    expect(
      await prisma.shiftImport.count({
        where: { organisationId: { in: [a.organisation.id, b.organisation.id] } },
      }),
    ).toBe(0);
  },
});
