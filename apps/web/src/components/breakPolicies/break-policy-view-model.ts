import {
  BREAK_RESTRICTION_BEHAVIOURS,
  RESTRICTION_CATEGORY_LABELS,
  type BreakRestrictionBehaviour,
  type RestrictionCategory,
} from "@workmode/shared/enums";
import {
  BREAK_POLICY_DEFAULTS,
  BREAK_POLICY_LIMITS,
  breakPolicyRulesSchema,
  type BreakPolicy,
  type BreakPolicyRules,
  type CreateBreakPolicyInput,
  type UpdateBreakPolicyInput,
} from "@workmode/validation/breakPolicies";
import { z } from "zod";
import { formatDurationMinutes } from "@/lib/format";

/**
 * Pure helpers behind the Break Rules pages: summary lines, behaviour copy, presets, form ↔ API mapping and
 * the delete guard. No React here so everything is unit-testable in node.
 */

// ── Break behaviour ─────────────────────────────────────────────────────────

export interface BreakBehaviourOption {
  readonly value: BreakRestrictionBehaviour;
  /** Title in pickers, e.g. "Relax everything". */
  readonly label: string;
  /** Lower-case fragment for summary lines, e.g. "relax all". */
  readonly summary: string;
  readonly description: string;
}

export const BREAK_BEHAVIOUR_META: Record<BreakRestrictionBehaviour, BreakBehaviourOption> = {
  RELAX_ALL: {
    value: "RELAX_ALL",
    label: "Relax everything",
    summary: "relax all",
    description:
      "Every restricted app becomes available for the length of the break, then Work Mode switches back on automatically.",
  },
  RELAX_CATEGORIES: {
    value: "RELAX_CATEGORIES",
    label: "Relax some categories",
    summary: "relax some",
    description:
      "Only the categories you choose open up during a break. Everything else stays restricted. Needs a second Screen Time selection on each phone.",
  },
  KEEP_RESTRICTIONS: {
    value: "KEEP_RESTRICTIONS",
    label: "Keep restrictions",
    summary: "keep restrictions",
    description:
      "The break is recorded for timekeeping, but the phone stays in Work Mode throughout.",
  },
};

/** The three behaviours in display order, with the explanation shown under each option. */
export const BREAK_BEHAVIOUR_OPTIONS: readonly BreakBehaviourOption[] =
  BREAK_RESTRICTION_BEHAVIOURS.map((value) => BREAK_BEHAVIOUR_META[value]);

/**
 * Honest note shown when RELAX_CATEGORIES is picked: the phone needs two Screen Time selections, and until the
 * second one exists a break keeps every restriction (docs/SCREEN_TIME_IMPLEMENTATION.md §6).
 */
export const RELAX_CATEGORIES_DEVICE_NOTE =
  "Relaxing only some categories needs two Screen Time selections on the employee's phone: the apps restricted during shifts, and the smaller set that stays restricted on breaks. Employees make both selections in the app; the employer never sees either. Until an employee has made the second selection, their breaks keep every restriction and the app asks them to finish it.";

/** `relax all` · `relax 2 categories` · `keep restrictions` — the behaviour fragment of a summary line. */
export function describeBreakBehaviour(
  behaviour: BreakRestrictionBehaviour,
  relaxedCategories: readonly RestrictionCategory[],
): string {
  if (behaviour !== "RELAX_CATEGORIES") return BREAK_BEHAVIOUR_META[behaviour].summary;
  const count = relaxedCategories.length;
  if (count === 0) return BREAK_BEHAVIOUR_META.RELAX_CATEGORIES.summary;
  if (count === 1)
    return `relax ${RESTRICTION_CATEGORY_LABELS[relaxedCategories[0] as RestrictionCategory].toLowerCase()}`;
  return `relax ${count} categories`;
}

// ── Summary line ────────────────────────────────────────────────────────────

export function formatBreakCount(count: number): string {
  return `${count} ${count === 1 ? "break" : "breaks"}`;
}

/**
 * One line for list rows and cards: `2 breaks · 15 min each · relax all`. The total allowance is added only
 * when it caps the breaks (`2 breaks · 20 min each · 30 min total · …`); disabled rules read `Breaks off`.
 */
export function summariseBreakPolicy(rules: BreakPolicyRules): string {
  if (!rules.breaksEnabled) return "Breaks off";
  const parts = [
    formatBreakCount(rules.maxBreaksPerShift),
    `${formatDurationMinutes(rules.maxBreakDurationMinutes)} each`,
  ];
  if (rules.maxTotalBreakMinutes < rules.maxBreaksPerShift * rules.maxBreakDurationMinutes) {
    parts.push(`${formatDurationMinutes(rules.maxTotalBreakMinutes)} total`);
  }
  parts.push(describeBreakBehaviour(rules.restrictionBehaviour, rules.relaxedCategories));
  return parts.join(" · ");
}

/** Second line for detail views: who can start breaks and the timing gates. */
export function describeBreakTriggers(rules: BreakPolicyRules): string {
  if (!rules.breaksEnabled) return "Employees cannot take breaks under these rules.";
  const who: string[] = [];
  if (rules.employeeTriggeredAllowed) who.push("employees can start breaks from the app");
  if (rules.scheduledBreaksAllowed) who.push("scheduled breaks start automatically");
  const trigger = who.length > 0 ? who.join(" and ") : "only managers can start breaks";
  const timing: string[] = [];
  if (rules.minMinutesAfterShiftStart > 0)
    timing.push(`not in the first ${formatDurationMinutes(rules.minMinutesAfterShiftStart)}`);
  if (rules.minGapBetweenBreaksMinutes > 0)
    timing.push(`at least ${formatDurationMinutes(rules.minGapBetweenBreaksMinutes)} apart`);
  const sentence = trigger.charAt(0).toUpperCase() + trigger.slice(1);
  return timing.length > 0 ? `${sentence}; ${timing.join(", ")}.` : `${sentence}.`;
}

// ── Presets ─────────────────────────────────────────────────────────────────

export interface BreakPolicyPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rules: BreakPolicyRules;
}

/** Starting points offered when creating Break Rules. Each validates against `breakPolicyRulesSchema`. */
export const BREAK_POLICY_PRESETS: readonly BreakPolicyPreset[] = [
  {
    id: "standard",
    name: "Standard Break",
    description:
      "Two 15-minute breaks per shift, at least an hour apart, with the phone fully available on break.",
    rules: {
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
    },
  },
  {
    id: "lunch",
    name: "Lunch Shift",
    description: "One 30-minute lunch break, no earlier than two hours into the shift.",
    rules: {
      breaksEnabled: true,
      maxBreaksPerShift: 1,
      maxBreakDurationMinutes: 30,
      maxTotalBreakMinutes: 30,
      minGapBetweenBreaksMinutes: 0,
      minMinutesAfterShiftStart: 120,
      employeeTriggeredAllowed: true,
      scheduledBreaksAllowed: true,
      restrictionBehaviour: "RELAX_ALL",
      relaxedCategories: [],
    },
  },
  {
    id: "no-unlock",
    name: "No Phone Break Unlock",
    description: "Breaks are recorded for timekeeping but the phone stays in Work Mode throughout.",
    rules: {
      breaksEnabled: true,
      maxBreaksPerShift: 2,
      maxBreakDurationMinutes: 15,
      maxTotalBreakMinutes: 30,
      minGapBetweenBreaksMinutes: 60,
      minMinutesAfterShiftStart: 60,
      employeeTriggeredAllowed: true,
      scheduledBreaksAllowed: true,
      restrictionBehaviour: "KEEP_RESTRICTIONS",
      relaxedCategories: [],
    },
  },
];

// ── Form ────────────────────────────────────────────────────────────────────

/**
 * The API's rule set (same constraints and cross-field checks as `breakPolicyRulesSchema`) plus name and
 * description, so client validation never drifts from the server's.
 */
export const breakPolicyFormSchema = breakPolicyRulesSchema.extend({
  name: z
    .string()
    .trim()
    .min(1, "Give these break rules a name")
    .max(120, "Keep the name under 120 characters"),
  description: z.string().trim().max(500, "Keep the description under 500 characters"),
});
export type BreakPolicyFormValues = z.infer<typeof breakPolicyFormSchema>;

/** The rule keys of `BreakPolicyRules`, for picking them out of wider objects (form values carry name/description too). */
export const BREAK_RULE_KEYS = [
  "breaksEnabled",
  "maxBreaksPerShift",
  "maxBreakDurationMinutes",
  "maxTotalBreakMinutes",
  "minGapBetweenBreaksMinutes",
  "minMinutesAfterShiftStart",
  "employeeTriggeredAllowed",
  "scheduledBreaksAllowed",
  "restrictionBehaviour",
  "relaxedCategories",
] as const satisfies readonly (keyof BreakPolicyRules)[];

export function pickBreakRules(source: BreakPolicyRules): BreakPolicyRules {
  return {
    breaksEnabled: source.breaksEnabled,
    maxBreaksPerShift: source.maxBreaksPerShift,
    maxBreakDurationMinutes: source.maxBreakDurationMinutes,
    maxTotalBreakMinutes: source.maxTotalBreakMinutes,
    minGapBetweenBreaksMinutes: source.minGapBetweenBreaksMinutes,
    minMinutesAfterShiftStart: source.minMinutesAfterShiftStart,
    employeeTriggeredAllowed: source.employeeTriggeredAllowed,
    scheduledBreaksAllowed: source.scheduledBreaksAllowed,
    restrictionBehaviour: source.restrictionBehaviour,
    relaxedCategories: [...source.relaxedCategories],
  };
}

/**
 * Form defaults: an existing policy's values when editing, otherwise a preset (or the API defaults) with an
 * empty name.
 */
export function toBreakPolicyFormValues(
  policy: BreakPolicy | null,
  preset: BreakPolicyPreset | null = null,
): BreakPolicyFormValues {
  if (policy) {
    return { name: policy.name, description: policy.description ?? "", ...pickBreakRules(policy) };
  }
  return {
    name: preset?.name ?? "",
    description: preset?.description ?? "",
    ...pickBreakRules(preset?.rules ?? BREAK_POLICY_DEFAULTS),
  };
}

function normaliseRules(values: BreakPolicyFormValues): BreakPolicyRules {
  const rules = pickBreakRules(values);
  // Relaxed categories only mean something for RELAX_CATEGORIES; never send stale picks with another behaviour.
  if (rules.restrictionBehaviour !== "RELAX_CATEGORIES") rules.relaxedCategories = [];
  return rules;
}

function normaliseDescription(description: string): string | null {
  const trimmed = description.trim();
  return trimmed === "" ? null : trimmed;
}

export function toCreateBreakPolicyInput(values: BreakPolicyFormValues): CreateBreakPolicyInput {
  return {
    name: values.name.trim(),
    description: normaliseDescription(values.description),
    ...normaliseRules(values),
  };
}

/** Full PATCH body (every rule is sent so the server re-validates the complete, consistent set). */
export function toUpdateBreakPolicyInput(values: BreakPolicyFormValues): UpdateBreakPolicyInput {
  return {
    name: values.name.trim(),
    description: normaliseDescription(values.description),
    ...normaliseRules(values),
  };
}

/** Labels, help text and bounds for the numeric rule fields. */
export interface BreakRuleFieldMeta {
  readonly label: string;
  readonly description: string;
  readonly min: number;
  readonly max: number;
  readonly unit: "breaks" | "min";
}

export const BREAK_RULE_FIELD_META: Record<
  | "maxBreaksPerShift"
  | "maxBreakDurationMinutes"
  | "maxTotalBreakMinutes"
  | "minGapBetweenBreaksMinutes"
  | "minMinutesAfterShiftStart",
  BreakRuleFieldMeta
> = {
  maxBreaksPerShift: {
    label: "Breaks per shift",
    description: "The most breaks an employee can take in one shift.",
    min: 0,
    max: BREAK_POLICY_LIMITS.maxBreaksPerShift,
    unit: "breaks",
  },
  maxBreakDurationMinutes: {
    label: "Longest single break",
    description: "A break ends automatically after this long.",
    min: 1,
    max: BREAK_POLICY_LIMITS.maxBreakDurationMinutes,
    unit: "min",
  },
  maxTotalBreakMinutes: {
    label: "Total break time per shift",
    description: "All breaks in a shift add up to no more than this.",
    min: 0,
    max: BREAK_POLICY_LIMITS.maxTotalBreakMinutes,
    unit: "min",
  },
  minGapBetweenBreaksMinutes: {
    label: "Minimum gap between breaks",
    description: "How long after one break ends before the next can start. 0 means no gap.",
    min: 0,
    max: BREAK_POLICY_LIMITS.minGapBetweenBreaksMinutes,
    unit: "min",
  },
  minMinutesAfterShiftStart: {
    label: "Earliest break after shift start",
    description: "No breaks in the first part of a shift. 0 allows a break straight away.",
    min: 0,
    max: BREAK_POLICY_LIMITS.minMinutesAfterShiftStart,
    unit: "min",
  },
};

// ── Guards ──────────────────────────────────────────────────────────────────

export type BreakPolicyDeleteGuard = { blocked: false } | { blocked: true; reasons: string[] };

/** Why `DELETE /api/break-policies/:id` would fail with `POLICY_ASSIGNED`, so the UI can explain instead of trying. */
export function breakPolicyDeleteGuard(
  policy: Pick<BreakPolicy, "isDefault" | "assignmentCount">,
): BreakPolicyDeleteGuard {
  const reasons: string[] = [];
  if (policy.isDefault)
    reasons.push("They are the organisation default. Choose different default Break Rules first.");
  if (policy.assignmentCount > 0) {
    reasons.push(
      `They are assigned to ${policy.assignmentCount} ${policy.assignmentCount === 1 ? "scope" : "scopes"}. Remove those assignments or assign other Break Rules first.`,
    );
  }
  return reasons.length > 0 ? { blocked: true, reasons } : { blocked: false };
}

/** Client-side name/description search over an already-loaded list. */
export function matchesBreakPolicySearch(
  policy: Pick<BreakPolicy, "name" | "description">,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") return true;
  return (
    policy.name.toLowerCase().includes(needle) ||
    (policy.description ?? "").toLowerCase().includes(needle)
  );
}

// ── Live preview & guards ───────────────────────────────────────────────────

/**
 * Summary line for a form that may be half-filled (numbers are NaN while a box is empty). `null` until the
 * rules are complete and consistent, so the preview never reads "NaN min". Only the rule keys are read:
 * the form's whole value object (name, description, …) can be passed straight in — `breakPolicyRulesSchema`
 * is strict and would otherwise reject the extra keys.
 */
export function previewBreakSummary(values: Partial<BreakPolicyRules>): string | null {
  const merged: Record<string, unknown> = { ...BREAK_POLICY_DEFAULTS };
  for (const key of BREAK_RULE_KEYS) {
    if (values[key] !== undefined) merged[key] = values[key];
  }
  const parsed = breakPolicyRulesSchema.safeParse(merged);
  return parsed.success ? summariseBreakPolicy(parsed.data) : null;
}

export type BreakPolicyActionGuard = { ok: true } | { ok: false; reason: string };

/** Break Rules have no publish step: anything not archived can be assigned (`POLICY_ARCHIVED` otherwise). */
export function breakPolicyAssignGuard(
  policy: Pick<BreakPolicy, "status">,
): BreakPolicyActionGuard {
  if (policy.status === "ARCHIVED")
    return { ok: false, reason: "Archived Break Rules can't be assigned." };
  return { ok: true };
}

export function breakPolicySetDefaultGuard(
  policy: Pick<BreakPolicy, "status" | "isDefault">,
): BreakPolicyActionGuard {
  if (policy.isDefault)
    return { ok: false, reason: "These are already the organisation default Break Rules." };
  if (policy.status === "ARCHIVED")
    return { ok: false, reason: "Archived Break Rules can't be the default." };
  return { ok: true };
}

/** `Relax everything` · `Relax some categories (Games, Video)` · `Keep restrictions` — for detail views. */
export function describeBreakBehaviourLabel(
  behaviour: BreakRestrictionBehaviour,
  relaxedCategories: readonly RestrictionCategory[],
): string {
  const label = BREAK_BEHAVIOUR_META[behaviour].label;
  if (behaviour !== "RELAX_CATEGORIES" || relaxedCategories.length === 0) return label;
  return `${label} (${relaxedCategories.map((c) => RESTRICTION_CATEGORY_LABELS[c]).join(", ")})`;
}

/** Who (or what) can start a break under these rules, for detail views. */
export function describeBreakStarters(
  rules: Pick<
    BreakPolicyRules,
    "breaksEnabled" | "employeeTriggeredAllowed" | "scheduledBreaksAllowed"
  >,
): string {
  if (!rules.breaksEnabled) return "Nobody — breaks are off";
  if (rules.employeeTriggeredAllowed && rules.scheduledBreaksAllowed)
    return "Employees from the app, and scheduled breaks";
  if (rules.employeeTriggeredAllowed) return "Employees from the app";
  if (rules.scheduledBreaksAllowed) return "Scheduled breaks only";
  return "Managers only";
}
