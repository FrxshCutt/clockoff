import {
  COMPLIANCE_METRIC_KEYS,
  type ComplianceEmployeeRow,
  type UpcomingShift,
} from "@clockoff/validation/compliance";
import { describe, expect, it } from "vitest";
import {
  METRIC_CARDS,
  UPCOMING_SHIFT_WINDOW_HOURS,
  describeAwaitingSetup,
  isComplianceMetricKey,
  metricHref,
  metricValueTone,
  upcomingShiftsWithin,
} from "./overview-model";

const employee = {
  id: "0b0e2e9e-7c0a-4a2b-9e3b-1b4c2a9d8f10",
  firstName: "Jane",
  lastName: "Smith",
  jobTitle: null,
  primaryLocation: null,
  inviteStatus: "INVITED" as const,
};

describe("metric cards", () => {
  it("defines the eight cards in the contract's order with unique labels", () => {
    expect(METRIC_CARDS.map((card) => card.key)).toEqual([...COMPLIANCE_METRIC_KEYS]);
    expect(new Set(METRIC_CARDS.map((card) => card.label)).size).toBe(8);
    for (const card of METRIC_CARDS) expect(card.description.trim()).not.toBe("");
  });

  it("links a card to the employees quick filter only when it selects exactly the rows the metric counted", () => {
    expect(metricHref("totalEmployees")).toBe("/employees");
    expect(metricHref("connected")).toBe("/employees?filter=connected");
    expect(metricHref("missingPermissions")).toBe("/employees?filter=permissionsMissing");
    expect(metricHref("onBreak")).toBe("/employees?filter=onBreak");
  });

  it("sends metrics without an identical quick filter to the compliance tab, which has the exact API filter", () => {
    // NOT_INVITED counts as awaiting setup; the employees quick filter starts at INVITED.
    expect(metricHref("awaitingSetup")).toBe("/activity?tab=compliance&filter=AWAITING_SETUP");
    // Expected on shift, whatever the phone reports — not the WORKING / WORK_MODE_ACTIVE badges.
    expect(metricHref("workingNow")).toBe("/activity?tab=compliance&filter=WORKING_NOW");
    expect(metricHref("workModeActive")).toBe("/activity?tab=compliance&filter=WORK_MODE_ACTIVE");
    // PERMISSIONS_MISSING only needs attention while on shift; the quick filter counts it always.
    expect(metricHref("needsAttention")).toBe("/activity?tab=compliance&filter=NEEDS_ATTENTION");
  });

  it("tones a value by what it means, and keeps zero neutral", () => {
    for (const key of COMPLIANCE_METRIC_KEYS) expect(metricValueTone(key, 0)).toBe("neutral");
    expect(metricValueTone("needsAttention", 1)).toBe("danger");
    expect(metricValueTone("missingPermissions", 3)).toBe("danger");
    expect(metricValueTone("awaitingSetup", 2)).toBe("warning");
    expect(metricValueTone("connected", 9)).toBe("success");
    expect(metricValueTone("workModeActive", 4)).toBe("success");
    expect(metricValueTone("workingNow", 5)).toBe("info");
    expect(metricValueTone("onBreak", 1)).toBe("info");
    expect(metricValueTone("totalEmployees", 50)).toBe("neutral");
  });

  it("recognises metric keys", () => {
    expect(isComplianceMetricKey("onBreak")).toBe(true);
    expect(isComplianceMetricKey("ON_BREAK")).toBe(false);
    expect(isComplianceMetricKey(undefined)).toBe(false);
  });
});

describe("upcomingShiftsWithin", () => {
  const now = Date.parse("2026-10-06T09:00:00.000Z");
  const hours = (n: number) => new Date(now + n * 3_600_000).toISOString();
  const shift = (id: string, startHours: number, endHours: number): UpcomingShift => ({
    shift: {
      id,
      startsAt: hours(startHours),
      endsAt: hours(endHours),
      timezone: "Europe/London",
      status: "SCHEDULED",
      location: null,
    },
    employee,
    deviceStatus: null,
    ready: true,
  });

  it("keeps shifts that start within the window or are already in progress, soonest first", () => {
    const result = upcomingShiftsWithin(
      [shift("later", 11, 19), shift("inProgress", -2, 6), shift("soon", 1, 9)],
      now,
    );
    expect(result.map((entry) => entry.shift.id)).toEqual(["inProgress", "soon", "later"]);
  });

  it("drops shifts that start after the window or have already ended", () => {
    const result = upcomingShiftsWithin(
      [
        shift("tooLate", UPCOMING_SHIFT_WINDOW_HOURS + 1, 30),
        shift("ended", -10, -1),
        shift("edge", UPCOMING_SHIFT_WINDOW_HOURS, 20),
      ],
      now,
    );
    expect(result.map((entry) => entry.shift.id)).toEqual(["edge"]);
  });

  it("accepts a custom window and tolerates bad input", () => {
    expect(upcomingShiftsWithin([shift("a", 3, 4)], now, 2)).toEqual([]);
    expect(upcomingShiftsWithin([shift("a", 3, 4)], now, 4).map((e) => e.shift.id)).toEqual(["a"]);
    expect(upcomingShiftsWithin([shift("a", 1, 2)], "not a date")).toEqual([]);
    const broken = {
      ...shift("b", 1, 2),
      shift: { ...shift("b", 1, 2).shift, startsAt: "garbage" },
    };
    expect(upcomingShiftsWithin([broken], now)).toEqual([]);
  });
});

describe("describeAwaitingSetup", () => {
  type Input = Parameters<typeof describeAwaitingSetup>[0];
  const row = (
    overrides: Partial<Input> & {
      inviteStatus?: ComplianceEmployeeRow["employee"]["inviteStatus"];
    } = {},
  ): Input => {
    const { inviteStatus, ...rest } = overrides;
    return {
      employee: { ...employee, inviteStatus: inviteStatus ?? "INVITED" },
      deviceStatus: null,
      permissionState: null,
      selectionState: null,
      attentionReason: null,
      ...rest,
    };
  };

  it("describes each stage before the employee has joined, with the right invite action", () => {
    expect(describeAwaitingSetup(row({ inviteStatus: "NOT_INVITED" }))).toMatchObject({
      stage: "notInvited",
      statusText: "Not invited yet",
      inviteAction: "invite",
      canCopyInvite: true,
    });
    expect(describeAwaitingSetup(row({ inviteStatus: "INVITED" }))).toMatchObject({
      stage: "invited",
      statusText: "Invite sent · waiting for them to join",
      tone: "info",
      inviteAction: "resend",
      canCopyInvite: true,
    });
  });

  it("stops offering invite actions once the employee has joined", () => {
    const joined = describeAwaitingSetup(row({ inviteStatus: "JOINED" }));
    expect(joined).toMatchObject({ stage: "joined", inviteAction: null, canCopyInvite: false });
    expect(joined.statusText).toContain("Joined");
  });

  it("explains what is still missing for a partly set up phone", () => {
    expect(
      describeAwaitingSetup(row({ inviteStatus: "SETUP_INCOMPLETE", permissionState: "DENIED" })),
    ).toMatchObject({
      statusText: "Permission missing",
      tone: "danger",
      inviteAction: null,
    });
    expect(
      describeAwaitingSetup(row({ inviteStatus: "SETUP_INCOMPLETE", permissionState: "REVOKED" }))
        .statusText,
    ).toBe("Permission missing");
    expect(
      describeAwaitingSetup(
        row({
          inviteStatus: "SETUP_INCOMPLETE",
          permissionState: "APPROVED",
          selectionState: "NONE",
        }),
      ),
    ).toMatchObject({
      statusText: "Joined · no apps selected yet",
      tone: "warning",
    });
    expect(
      describeAwaitingSetup(
        row({ inviteStatus: "SETUP_INCOMPLETE", permissionState: "NOT_DETERMINED" }),
      ).statusText,
    ).toBe("Joined · permission not granted yet");
    expect(
      describeAwaitingSetup(row({ inviteStatus: "SETUP_INCOMPLETE", permissionState: null }))
        .statusText,
    ).toBe("Joined · permission not granted yet");
    expect(
      describeAwaitingSetup(
        row({
          inviteStatus: "SETUP_INCOMPLETE",
          permissionState: "APPROVED",
          selectionState: "CONFIGURED",
        }),
      ).statusText,
    ).toBe("Joined · setup incomplete");
  });

  it("falls back to the humanised lifecycle label for stages the panel does not expect", () => {
    expect(describeAwaitingSetup(row({ inviteStatus: "CONNECTED" }))).toMatchObject({
      stage: "other",
      statusText: "Connected",
      inviteAction: null,
    });
    expect(describeAwaitingSetup(row({ inviteStatus: "DEACTIVATED" })).statusText).toBe(
      "Deactivated",
    );
  });

  it("surfaces the attention reason, else the badge's reason, as the detail line", () => {
    const badge = {
      badge: "PERMISSIONS_MISSING" as const,
      reason: "Screen Time access was revoked",
      severity: "warning" as const,
      since: null,
    };
    expect(
      describeAwaitingSetup(row({ attentionReason: "Clock is 7 minutes out", deviceStatus: badge }))
        .detail,
    ).toBe("Clock is 7 minutes out");
    expect(describeAwaitingSetup(row({ deviceStatus: badge })).detail).toBe(
      "Screen Time access was revoked",
    );
    expect(describeAwaitingSetup(row({ attentionReason: "  " })).detail).toBeNull();
  });
});
