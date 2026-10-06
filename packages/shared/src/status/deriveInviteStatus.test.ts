import { describe, expect, it } from "vitest";
import type { InviteStatus, PermissionState, SelectionState } from "../enums";
import {
  EMPLOYMENT_STATUSES,
  INVITE_STATUSES,
  PERMISSION_STATES,
  SELECTION_STATES,
} from "../enums";
import { deriveInviteStatus, type DeriveInviteStatusInput } from "./deriveInviteStatus";

const device = (
  permissionState: PermissionState,
  selectionState: SelectionState,
  isActive = true,
) => ({
  permissionState,
  selectionState,
  isActive,
});

describe("deriveInviteStatus decision table", () => {
  const rows: ReadonlyArray<readonly [string, DeriveInviteStatusInput, InviteStatus]> = [
    [
      "no link, no invite → NOT_INVITED",
      { hasLink: false, employmentStatus: "ACTIVE", hasPendingInvite: false },
      "NOT_INVITED",
    ],
    [
      "no link, pending invite → INVITED",
      { hasLink: false, employmentStatus: "ACTIVE", hasPendingInvite: true },
      "INVITED",
    ],
    [
      "no link, old deactivated device, no invite → NOT_INVITED (left the workplace)",
      {
        hasLink: false,
        device: device("APPROVED", "CONFIGURED", false),
        employmentStatus: "ACTIVE",
        hasPendingInvite: false,
      },
      "NOT_INVITED",
    ],
    [
      "no link, old device, re-invited → INVITED",
      {
        hasLink: false,
        device: device("APPROVED", "CONFIGURED", false),
        employmentStatus: "ACTIVE",
        hasPendingInvite: true,
      },
      "INVITED",
    ],
    [
      "linked, no device → JOINED",
      { hasLink: true, employmentStatus: "ACTIVE", hasPendingInvite: false },
      "JOINED",
    ],
    [
      "linked, device null → JOINED",
      { hasLink: true, device: null, employmentStatus: "ACTIVE", hasPendingInvite: true },
      "JOINED",
    ],
    [
      "linked, device untouched → JOINED",
      {
        hasLink: true,
        device: device("NOT_DETERMINED", "NONE"),
        employmentStatus: "ACTIVE",
        hasPendingInvite: false,
      },
      "JOINED",
    ],
    [
      "permission approved, nothing selected → SETUP_INCOMPLETE",
      {
        hasLink: true,
        device: device("APPROVED", "NONE"),
        employmentStatus: "ACTIVE",
        hasPendingInvite: false,
      },
      "SETUP_INCOMPLETE",
    ],
    [
      "permission denied → SETUP_INCOMPLETE",
      {
        hasLink: true,
        device: device("DENIED", "NONE"),
        employmentStatus: "ACTIVE",
        hasPendingInvite: false,
      },
      "SETUP_INCOMPLETE",
    ],
    [
      "permission revoked after setup → SETUP_INCOMPLETE",
      {
        hasLink: true,
        device: device("REVOKED", "CONFIGURED"),
        employmentStatus: "ACTIVE",
        hasPendingInvite: false,
      },
      "SETUP_INCOMPLETE",
    ],
    [
      "approved + configured → CONNECTED",
      {
        hasLink: true,
        device: device("APPROVED", "CONFIGURED"),
        employmentStatus: "ACTIVE",
        hasPendingInvite: false,
      },
      "CONNECTED",
    ],
    [
      "linked, device deactivated → DEACTIVATED",
      {
        hasLink: true,
        device: device("APPROVED", "CONFIGURED", false),
        employmentStatus: "ACTIVE",
        hasPendingInvite: false,
      },
      "DEACTIVATED",
    ],
    [
      "employment INACTIVE beats everything → DEACTIVATED",
      {
        hasLink: true,
        device: device("APPROVED", "CONFIGURED"),
        employmentStatus: "INACTIVE",
        hasPendingInvite: true,
      },
      "DEACTIVATED",
    ],
    [
      "employment INACTIVE, never invited → DEACTIVATED",
      { hasLink: false, employmentStatus: "INACTIVE", hasPendingInvite: false },
      "DEACTIVATED",
    ],
  ];

  it.each(rows)("%s", (_name, input, expected) => {
    expect(deriveInviteStatus(input)).toBe(expected);
  });

  it("covers every InviteStatus", () => {
    expect(new Set(rows.map((r) => r[2]))).toEqual(new Set(INVITE_STATUSES));
  });
});

describe("deriveInviteStatus is total and consistent", () => {
  it("returns a valid status for every combination and respects the lifecycle rules", () => {
    for (const employmentStatus of EMPLOYMENT_STATUSES) {
      for (const hasLink of [false, true]) {
        for (const hasPendingInvite of [false, true]) {
          const devices = [
            undefined,
            null,
            ...PERMISSION_STATES.flatMap((p) =>
              SELECTION_STATES.flatMap((s) => [device(p, s, true), device(p, s, false)]),
            ),
          ];
          for (const d of devices) {
            const status = deriveInviteStatus({
              hasLink,
              device: d,
              employmentStatus,
              hasPendingInvite,
            });
            expect(INVITE_STATUSES).toContain(status);
            if (employmentStatus === "INACTIVE") expect(status).toBe("DEACTIVATED");
            if (status === "CONNECTED") {
              expect(hasLink).toBe(true);
              expect(d?.permissionState).toBe("APPROVED");
              expect(d?.selectionState).toBe("CONFIGURED");
              expect(d?.isActive).toBe(true);
            }
            if (!hasLink && employmentStatus === "ACTIVE") {
              expect(status).toBe(hasPendingInvite ? "INVITED" : "NOT_INVITED");
            }
          }
        }
      }
    }
  });
});
