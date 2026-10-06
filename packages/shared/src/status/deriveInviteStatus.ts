import type { EmploymentStatus, InviteStatus, PermissionState, SelectionState } from "../enums";

export interface DeriveInviteStatusInput {
  /** An active EmployeeUserLink exists (unlinkedAt is null). */
  readonly hasLink: boolean;
  /** The employee's most recently registered device, if any. */
  readonly device?: {
    readonly permissionState: PermissionState;
    readonly selectionState: SelectionState;
    readonly isActive: boolean;
  } | null;
  readonly employmentStatus: EmploymentStatus;
  /** An EmployeeInvite in PENDING or SENT status exists and has not expired. */
  readonly hasPendingInvite: boolean;
}

/**
 * §9 employee lifecycle, in order:
 *
 *   NOT_INVITED → INVITED (a live invite exists) → JOINED (linked from the app) → SETUP_INCOMPLETE →
 *   CONNECTED (permission APPROVED and selection CONFIGURED); DEACTIVATED when employment is INACTIVE or the
 *   linked device has been deactivated.
 *
 * Choices:
 * - The join flow registers the device in the same step as the link, so "JOINED" covers both "linked, no
 *   device row yet" and "device registered but setup untouched" (permission NOT_DETERMINED and selection
 *   NONE). Any progress — or a denial — is SETUP_INCOMPLETE until both conditions for CONNECTED hold.
 * - Without a link the invite decides; an unlinked employee with a deactivated old device is not
 *   DEACTIVATED (they left the workplace and may be re-invited).
 */
export function deriveInviteStatus(input: DeriveInviteStatusInput): InviteStatus {
  if (input.employmentStatus === "INACTIVE") return "DEACTIVATED";
  if (!input.hasLink) return input.hasPendingInvite ? "INVITED" : "NOT_INVITED";
  const device = input.device ?? null;
  if (device === null) return "JOINED";
  if (!device.isActive) return "DEACTIVATED";
  if (device.permissionState === "APPROVED" && device.selectionState === "CONFIGURED")
    return "CONNECTED";
  if (device.permissionState === "NOT_DETERMINED" && device.selectionState === "NONE")
    return "JOINED";
  return "SETUP_INCOMPLETE";
}
