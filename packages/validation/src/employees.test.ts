import { describe, expect, it } from "vitest";
import { searchParamsToObject } from "./common";
import {
  assignEmployeeLocationSchema,
  bulkEmployeeActionSchema,
  createEmployeeSchema,
  employeeQuerySchema,
  updateEmployeeSchema,
} from "./employees";
import { createEmployeeInviteSchema, resendEmployeeInviteSchema } from "./invites";

const id1 = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const id2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("employee bodies", () => {
  it("creates with trimmed names and a lower-cased email", () => {
    expect(
      createEmployeeSchema.parse({
        firstName: " Jane ",
        lastName: "Smith",
        email: "Jane.Smith@Example.COM",
        teamIds: [id1],
      }),
    ).toEqual({
      firstName: "Jane",
      lastName: "Smith",
      email: "jane.smith@example.com",
      teamIds: [id1],
    });
  });

  it("rejects unknown keys, blank names and duplicate ids", () => {
    expect(
      createEmployeeSchema.safeParse({
        firstName: "Jane",
        lastName: "Smith",
        inviteStatus: "CONNECTED",
      }).success,
    ).toBe(false);
    expect(createEmployeeSchema.safeParse({ firstName: "", lastName: "Smith" }).success).toBe(
      false,
    );
    expect(
      createEmployeeSchema.safeParse({
        firstName: "Jane",
        lastName: "Smith",
        locationIds: [id1, id1],
      }).success,
    ).toBe(false);
    expect(
      createEmployeeSchema.safeParse({ firstName: "Jane", lastName: "Smith", phone: "call me" })
        .success,
    ).toBe(false);
  });

  it("patches: omitted = unchanged, null = clear", () => {
    expect(updateEmployeeSchema.parse({})).toEqual({});
    expect(updateEmployeeSchema.parse({ email: null, jobTitle: "", policyId: null })).toEqual({
      email: null,
      jobTitle: null,
      policyId: null,
    });
  });

  it("assign-location needs at least one field", () => {
    expect(assignEmployeeLocationSchema.safeParse({}).success).toBe(false);
    expect(assignEmployeeLocationSchema.safeParse({ primaryLocationId: null }).success).toBe(true);
  });
});

describe("employeeQuerySchema", () => {
  it("parses list filters, pagination and sort from the URL", () => {
    const params = new URLSearchParams(
      "search=jane&inviteStatus=INVITED&inviteStatus=JOINED&deviceStatus=OFFLINE,SYNC_DELAYED&page=2&pageSize=50&sort=-lastSyncAt",
    );
    expect(employeeQuerySchema.parse(searchParamsToObject(params))).toEqual({
      search: "jane",
      inviteStatus: ["INVITED", "JOINED"],
      deviceStatus: ["OFFLINE", "SYNC_DELAYED"],
      page: 2,
      pageSize: 50,
      sort: "-lastSyncAt",
    });
  });

  it("defaults and rejects unknown enum values", () => {
    expect(employeeQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25, sort: "lastName" });
    expect(employeeQuerySchema.safeParse({ sort: "salary" }).success).toBe(false);
    expect(employeeQuerySchema.safeParse({ inviteStatus: "MAYBE" }).success).toBe(false);
    expect(employeeQuerySchema.safeParse({ pageSize: "500" }).success).toBe(false);
  });
});

describe("bulkEmployeeActionSchema", () => {
  it("discriminates on action with typed payloads", () => {
    expect(bulkEmployeeActionSchema.parse({ action: "INVITE", employeeIds: [id1, id2] })).toEqual({
      action: "INVITE",
      employeeIds: [id1, id2],
      payload: { channel: "LINK" },
    });
    expect(
      bulkEmployeeActionSchema.safeParse({
        action: "ASSIGN_POLICY",
        employeeIds: [id1],
        payload: { policyId: null },
      }).success,
    ).toBe(true);
    expect(
      bulkEmployeeActionSchema.safeParse({ action: "ASSIGN_POLICY", employeeIds: [id1] }).success,
    ).toBe(false);
    expect(
      bulkEmployeeActionSchema.safeParse({
        action: "ADD_TO_TEAM",
        employeeIds: [id1],
        payload: { teamId: "x" },
      }).success,
    ).toBe(false);
    expect(
      bulkEmployeeActionSchema.safeParse({ action: "DELETE", employeeIds: [id1] }).success,
    ).toBe(false);
    expect(bulkEmployeeActionSchema.safeParse({ action: "ARCHIVE", employeeIds: [] }).success).toBe(
      false,
    );
  });
});

describe("employee invites", () => {
  it("defaults the channel to LINK", () => {
    expect(createEmployeeInviteSchema.parse({})).toEqual({ channel: "LINK" });
    expect(createEmployeeInviteSchema.safeParse({ channel: "WHATSAPP" }).success).toBe(false);
    expect(resendEmployeeInviteSchema.parse({})).toEqual({});
  });
});
