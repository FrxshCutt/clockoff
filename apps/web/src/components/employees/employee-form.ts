import {
  EMPLOYEE_LIMITS,
  createEmployeeSchema,
  updateEmployeeSchema,
  type CreateEmployeeInput,
  type Employee,
  type UpdateEmployeeInput,
} from "@clockoff/validation/employees";
import { phoneSchema } from "@clockoff/validation/primitives";
import { z } from "zod";

/**
 * Add / Edit employee form model. The form works with strings (`""` = empty) so inputs stay controlled;
 * `toCreateEmployeeInput` / `toUpdateEmployeeInput` turn the values into the exact API bodies, which are
 * re-validated against the contract schemas so the client can never drift from the server.
 */

const optionalText = (max: number) => z.string().trim().max(max);
const optionalId = z.string(); // "" or a uuid chosen from a select

export const employeeFormSchema = z.object({
  firstName: z.string().trim().min(1, "Enter a first name").max(EMPLOYEE_LIMITS.nameMaxLength),
  lastName: z.string().trim().min(1, "Enter a last name").max(EMPLOYEE_LIMITS.nameMaxLength),
  email: z.union([z.literal(""), z.email("Enter a valid email address").max(254)]),
  phone: z.union([z.literal(""), phoneSchema]),
  externalEmployeeId: optionalText(EMPLOYEE_LIMITS.externalIdMaxLength),
  jobTitle: optionalText(EMPLOYEE_LIMITS.jobTitleMaxLength),
  departmentId: optionalId,
  primaryLocationId: optionalId,
  /** Additional locations (the primary one is implied). */
  locationIds: z.array(z.string()).max(EMPLOYEE_LIMITS.maxLocations),
  teamIds: z.array(z.string()).max(EMPLOYEE_LIMITS.maxTeams),
  policyId: optionalId,
  breakPolicyId: optionalId,
});
export type EmployeeFormValues = z.infer<typeof employeeFormSchema>;

export const EMPTY_EMPLOYEE_FORM: EmployeeFormValues = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  externalEmployeeId: "",
  jobTitle: "",
  departmentId: "",
  primaryLocationId: "",
  locationIds: [],
  teamIds: [],
  policyId: "",
  breakPolicyId: "",
};

/** Prefill from an existing employee. Additional locations exclude the primary one. */
export function employeeToFormValues(employee: Employee): EmployeeFormValues {
  const primary = employee.primaryLocation?.id ?? "";
  return {
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.email ?? "",
    phone: employee.phone ?? "",
    externalEmployeeId: employee.externalEmployeeId ?? "",
    jobTitle: employee.jobTitle ?? "",
    departmentId: employee.department?.id ?? "",
    primaryLocationId: primary,
    locationIds: employee.locations.map((l) => l.id).filter((id) => id !== primary),
    teamIds: employee.teams.map((t) => t.id),
    policyId: employee.policyOverride?.id ?? "",
    breakPolicyId: employee.breakPolicyOverride?.id ?? "",
  };
}

function blankToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function additionalLocations(values: EmployeeFormValues): string[] {
  const primary = values.primaryLocationId.trim();
  return [...new Set(values.locationIds.filter((id) => id && id !== primary))];
}

/** `POST /api/employees` body. Throws a ZodError if the mapping ever produces an invalid body (a bug). */
export function toCreateEmployeeInput(values: EmployeeFormValues): CreateEmployeeInput {
  const locationIds = additionalLocations(values);
  const teamIds = [...new Set(values.teamIds.filter(Boolean))];
  const body: CreateEmployeeInput = {
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
    ...(blankToUndefined(values.email) ? { email: values.email.trim() } : {}),
    ...(blankToUndefined(values.phone) ? { phone: values.phone.trim() } : {}),
    ...(blankToUndefined(values.externalEmployeeId)
      ? { externalEmployeeId: values.externalEmployeeId.trim() }
      : {}),
    ...(blankToUndefined(values.jobTitle) ? { jobTitle: values.jobTitle.trim() } : {}),
    ...(blankToUndefined(values.departmentId) ? { departmentId: values.departmentId } : {}),
    ...(blankToUndefined(values.primaryLocationId)
      ? { primaryLocationId: values.primaryLocationId }
      : {}),
    ...(locationIds.length > 0 ? { locationIds } : {}),
    ...(teamIds.length > 0 ? { teamIds } : {}),
    ...(blankToUndefined(values.policyId) ? { policyId: values.policyId } : {}),
    ...(blankToUndefined(values.breakPolicyId) ? { breakPolicyId: values.breakPolicyId } : {}),
  };
  return createEmployeeSchema.parse(body);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * `PATCH /api/employees/:id` body containing only what changed: omitted = unchanged, `null` = cleared,
 * `locationIds` / `teamIds` replace the whole set. Returns `null` when nothing changed.
 */
export function toUpdateEmployeeInput(
  values: EmployeeFormValues,
  original: Employee,
): UpdateEmployeeInput | null {
  const before = employeeToFormValues(original);
  const body: Record<string, unknown> = {};

  const text = (key: "firstName" | "lastName") => {
    const next = values[key].trim();
    if (next !== before[key]) body[key] = next;
  };
  text("firstName");
  text("lastName");

  const nullable = (
    key:
      | "email"
      | "phone"
      | "externalEmployeeId"
      | "jobTitle"
      | "departmentId"
      | "primaryLocationId"
      | "policyId"
      | "breakPolicyId",
  ) => {
    const next = values[key].trim();
    if (next === before[key]) return;
    body[key] = next === "" ? null : next;
  };
  nullable("email");
  nullable("phone");
  nullable("externalEmployeeId");
  nullable("jobTitle");
  nullable("departmentId");
  nullable("primaryLocationId");
  nullable("policyId");
  nullable("breakPolicyId");

  // The API's `locationIds` is the full set including the primary location (`Employee.locations`).
  const nextPrimary = values.primaryLocationId.trim();
  const nextLocations = [
    ...new Set([...(nextPrimary ? [nextPrimary] : []), ...additionalLocations(values)]),
  ];
  const beforeLocations = original.locations.map((l) => l.id);
  if (!sameSet(nextLocations, beforeLocations)) body.locationIds = nextLocations;

  const nextTeams = [...new Set(values.teamIds.filter(Boolean))];
  if (!sameSet(nextTeams, before.teamIds)) body.teamIds = nextTeams;

  if (Object.keys(body).length === 0) return null;
  return updateEmployeeSchema.parse(body);
}
