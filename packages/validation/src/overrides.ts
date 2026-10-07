import { z } from "zod";
import type { OverrideType, Role } from "@clockoff/shared/enums";
import {
  cursorPaginationQuerySchema,
  isoDateTimeSchema,
  paginatedResponseSchema,
  uuidSchema,
} from "./common";
import {
  breakRestrictionBehaviourSchema,
  overrideTypeSchema,
  restrictionCategorySchema,
} from "./enumSchemas";
import { restrictionCategoryListSchema } from "./policies";
import { instantSchema, nullableInstantSchema, queryListSchema } from "./primitives";
import { actorRefSchema, employeeSummarySchema } from "./refs";

/**
 * Manager overrides (§5 overrides). A manager can exempt an employee for a while, end Work Mode early,
 * relax restrictions temporarily or apply an organisation-wide emergency override.
 *
 * Duration cap: managers and admins may create overrides of at most `maxDurationMinutes` (24 h); only
 * OWNERs may go up to `ownerMaxDurationMinutes`. The schema accepts the owner cap (it does not know the
 * caller's role); the handler MUST enforce the role cap with `overrideMaxDurationMinutes(role)` and reply
 * OVERRIDE_TOO_LONG. The caps are also published in the OpenAPI document via `x-max-duration-minutes`.
 */
export const OVERRIDE_LIMITS = {
  defaultDurationMinutes: 60,
  /** Cap for ADMIN / MANAGER. */
  maxDurationMinutes: 24 * 60,
  /** Hard cap, OWNER only (7 days). */
  ownerMaxDurationMinutes: 7 * 24 * 60,
  reasonMinLength: 5,
  reasonMaxLength: 500,
} as const;

export function overrideMaxDurationMinutes(role: Role): number {
  switch (role) {
    case "OWNER":
      return OVERRIDE_LIMITS.ownerMaxDurationMinutes;
    case "ADMIN":
    case "MANAGER":
      return OVERRIDE_LIMITS.maxDurationMinutes;
    default: {
      const unreachable: never = role;
      throw new Error(`Unhandled role ${String(unreachable)}`);
    }
  }
}

/** Overrides that apply to the whole organisation when no employee is given. */
export const ORG_WIDE_OVERRIDE_TYPES = [
  "EMERGENCY_POLICY_OVERRIDE",
] as const satisfies readonly OverrideType[];

export function overrideTypeAllowsOrgWide(type: OverrideType): boolean {
  switch (type) {
    case "EMERGENCY_POLICY_OVERRIDE":
      return true;
    case "EXEMPT_TEMPORARILY":
    case "END_WORK_MODE_EARLY":
    case "TEMPORARY_EXCEPTION":
      return false;
    default: {
      const unreachable: never = type;
      throw new Error(`Unhandled override type ${String(unreachable)}`);
    }
  }
}

/**
 * Whether an override type reads `payload`. Only TEMPORARY_EXCEPTION does (the state machine relaxes
 * restrictions like a break with the payload's behaviour); the lifting types ignore it, so the API rejects
 * a payload on them rather than storing data that has no effect.
 */
export function overrideTypeAcceptsPayload(type: OverrideType): boolean {
  switch (type) {
    case "TEMPORARY_EXCEPTION":
      return true;
    case "EXEMPT_TEMPORARILY":
    case "END_WORK_MODE_EARLY":
    case "EMERGENCY_POLICY_OVERRIDE":
      return false;
    default: {
      const unreachable: never = type;
      throw new Error(`Unhandled override type ${String(unreachable)}`);
    }
  }
}

/**
 * `payload` of `POST /api/overrides` (TEMPORARY_EXCEPTION only), strict allow-list. Either an explicit
 * behaviour (`restrictionBehaviour` + `relaxedCategories` for RELAX_CATEGORIES; RELAX_ALL when omitted) OR a
 * `breakPolicyId` whose behaviour the handler resolves and merges in before storing — never both, so there
 * is no ambiguity about which one wins. The state machine reads only `restrictionBehaviour` /
 * `relaxedCategories` (`OverridePayloadLike` in @clockoff/shared).
 */
export const overridePayloadSchema = z
  .object({
    restrictionBehaviour: breakRestrictionBehaviourSchema.optional(),
    /** Only with RELAX_CATEGORIES (at least one). */
    relaxedCategories: restrictionCategoryListSchema.optional(),
    /** Break policy whose behaviour applies for the duration; the handler merges it into the payload. */
    breakPolicyId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.breakPolicyId !== undefined &&
      (value.restrictionBehaviour !== undefined || value.relaxedCategories !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["breakPolicyId"],
        message: "Use either breakPolicyId or restrictionBehaviour/relaxedCategories, not both",
      });
    }
    if (value.restrictionBehaviour === "RELAX_CATEGORIES") {
      if ((value.relaxedCategories ?? []).length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["relaxedCategories"],
          message: "Choose at least one category to relax with RELAX_CATEGORIES",
        });
      }
    } else if (value.relaxedCategories !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["relaxedCategories"],
        message: "relaxedCategories is only used with restrictionBehaviour RELAX_CATEGORIES",
      });
    }
  })
  .meta({ id: "OverridePayloadInput" });
export type OverridePayloadInput = z.infer<typeof overridePayloadSchema>;

/**
 * `ManagerOverride.payload` as stored and returned: the request payload after the handler merged a
 * referenced break policy's behaviour, so `breakPolicyId` may sit next to `restrictionBehaviour`. `{}` for
 * the lifting override types. Open (not strict) like every response object.
 */
export const overridePayloadResponseSchema = z
  .object({
    restrictionBehaviour: breakRestrictionBehaviourSchema.optional(),
    relaxedCategories: z.array(restrictionCategorySchema).optional(),
    breakPolicyId: uuidSchema.optional(),
  })
  .meta({ id: "OverridePayload" });
export type OverridePayload = z.infer<typeof overridePayloadResponseSchema>;

/** `POST /api/overrides` */
export const createOverrideSchema = z
  .object({
    /** Required except for EMERGENCY_POLICY_OVERRIDE, which is organisation-wide when omitted. */
    employeeId: uuidSchema.optional(),
    type: overrideTypeSchema,
    reason: z
      .string()
      .trim()
      .min(OVERRIDE_LIMITS.reasonMinLength)
      .max(OVERRIDE_LIMITS.reasonMaxLength),
    /** Absolute expiry. Mutually exclusive with `durationMinutes`. */
    expiresAt: isoDateTimeSchema.optional(),
    /** Minutes from now. Defaults to 60 when neither this nor `expiresAt` is given. */
    durationMinutes: z
      .int()
      .min(1)
      .max(OVERRIDE_LIMITS.ownerMaxDurationMinutes)
      .optional()
      .meta({
        "x-max-duration-minutes": OVERRIDE_LIMITS.maxDurationMinutes,
        "x-owner-max-duration-minutes": OVERRIDE_LIMITS.ownerMaxDurationMinutes,
        description: `Default ${OVERRIDE_LIMITS.defaultDurationMinutes}. Max ${OVERRIDE_LIMITS.maxDurationMinutes} unless the caller is an OWNER (max ${OVERRIDE_LIMITS.ownerMaxDurationMinutes}); enforced by the handler (OVERRIDE_TOO_LONG).`,
      }),
    /** TEMPORARY_EXCEPTION only (rejected for the other types). */
    payload: overridePayloadSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.payload !== undefined && !overrideTypeAcceptsPayload(value.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["payload"],
        message: "payload is only used by TEMPORARY_EXCEPTION overrides",
      });
    }
    if (value.expiresAt !== undefined && value.durationMinutes !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["durationMinutes"],
        message: "Use either expiresAt or durationMinutes",
      });
    }
    if (value.employeeId === undefined && !overrideTypeAllowsOrgWide(value.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["employeeId"],
        message: "employeeId is required for this override type",
      });
    }
  });
export type CreateOverrideInput = z.infer<typeof createOverrideSchema>;

export type OverrideWindowResult =
  | { ok: true; startsAt: Date; expiresAt: Date; durationMinutes: number }
  | { ok: false; code: "OVERRIDE_TOO_LONG" | "VALIDATION_ERROR"; message: string };

/**
 * Resolves `expiresAt` / `durationMinutes` (default 60) into an absolute window starting at `now` and
 * applies the role cap. Pure, so the handler and its tests share one implementation.
 */
export function resolveOverrideWindow(
  input: Pick<CreateOverrideInput, "expiresAt" | "durationMinutes">,
  now: Date,
  role: Role,
): OverrideWindowResult {
  const maxMinutes = overrideMaxDurationMinutes(role);
  let expiresAtMs: number;
  if (input.expiresAt !== undefined) {
    expiresAtMs = Date.parse(input.expiresAt);
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= now.getTime()) {
      return { ok: false, code: "VALIDATION_ERROR", message: "expiresAt must be in the future" };
    }
  } else {
    expiresAtMs =
      now.getTime() + (input.durationMinutes ?? OVERRIDE_LIMITS.defaultDurationMinutes) * 60_000;
  }
  const durationMinutes = Math.ceil((expiresAtMs - now.getTime()) / 60_000);
  if (durationMinutes > maxMinutes) {
    return {
      ok: false,
      code: "OVERRIDE_TOO_LONG",
      message: `Overrides can last at most ${maxMinutes} minutes for your role`,
    };
  }
  return {
    ok: true,
    startsAt: new Date(now.getTime()),
    expiresAt: new Date(expiresAtMs),
    durationMinutes,
  };
}

/** `POST /api/overrides/:id/revoke` */
export const revokeOverrideSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();
export type RevokeOverrideInput = z.infer<typeof revokeOverrideSchema>;

/** Derived from startsAt / expiresAt / revokedAt at read time. */
export const OVERRIDE_STATUSES = ["SCHEDULED", "ACTIVE", "EXPIRED", "REVOKED"] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];
export const overrideStatusSchema = z.enum(OVERRIDE_STATUSES).meta({ id: "OverrideStatus" });

export function deriveOverrideStatus(
  override: { startsAt: Date; expiresAt: Date; revokedAt: Date | null },
  now: Date,
): OverrideStatus {
  if (override.revokedAt !== null) return "REVOKED";
  if (override.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  if (override.startsAt.getTime() > now.getTime()) return "SCHEDULED";
  return "ACTIVE";
}

/** `GET /api/overrides` */
export const overrideQuerySchema = cursorPaginationQuerySchema.extend({
  employeeId: uuidSchema.optional(),
  type: queryListSchema(overrideTypeSchema).optional(),
  status: queryListSchema(overrideStatusSchema).optional(),
});
export type OverrideQuery = z.infer<typeof overrideQuerySchema>;

export const overrideSchema = z
  .object({
    id: uuidSchema,
    type: overrideTypeSchema,
    status: overrideStatusSchema,
    reason: z.string(),
    /** Null for an organisation-wide override. */
    employee: employeeSummarySchema.nullable(),
    createdBy: actorRefSchema.nullable(),
    startsAt: instantSchema,
    expiresAt: instantSchema,
    revokedAt: nullableInstantSchema,
    payload: overridePayloadResponseSchema,
    createdAt: instantSchema,
  })
  .meta({ id: "Override" });
export type Override = z.infer<typeof overrideSchema>;

export const overrideResponseSchema = z
  .object({ override: overrideSchema })
  .meta({ id: "OverrideResponse" });
export type OverrideResponse = z.infer<typeof overrideResponseSchema>;

export const listOverridesResponseSchema = paginatedResponseSchema(overrideSchema).meta({
  id: "ListOverridesResponse",
});
export type ListOverridesResponse = z.infer<typeof listOverridesResponseSchema>;
