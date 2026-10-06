import type { AssignmentScopeType } from "@workmode/shared/enums";
import { isValidTimeZone } from "@workmode/shared/time/time";
import type { BreakPolicy } from "@workmode/validation/breakPolicies";
import type {
  CreateTeamInput,
  Department,
  Location,
  ScopeAssignment,
  Team,
  UpdateTeamInput,
  createLocationSchema,
  updateLocationSchema,
} from "@workmode/validation/locationsTeams";
import type { Policy } from "@workmode/validation/policies";
import { z } from "zod";
import { formatCount, formatTimeZoneLabel } from "@/lib/format";

/**
 * Pure helpers behind the Locations & Teams page: tab config, form ↔ API mapping (with PATCH diffs), delete
 * warnings and the summary of the Work Policy / Break Rules assigned at a scope for the inline "Assign…"
 * controls. No React here so everything is unit-testable in node.
 */

/**
 * Request bodies are typed as the schemas' INPUT (what the client sends), not `z.infer` (the parsed output):
 * `address` is transformed on the server (`"" → null`), which makes it required in the output type only.
 */
export type CreateLocationBody = z.input<typeof createLocationSchema>;
export type UpdateLocationBody = z.input<typeof updateLocationSchema>;

// ── Tabs ────────────────────────────────────────────────────────────────────

export const LOCATIONS_TABS = ["locations", "departments", "teams"] as const;
export type LocationsTab = (typeof LOCATIONS_TABS)[number];
export const DEFAULT_LOCATIONS_TAB: LocationsTab = "locations";

export const LOCATIONS_TAB_META: Record<LocationsTab, { label: string; description: string }> = {
  locations: {
    label: "Locations",
    description: "Your sites. Each location can have its own time zone, Work Policy and Break Rules.",
  },
  departments: {
    label: "Departments",
    description: "Simple groupings for filtering and reporting, such as Kitchen or Front of house.",
  },
  teams: {
    label: "Teams",
    description: "Groups of employees, optionally within a location, that share a Work Policy or Break Rules.",
  },
};

export function isLocationsTab(value: unknown): value is LocationsTab {
  return typeof value === "string" && (LOCATIONS_TABS as readonly string[]).includes(value);
}

/** Tab from a `?tab=` value; unknown or missing values fall back to the locations tab. */
export function parseLocationsTab(value: string | null | undefined): LocationsTab {
  return isLocationsTab(value) ? value : DEFAULT_LOCATIONS_TAB;
}

// ── Locations ───────────────────────────────────────────────────────────────

export const LOCATION_LIMITS = { nameMaxLength: 120, addressMaxLength: 300 } as const;

/**
 * Form values for the location sheet. The API's `timezone` is nullable ("use the organisation zone"); the
 * form expresses that as a switch so the combobox is never shown empty.
 */
export const locationFormSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name for this location").max(LOCATION_LIMITS.nameMaxLength),
    useOrganisationTimezone: z.boolean(),
    timezone: z.string(),
    address: z.string().trim().max(LOCATION_LIMITS.addressMaxLength),
  })
  .superRefine((values, ctx) => {
    if (!values.useOrganisationTimezone && !isValidTimeZone(values.timezone)) {
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "Choose a valid time zone" });
    }
  });
export type LocationFormValues = z.infer<typeof locationFormSchema>;

export function emptyLocationForm(organisationTimezone: string): LocationFormValues {
  return { name: "", useOrganisationTimezone: true, timezone: organisationTimezone, address: "" };
}

export function locationToFormValues(location: Location, organisationTimezone: string): LocationFormValues {
  return {
    name: location.name,
    useOrganisationTimezone: location.timezone === null,
    timezone: location.timezone ?? organisationTimezone,
    address: location.address ?? "",
  };
}

export function toCreateLocationInput(values: LocationFormValues): CreateLocationBody {
  const input: CreateLocationBody = { name: values.name };
  if (!values.useOrganisationTimezone) input.timezone = values.timezone;
  if (values.address !== "") input.address = values.address;
  return input;
}

/** Only the fields that changed, or `null` when nothing did (so "Save" with no edits is a no-op). */
export function toUpdateLocationInput(values: LocationFormValues, location: Location): UpdateLocationBody | null {
  const input: UpdateLocationBody = {};
  if (values.name !== location.name) input.name = values.name;
  const nextTimezone = values.useOrganisationTimezone ? null : values.timezone;
  if (nextTimezone !== location.timezone) input.timezone = nextTimezone;
  const nextAddress = values.address === "" ? null : values.address;
  if (nextAddress !== (location.address ?? null)) input.address = nextAddress;
  return Object.keys(input).length === 0 ? null : input;
}

/** Display label for a location's zone, saying when it inherits the organisation's. */
export function describeLocationTimezone(
  location: Pick<Location, "timezone">,
  organisationTimezone: string | undefined,
): { label: string; inherited: boolean } {
  if (location.timezone) return { label: formatTimeZoneLabel(location.timezone), inherited: false };
  return {
    label: organisationTimezone ? `Organisation default · ${formatTimeZoneLabel(organisationTimezone)}` : "Organisation default",
    inherited: true,
  };
}

/** What deleting a location changes for other records. Empty when nothing depends on it. */
export function locationDeleteWarnings(location: Pick<Location, "employeeCount" | "teamCount">): string[] {
  const warnings: string[] = [];
  if (location.employeeCount > 0) {
    warnings.push(
      `${formatCount(location.employeeCount, "employee")} ${location.employeeCount === 1 ? "has" : "have"} this as a location. They keep their records but will have no location until you assign another.`,
    );
  }
  if (location.teamCount > 0) {
    warnings.push(
      `${formatCount(location.teamCount, "team")} ${location.teamCount === 1 ? "belongs" : "belong"} to this location. ${location.teamCount === 1 ? "It keeps its members" : "They keep their members"} but will no longer be tied to a location.`,
    );
  }
  return warnings;
}

// ── Departments ─────────────────────────────────────────────────────────────

export const departmentFormSchema = z.object({
  name: z.string().trim().min(1, "Enter a name for this department").max(LOCATION_LIMITS.nameMaxLength),
});
export type DepartmentFormValues = z.infer<typeof departmentFormSchema>;

export function departmentDeleteWarnings(department: Pick<Department, "employeeCount">): string[] {
  if (department.employeeCount === 0) return [];
  return [
    `${formatCount(department.employeeCount, "employee")} ${department.employeeCount === 1 ? "is" : "are"} in this department. They keep their records but will have no department.`,
  ];
}

// ── Teams ───────────────────────────────────────────────────────────────────

/** `locationId: ""` means "no location". */
export const teamFormSchema = z.object({
  name: z.string().trim().min(1, "Enter a name for this team").max(LOCATION_LIMITS.nameMaxLength),
  locationId: z.string(),
});
export type TeamFormValues = z.infer<typeof teamFormSchema>;

export const EMPTY_TEAM_FORM: TeamFormValues = { name: "", locationId: "" };

export function teamToFormValues(team: Team): TeamFormValues {
  return { name: team.name, locationId: team.location?.id ?? "" };
}

export function toCreateTeamInput(values: TeamFormValues): CreateTeamInput {
  const input: CreateTeamInput = { name: values.name };
  if (values.locationId !== "") input.locationId = values.locationId;
  return input;
}

export function toUpdateTeamInput(values: TeamFormValues, team: Team): UpdateTeamInput | null {
  const input: UpdateTeamInput = {};
  if (values.name !== team.name) input.name = values.name;
  const nextLocationId = values.locationId === "" ? null : values.locationId;
  if (nextLocationId !== (team.location?.id ?? null)) input.locationId = nextLocationId;
  return Object.keys(input).length === 0 ? null : input;
}

export function teamDeleteWarnings(team: Pick<Team, "memberCount">): string[] {
  if (team.memberCount === 0) return [];
  return [
    `${formatCount(team.memberCount, "member")} will leave the team. Any Work Policy or Break Rules assigned to the team stop applying to them from their phone's next sync.`,
  ];
}

// ── Scope assignments (Work Policy / Break Rules at LOCATION or TEAM scope) ──

export type AssignableScope = Extract<AssignmentScopeType, "LOCATION" | "TEAM">;

export interface PolicyOption {
  readonly id: string;
  readonly name: string;
  readonly hint?: string;
  readonly disabled: boolean;
}

/** Published Work Policies first; drafts stay visible but disabled so the reason is clear. Archived are hidden. */
export function assignableWorkPolicies(policies: readonly Policy[]): PolicyOption[] {
  return policies
    .filter((policy) => policy.status !== "ARCHIVED")
    .map((policy) => {
      const published = policy.status === "ACTIVE" && policy.currentVersion !== null;
      return {
        id: policy.id,
        name: policy.name,
        hint: !published ? "Draft — publish it first" : policy.isDefault ? "Organisation default" : undefined,
        disabled: !published,
      };
    })
    .sort(compareOptions);
}

export function assignableBreakPolicies(breakPolicies: readonly BreakPolicy[]): PolicyOption[] {
  return breakPolicies
    .filter((policy) => policy.status !== "ARCHIVED")
    .map((policy) => ({
      id: policy.id,
      name: policy.name,
      hint: policy.status !== "ACTIVE" ? "Draft — publish it first" : policy.isDefault ? "Organisation default" : undefined,
      disabled: policy.status !== "ACTIVE",
    }))
    .sort(compareOptions);
}

function compareOptions(a: PolicyOption, b: PolicyOption): number {
  if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
  return a.name.localeCompare(b.name);
}

export interface ScopeAssignmentSummary {
  /** Visible label: the policy name, or "Inherited" when nothing is assigned at this scope. */
  readonly label: string;
  readonly assigned: boolean;
  /** The PolicyAssignment / BreakPolicyAssignment in force at this scope, if any. */
  readonly assignmentId: string | null;
  readonly policyId: string | null;
}

/**
 * Summarises the assignment the API embeds on each location / team row (`policyAssignment` /
 * `breakPolicyAssignment`, at most one open per scope). `undefined` (field not sent) reads as none.
 */
export function summariseScopeAssignment(assignment: ScopeAssignment | null | undefined): ScopeAssignmentSummary {
  if (!assignment) return { label: "Inherited", assigned: false, assignmentId: null, policyId: null };
  return { label: assignment.policy.name, assigned: true, assignmentId: assignment.id, policyId: assignment.policy.id };
}

/** Human noun for the kind of policy being assigned. */
export const POLICY_KIND_NOUN = { policy: "Work Policy", breakPolicy: "Break Rules" } as const;
export type PolicyKind = keyof typeof POLICY_KIND_NOUN;

export const SCOPE_NOUN: Record<AssignableScope, string> = { LOCATION: "location", TEAM: "team" };

/** Sort rows by name for stable tables. */
export function compareByName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}
