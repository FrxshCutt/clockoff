import type { ComplianceEmployeeRow, ComplianceFilter } from "@workmode/validation/compliance";

/** Pure helpers for the Compliance tab (unit tested in node). */

export interface ComplianceFilterMeta {
  readonly label: string;
  readonly description: string;
}

export const COMPLIANCE_FILTER_META: Record<ComplianceFilter, ComplianceFilterMeta> = {
  ALL: { label: "All", description: "Every active employee." },
  CONNECTED: {
    label: "Connected",
    description: "Setup complete: Work Mode runs during their shifts.",
  },
  AWAITING_SETUP: {
    label: "Awaiting setup",
    description: "Not invited, invited, joined or part-way through setup.",
  },
  MISSING_PERMISSIONS: {
    label: "Missing permissions",
    description: "Screen Time access denied or revoked.",
  },
  WORKING_NOW: { label: "Working now", description: "Expected to be on shift right now." },
  WORK_MODE_ACTIVE: {
    label: "Work Mode active",
    description: "The phone confirms restrictions are on.",
  },
  ON_BREAK: { label: "On break", description: "A break the phone has confirmed is in progress." },
  NEEDS_ATTENTION: {
    label: "Needs attention",
    description: "On shift with a permission, sync or state problem.",
  },
};

export type StateAgreement = "match" | "diverged" | "unknown";

/** Whether the phone's reported state agrees with what the schedule expects. */
export function stateAgreement(
  row: Pick<ComplianceEmployeeRow, "expectedState" | "reportedState">,
): StateAgreement {
  if (row.expectedState === null || row.reportedState === null) return "unknown";
  return row.expectedState === row.reportedState ? "match" : "diverged";
}

/** The attention copy for a row: the explicit reason, else the badge's reason, else nothing. */
export function describeAttention(
  row: Pick<ComplianceEmployeeRow, "attentionReason" | "deviceStatus">,
): string | null {
  const explicit = row.attentionReason?.trim();
  if (explicit) return explicit;
  const fromBadge = row.deviceStatus?.reason?.trim();
  return fromBadge ? fromBadge : null;
}
