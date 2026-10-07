import type { Employee } from "@clockoff/validation/employees";
import { describe, expect, it } from "vitest";
import {
  EMPTY_EMPLOYEE_FORM,
  employeeFormSchema,
  employeeToFormValues,
  toCreateEmployeeInput,
  toUpdateEmployeeInput,
} from "./employee-form";

const LOC_A = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";
const LOC_B = "7f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a11";
const TEAM = "8f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a12";
const POLICY = "9f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a13";
const DEPT = "af1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a14";

const EMPLOYEE: Employee = {
  id: "bf1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a15",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phone: null,
  externalEmployeeId: "E-001",
  jobTitle: "Barista",
  department: { id: DEPT, name: "Café" },
  primaryLocation: { id: LOC_A, name: "Harbour" },
  locations: [
    { id: LOC_A, name: "Harbour" },
    { id: LOC_B, name: "Market" },
  ],
  teams: [{ id: TEAM, name: "Front of House" }],
  employmentStatus: "ACTIVE",
  inviteStatus: "CONNECTED",
  deviceStatus: null,
  policyOverride: null,
  breakPolicyOverride: null,
  resolvedPolicy: null,
  resolvedBreakPolicy: null,
  nextShift: null,
  lastSyncAt: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
};

describe("employeeFormSchema", () => {
  it("requires names and accepts blank optional fields", () => {
    expect(employeeFormSchema.safeParse(EMPTY_EMPLOYEE_FORM).success).toBe(false);
    expect(
      employeeFormSchema.safeParse({
        ...EMPTY_EMPLOYEE_FORM,
        firstName: "Ada",
        lastName: "Lovelace",
      }).success,
    ).toBe(true);
  });

  it("validates email and phone only when provided", () => {
    const base = { ...EMPTY_EMPLOYEE_FORM, firstName: "Ada", lastName: "L" };
    expect(employeeFormSchema.safeParse({ ...base, email: "nope" }).success).toBe(false);
    expect(employeeFormSchema.safeParse({ ...base, phone: "abc" }).success).toBe(false);
    expect(employeeFormSchema.safeParse({ ...base, phone: "+44 7700 900123" }).success).toBe(true);
  });
});

describe("toCreateEmployeeInput", () => {
  it("produces the minimal valid body for names only", () => {
    expect(
      toCreateEmployeeInput({ ...EMPTY_EMPLOYEE_FORM, firstName: " Ada ", lastName: "Lovelace" }),
    ).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("maps every field, lower-cases the email and excludes the primary location from locationIds", () => {
    const body = toCreateEmployeeInput({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "Ada@Example.com",
      phone: "+44 7700 900123",
      externalEmployeeId: "E-1",
      jobTitle: "Barista",
      departmentId: DEPT,
      primaryLocationId: LOC_A,
      locationIds: [LOC_A, LOC_B, LOC_B],
      teamIds: [TEAM],
      policyId: POLICY,
      breakPolicyId: "",
    });
    expect(body).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      phone: "+44 7700 900123",
      externalEmployeeId: "E-1",
      jobTitle: "Barista",
      departmentId: DEPT,
      primaryLocationId: LOC_A,
      locationIds: [LOC_B],
      teamIds: [TEAM],
      policyId: POLICY,
    });
  });
});

describe("employeeToFormValues / toUpdateEmployeeInput", () => {
  it("prefills from the employee and reports no change when untouched", () => {
    const values = employeeToFormValues(EMPLOYEE);
    expect(values.locationIds).toEqual([LOC_B]);
    expect(values.primaryLocationId).toBe(LOC_A);
    expect(toUpdateEmployeeInput(values, EMPLOYEE)).toBeNull();
  });

  it("sends only changed fields, null to clear, and the full location set when it changes", () => {
    const values = employeeToFormValues(EMPLOYEE);
    const body = toUpdateEmployeeInput(
      {
        ...values,
        jobTitle: "",
        email: "ada+new@example.com",
        primaryLocationId: LOC_B,
        locationIds: [],
        teamIds: [],
      },
      EMPLOYEE,
    );
    expect(body).toEqual({
      email: "ada+new@example.com",
      jobTitle: null,
      primaryLocationId: LOC_B,
      locationIds: [LOC_B],
      teamIds: [],
    });
  });

  it("clears an employee-level policy override with null", () => {
    const withOverride: Employee = { ...EMPLOYEE, policyOverride: { id: POLICY, name: "Strict" } };
    const values = employeeToFormValues(withOverride);
    expect(values.policyId).toBe(POLICY);
    expect(toUpdateEmployeeInput({ ...values, policyId: "" }, withOverride)).toEqual({
      policyId: null,
    });
  });
});
