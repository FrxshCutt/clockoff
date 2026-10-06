import type { EmployeeInviteStatus, InviteChannel, InviteStatus } from "@workmode/shared/enums";
import type { EmployeeInvite } from "@workmode/validation/invites";
import { toDate, type DateInput } from "@/lib/format";

/** Pure helpers for the employee invite UX (unit tested in node). */

export interface InviteChannelMeta {
  readonly label: string;
  readonly description: string;
  /** False while the channel is not implemented (shown disabled with "Coming soon"). */
  readonly available: boolean;
}

export const INVITE_CHANNEL_META: Record<InviteChannel, InviteChannelMeta> = {
  LINK: {
    label: "Share instructions myself",
    description:
      "Creates the invite code. You copy the setup steps and send them however you like.",
    available: true,
  },
  EMAIL: {
    label: "Email",
    description: "We email the employee their code and setup steps.",
    available: true,
  },
  SMS: {
    label: "Text message (SMS)",
    description: "We text the employee their code and setup steps.",
    available: false,
  },
};

export const INVITE_CHANNEL_ORDER: readonly InviteChannel[] = ["LINK", "EMAIL", "SMS"];

export interface ChannelAvailability {
  readonly enabled: boolean;
  /** Why the option is disabled, e.g. "Coming soon" or "Add an email address first". */
  readonly reason: string | null;
}

export function channelAvailability(
  channel: InviteChannel,
  employee: { email: string | null; phone: string | null },
): ChannelAvailability {
  const meta = INVITE_CHANNEL_META[channel];
  if (!meta.available) return { enabled: false, reason: "Coming soon" };
  if (channel === "EMAIL" && !employee.email)
    return { enabled: false, reason: "Add an email address to the employee first" };
  if (channel === "SMS" && !employee.phone)
    return { enabled: false, reason: "Add a phone number to the employee first" };
  return { enabled: true, reason: null };
}

/** PENDING / SENT invites that have passed `expiresAt` read as EXPIRED even before the server marks them. */
export function inviteEffectiveStatus(
  invite: Pick<EmployeeInvite, "status" | "expiresAt">,
  now: DateInput = Date.now(),
): EmployeeInviteStatus {
  if (invite.status !== "PENDING" && invite.status !== "SENT") return invite.status;
  const expires = toDate(invite.expiresAt);
  const reference = toDate(now);
  if (expires && reference && expires.getTime() <= reference.getTime()) return "EXPIRED";
  return invite.status;
}

/** An invite the employee can still use. */
export function isInviteOpen(
  invite: Pick<EmployeeInvite, "status" | "expiresAt">,
  now: DateInput = Date.now(),
): boolean {
  const status = inviteEffectiveStatus(invite, now);
  return status === "PENDING" || status === "SENT";
}

/** Resend makes sense for anything not accepted or revoked (a fresh code is issued). */
export function canResendInvite(
  invite: Pick<EmployeeInvite, "status" | "expiresAt">,
  now: DateInput = Date.now(),
): boolean {
  const status = inviteEffectiveStatus(invite, now);
  return status === "PENDING" || status === "SENT" || status === "EXPIRED";
}

/** Revoke only applies to an invite that is still open. */
export function canRevokeInvite(
  invite: Pick<EmployeeInvite, "status" | "expiresAt">,
  now: DateInput = Date.now(),
): boolean {
  return isInviteOpen(invite, now);
}

/** Instructions can be shown while the code is still usable. */
export function canShowInstructions(
  invite: Pick<EmployeeInvite, "status" | "expiresAt">,
  now: DateInput = Date.now(),
): boolean {
  return isInviteOpen(invite, now);
}

/**
 * Label for the employee-level "Invite" action, from the §9 lifecycle: NOT_INVITED → "Invite", INVITED →
 * "Resend invite"; once the employee has joined (or is deactivated) the invite is no longer relevant.
 */
export function inviteActionLabel(inviteStatus: InviteStatus): string | null {
  switch (inviteStatus) {
    case "NOT_INVITED":
      return "Invite";
    case "INVITED":
      return "Resend invite";
    case "JOINED":
    case "SETUP_INCOMPLETE":
    case "CONNECTED":
    case "DEACTIVATED":
      return null;
    default:
      return null;
  }
}

/** Whether the employee can be (re)invited at all: active and not yet linked to a device. */
export function canInviteEmployee(employee: {
  inviteStatus: InviteStatus;
  employmentStatus: "ACTIVE" | "INACTIVE";
}): boolean {
  return (
    employee.employmentStatus === "ACTIVE" && inviteActionLabel(employee.inviteStatus) !== null
  );
}
