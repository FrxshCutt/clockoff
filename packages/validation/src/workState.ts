import { z } from "zod";
import type { RelaxationSource } from "@workmode/shared/workMode/types";
import { uuidSchema } from "./common";
import {
  breakEndReasonSchema,
  breakRestrictionBehaviourSchema,
  breakSessionStatusSchema,
  effectiveRestrictionSchema,
  overrideTypeSchema,
  permissionStateSchema,
  restrictionCategorySchema,
  workModeStateSchema,
  workStateSourceSchema,
} from "./enumSchemas";
import { instantSchema, nullableInstantSchema } from "./primitives";

/**
 * Work Mode state shapes shared by the manager API (`GET /employees/:id/state`) and the mobile API
 * (`GET /sync`, `POST /device/state`). `expectedStateSchema` is the wire form of `ExpectedStateJson` produced
 * by `toExpectedStateJson(computeExpectedState(...))` in @workmode/shared — the type equality is asserted in
 * workState.test.ts, so a change to the state machine output fails the build here first.
 */

// ── Expected state (state machine output, §6.2) ─────────────────────────────

export const shiftRefSchema = z
  .object({ id: uuidSchema, startsAt: instantSchema, endsAt: instantSchema })
  .meta({ id: "ShiftRef" });
export type ShiftRefJson = z.infer<typeof shiftRefSchema>;

export const breakRefSchema = z
  .object({
    id: uuidSchema,
    shiftId: uuidSchema,
    startedAt: instantSchema,
    plannedEndsAt: instantSchema,
    /** Effective end: min(plannedEndsAt, endedAt, end of the working interval). */
    endsAt: instantSchema,
  })
  .meta({ id: "BreakRef" });

export const overrideRefSchema = z
  .object({
    id: uuidSchema,
    type: overrideTypeSchema,
    startsAt: instantSchema,
    expiresAt: instantSchema,
    /** Null for an organisation-wide override. */
    employeeId: uuidSchema.nullable(),
  })
  .meta({ id: "OverrideRef" });

export const workingIntervalSchema = z
  .object({
    startsAt: instantSchema,
    endsAt: instantSchema,
    shiftIds: z.array(uuidSchema),
    shifts: z.array(shiftRefSchema),
  })
  .meta({ id: "WorkingInterval", description: "Union of overlapping/adjacent scheduled shifts." });

/** Values of `RelaxationSource` (@workmode/shared, a type only); the ExpectedState type test pins equality. */
export const RELAXATION_SOURCES = [
  "BREAK",
  "OVERRIDE",
] as const satisfies readonly RelaxationSource[];
export const relaxationSourceSchema = z.enum(RELAXATION_SOURCES).meta({ id: "RelaxationSource" });

export const restrictionRelaxationSchema = z
  .object({
    source: relaxationSourceSchema,
    restrictionBehaviour: breakRestrictionBehaviourSchema,
    /** Stored snapshot (only meaningful for RELAX_CATEGORIES). */
    relaxedCategories: z.array(restrictionCategorySchema),
    /** What the device actually unblocks (every category for RELAX_ALL). */
    liftedCategories: z.array(restrictionCategorySchema),
  })
  .meta({
    id: "RestrictionRelaxation",
    description: "Present exactly when effectiveRestriction is BREAK_RELAXED.",
  });

export const expectedStateSchema = z
  .object({
    state: workModeStateSchema,
    /** What the restriction engine should apply right now. */
    effectiveRestriction: effectiveRestrictionSchema,
    restrictionsShouldBeActive: z.boolean(),
    computedAt: instantSchema,
    timezone: z.string().nullable(),
    permissionState: permissionStateSchema,
    activeShift: shiftRefSchema.nullable(),
    upcomingShift: shiftRefSchema.nullable(),
    activeBreak: breakRefSchema.nullable(),
    activeOverride: overrideRefSchema.nullable(),
    workingInterval: workingIntervalSchema.nullable(),
    relaxation: restrictionRelaxationSchema.nullable(),
    /** Earliest future instant at which this output changes; null when nothing is scheduled. */
    nextTransitionAt: nullableInstantSchema,
  })
  .meta({
    id: "ExpectedState",
    description:
      "Server-computed Work Mode state (computeExpectedState). Same contract as the iOS engine.",
  });
export type ExpectedStateResponse = z.infer<typeof expectedStateSchema>;

// ── Breaks ──────────────────────────────────────────────────────────────────

/** Allowance snapshot for the current shift (`computeBreakAllowance` in @workmode/shared). */
export const breakAllowanceSchema = z
  .object({
    breaksTaken: z.int().min(0),
    breaksRemaining: z.int().min(0),
    minutesUsed: z.int().min(0),
    minutesRemaining: z.int().min(0),
    /** Earliest instant another break could start; null when no further break is possible this shift. */
    nextEligibleAt: nullableInstantSchema,
    canStartNow: z.boolean(),
  })
  .meta({ id: "BreakAllowance" });
export type BreakAllowanceResponse = z.infer<typeof breakAllowanceSchema>;

export const breakSessionSchema = z
  .object({
    id: uuidSchema,
    /** Idempotency key generated on the device. */
    clientBreakId: z.string(),
    shiftId: uuidSchema,
    startedAt: instantSchema,
    /** Absolute UTC end; the device lifts the relaxation at this instant even if the app is closed. */
    plannedEndsAt: instantSchema,
    endedAt: nullableInstantSchema,
    status: breakSessionStatusSchema,
    endReason: breakEndReasonSchema.nullable(),
    /** Behaviour snapshot taken when the break started (a policy change mid-break does not alter it). */
    restrictionBehaviour: breakRestrictionBehaviourSchema,
    relaxedCategories: z.array(restrictionCategorySchema),
  })
  .meta({ id: "BreakSession" });
export type BreakSessionResponse = z.infer<typeof breakSessionSchema>;

// ── Stored work state (EmployeeWorkState row) ───────────────────────────────

export const employeeWorkStateSchema = z
  .object({
    state: workModeStateSchema,
    stateSince: instantSchema,
    source: workStateSourceSchema,
    expectedState: workModeStateSchema.nullable(),
    expectedRestriction: effectiveRestrictionSchema.nullable(),
    expectedComputedAt: nullableInstantSchema,
    reportedState: workModeStateSchema.nullable(),
    reportedAt: nullableInstantSchema,
    nextTransitionAt: nullableInstantSchema,
    attentionReason: z.string().nullable(),
    activeShiftId: uuidSchema.nullable(),
    activeBreakSessionId: uuidSchema.nullable(),
    breaksTakenCount: z.int().min(0),
    breakMinutesUsed: z.int().min(0),
    lastUpdatedAt: instantSchema,
  })
  .meta({
    id: "EmployeeWorkState",
    description: "Last device-reported state and server-expected state.",
  });
export type EmployeeWorkStateResponse = z.infer<typeof employeeWorkStateSchema>;
