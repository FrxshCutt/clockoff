import { z } from "zod";
import { ASSIGNMENT_SCOPE_TYPES, RESTRICTION_CATEGORIES } from "@clockoff/shared/enums";
import { isoDateTimeSchema, nonEmptyString, optionalString, uuidSchema } from "./common";
import {
  activationModeSchema,
  assignmentScopeTypeSchema,
  breakRestrictionBehaviourSchema,
  policyStatusSchema,
  restrictionCategorySchema,
} from "./enumSchemas";
import {
  instantSchema,
  nullableInstantSchema,
  patchStringSchema,
  queryBooleanSchema,
  queryListSchema,
} from "./primitives";
import { namedRefSchema } from "./refs";

// ── Restriction config (PolicyVersion.restriction_config, §3) ───────────────

export const RESTRICTION_CONFIG_LIMITS = {
  shieldMessageMaxLength: 120,
  preShiftWarningMaxMinutes: 120,
  alwaysAllowedNoteMaxItems: 20,
  alwaysAllowedNoteMaxLength: 200,
} as const;

function allUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * A set of restriction categories: known values only, no duplicates, at most one of each. Used by the
 * restriction config, the break behaviour (policy default, break policy, override payload).
 */
export const restrictionCategoryListSchema = z
  .array(restrictionCategorySchema)
  .max(RESTRICTION_CATEGORIES.length)
  .refine(allUnique, "Categories must be unique")
  .meta({ uniqueItems: true });
const restrictionCategoriesSchema = restrictionCategoryListSchema;

const restrictionConfigBase = z
  .object({
    /** App categories restricted while Work Mode is active. At least one. */
    categories: restrictionCategoriesSchema.min(1),
    /** When true the employee must pick the apps/categories to shield on their own phone (recommended). */
    requireEmployeeAppSelection: z.boolean(),
    /** Free-text notes shown to employees about what is always allowed (e.g. "Phone, Messages, Maps"). */
    alwaysAllowedNote: z
      .array(z.string().trim().min(1).max(RESTRICTION_CONFIG_LIMITS.alwaysAllowedNoteMaxLength))
      .max(RESTRICTION_CONFIG_LIMITS.alwaysAllowedNoteMaxItems),
    /** Message shown on the iOS shield screen. */
    shieldMessage: z
      .string()
      .trim()
      .min(1)
      .max(RESTRICTION_CONFIG_LIMITS.shieldMessageMaxLength)
      .optional(),
    activationMode: activationModeSchema,
    /** Minutes before a shift at which the device shows "starting soon" (0 disables). */
    preShiftWarningMinutes: z.int().min(0).max(RESTRICTION_CONFIG_LIMITS.preShiftWarningMaxMinutes),
  })
  .strict();

export const restrictionConfigSchema = restrictionConfigBase.meta({
  id: "RestrictionConfig",
  description:
    "PolicyVersion.restriction_config — what a Work Policy restricts and how it activates.",
});
export type RestrictionConfig = z.infer<typeof restrictionConfigSchema>;

const breakBehaviourDefaultBase = z
  .object({
    restrictionBehaviour: breakRestrictionBehaviourSchema,
    /** Categories relaxed during a break when behaviour is RELAX_CATEGORIES (ignored otherwise). */
    relaxedCategories: restrictionCategoriesSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.restrictionBehaviour === "RELAX_CATEGORIES" && value.relaxedCategories.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["relaxedCategories"],
        message: "Choose at least one category to relax, or use RELAX_ALL / KEEP_RESTRICTIONS",
      });
    }
  });

export const breakBehaviourDefaultSchema = breakBehaviourDefaultBase.meta({
  id: "BreakBehaviourDefault",
  description: "PolicyVersion.break_behaviour_default — applied when no Break Policy resolves.",
});
export type BreakBehaviourDefault = z.infer<typeof breakBehaviourDefaultSchema>;

export const BREAK_BEHAVIOUR_DEFAULT: BreakBehaviourDefault = {
  restrictionBehaviour: "RELAX_ALL",
  relaxedCategories: [],
};

// ── Policy & versions ───────────────────────────────────────────────────────

export const policyVersionSchema = z
  .object({
    id: uuidSchema,
    policyId: uuidSchema,
    versionNumber: z.int().min(1),
    restrictionConfig: restrictionConfigSchema,
    breakBehaviourDefault: breakBehaviourDefaultSchema,
    changeNote: z.string().nullable(),
    /** Null while the version is an unpublished draft. */
    publishedAt: nullableInstantSchema,
    createdBy: namedRefSchema.nullable(),
    createdAt: instantSchema,
  })
  .meta({ id: "PolicyVersion" });
export type PolicyVersion = z.infer<typeof policyVersionSchema>;

export const policySchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    description: z.string().nullable(),
    status: policyStatusSchema,
    /** Published version devices receive. Null for a never-published draft. */
    currentVersion: policyVersionSchema.nullable(),
    /** Unpublished edits newer than `currentVersion`, if any. */
    draftVersion: policyVersionSchema.nullable(),
    isDefault: z.boolean(),
    assignmentCount: z.int().min(0),
    /** Employees whose resolved policy is this one (direct, team, location, org or default). */
    assignedEmployeeCount: z.int().min(0),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .meta({ id: "Policy" });
export type Policy = z.infer<typeof policySchema>;

export const policyQuerySchema = z.object({
  status: queryListSchema(policyStatusSchema).optional(),
  search: z.string().trim().max(100).optional(),
  includeArchived: queryBooleanSchema.optional(),
});
export type PolicyQuery = z.infer<typeof policyQuerySchema>;

/** `POST /api/policies` — creates the policy with a draft version 1. */
export const createPolicySchema = z
  .object({
    name: nonEmptyString(120),
    description: optionalString(500),
    restrictionConfig: restrictionConfigSchema,
    breakBehaviourDefault: breakBehaviourDefaultSchema.optional(),
  })
  .strict();
export type CreatePolicyInput = z.infer<typeof createPolicySchema>;

/** `PATCH /api/policies/:id` — config changes create/replace the draft version; publish to roll out. */
export const updatePolicySchema = z
  .object({
    name: nonEmptyString(120).optional(),
    description: patchStringSchema(500),
    restrictionConfig: restrictionConfigSchema.optional(),
    breakBehaviourDefault: breakBehaviourDefaultSchema.optional(),
  })
  .strict();
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

/** `POST /api/policies/:id/publish` */
export const publishPolicySchema = z
  .object({ changeNote: z.string().trim().max(500).optional() })
  .strict();
export type PublishPolicyInput = z.infer<typeof publishPolicySchema>;

/** `POST /api/policies/:id/duplicate` */
export const duplicatePolicySchema = z.object({ name: nonEmptyString(120).optional() }).strict();
export type DuplicatePolicyInput = z.infer<typeof duplicatePolicySchema>;

export const listPoliciesResponseSchema = z
  .object({ policies: z.array(policySchema) })
  .meta({ id: "ListPoliciesResponse" });
export type ListPoliciesResponse = z.infer<typeof listPoliciesResponseSchema>;

export const policyResponseSchema = z
  .object({ policy: policySchema })
  .meta({ id: "PolicyResponse" });
export type PolicyResponse = z.infer<typeof policyResponseSchema>;

export const policyVersionsResponseSchema = z
  .object({ versions: z.array(policyVersionSchema) })
  .meta({ id: "PolicyVersionsResponse" });
export type PolicyVersionsResponse = z.infer<typeof policyVersionsResponseSchema>;

// ── Resolution ──────────────────────────────────────────────────────────────

export const POLICY_RESOLUTION_SOURCES = [...ASSIGNMENT_SCOPE_TYPES, "DEFAULT"] as const;
export type PolicyResolutionSource = (typeof POLICY_RESOLUTION_SOURCES)[number];
export const policyResolutionSourceSchema = z.enum(POLICY_RESOLUTION_SOURCES).meta({
  id: "PolicyResolutionSource",
  description:
    "Which assignment scope produced the resolved policy; DEFAULT = organisation default.",
});

/** `{ id, name, resolvedFrom }` for an employee's resolved Work Policy or Break Policy. */
export const resolvedPolicyRefSchema = z
  .object({ id: uuidSchema, name: z.string(), resolvedFrom: policyResolutionSourceSchema })
  .meta({ id: "ResolvedPolicyRef" });
export type ResolvedPolicyRef = z.infer<typeof resolvedPolicyRefSchema>;

// ── Assignments ─────────────────────────────────────────────────────────────

/** Shared by policy and break-policy assignments. */
export const createAssignmentSchema = z
  .object({
    scopeType: assignmentScopeTypeSchema,
    /** Organisation / location / team / employee id matching `scopeType`. */
    scopeId: uuidSchema,
    effectiveFrom: isoDateTimeSchema.optional(),
    effectiveTo: isoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.effectiveFrom !== undefined &&
      value.effectiveTo !== undefined &&
      Date.parse(value.effectiveTo) <= Date.parse(value.effectiveFrom)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["effectiveTo"],
        message: "effectiveTo must be after effectiveFrom",
      });
    }
  });
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;

export const createPolicyAssignmentSchema = createAssignmentSchema;
export type CreatePolicyAssignmentInput = CreateAssignmentInput;

export const policyAssignmentSchema = z
  .object({
    id: uuidSchema,
    policy: namedRefSchema,
    scopeType: assignmentScopeTypeSchema,
    scopeId: uuidSchema,
    /** Name of the scoped location / team / employee (null for ORGANISATION or a deleted target). */
    scope: namedRefSchema.nullable(),
    effectiveFrom: nullableInstantSchema,
    effectiveTo: nullableInstantSchema,
    isActive: z.boolean(),
    createdBy: namedRefSchema.nullable(),
    createdAt: instantSchema,
  })
  .meta({ id: "PolicyAssignment" });
export type PolicyAssignment = z.infer<typeof policyAssignmentSchema>;

export const policyAssignmentResponseSchema = z
  .object({ assignment: policyAssignmentSchema })
  .meta({ id: "PolicyAssignmentResponse" });
export type PolicyAssignmentResponse = z.infer<typeof policyAssignmentResponseSchema>;
export const listPolicyAssignmentsResponseSchema = z
  .object({ assignments: z.array(policyAssignmentSchema) })
  .meta({ id: "ListPolicyAssignmentsResponse" });
export type ListPolicyAssignmentsResponse = z.infer<typeof listPolicyAssignmentsResponseSchema>;

/** `POST /api/organisations/current/default-policy` — `null` clears the default. */
export const setDefaultPolicySchema = z.object({ policyId: uuidSchema.nullable() }).strict();
export type SetDefaultPolicyInput = z.infer<typeof setDefaultPolicySchema>;
