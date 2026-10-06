import { ACTIVATION_MODES, INTEGRATION_PROVIDERS } from "@workmode/shared/enums";
import { PROVIDERS } from "@workmode/shared/providers/registry";
import { integrationProviderParamSchema } from "@workmode/validation/integrations";
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_MODE_COPY,
  describeActivationModes,
  integrationCardState,
  providerInitials,
  providerPathSegment,
  safeExternalUrl,
  websiteLabel,
} from "./integration-view-model";

describe("providerInitials", () => {
  it("takes the first letters of the first two words, or the first two characters", () => {
    expect(providerInitials("Planday")).toBe("PL");
    expect(providerInitials("When I Work")).toBe("WI");
    expect(providerInitials("7shifts")).toBe("7S");
    expect(providerInitials("  ")).toBe("?");
  });

  it("gives every registered provider a two-character placeholder", () => {
    for (const id of INTEGRATION_PROVIDERS)
      expect(providerInitials(PROVIDERS[id].displayName), id).toHaveLength(2);
  });
});

describe("providerPathSegment", () => {
  it("produces a segment the API's provider param accepts for every provider", () => {
    for (const id of INTEGRATION_PROVIDERS) {
      const segment = providerPathSegment(id);
      expect(segment, id).toMatch(/^[a-z0-9-]+$/);
      expect(integrationProviderParamSchema.parse(segment), id).toBe(id);
    }
    expect(providerPathSegment("WHEN_I_WORK")).toBe("when-i-work");
  });
});

describe("integrationCardState", () => {
  it("is coming-soon whenever the provider isn't available, else follows the stored status", () => {
    expect(integrationCardState({ availability: "COMING_SOON", status: "CONNECTED" })).toBe(
      "coming-soon",
    );
    expect(integrationCardState({ availability: "AVAILABLE", status: "NOT_CONNECTED" })).toBe(
      "not-connected",
    );
    expect(integrationCardState({ availability: "AVAILABLE", status: "CONNECTED" })).toBe(
      "connected",
    );
    expect(integrationCardState({ availability: "AVAILABLE", status: "ERROR" })).toBe("error");
    expect(integrationCardState({ availability: "AVAILABLE", status: "DISCONNECTED" })).toBe(
      "disconnected",
    );
  });
});

describe("activation modes", () => {
  it("has copy for every mode and joins labels readably", () => {
    for (const mode of ACTIVATION_MODES) {
      expect(ACTIVATION_MODE_COPY[mode].label, mode).toBeTruthy();
      expect(ACTIVATION_MODE_COPY[mode].detail, mode).toMatch(/\.$/);
    }
    expect(describeActivationModes(["SCHEDULED", "CLOCK_EVENT"])).toBe("Scheduled or Clock-in");
    expect(describeActivationModes(["SCHEDULED"])).toBe("Scheduled");
    expect(describeActivationModes([])).toBe("—");
  });
});

describe("website links", () => {
  it("keeps only http(s) URLs and labels them by host", () => {
    expect(safeExternalUrl("https://www.planday.com")).toBe("https://www.planday.com/");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
    expect(websiteLabel("https://www.planday.com")).toBe("planday.com");
    expect(websiteLabel("https://wheniwork.com")).toBe("wheniwork.com");
    expect(websiteLabel("javascript:alert(1)")).toBe("");
  });
});
