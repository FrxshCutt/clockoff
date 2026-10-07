import {
  ACTIVATION_MODES,
  RESTRICTION_CATEGORIES,
  RESTRICTION_CATEGORY_LABELS,
  type ActivationMode,
  type AssignmentScopeType,
  type RestrictionCategory,
} from "@clockoff/shared/enums";
import { SCOPE_TYPE_LABELS } from "@clockoff/shared/policy/explainResolution";
import { POLICY_SCOPE_PRECEDENCE } from "@clockoff/shared/policy/resolvePolicy";
import { DEFAULT_RESTRICTION_CONFIG } from "@clockoff/shared/policy/restrictionConfig";
import {
  activationModeSchema,
  breakRestrictionBehaviourSchema,
} from "@clockoff/validation/enumSchemas";
import {
  BREAK_BEHAVIOUR_DEFAULT,
  RESTRICTION_CONFIG_LIMITS,
  restrictionCategoryListSchema,
  type BreakBehaviourDefault,
  type CreatePolicyInput,
  type Policy,
  type PolicyVersion,
  type RestrictionConfig,
  type UpdatePolicyInput,
} from "@clockoff/validation/policies";
import { z } from "zod";
import { toDate, type DateInput } from "@/lib/format";
import { BREAK_BEHAVIOUR_META } from "@/components/breakPolicies/break-policy-view-model";

/**
 * Pure helpers behind the Policies pages: labels, version copy, publish impact, precedence explainer, version
 * diffs and form ↔ API mapping. No React here so everything is unit-testable in node.
 */

// ── Categories ──────────────────────────────────────────────────────────────

export interface RestrictionCategoryMeta {
  readonly value: RestrictionCategory;
  readonly label: string;
  readonly description: string;
}

const CATEGORY_DESCRIPTIONS: Record<RestrictionCategory, string> = {
  SOCIAL_MEDIA: "Feeds, stories and social messaging.",
  GAMES: "Mobile games of every kind.",
  ENTERTAINMENT: "Music, podcasts and other entertainment apps.",
  STREAMING: "Live and on-demand streaming services.",
  VIDEO: "Short-form and long-form video apps.",
  SHOPPING: "Shopping and marketplace apps.",
  DATING: "Dating apps.",
  OTHER_SELECTED: "Specific apps each employee picks on their own phone.",
};

export const RESTRICTION_CATEGORY_OPTIONS: readonly RestrictionCategoryMeta[] =
  RESTRICTION_CATEGORIES.map((value) => ({
    value,
    label: RESTRICTION_CATEGORY_LABELS[value],
    description: CATEGORY_DESCRIPTIONS[value],
  }));

/** Spec copy shown when "Other selected apps" is on. */
export const OTHER_SELECTED_CALLOUT =
  "Employees pick the specific apps in the Screen Time picker on their phone; the employer never sees which apps";

/** Choosing "Other selected apps" only works when employees pick apps on their phone. */
export function requiresEmployeeAppSelection(categories: readonly RestrictionCategory[]): boolean {
  return categories.includes("OTHER_SELECTED");
}

export function categoryLabels(categories: readonly RestrictionCategory[]): string[] {
  return RESTRICTION_CATEGORIES.filter((c) => categories.includes(c)).map(
    (c) => RESTRICTION_CATEGORY_LABELS[c],
  );
}

// ── Activation ──────────────────────────────────────────────────────────────

export interface ActivationModeOption {
  readonly value: ActivationMode;
  readonly label: string;
  readonly description: string;
  readonly disabled: boolean;
  /** Why the option can't be chosen yet. */
  readonly hint?: string;
}

export const ACTIVATION_MODE_LABELS: Record<ActivationMode, string> = {
  SCHEDULED: "Scheduled",
  CLOCK_EVENT: "Clock-in",
};

export const ACTIVATION_MODE_OPTIONS: readonly ActivationModeOption[] = ACTIVATION_MODES.map(
  (value) =>
    value === "SCHEDULED"
      ? {
          value,
          label: ACTIVATION_MODE_LABELS[value],
          description: "ClockOff follows each employee's shifts in the schedule.",
          disabled: false,
        }
      : {
          value,
          label: ACTIVATION_MODE_LABELS[value],
          description:
            "Work Mode starts and stops with clock-in and clock-out events from your rota software.",
          disabled: true,
          hint: "Available with integrations",
        },
);

// ── Form schema & mapping ───────────────────────────────────────────────────

/**
 * Builder form values. Same constraints as `createPolicySchema` (`restrictionConfigSchema` +
 * `breakBehaviourDefaultSchema`) but flat, with an always-present shield message string (empty = none).
 */
export const policyFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Give the policy a name")
      .max(120, "Keep the name under 120 characters"),
    description: z.string().trim().max(500, "Keep the description under 500 characters"),
    categories: restrictionCategoryListSchema.min(1, "Choose at least one category"),
    requireEmployeeAppSelection: z.boolean(),
    alwaysAllowedNote: z
      .array(z.string().trim().min(1).max(RESTRICTION_CONFIG_LIMITS.alwaysAllowedNoteMaxLength))
      .max(
        RESTRICTION_CONFIG_LIMITS.alwaysAllowedNoteMaxItems,
        `Keep it to ${RESTRICTION_CONFIG_LIMITS.alwaysAllowedNoteMaxItems} items`,
      ),
    shieldMessage: z
      .string()
      .trim()
      .max(
        RESTRICTION_CONFIG_LIMITS.shieldMessageMaxLength,
        `Keep the shield message under ${RESTRICTION_CONFIG_LIMITS.shieldMessageMaxLength} characters`,
      ),
    activationMode: activationModeSchema,
    preShiftWarningMinutes: z
      .number({ error: "Enter a whole number of minutes" })
      .int({ error: "Whole minutes only" })
      .min(0, "Use 0 to turn the warning off")
      .max(
        RESTRICTION_CONFIG_LIMITS.preShiftWarningMaxMinutes,
        `At most ${RESTRICTION_CONFIG_LIMITS.preShiftWarningMaxMinutes} minutes`,
      ),
    restrictionBehaviour: breakRestrictionBehaviourSchema,
    relaxedCategories: restrictionCategoryListSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.restrictionBehaviour === "RELAX_CATEGORIES" &&
      relaxableCategories(value).length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["relaxedCategories"],
        message:
          "Choose at least one restricted category to relax, or pick another break behaviour",
      });
    }
  });
export type PolicyFormValues = z.infer<typeof policyFormSchema>;

/** Relaxing a category the policy doesn't restrict means nothing, so only the overlap counts (canonical order). */
export function relaxableCategories(
  values: Pick<PolicyFormValues, "categories" | "relaxedCategories">,
): RestrictionCategory[] {
  return RESTRICTION_CATEGORIES.filter(
    (c) => values.relaxedCategories.includes(c) && values.categories.includes(c),
  );
}

/** The version the builder edits: unpublished draft changes if there are any, otherwise the published version. */
export function editableVersion(policy: Policy): PolicyVersion | null {
  return policy.draftVersion ?? policy.currentVersion;
}

export function toPolicyFormValues(policy: Policy | null): PolicyFormValues {
  const version = policy ? editableVersion(policy) : null;
  const config: RestrictionConfig = version?.restrictionConfig ?? {
    ...DEFAULT_RESTRICTION_CONFIG,
    categories: [...DEFAULT_RESTRICTION_CONFIG.categories],
    alwaysAllowedNote: [...DEFAULT_RESTRICTION_CONFIG.alwaysAllowedNote],
  };
  const breaks: BreakBehaviourDefault = version?.breakBehaviourDefault ?? BREAK_BEHAVIOUR_DEFAULT;
  return {
    name: policy?.name ?? "",
    description: policy?.description ?? "",
    categories: [...config.categories],
    requireEmployeeAppSelection: config.requireEmployeeAppSelection,
    alwaysAllowedNote: [...config.alwaysAllowedNote],
    shieldMessage: config.shieldMessage ?? "",
    activationMode: config.activationMode,
    preShiftWarningMinutes: config.preShiftWarningMinutes,
    restrictionBehaviour: breaks.restrictionBehaviour,
    relaxedCategories: [...breaks.relaxedCategories],
  };
}

export function toRestrictionConfig(values: PolicyFormValues): RestrictionConfig {
  const categories = RESTRICTION_CATEGORIES.filter((c) => values.categories.includes(c));
  const shieldMessage = values.shieldMessage.trim();
  return {
    categories,
    // "Other selected apps" is meaningless unless employees pick apps on their phone.
    requireEmployeeAppSelection:
      values.requireEmployeeAppSelection || requiresEmployeeAppSelection(categories),
    alwaysAllowedNote: values.alwaysAllowedNote.map((s) => s.trim()).filter((s) => s !== ""),
    ...(shieldMessage === "" ? {} : { shieldMessage }),
    activationMode: values.activationMode,
    preShiftWarningMinutes: values.preShiftWarningMinutes,
  };
}

export function toBreakBehaviourDefault(
  values: Pick<PolicyFormValues, "restrictionBehaviour" | "relaxedCategories" | "categories">,
): BreakBehaviourDefault {
  return {
    restrictionBehaviour: values.restrictionBehaviour,
    relaxedCategories:
      values.restrictionBehaviour === "RELAX_CATEGORIES" ? relaxableCategories(values) : [],
  };
}

function normaliseDescription(description: string): string | null {
  const trimmed = description.trim();
  return trimmed === "" ? null : trimmed;
}

export function toCreatePolicyInput(values: PolicyFormValues): CreatePolicyInput {
  return {
    name: values.name.trim(),
    description: normaliseDescription(values.description),
    restrictionConfig: toRestrictionConfig(values),
    breakBehaviourDefault: toBreakBehaviourDefault(values),
  };
}

export function sameRestrictionConfig(a: RestrictionConfig, b: RestrictionConfig): boolean {
  return (
    sameSet(a.categories, b.categories) &&
    a.requireEmployeeAppSelection === b.requireEmployeeAppSelection &&
    sameList(a.alwaysAllowedNote, b.alwaysAllowedNote) &&
    (a.shieldMessage ?? "") === (b.shieldMessage ?? "") &&
    a.activationMode === b.activationMode &&
    a.preShiftWarningMinutes === b.preShiftWarningMinutes
  );
}

export function sameBreakBehaviourDefault(
  a: BreakBehaviourDefault,
  b: BreakBehaviourDefault,
): boolean {
  if (a.restrictionBehaviour !== b.restrictionBehaviour) return false;
  return (
    a.restrictionBehaviour !== "RELAX_CATEGORIES" ||
    sameSet(a.relaxedCategories, b.relaxedCategories)
  );
}

/**
 * PATCH body holding only what changed. Config keys are sent only when the config really differs from the
 * version being edited, because the server turns any config key into a new draft version. `null` when
 * nothing changed at all.
 */
export function toUpdatePolicyInput(
  values: PolicyFormValues,
  policy: Policy,
): UpdatePolicyInput | null {
  // `patchStringSchema` pipes through a transform, so `description` is typed as a required key that may be
  // undefined; build the body as a Partial and only hand it over once at least one real change is in it.
  const input: Partial<UpdatePolicyInput> = {};
  const name = values.name.trim();
  if (name !== policy.name) input.name = name;
  const description = normaliseDescription(values.description);
  if (description !== policy.description) input.description = description;
  const version = editableVersion(policy);
  const restrictionConfig = toRestrictionConfig(values);
  if (!version || !sameRestrictionConfig(version.restrictionConfig, restrictionConfig)) {
    input.restrictionConfig = restrictionConfig;
  }
  const breakBehaviourDefault = toBreakBehaviourDefault(values);
  if (
    !version ||
    !sameBreakBehaviourDefault(version.breakBehaviourDefault, breakBehaviourDefault)
  ) {
    input.breakBehaviourDefault = breakBehaviourDefault;
  }
  return Object.keys(input).length === 0 ? null : (input as UpdatePolicyInput);
}

/** Footer copy under the builder's Save button: what saving does to versions and devices. */
export function saveHintText(
  policy: Pick<Policy, "status" | "currentVersion" | "draftVersion"> | null,
): string {
  if (!policy)
    return "The policy is created as a draft. Nothing reaches devices until you publish it.";
  if (policy.status === "ARCHIVED") return "Archived policies can't be changed.";
  if (policy.currentVersion === null)
    return `Changes stay in draft v${nextVersionNumber(policy)} until you publish.`;
  const live = policy.currentVersion.versionNumber;
  return policy.draftVersion
    ? `Changes are saved to draft v${policy.draftVersion.versionNumber}; devices stay on v${live} until you publish.`
    : `Saving configuration changes creates draft v${live + 1}; devices stay on v${live} until you publish.`;
}

// ── Versions & publishing ───────────────────────────────────────────────────

const COMPACT_UNITS: ReadonlyArray<{ suffix: string; ms: number }> = [
  { suffix: "y", ms: 365 * 24 * 60 * 60 * 1000 },
  { suffix: "mo", ms: 30 * 24 * 60 * 60 * 1000 },
  { suffix: "w", ms: 7 * 24 * 60 * 60 * 1000 },
  { suffix: "d", ms: 24 * 60 * 60 * 1000 },
  { suffix: "h", ms: 60 * 60 * 1000 },
  { suffix: "m", ms: 60 * 1000 },
];

/** `just now`, `5m ago`, `2d ago`, `3w ago`, `in 2h` — the compact form used in card footers. */
export function formatCompactRelativeTime(
  value: DateInput | null | undefined,
  now: DateInput = Date.now(),
): string {
  const date = toDate(value);
  const reference = toDate(now);
  if (!date || !reference) return "—";
  const diff = date.getTime() - reference.getTime();
  const abs = Math.abs(diff);
  if (abs < 45_000) return "just now";
  for (const { suffix, ms } of COMPACT_UNITS) {
    if (abs >= ms) {
      const amount = `${Math.trunc(abs / ms)}${suffix}`;
      return diff < 0 ? `${amount} ago` : `in ${amount}`;
    }
  }
  return diff < 0 ? "1m ago" : "in 1m";
}

/** Version number the next publish will create. */
export function nextVersionNumber(policy: Pick<Policy, "currentVersion" | "draftVersion">): number {
  if (policy.draftVersion) return policy.draftVersion.versionNumber;
  return policy.currentVersion ? policy.currentVersion.versionNumber + 1 : 1;
}

/** `v3 · published 2d ago`, `v3 · published 2d ago · unpublished changes`, `v1 · draft`. */
export function formatVersionLabel(
  policy: Pick<Policy, "currentVersion" | "draftVersion">,
  now: DateInput = Date.now(),
): string {
  const { currentVersion, draftVersion } = policy;
  if (currentVersion) {
    const published = `v${currentVersion.versionNumber} · published ${formatCompactRelativeTime(currentVersion.publishedAt, now)}`;
    return draftVersion ? `${published} · unpublished changes` : published;
  }
  if (draftVersion) return `v${draftVersion.versionNumber} · draft`;
  return "No versions yet";
}

export function canPublish(policy: Pick<Policy, "status" | "draftVersion">): boolean {
  return policy.status !== "ARCHIVED" && policy.draftVersion !== null;
}

/**
 * `v2 will reach 12 employees` — the headline of the publish dialog. `assignedEmployeeCount` counts employees
 * whose resolved policy is this one, not phones (an employee who hasn't connected a phone has no device yet).
 */
export function publishImpactText(
  policy: Pick<Policy, "currentVersion" | "draftVersion" | "assignedEmployeeCount">,
): string {
  const count = policy.assignedEmployeeCount;
  return `v${nextVersionNumber(policy)} will reach ${count} ${count === 1 ? "employee" : "employees"}`;
}

export const PUBLISH_IMPACT_HELP =
  "Everyone whose resolved Work Policy is this one. Phones that have joined pick the new version up on their next sync; employees who haven't connected a phone get it when they do.";

/** `12 employees · 3 assignments`. */
export function formatAssignedSummary(
  policy: Pick<Policy, "assignedEmployeeCount" | "assignmentCount">,
): string {
  const employees = `${policy.assignedEmployeeCount} ${policy.assignedEmployeeCount === 1 ? "employee" : "employees"}`;
  const assignments = `${policy.assignmentCount} ${policy.assignmentCount === 1 ? "assignment" : "assignments"}`;
  return `${employees} · ${assignments}`;
}

export type ActionGuard = { ok: true } | { ok: false; reason: string };

/** Only a published, non-archived policy can be the organisation default (`POLICY_NOT_PUBLISHED` / `POLICY_ARCHIVED`). */
export function setDefaultGuard(
  policy: Pick<Policy, "status" | "currentVersion" | "isDefault">,
): ActionGuard {
  if (policy.isDefault)
    return { ok: false, reason: "This policy is already the organisation default." };
  if (policy.status === "ARCHIVED")
    return { ok: false, reason: "Archived policies can't be the default." };
  if (policy.status !== "ACTIVE" || policy.currentVersion === null) {
    return { ok: false, reason: "Publish this policy before making it the default." };
  }
  return { ok: true };
}

/** Assignments need a published, non-archived policy (`POLICY_NOT_PUBLISHED` / `POLICY_ARCHIVED`). */
export function assignGuard(policy: Pick<Policy, "status" | "currentVersion">): ActionGuard {
  if (policy.status === "ARCHIVED")
    return { ok: false, reason: "Archived policies can't be assigned." };
  if (policy.status !== "ACTIVE" || policy.currentVersion === null) {
    return { ok: false, reason: "Publish this policy before assigning it." };
  }
  return { ok: true };
}

export type ArchiveGuard = { blocked: false } | { blocked: true; reasons: string[] };

/**
 * Archiving a policy that still applies to people would silently move them to the next scope, so the UI
 * asks for reassignment first. Mirrors the delete rule (`POLICY_ASSIGNED`).
 */
export function archiveGuard(policy: Pick<Policy, "isDefault" | "assignmentCount">): ArchiveGuard {
  const reasons: string[] = [];
  if (policy.isDefault)
    reasons.push("It is the organisation default. Choose a different default policy first.");
  if (policy.assignmentCount > 0) {
    reasons.push(
      `It is assigned to ${policy.assignmentCount} ${policy.assignmentCount === 1 ? "scope" : "scopes"}. Remove those assignments or assign another policy first.`,
    );
  }
  return reasons.length > 0 ? { blocked: true, reasons } : { blocked: false };
}

export function canDelete(policy: Pick<Policy, "isDefault" | "assignmentCount">): boolean {
  return !policy.isDefault && policy.assignmentCount === 0;
}

/** Client-side name/description search over an already-loaded list. */
export function matchesPolicySearch(
  policy: Pick<Policy, "name" | "description">,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") return true;
  return (
    policy.name.toLowerCase().includes(needle) ||
    (policy.description ?? "").toLowerCase().includes(needle)
  );
}

/** Default first, then active, draft, archived; ties by name. */
export function comparePolicies(a: Policy, b: Policy): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  const rank = { ACTIVE: 0, DRAFT: 1, ARCHIVED: 2 } as const;
  if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
  return a.name.localeCompare(b.name);
}

// ── Version diff ────────────────────────────────────────────────────────────

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((item) => set.has(item));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function joinLabels(categories: readonly RestrictionCategory[]): string {
  return categoryLabels(categories).join(", ");
}

/**
 * Human summary of what changed between two versions, for the version history panel. `previous` is null
 * for the first version.
 */
export function summariseVersionDiff(
  previous: Pick<PolicyVersion, "restrictionConfig" | "breakBehaviourDefault"> | null,
  next: Pick<PolicyVersion, "restrictionConfig" | "breakBehaviourDefault">,
): string[] {
  if (previous === null) return ["Initial version"];
  const changes: string[] = [];
  const before = previous.restrictionConfig;
  const after = next.restrictionConfig;

  const added = after.categories.filter((c) => !before.categories.includes(c));
  const removed = before.categories.filter((c) => !after.categories.includes(c));
  if (added.length > 0) changes.push(`Now restricts ${joinLabels(added)}`);
  if (removed.length > 0) changes.push(`No longer restricts ${joinLabels(removed)}`);

  if (before.requireEmployeeAppSelection !== after.requireEmployeeAppSelection) {
    changes.push(
      after.requireEmployeeAppSelection
        ? "Employee app selection now required"
        : "Employee app selection now optional",
    );
  }
  if (!sameList(before.alwaysAllowedNote, after.alwaysAllowedNote))
    changes.push("Always-available list updated");
  if ((before.shieldMessage ?? "") !== (after.shieldMessage ?? ""))
    changes.push("Shield message updated");
  if (before.activationMode !== after.activationMode) {
    changes.push(
      `Activation: ${ACTIVATION_MODE_LABELS[before.activationMode]} → ${ACTIVATION_MODE_LABELS[after.activationMode]}`,
    );
  }
  if (before.preShiftWarningMinutes !== after.preShiftWarningMinutes) {
    changes.push(
      `Pre-shift warning: ${before.preShiftWarningMinutes} → ${after.preShiftWarningMinutes} min`,
    );
  }

  const breaksBefore = previous.breakBehaviourDefault;
  const breaksAfter = next.breakBehaviourDefault;
  if (breaksBefore.restrictionBehaviour !== breaksAfter.restrictionBehaviour) {
    changes.push(
      `Break behaviour: ${BREAK_BEHAVIOUR_META[breaksBefore.restrictionBehaviour].label} → ${BREAK_BEHAVIOUR_META[breaksAfter.restrictionBehaviour].label}`,
    );
  } else if (
    breaksAfter.restrictionBehaviour === "RELAX_CATEGORIES" &&
    !sameSet(breaksBefore.relaxedCategories, breaksAfter.relaxedCategories)
  ) {
    changes.push("Categories relaxed on breaks updated");
  }

  return changes.length > 0 ? changes : ["No configuration changes"];
}

/** Newest first; the diff for each version is against the version just before it. */
export function describeVersionHistory(
  versions: readonly PolicyVersion[],
): Array<{ version: PolicyVersion; changes: string[] }> {
  const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
  return sorted.map((version, index) => ({
    version,
    changes: summariseVersionDiff(sorted[index + 1] ?? null, version),
  }));
}

// ── Precedence explainer ────────────────────────────────────────────────────

export interface PrecedenceLevel {
  readonly scopeType: AssignmentScopeType;
  /** 1 = highest priority. */
  readonly rank: number;
  readonly label: string;
  readonly description: string;
}

const PRECEDENCE_DESCRIPTIONS: Record<AssignmentScopeType, string> = {
  EMPLOYEE: "Assigned directly to a person. Always wins.",
  TEAM: "Any team the employee belongs to. If their teams disagree, the most recently assigned policy wins.",
  LOCATION: "The employee's primary location.",
  ORGANISATION:
    "Everyone, unless something above applies. An organisation-wide assignment beats the organisation default, which is the final fallback.",
};

/** `POLICY_SCOPE_PRECEDENCE` from @clockoff/shared, with dashboard copy: Employee › Team › Location › Organisation. */
export const PRECEDENCE_LEVELS: readonly PrecedenceLevel[] = POLICY_SCOPE_PRECEDENCE.map(
  (scopeType, index) => ({
    scopeType,
    rank: index + 1,
    label: SCOPE_TYPE_LABELS[scopeType],
    description: PRECEDENCE_DESCRIPTIONS[scopeType],
  }),
);

export const PRECEDENCE_SUMMARY = PRECEDENCE_LEVELS.map((level) => level.label).join(" > ");

// ── Assignments ─────────────────────────────────────────────────────────────

/** The fields `PolicyAssignment` and `BreakPolicyAssignment` share. */
export interface ScopedAssignment {
  readonly id: string;
  readonly scopeType: AssignmentScopeType;
  readonly scopeId: string;
  readonly scope: { readonly id: string; readonly name: string } | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly name: string } | null;
}

export const SCOPE_TYPE_PLURALS: Record<AssignmentScopeType, string> = {
  EMPLOYEE: "employees",
  TEAM: "teams",
  LOCATION: "locations",
  ORGANISATION: "organisation",
};

/** Display name for an assignment's target, with an honest fallback when the target was deleted. */
export function describeAssignmentScope(
  assignment: Pick<ScopedAssignment, "scopeType" | "scope">,
): string {
  if (assignment.scope) return assignment.scope.name;
  if (assignment.scopeType === "ORGANISATION") return "Whole organisation";
  return `Deleted ${SCOPE_TYPE_LABELS[assignment.scopeType].toLowerCase()}`;
}

/**
 * Open = not ended: `effectiveTo` is null or still in the future. This is the server's rule for
 * `assignmentCount` and for the `POLICY_ASSIGNED` guard, so the dashboard's guards mirror it exactly.
 * A not-yet-effective (scheduled) assignment is open but not active.
 */
export function isAssignmentOpen(
  assignment: Pick<ScopedAssignment, "effectiveTo">,
  now: DateInput = Date.now(),
): boolean {
  if (assignment.effectiveTo === null) return true;
  const end = toDate(assignment.effectiveTo);
  const reference = toDate(now);
  if (!end || !reference) return true;
  return end.getTime() > reference.getTime();
}

/** The assignments that still count (open), in their original order. */
export function openAssignments<T extends ScopedAssignment>(
  assignments: readonly T[],
  now: DateInput = Date.now(),
): T[] {
  return assignments.filter((assignment) => isAssignmentOpen(assignment, now));
}

export function groupAssignmentsByScope<T extends ScopedAssignment>(
  assignments: readonly T[],
): Record<AssignmentScopeType, T[]> {
  const groups: Record<AssignmentScopeType, T[]> = {
    EMPLOYEE: [],
    TEAM: [],
    LOCATION: [],
    ORGANISATION: [],
  };
  for (const assignment of assignments) groups[assignment.scopeType].push(assignment);
  return groups;
}

/** `scopeId → assignment` for the active assignments of one scope type (what the pickers show as selected). */
export function activeAssignmentsByScopeId<T extends ScopedAssignment>(
  assignments: readonly T[],
  scopeType: AssignmentScopeType,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const assignment of assignments) {
    if (assignment.scopeType === scopeType && assignment.isActive)
      map.set(assignment.scopeId, assignment);
  }
  return map;
}
