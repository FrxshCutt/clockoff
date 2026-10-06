import { describe, expect, it } from "vitest";
import {
  canInviteEmployee,
  canResendInvite,
  canRevokeInvite,
  canShowInstructions,
  channelAvailability,
  inviteActionLabel,
  inviteEffectiveStatus,
  isInviteOpen,
} from "./invite-helpers";

const NOW = "2026-10-06T09:00:00.000Z";
const FUTURE = "2026-10-13T09:00:00.000Z";
const PAST = "2026-10-01T09:00:00.000Z";

describe("invite status helpers", () => {
  it("treats a PENDING/SENT invite past its expiry as EXPIRED", () => {
    expect(inviteEffectiveStatus({ status: "SENT", expiresAt: PAST }, NOW)).toBe("EXPIRED");
    expect(inviteEffectiveStatus({ status: "PENDING", expiresAt: FUTURE }, NOW)).toBe("PENDING");
    expect(inviteEffectiveStatus({ status: "ACCEPTED", expiresAt: PAST }, NOW)).toBe("ACCEPTED");
    expect(inviteEffectiveStatus({ status: "REVOKED", expiresAt: FUTURE }, NOW)).toBe("REVOKED");
  });

  it("knows which invites are open, resendable and revocable", () => {
    const open = { status: "SENT" as const, expiresAt: FUTURE };
    const expired = { status: "SENT" as const, expiresAt: PAST };
    const accepted = { status: "ACCEPTED" as const, expiresAt: FUTURE };
    const revoked = { status: "REVOKED" as const, expiresAt: FUTURE };
    expect(isInviteOpen(open, NOW)).toBe(true);
    expect(isInviteOpen(expired, NOW)).toBe(false);
    expect(canResendInvite(open, NOW)).toBe(true);
    expect(canResendInvite(expired, NOW)).toBe(true);
    expect(canResendInvite(accepted, NOW)).toBe(false);
    expect(canResendInvite(revoked, NOW)).toBe(false);
    expect(canRevokeInvite(open, NOW)).toBe(true);
    expect(canRevokeInvite(expired, NOW)).toBe(false);
    expect(canShowInstructions(open, NOW)).toBe(true);
    expect(canShowInstructions(revoked, NOW)).toBe(false);
  });
});

describe("inviteActionLabel / canInviteEmployee", () => {
  it("follows the §9 lifecycle", () => {
    expect(inviteActionLabel("NOT_INVITED")).toBe("Invite");
    expect(inviteActionLabel("INVITED")).toBe("Resend invite");
    expect(inviteActionLabel("JOINED")).toBeNull();
    expect(inviteActionLabel("CONNECTED")).toBeNull();
    expect(inviteActionLabel("DEACTIVATED")).toBeNull();
    expect(canInviteEmployee({ inviteStatus: "NOT_INVITED", employmentStatus: "ACTIVE" })).toBe(
      true,
    );
    expect(canInviteEmployee({ inviteStatus: "NOT_INVITED", employmentStatus: "INACTIVE" })).toBe(
      false,
    );
  });
});

describe("channelAvailability", () => {
  it("disables SMS as coming soon and EMAIL without an address", () => {
    expect(channelAvailability("SMS", { email: "a@b.c", phone: "+44 7700 900123" })).toEqual({
      enabled: false,
      reason: "Coming soon",
    });
    expect(channelAvailability("EMAIL", { email: null, phone: null }).enabled).toBe(false);
    expect(channelAvailability("EMAIL", { email: "a@b.c", phone: null })).toEqual({
      enabled: true,
      reason: null,
    });
    expect(channelAvailability("LINK", { email: null, phone: null }).enabled).toBe(true);
  });
});
