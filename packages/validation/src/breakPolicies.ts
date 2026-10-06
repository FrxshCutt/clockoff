import { z } from "zod";
import { nonEmptyString, optionalString, uuidSchema } from "./common";
import {
  assignmentScopeTypeSchema,
  breakRestrictionBehaviourSchema,
  policyStatusSchema,
} from "./enumSchemas";
import { createAssignmentSchema, restrictionCategoryListSchema } from "./policies";
import {
  instantSchema,
  nullableInstantSchema,
  patchStringSchema,
  queryBooleanSchema,
  queryListSchema,
} from "./primitives";
import { namedRefSchema } from "./refs";

// ── Rules ───────────────────────────────────────────────────────────────────

export const BREAK_POLICY_LIMITS = {
  maxBreaksPerShift: 10,
  maxBreakDurationMinutes: 240,
  maxTotalBreakMinutes: 480,
  minGapBetweenBreaksMinutes: 480,
  minMinutesAfterShiftStart: 480,
} as const;

const breakPolicyRulesShape = {
  breaksEnabled: z.boolean(),
  maxBreaksPerShift: z.int().min(0).max(BREAK_POLICY_LIMITS.maxBreaksPerShift),
  maxBreakDurationMinutes: z.int().min(1).max(BREAK_POLICY_LIMITS.maxBreakDurationMinutes),
  maxTotalBreakMinutes: z.int().min(0).max(BREAK_POLICY_LIMITS.maxTotalBreakMinutes),
  minGapBetweenBreaksMinutes: z.int().min(0).max(BREAK_POLICY_LIMITS.minGapBetweenBreaksMinutes),
  minMinutesAfterShiftStart: z.int().min(0).max(BREAK_POLICY_LIMITS.minMinutesAfterShiftStart),
  /** Employees may start a break from the app. */
  employeeTriggeredAllowed: z.boolean(),
  /** Breaks scheduled on the shift start automatically. */
  scheduledBreaksAllowed: z.boolean(),
  restrictionBehaviour: breakRestrictionBehaviourSchema,
  /** Categories relaxed during a break when behaviour is RELAX_CATEGORIES (unique). */
  relaxedCategories: restrictionCategoryListSchema,
};

type BreakPolicyRulesValue = z.infer<z.ZodObject<typeof breakPolicyRulesShape>>;

function validateBreakRules(rules: BreakPolicyRulesValue, ctx: z.RefinementCtx): void {
  if (rules.breaksEnabled && rules.maxBreaksPerShift === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["maxBreaksPerShift"],
      message: "Allow at least one break per shift, or disable breaks",
    });
  }
  // `maxTotalBreakMinutes = 0` means "no break minutes at all" to the break rules (BREAK_LIMIT_REACHED),
  // which contradicts breaksEnabled — disable breaks instead.
  if (rules.breaksEnabled && rules.maxTotalBreakMinutes === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["maxTotalBreakMinutes"],
      message: "Allow some break minutes per shift, or disable breaks",
    });
  }
  if (
    rules.maxTotalBreakMinutes > 0 &&
    rules.maxBreakDurationMinutes > rules.maxTotalBreakMinutes
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["maxBreakDurationMinutes"],
      message: "A single break cannot be longer than the total break allowance",
    });
  }
  if (rules.restrictionBehaviour === "RELAX_CATEGORIES" && rules.relaxedCategories.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["relaxedCategories"],
      message: "Choose at least one category to relax, or use RELAX_ALL / KEEP_RESTRICTIONS",
    });
  }
}

/** Complete rule set (no defaults). Handlers re-validate the merged state after a PATCH with this. */
export const breakPolicyRulesSchema = z
  .object(breakPolicyRulesShape)
  .strict()
  .superRefine(validateBreakRules)
  .meta({ id: "BreakPolicyRules" });
export type BreakPolicyRules = z.infer<typeof breakPolicyRulesSchema>;

/** Mirrors the Prisma column defaults. */
export const BREAK_POLICY_DEFAULTS: BreakPolicyRules = {
  breaksEnabled: true,
  maxBreaksPerShift: 2,
  maxBreakDurationMinutes: 15,
  maxTotalBreakMinutes: 30,
  minGapBetweenBreaksMinutes: 60,
  minMinutesAfterShiftStart: 60,
  employeeTriggeredAllowed: true,
  scheduledBreaksAllowed: true,
  restrictionBehaviour: "RELAX_ALL",
  relaxedCategories: [],
};

// ── CRUD ────────────────────────────────────────────────────────────────────

/** `POST /api/break-policies` — every rule is optional and falls back to `BREAK_POLICY_DEFAULTS`. */
export const createBreakPolicySchema = z
  .object({
    name: nonEmptyString(120),
    description: optionalString(500),
    breaksEnabled: breakPolicyRulesShape.breaksEnabled.default(BREAK_POLICY_DEFAULTS.breaksEnabled),
    maxBreaksPerShift: breakPolicyRulesShape.maxBreaksPerShift.default(
      BREAK_POLICY_DEFAULTS.maxBreaksPerShift,
    ),
    maxBreakDurationMinutes: breakPolicyRulesShape.maxBreakDurationMinutes.default(
      BREAK_POLICY_DEFAULTS.maxBreakDurationMinutes,
    ),
    maxTotalBreakMinutes: breakPolicyRulesShape.maxTotalBreakMinutes.default(
      BREAK_POLICY_DEFAULTS.maxTotalBreakMinutes,
    ),
    minGapBetweenBreaksMinutes: breakPolicyRulesShape.minGapBetweenBreaksMinutes.default(
      BREAK_POLICY_DEFAULTS.minGapBetweenBreaksMinutes,
    ),
    minMinutesAfterShiftStart: breakPolicyRulesShape.minMinutesAfterShiftStart.default(
      BREAK_POLICY_DEFAULTS.minMinutesAfterShiftStart,
    ),
    employeeTriggeredAllowed: breakPolicyRulesShape.employeeTriggeredAllowed.default(
      BREAK_POLICY_DEFAULTS.employeeTriggeredAllowed,
    ),
    scheduledBreaksAllowed: breakPolicyRulesShape.scheduledBreaksAllowed.default(
      BREAK_POLICY_DEFAULTS.scheduledBreaksAllowed,
    ),
    restrictionBehaviour: breakPolicyRulesShape.restrictionBehaviour.default(
      BREAK_POLICY_DEFAULTS.restrictionBehaviour,
    ),
    relaxedCategories: breakPolicyRulesShape.relaxedCategories.default([]),
  })
  .strict()
  .superRefine(validateBreakRules);
export type CreateBreakPolicyInput = z.infer<typeof createBreakPolicySchema>;

/** `PATCH /api/break-policies/:id` — partial; the handler merges and re-validates with `breakPolicyRulesSchema`. */
export const updateBreakPolicySchema = z
  .object({
    name: nonEmptyString(120),
    description: patchStringSchema(500),
    ...breakPolicyRulesShape,
  })
  .strict()
  .partial();
export type UpdateBreakPolicyInput = z.infer<typeof updateBreakPolicySchema>;

export const breakPolicySchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    description: z.string().nullable(),
    ...breakPolicyRulesShape,
    status: policyStatusSchema,
    isDefault: z.boolean(),
    assignmentCount: z.int().min(0),
    assignedEmployeeCount: z.int().min(0),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .meta({ id: "BreakPolicy" });
export type BreakPolicy = z.infer<typeof breakPolicySchema>;

/** `GET /api/break-policies` — archived policies are hidden unless requested. */
export const breakPolicyQuerySchema = z.object({
  status: queryListSchema(policyStatusSchema).optional(),
  search: z.string().trim().max(100).optional(),
  includeArchived: queryBooleanSchema.optional(),
});
export type BreakPolicyQuery = z.infer<typeof breakPolicyQuerySchema>;

export const listBreakPoliciesResponseSchema = z
  .object({ breakPolicies: z.array(breakPolicySchema) })
  .meta({ id: "ListBreakPoliciesResponse" });
export type ListBreakPoliciesResponse = z.infer<typeof listBreakPoliciesResponseSchema>;

export const breakPolicyResponseSchema = z
  .object({ breakPolicy: breakPolicySchema })
  .meta({ id: "BreakPolicyResponse" });
export type BreakPolicyResponse = z.infer<typeof breakPolicyResponseSchema>;

// ── Assignments & default ───────────────────────────────────────────────────

export const createBreakPolicyAssignmentSchema = createAssignmentSchema;
export type CreateBreakPolicyAssignmentInput = z.infer<typeof createBreakPolicyAssignmentSchema>;

export const breakPolicyAssignmentSchema = z
  .object({
    id: uuidSchema,
    breakPolicy: namedRefSchema,
    scopeType: assignmentScopeTypeSchema,
    scopeId: uuidSchema,
    scope: namedRefSchema.nullable(),
    effectiveFrom: nullableInstantSchema,
    effectiveTo: nullableInstantSchema,
    isActive: z.boolean(),
    createdBy: namedRefSchema.nullable(),
    createdAt: instantSchema,
  })
  .meta({ id: "BreakPolicyAssignment" });
export type BreakPolicyAssignment = z.infer<typeof breakPolicyAssignmentSchema>;

export const breakPolicyAssignmentResponseSchema = z
  .object({ assignment: breakPolicyAssignmentSchema })
  .meta({ id: "BreakPolicyAssignmentResponse" });
export type BreakPolicyAssignmentResponse = z.infer<typeof breakPolicyAssignmentResponseSchema>;
export const listBreakPolicyAssignmentsResponseSchema = z
  .object({ assignments: z.array(breakPolicyAssignmentSchema) })
  .meta({ id: "ListBreakPolicyAssignmentsResponse" });
export type ListBreakPolicyAssignmentsResponse = z.infer<
  typeof listBreakPolicyAssignmentsResponseSchema
>;

/** `POST /api/organisations/current/default-break-policy` — `null` clears the default. */
export const setDefaultBreakPolicySchema = z
  .object({ breakPolicyId: uuidSchema.nullable() })
  .strict();
export type SetDefaultBreakPolicyInput = z.infer<typeof setDefaultBreakPolicySchema>;
