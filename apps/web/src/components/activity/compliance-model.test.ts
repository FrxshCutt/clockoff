import { COMPLIANCE_FILTERS } from "@clockoff/validation/compliance";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_FILTER_META, describeAttention, stateAgreement } from "./compliance-model";

describe("COMPLIANCE_FILTER_META", () => {
  it("labels every filter the API accepts, uniquely", () => {
    expect(Object.keys(COMPLIANCE_FILTER_META).sort()).toEqual([...COMPLIANCE_FILTERS].sort());
    const labels = COMPLIANCE_FILTERS.map((filter) => COMPLIANCE_FILTER_META[filter].label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const filter of COMPLIANCE_FILTERS)
      expect(COMPLIANCE_FILTER_META[filter].description.trim()).not.toBe("");
  });
});

describe("stateAgreement", () => {
  it("is unknown until both sides have a state", () => {
    expect(stateAgreement({ expectedState: null, reportedState: null })).toBe("unknown");
    expect(stateAgreement({ expectedState: "WORKING", reportedState: null })).toBe("unknown");
    expect(stateAgreement({ expectedState: null, reportedState: "WORKING" })).toBe("unknown");
  });

  it("compares the two states", () => {
    expect(stateAgreement({ expectedState: "WORKING", reportedState: "WORKING" })).toBe("match");
    expect(stateAgreement({ expectedState: "WORKING", reportedState: "OFF_SHIFT" })).toBe(
      "diverged",
    );
  });
});

describe("describeAttention", () => {
  const badge = {
    badge: "SYNC_DELAYED" as const,
    reason: "No check-in for 3 hours",
    severity: "warning" as const,
    since: null,
  };

  it("prefers the explicit reason, then the badge's reason, else nothing", () => {
    expect(
      describeAttention({ attentionReason: "Clock is 7 minutes out", deviceStatus: badge }),
    ).toBe("Clock is 7 minutes out");
    expect(describeAttention({ attentionReason: null, deviceStatus: badge })).toBe(
      "No check-in for 3 hours",
    );
    expect(
      describeAttention({ attentionReason: "   ", deviceStatus: { ...badge, reason: null } }),
    ).toBeNull();
    expect(describeAttention({ attentionReason: null, deviceStatus: null })).toBeNull();
  });
});
