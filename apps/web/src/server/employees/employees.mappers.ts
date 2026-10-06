import type {
  ActivityEvent as ActivityEventRow,
  BreakSession as BreakSessionRow,
  EmployeeInvite as EmployeeInviteRow,
  EmployeeWorkState as EmployeeWorkStateRow,
  Prisma,
} from "@workmode/db";
import { parseRelaxedCategories } from "@workmode/shared/breaks/breakRules";
import type { ActivityEventType } from "@workmode/shared/enums";
import type { ActivityEvent } from "@workmode/validation/activity";
import type { DeviceSummary } from "@workmode/validation/devices";
import type { EmployeeInvite } from "@workmode/validation/invites";
import type { MobileEmployee, MobileOrganisation } from "@workmode/validation/mobile";
import {
  deriveOverrideStatus,
  type Override,
  type OverridePayload,
} from "@workmode/validation/overrides";
import type {
  DeviceStatus,
  EmployeeSummary,
  NamedRef,
  ShiftSummary,
} from "@workmode/validation/refs";
import type {
  BreakSessionResponse,
  EmployeeWorkStateResponse,
} from "@workmode/validation/workState";
import type {
  DeviceRow,
  EmployeeRow,
  NextShiftRow,
  OverrideRow,
  ShiftRow,
} from "./employees.repository";

/**
 * Row → API DTO mappers for the employee domain. Instants become UTC ISO-8601 strings; nothing beyond the
 * §12 operational fields of a device is ever copied (no push tokens, no identifiers).
 */

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function toNamedRef(row: { id: string; name: string }): NamedRef {
  return { id: row.id, name: row.name };
}

export function toEmployeeSummary(row: {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  inviteStatus: EmployeeSummary["inviteStatus"];
  primaryLocation: { id: string; name: string } | null;
}): EmployeeSummary {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    jobTitle: row.jobTitle,
    primaryLocation: row.primaryLocation ? toNamedRef(row.primaryLocation) : null,
    inviteStatus: row.inviteStatus,
  };
}

/** Every location the employee works at: the primary one first, then the rest (deleted ones dropped). */
export function employeeLocations(row: EmployeeRow): NamedRef[] {
  const out: NamedRef[] = [];
  const seen = new Set<string>();
  if (row.primaryLocation) {
    out.push(toNamedRef(row.primaryLocation));
    seen.add(row.primaryLocation.id);
  }
  for (const link of row.locations) {
    if (link.location.deletedAt || seen.has(link.location.id)) continue;
    seen.add(link.location.id);
    out.push(toNamedRef(link.location));
  }
  return out;
}

export function toDeviceSummary(device: DeviceRow): DeviceSummary {
  return {
    id: device.id,
    platform: device.platform,
    appVersion: device.appVersion,
    osVersion: device.osVersion,
    deviceModel: device.deviceModel,
    permissionState: device.permissionState,
    selectionState: device.selectionState,
    selectionCounts: {
      categories: device.selectionCategoryCount,
      applications: device.selectionAppCount,
      webDomains: device.selectionDomainCount,
    },
    restrictionEngineState: device.restrictionEngineState,
    policyVersionId: device.policyVersionId,
    policyVersionNumber: device.policyVersion?.versionNumber ?? null,
    scheduleVersion: device.scheduleVersion,
    timezone: device.timezone,
    lastDeviceSyncAt: isoOrNull(device.lastDeviceSyncAt),
    lastPolicySyncAt: isoOrNull(device.lastPolicySyncAt),
    lastScheduleSyncAt: isoOrNull(device.lastScheduleSyncAt),
    lastSeenAt: isoOrNull(device.lastSeenAt),
    lastClockSkewSeconds: device.lastClockSkewSeconds,
    hasPushToken: device.pushTokenEncrypted !== null,
    isActive: device.isActive,
    deactivatedAt: isoOrNull(device.deactivatedAt),
    createdAt: iso(device.createdAt),
  };
}

export function toWorkStateDto(row: EmployeeWorkStateRow): EmployeeWorkStateResponse {
  return {
    state: row.state,
    stateSince: iso(row.stateSince),
    source: row.source,
    expectedState: row.expectedState,
    expectedRestriction: row.expectedRestriction,
    expectedComputedAt: isoOrNull(row.expectedComputedAt),
    reportedState: row.reportedState,
    reportedAt: isoOrNull(row.reportedAt),
    nextTransitionAt: isoOrNull(row.nextTransitionAt),
    attentionReason: row.attentionReason,
    activeShiftId: row.activeShiftId,
    activeBreakSessionId: row.activeBreakSessionId,
    breaksTakenCount: row.breaksTakenCount,
    breakMinutesUsed: row.breakMinutesUsed,
    lastUpdatedAt: iso(row.lastUpdatedAt),
  };
}

export function toShiftSummaryFromNext(row: NextShiftRow): ShiftSummary {
  return {
    id: row.id,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    timezone: row.timezone,
    status: row.status,
    location:
      row.locationId && row.locationName ? { id: row.locationId, name: row.locationName } : null,
  };
}

export function toShiftSummary(row: ShiftRow): ShiftSummary {
  return {
    id: row.id,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    timezone: row.timezone,
    status: row.status,
    location: row.location ? toNamedRef(row.location) : null,
  };
}

export function toBreakSessionDto(row: BreakSessionRow): BreakSessionResponse {
  return {
    id: row.id,
    clientBreakId: row.clientBreakId,
    shiftId: row.shiftId,
    startedAt: iso(row.startedAt),
    plannedEndsAt: iso(row.plannedEndsAt),
    endedAt: isoOrNull(row.endedAt),
    status: row.status,
    endReason: row.endReason,
    restrictionBehaviour: row.restrictionBehaviour,
    relaxedCategories: parseRelaxedCategories(row.relaxedCategories),
  };
}

function toOverridePayload(value: Prisma.JsonValue): OverridePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const out: OverridePayload = {};
  if (
    record.restrictionBehaviour === "RELAX_ALL" ||
    record.restrictionBehaviour === "RELAX_CATEGORIES" ||
    record.restrictionBehaviour === "KEEP_RESTRICTIONS"
  ) {
    out.restrictionBehaviour = record.restrictionBehaviour;
  }
  if (Array.isArray(record.relaxedCategories)) {
    out.relaxedCategories = parseRelaxedCategories(record.relaxedCategories);
  }
  if (typeof record.breakPolicyId === "string") out.breakPolicyId = record.breakPolicyId;
  return out;
}

export function toOverrideDto(row: OverrideRow, now: Date): Override {
  return {
    id: row.id,
    type: row.type,
    status: deriveOverrideStatus(row, now),
    reason: row.reason,
    employee: row.employee ? toEmployeeSummary(row.employee) : null,
    createdBy: row.createdBy
      ? { id: row.createdBy.id, name: row.createdBy.name, email: row.createdBy.email }
      : null,
    startsAt: iso(row.startsAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: isoOrNull(row.revokedAt),
    payload: toOverridePayload(row.payload),
    createdAt: iso(row.createdAt),
  };
}

/** Effective invite status: a stored PENDING / SENT invite whose expiry has passed reads as EXPIRED. */
export function effectiveInviteStatus(
  invite: Pick<EmployeeInviteRow, "status" | "expiresAt">,
  now: Date,
): EmployeeInvite["status"] {
  if (
    (invite.status === "PENDING" || invite.status === "SENT") &&
    invite.expiresAt.getTime() <= now.getTime()
  ) {
    return "EXPIRED";
  }
  return invite.status;
}

export function toEmployeeInviteDto(
  invite: EmployeeInviteRow,
  now: Date = new Date(),
): EmployeeInvite {
  return {
    id: invite.id,
    employeeId: invite.employeeId,
    code: invite.code,
    channel: invite.channel,
    status: effectiveInviteStatus(invite, now),
    sentAt: isoOrNull(invite.sentAt),
    acceptedAt: isoOrNull(invite.acceptedAt),
    expiresAt: iso(invite.expiresAt),
    revokedAt: isoOrNull(invite.revokedAt),
    createdAt: iso(invite.createdAt),
  };
}

export function toMobileEmployee(row: EmployeeRow): MobileEmployee {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    jobTitle: row.jobTitle,
    primaryLocation: row.primaryLocation
      ? {
          id: row.primaryLocation.id,
          name: row.primaryLocation.name,
          timezone: row.primaryLocation.timezone,
        }
      : null,
  };
}

export function toMobileOrganisation(org: {
  id: string;
  name: string;
  timezone: string;
}): MobileOrganisation {
  return { id: org.id, name: org.name, timezone: org.timezone };
}

// ── Activity feed ───────────────────────────────────────────────────────────

const ACTIVITY_VERBS: Record<ActivityEventType, string> = {
  EMPLOYEE_JOINED: "joined from the Work Mode app",
  SETUP_COMPLETED: "completed Screen Time setup",
  PERMISSION_GRANTED: "granted Screen Time permission",
  PERMISSION_NEEDS_ATTENTION: "has a Screen Time permission that needs attention",
  SELECTION_CONFIGURED: "selected the apps to shield",
  WORK_MODE_STARTED: "started Work Mode",
  WORK_MODE_ENDED: "ended Work Mode",
  BREAK_STARTED: "started a break",
  BREAK_ENDED: "ended a break",
  BREAK_EXPIRED: "had a break expire",
  SCHEDULE_SYNCED: "synced the schedule",
  POLICY_SYNCED: "synced the Work Policy",
  DEVICE_SYNC_DELAYED: "has a device whose sync is delayed",
  POLICY_UPDATED: "had a Work Policy updated",
  SHIFT_CREATED: "had a shift created",
  SHIFT_UPDATED: "had a shift updated",
  SHIFT_CANCELLED: "had a shift cancelled",
  OVERRIDE_CREATED: "received a manager override",
  OVERRIDE_EXPIRED: "had a manager override expire",
  INTEGRATION_ERROR: "integration error",
  IMPORT_COMPLETED: "shift import completed",
  POLICY_RESOLUTION_WARNING: "has an ambiguous policy assignment",
};

/** Plain-English one-liner for the feed. Metadata is operational only, so nothing sensitive can leak. */
export function summariseActivity(
  type: ActivityEventType,
  employeeName: string | null,
  actorName: string | null,
): string {
  const verb = ACTIVITY_VERBS[type] ?? type.toLowerCase().replace(/_/g, " ");
  const subject = employeeName ?? "Organisation";
  const base = `${subject} ${verb}`;
  return actorName ? `${base} (by ${actorName})` : base;
}

function toMetadataRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface ActivityActor {
  id: string;
  name: string;
  email: string | null;
}

export function toActivityEventDto(
  row: ActivityEventRow,
  employee: EmployeeSummary | null,
  actor: ActivityActor | null,
): ActivityEvent {
  const employeeName = employee ? `${employee.firstName} ${employee.lastName}`.trim() : null;
  return {
    id: row.id,
    type: row.type,
    occurredAt: iso(row.occurredAt),
    actorType: row.actorType,
    actor: actor ? { id: actor.id, name: actor.name, email: actor.email } : null,
    employee,
    deviceId: row.deviceId,
    summary: summariseActivity(
      row.type,
      employeeName,
      row.actorType === "MANAGER" ? (actor?.name ?? null) : null,
    ),
    metadata: toMetadataRecord(row.metadata),
  };
}

export function toDeviceStatusDto(
  status: {
    badge: DeviceStatus["badge"];
    reason?: string;
    severity: DeviceStatus["severity"];
  } | null,
  since: Date | null,
): DeviceStatus | null {
  if (!status) return null;
  return {
    badge: status.badge,
    reason: status.reason ?? null,
    severity: status.severity,
    since: isoOrNull(since),
  };
}
