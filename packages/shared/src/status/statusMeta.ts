import type { DeviceStatusBadge, InviteStatus, WorkModeState } from "../enums";

/** Visual tone; the web `StatusBadge` component maps tone → colour so copy and colour never drift apart. */
export type StatusTone = "neutral" | "success" | "info" | "warning" | "danger";

export const STATUS_TONES = [
  "neutral",
  "success",
  "info",
  "warning",
  "danger",
] as const satisfies readonly StatusTone[];

export interface StatusMeta {
  readonly label: string;
  readonly tone: StatusTone;
  /** One sentence for tooltips / help text. */
  readonly description: string;
}

/** Copy for the derived device badge (§9). Not stored; computed by `deriveDeviceStatus`. */
export const STATUS_BADGE_META: Record<DeviceStatusBadge, StatusMeta> = {
  READY: {
    label: "Ready",
    tone: "success",
    description:
      "Setup is complete and the device is connected. No shift is active yet (a shift may be about to start).",
  },
  OFF_SHIFT: {
    label: "Off shift",
    tone: "neutral",
    description:
      "Connected and working normally; no shift is active, so no restrictions are applied.",
  },
  WORKING: {
    label: "Working",
    tone: "info",
    description:
      "A shift is active but the device has not confirmed Work Mode yet, or a manager override has lifted restrictions.",
  },
  WORK_MODE_ACTIVE: {
    label: "Work Mode active",
    tone: "success",
    description: "A shift is active and the device has confirmed that Work Mode is running.",
  },
  ON_BREAK: {
    label: "On break",
    tone: "info",
    description:
      "The employee is on a break the device has confirmed; restrictions are relaxed as the Break Rules allow.",
  },
  PERMISSIONS_MISSING: {
    label: "Permissions missing",
    tone: "warning",
    description:
      "Screen Time authorisation is not approved or no apps have been selected. Ask the employee to finish setup in the app.",
  },
  SYNC_DELAYED: {
    label: "Sync delayed",
    tone: "warning",
    description:
      "The device has not checked in recently: over 2 hours during a shift, or over 24 hours otherwise.",
  },
  OFFLINE: {
    label: "Offline",
    tone: "danger",
    description: "The device has not checked in for more than 72 hours.",
  },
  NEEDS_ATTENTION: {
    label: "Needs attention",
    tone: "danger",
    description:
      "The device reported an error, its clock is more than 5 minutes out, or during a shift its state has disagreed with the schedule for over 10 minutes.",
  },
};

/** Copy for the employee lifecycle (§9). */
export const INVITE_STATUS_META: Record<InviteStatus, StatusMeta> = {
  NOT_INVITED: {
    label: "Not invited",
    tone: "neutral",
    description: "The employee exists in ClockOff but has not been sent an invite yet.",
  },
  INVITED: {
    label: "Invited",
    tone: "info",
    description: "An invite is pending. The employee has not joined from the app yet.",
  },
  JOINED: {
    label: "Joined",
    tone: "info",
    description: "The employee joined from the app but has not started Screen Time setup.",
  },
  SETUP_INCOMPLETE: {
    label: "Setup incomplete",
    tone: "warning",
    description: "Screen Time authorisation or app selection is not finished on the device.",
  },
  CONNECTED: {
    label: "Connected",
    tone: "success",
    description: "Authorisation approved and apps selected. Work Mode will run during shifts.",
  },
  DEACTIVATED: {
    label: "Deactivated",
    tone: "neutral",
    description: "The employee or their device has been deactivated. The device no longer syncs.",
  },
};

/** Copy for the Work Mode engine state (§6.2), used for both device-reported and server-expected state. */
export const WORK_MODE_STATE_META: Record<WorkModeState, StatusMeta> = {
  OFF_SHIFT: {
    label: "Off shift",
    tone: "neutral",
    description: "No shift is active; no restrictions are applied.",
  },
  SHIFT_STARTING_SOON: {
    label: "Starting soon",
    tone: "info",
    description: "A shift begins shortly; restrictions will apply when it starts.",
  },
  WORKING: {
    label: "Working",
    tone: "success",
    description: "A shift is active and Work Policy restrictions are applied.",
  },
  ON_BREAK: {
    label: "On break",
    tone: "info",
    description: "A break is in progress; restrictions are relaxed as the Break Rules allow.",
  },
  SHIFT_ENDING: {
    label: "Shift ending",
    tone: "info",
    description: "The shift ends in a few minutes; restrictions lift when it does.",
  },
  MANAGER_OVERRIDE: {
    label: "Manager override",
    tone: "warning",
    description: "A manager override has lifted restrictions for this shift.",
  },
  PERMISSION_ERROR: {
    label: "Permission error",
    tone: "danger",
    description:
      "Screen Time authorisation is missing or was revoked, so restrictions cannot be applied.",
  },
  SYNC_ERROR: {
    label: "Sync error",
    tone: "danger",
    description: "The device could not sync its schedule or policy.",
  },
  UNKNOWN: {
    label: "Unknown",
    tone: "neutral",
    description: "No state has been reported yet.",
  },
};
