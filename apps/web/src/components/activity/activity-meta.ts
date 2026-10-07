import { ACTIVITY_EVENT_TYPES, type ActivityEventType } from "@clockoff/shared/enums";
import type { StatusTone } from "@clockoff/shared/status/statusMeta";
import type { ActivityEvent } from "@clockoff/validation/activity";
import { formatDurationMinutes, humanizeEnum } from "@/lib/format";

/**
 * Presentation of every `ActivityEventType`: a short label, an icon, a tone and a plain-English sentence
 * built from operational metadata only (ids, counts, versions — never device content, §12). Pure, so
 * `activity-meta.test.ts` can prove every type is covered.
 */

/** Icon keys resolved to lucide components in `activity-item.tsx` (strings keep this module node-safe). */
export const ACTIVITY_ICONS = [
  "user-check",
  "circle-check",
  "shield-check",
  "shield-alert",
  "smartphone",
  "shield-off",
  "coffee",
  "circle-pause",
  "hourglass",
  "calendar",
  "refresh",
  "wifi-off",
  "pencil",
  "circle-x",
  "key",
  "plug",
  "file-up",
  "triangle-alert",
  "activity",
] as const;
export type ActivityIcon = (typeof ACTIVITY_ICONS)[number];

export const ACTIVITY_GROUPS = [
  "setup",
  "workMode",
  "breaks",
  "sync",
  "schedule",
  "policy",
  "overrides",
  "system",
] as const;
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];

export const ACTIVITY_GROUP_LABELS: Record<ActivityGroup, string> = {
  setup: "Setup",
  workMode: "Work Mode",
  breaks: "Breaks",
  sync: "Device sync",
  schedule: "Schedule",
  policy: "Policies",
  overrides: "Overrides",
  system: "System",
};

export interface ActivitySentenceContext {
  /** The employee's name, or "An employee" when the event has none. */
  readonly subject: string;
  /** Possessive form of `subject` ("Jane Smith's"). */
  readonly possessive: string;
  /** The manager who acted, or null. */
  readonly actor: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ActivityEventMeta {
  readonly label: string;
  readonly icon: ActivityIcon;
  readonly tone: StatusTone;
  readonly group: ActivityGroup;
  readonly sentence: (ctx: ActivitySentenceContext) => string;
}

function num(metadata: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(metadata: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function byManager(actor: string | null): string {
  return actor ?? "A manager";
}

export const ACTIVITY_EVENT_META: Record<ActivityEventType, ActivityEventMeta> = {
  EMPLOYEE_JOINED: {
    label: "Joined",
    icon: "user-check",
    tone: "success",
    group: "setup",
    sentence: ({ subject }) => `${subject} joined from the ClockOff app`,
  },
  SETUP_COMPLETED: {
    label: "Setup complete",
    icon: "circle-check",
    tone: "success",
    group: "setup",
    sentence: ({ subject }) => `${subject} finished setting up ClockOff`,
  },
  PERMISSION_GRANTED: {
    label: "Permission granted",
    icon: "shield-check",
    tone: "success",
    group: "setup",
    sentence: ({ subject }) => `${subject} granted Screen Time access`,
  },
  PERMISSION_NEEDS_ATTENTION: {
    label: "Permission needs attention",
    icon: "shield-alert",
    tone: "danger",
    group: "setup",
    sentence: ({ possessive, metadata }) => {
      const state = str(metadata, "permissionState");
      return `${possessive} Screen Time permission needs attention${state ? ` (${humanizeEnum(state).toLowerCase()})` : ""}`;
    },
  },
  SELECTION_CONFIGURED: {
    label: "Apps selected",
    icon: "smartphone",
    tone: "success",
    group: "setup",
    sentence: ({ subject }) => `${subject} chose what to shield during shifts`,
  },
  WORK_MODE_STARTED: {
    label: "Work Mode started",
    icon: "shield-check",
    tone: "success",
    group: "workMode",
    sentence: ({ subject }) => `Work Mode switched on for ${subject}`,
  },
  WORK_MODE_ENDED: {
    label: "Work Mode ended",
    icon: "shield-off",
    tone: "neutral",
    group: "workMode",
    sentence: ({ subject }) => `Work Mode switched off for ${subject}`,
  },
  BREAK_STARTED: {
    label: "Break started",
    icon: "coffee",
    tone: "info",
    group: "breaks",
    sentence: ({ subject, metadata }) => {
      const minutes = num(metadata, "durationMinutes");
      return `${subject} started a ${minutes ? `${formatDurationMinutes(minutes)} ` : ""}break`;
    },
  },
  BREAK_ENDED: {
    label: "Break ended",
    icon: "circle-pause",
    tone: "info",
    group: "breaks",
    sentence: ({ subject }) => `${subject} ended their break`,
  },
  BREAK_EXPIRED: {
    label: "Break ran out",
    icon: "hourglass",
    tone: "warning",
    group: "breaks",
    sentence: ({ possessive }) => `${possessive} break ran out and restrictions resumed`,
  },
  SCHEDULE_SYNCED: {
    label: "Schedule synced",
    icon: "calendar",
    tone: "neutral",
    group: "sync",
    sentence: ({ possessive }) => `${possessive} phone synced the latest schedule`,
  },
  POLICY_SYNCED: {
    label: "Policy synced",
    icon: "refresh",
    tone: "neutral",
    group: "sync",
    sentence: ({ possessive, metadata }) => {
      const version = num(metadata, "policyVersionNumber") ?? num(metadata, "policyVersion");
      return `${possessive} phone synced the latest Work Policy${version ? ` (version ${version})` : ""}`;
    },
  },
  DEVICE_SYNC_DELAYED: {
    label: "Sync delayed",
    icon: "wifi-off",
    tone: "warning",
    group: "sync",
    sentence: ({ possessive }) => `${possessive} phone hasn't synced recently`,
  },
  POLICY_UPDATED: {
    label: "Policy updated",
    icon: "pencil",
    tone: "neutral",
    group: "policy",
    sentence: ({ actor, metadata }) => {
      const name = str(metadata, "policyName");
      return `${byManager(actor)} updated ${name ? `the “${name}” Work Policy` : "a Work Policy"}`;
    },
  },
  SHIFT_CREATED: {
    label: "Shift added",
    icon: "calendar",
    tone: "neutral",
    group: "schedule",
    sentence: ({ actor, subject }) => `${byManager(actor)} added a shift for ${subject}`,
  },
  SHIFT_UPDATED: {
    label: "Shift changed",
    icon: "pencil",
    tone: "neutral",
    group: "schedule",
    sentence: ({ actor, subject }) => `${byManager(actor)} changed a shift for ${subject}`,
  },
  SHIFT_CANCELLED: {
    label: "Shift cancelled",
    icon: "circle-x",
    tone: "neutral",
    group: "schedule",
    sentence: ({ actor, subject }) => `${byManager(actor)} cancelled a shift for ${subject}`,
  },
  OVERRIDE_CREATED: {
    label: "Override created",
    icon: "key",
    tone: "warning",
    group: "overrides",
    sentence: ({ actor, subject, metadata }) => {
      const type = str(metadata, "overrideType");
      return `${byManager(actor)} created ${type ? `a “${humanizeEnum(type)}” override` : "an override"} for ${subject}`;
    },
  },
  OVERRIDE_EXPIRED: {
    label: "Override expired",
    icon: "hourglass",
    tone: "neutral",
    group: "overrides",
    sentence: ({ subject }) => `An override for ${subject} expired and normal rules resumed`,
  },
  INTEGRATION_ERROR: {
    label: "Integration error",
    icon: "plug",
    tone: "danger",
    group: "system",
    sentence: ({ metadata }) => {
      const provider = str(metadata, "provider");
      return `${provider ? humanizeEnum(provider) : "An integration"} reported a sync error`;
    },
  },
  IMPORT_COMPLETED: {
    label: "Import finished",
    icon: "file-up",
    tone: "success",
    group: "schedule",
    sentence: ({ actor, metadata }) => {
      const count = num(metadata, "importedCount") ?? num(metadata, "shiftsImported");
      return `${byManager(actor)} imported a schedule${count !== null ? ` (${count} shift${count === 1 ? "" : "s"})` : ""}`;
    },
  },
  POLICY_RESOLUTION_WARNING: {
    label: "Policy needs review",
    icon: "triangle-alert",
    tone: "warning",
    group: "policy",
    sentence: ({ possessive }) => `${possessive} Work Policy couldn't be resolved unambiguously`,
  },
};

const UNKNOWN_EVENT_META = (type: string): ActivityEventMeta => ({
  label: humanizeEnum(type) || "Activity",
  icon: "activity",
  tone: "neutral",
  group: "system",
  sentence: ({ subject }) => `${humanizeEnum(type) || "Something happened"} · ${subject}`,
});

/** Meta for a type; kinds newer than this UI degrade to a neutral entry instead of crashing the feed. */
export function activityEventMeta(type: ActivityEventType | string): ActivityEventMeta {
  return Object.prototype.hasOwnProperty.call(ACTIVITY_EVENT_META, type)
    ? ACTIVITY_EVENT_META[type as ActivityEventType]
    : UNKNOWN_EVENT_META(type);
}

export type ActivityEventLike = Pick<
  ActivityEvent,
  "type" | "employee" | "actor" | "actorType" | "metadata"
>;

function possessiveOf(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/** Sentence context from an event: employee name (or "An employee"), manager name and metadata. */
export function activitySentenceContext(event: ActivityEventLike): ActivitySentenceContext {
  const subject = event.employee
    ? `${event.employee.firstName} ${event.employee.lastName}`.trim() || "An employee"
    : "An employee";
  const actor = event.actorType === "MANAGER" && event.actor ? event.actor.name : null;
  return { subject, possessive: possessiveOf(subject), actor, metadata: event.metadata ?? {} };
}

/** A human sentence for the feed, built locally from the type and operational metadata. */
export function activitySentence(event: ActivityEventLike): string {
  return activityEventMeta(event.type).sentence(activitySentenceContext(event));
}

/** The text shown for an event: the server's summary when it has one, else the locally built sentence. */
export function activityText(event: ActivityEventLike & { summary?: string | null }): string {
  const summary = event.summary?.trim();
  return summary ? summary : activitySentence(event);
}

export interface ActivityTypeOption {
  readonly value: ActivityEventType;
  readonly label: string;
  readonly group: ActivityGroup;
}

/** Every type as a filter option, in enum order, with its group for the picker's section headings. */
export const ACTIVITY_TYPE_OPTIONS: readonly ActivityTypeOption[] = ACTIVITY_EVENT_TYPES.map(
  (value) => ({
    value,
    label: ACTIVITY_EVENT_META[value].label,
    group: ACTIVITY_EVENT_META[value].group,
  }),
);

export function isActivityEventType(value: unknown): value is ActivityEventType {
  return typeof value === "string" && (ACTIVITY_EVENT_TYPES as readonly string[]).includes(value);
}
