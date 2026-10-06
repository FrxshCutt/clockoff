import { z } from "zod";
import { nonEmptyString, optionalString, timezoneSchema, uuidSchema } from "./common";
import {
  instantSchema,
  nullableInstantSchema,
  patchStringSchema,
  uuidListSchema,
} from "./primitives";
import { namedRefSchema } from "./refs";

// ── Scope assignments (shared by locations and teams) ───────────────────────

/**
 * The assignment currently in force for a location or team scope (§6.1: at most one per scope). `policy`
 * is the Work Policy for `policyAssignment` and the Break Policy for `breakPolicyAssignment`.
 */
export const scopeAssignmentSchema = z
  .object({
    /** PolicyAssignment / BreakPolicyAssignment id. */
    id: uuidSchema,
    policy: namedRefSchema,
    effectiveFrom: nullableInstantSchema,
    effectiveTo: nullableInstantSchema,
  })
  .meta({
    id: "ScopeAssignment",
    description: "The policy assignment currently in force for a location or team scope.",
  });
export type ScopeAssignment = z.infer<typeof scopeAssignmentSchema>;

// ── Locations ───────────────────────────────────────────────────────────────

export const locationSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    /** Null means "use the organisation timezone". */
    timezone: z.string().nullable(),
    address: z.string().nullable(),
    employeeCount: z.int().min(0),
    teamCount: z.int().min(0),
    /** Active Work Policy assignment for this location (LOCATION scope), null when none. */
    policyAssignment: scopeAssignmentSchema.nullable().optional(),
    /** Active Break Policy assignment for this location, null when none. */
    breakPolicyAssignment: scopeAssignmentSchema.nullable().optional(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .meta({ id: "Location" });
export type Location = z.infer<typeof locationSchema>;

export const createLocationSchema = z
  .object({
    name: nonEmptyString(120),
    timezone: timezoneSchema.optional(),
    address: optionalString(300),
  })
  .strict();
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

/** PATCH semantics: omitted = unchanged, `null` (or `""` for address) = clear. */
export const updateLocationSchema = z
  .object({
    name: nonEmptyString(120).optional(),
    timezone: timezoneSchema.nullable().optional(),
    address: patchStringSchema(300),
  })
  .strict();
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

export const listLocationsResponseSchema = z
  .object({ locations: z.array(locationSchema) })
  .meta({ id: "ListLocationsResponse" });
export type ListLocationsResponse = z.infer<typeof listLocationsResponseSchema>;
export const locationResponseSchema = z
  .object({ location: locationSchema })
  .meta({ id: "LocationResponse" });
export type LocationResponse = z.infer<typeof locationResponseSchema>;

// ── Departments ─────────────────────────────────────────────────────────────

export const departmentSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    employeeCount: z.int().min(0),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .meta({ id: "Department" });
export type Department = z.infer<typeof departmentSchema>;

export const createDepartmentSchema = z.object({ name: nonEmptyString(120) }).strict();
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export const updateDepartmentSchema = createDepartmentSchema;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;

export const listDepartmentsResponseSchema = z
  .object({ departments: z.array(departmentSchema) })
  .meta({ id: "ListDepartmentsResponse" });
export type ListDepartmentsResponse = z.infer<typeof listDepartmentsResponseSchema>;
export const departmentResponseSchema = z
  .object({ department: departmentSchema })
  .meta({ id: "DepartmentResponse" });
export type DepartmentResponse = z.infer<typeof departmentResponseSchema>;

// ── Teams ───────────────────────────────────────────────────────────────────

export const TEAM_LIMITS = { maxMembersPerRequest: 1000 } as const;

export const teamSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    location: namedRefSchema.nullable(),
    memberCount: z.int().min(0),
    /** Active Work Policy assignment for this team (TEAM scope), null when none. */
    policyAssignment: scopeAssignmentSchema.nullable().optional(),
    /** Active Break Policy assignment for this team, null when none. */
    breakPolicyAssignment: scopeAssignmentSchema.nullable().optional(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .meta({ id: "Team" });
export type Team = z.infer<typeof teamSchema>;

export const createTeamSchema = z
  .object({
    name: nonEmptyString(120),
    locationId: uuidSchema.optional(),
    employeeIds: uuidListSchema({ max: TEAM_LIMITS.maxMembersPerRequest }).optional(),
  })
  .strict();
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = z
  .object({
    name: nonEmptyString(120).optional(),
    locationId: uuidSchema.nullable().optional(),
  })
  .strict();
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

/**
 * `POST /api/teams/:id/members` — adds the given employees to the team (idempotent). With `replace: true`
 * the list becomes the team's whole membership (employees not listed are removed).
 */
export const addTeamMembersSchema = z
  .object({
    employeeIds: uuidListSchema({ min: 1, max: TEAM_LIMITS.maxMembersPerRequest }),
    /** Replace the membership set instead of adding to it. Default false. */
    replace: z.boolean().optional(),
  })
  .strict();
export type AddTeamMembersInput = z.infer<typeof addTeamMembersSchema>;

export const teamMemberParamsSchema = z.object({ id: uuidSchema, employeeId: uuidSchema }).strict();
export type TeamMemberParams = z.infer<typeof teamMemberParamsSchema>;

export const listTeamsResponseSchema = z
  .object({ teams: z.array(teamSchema) })
  .meta({ id: "ListTeamsResponse" });
export type ListTeamsResponse = z.infer<typeof listTeamsResponseSchema>;
export const teamResponseSchema = z.object({ team: teamSchema }).meta({ id: "TeamResponse" });
export type TeamResponse = z.infer<typeof teamResponseSchema>;

export const teamQuerySchema = z.object({ locationId: uuidSchema.optional() });
export type TeamQuery = z.infer<typeof teamQuerySchema>;
