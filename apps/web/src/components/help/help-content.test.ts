import { DEVICE_STATUS_BADGES } from "@clockoff/shared/enums";
import { describe, expect, it } from "vitest";
import { isInternalPath } from "@/config/navigation";
import {
  FAQ_ITEMS,
  HELP_ANCHORS,
  IOS_MAIN_SCREENS,
  IOS_ONBOARDING_STEP_KEYS,
  SETUP_STEPS,
  SUPPORT,
  TROUBLESHOOTING,
} from "./help-content";

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

describe("FAQ", () => {
  it("has unique ids, questions ending in ? and answers ending in a full stop", () => {
    expect(FAQ_ITEMS.length).toBeGreaterThanOrEqual(8);
    expect(unique(FAQ_ITEMS.map((item) => item.id))).toBe(true);
    for (const item of FAQ_ITEMS) {
      expect(item.id, item.id).toMatch(/^[a-z0-9-]+$/);
      expect(item.question, item.id).toMatch(/\?$/);
      expect(item.answer, item.id).toMatch(/\.$/);
      expect(item.answer.length, item.id).toBeGreaterThan(40);
    }
  });

  it("only links to same-origin dashboard paths, each with a label", () => {
    for (const item of FAQ_ITEMS) {
      if (item.href === undefined) {
        expect(item.linkLabel, item.id).toBeUndefined();
        continue;
      }
      expect(isInternalPath(item.href), `${item.id}: ${item.href}`).toBe(true);
      expect(item.linkLabel, item.id).toBeTruthy();
    }
  });

  it("never promises data the privacy statements rule out", () => {
    const text = FAQ_ITEMS.map((item) => item.answer.toLowerCase()).join(" ");
    expect(text).not.toMatch(/see (their|which) (messages|photos|browsing)/);
    expect(text).not.toMatch(/track(s|ing)? (their )?location/);
  });
});

describe("employee setup guide", () => {
  it("mirrors the iOS onboarding steps exactly and in order", () => {
    // Source of truth: OnboardingViewModel.Step in apps/ios/ClockOffApp/Features/Onboarding/OnboardingViewModel.swift.
    expect(IOS_ONBOARDING_STEP_KEYS).toEqual([
      "welcome",
      "name",
      "joinWorkplace",
      "confirmIdentity",
      "screenTimeExplained",
      "authorise",
      "chooseApps",
      "confirmPolicy",
    ]);
    expect(SETUP_STEPS.map((step) => step.key)).toEqual([...IOS_ONBOARDING_STEP_KEYS]);
  });

  it("gives every step a screen name, title and detail", () => {
    expect(unique(SETUP_STEPS.map((step) => step.screen))).toBe(true);
    for (const step of SETUP_STEPS) {
      expect(step.screen, step.key).toBeTruthy();
      expect(step.title, step.key).toBeTruthy();
      expect(step.detail, step.key).toMatch(/\.$/);
      if (step.managerTip) expect(step.managerTip, step.key).toMatch(/\.$/);
    }
  });

  it("names the app's main tabs by their navigation titles", () => {
    expect(IOS_MAIN_SCREENS.map((screen) => screen.name)).toEqual([
      "ClockOff",
      "Schedule",
      "Settings",
    ]);
  });
});

describe("troubleshooting", () => {
  it("covers permission, sync and clock problems with real badges and concrete steps", () => {
    expect(TROUBLESHOOTING.map((item) => item.id)).toEqual([
      "permission-revoked",
      "sync-delayed",
      "clock-skew",
    ]);
    for (const item of TROUBLESHOOTING) {
      if (item.badge !== null) expect(DEVICE_STATUS_BADGES, item.id).toContain(item.badge);
      expect(item.symptom, item.id).toMatch(/\.$/);
      expect(item.cause, item.id).toMatch(/\.$/);
      expect(item.steps.length, item.id).toBeGreaterThanOrEqual(2);
      for (const step of item.steps) expect(step, item.id).toMatch(/\.$/);
    }
  });

  it("derives thresholds from the shared status rules", () => {
    const sync = TROUBLESHOOTING.find((item) => item.id === "sync-delayed")!;
    expect(sync.symptom).toContain("over 2 hours during a shift");
    expect(sync.symptom).toContain("over 24 hours otherwise");
    expect(sync.symptom).toContain("After 72 hours");
    const clock = TROUBLESHOOTING.find((item) => item.id === "clock-skew")!;
    expect(clock.symptom).toContain("more than 5 minutes");
  });
});

describe("support and anchors", () => {
  it("points at the configured support address", () => {
    expect(SUPPORT.email).toBe("support@clockoff.online");
    expect(SUPPORT.include.length).toBeGreaterThan(0);
  });

  it("uses url-safe anchor ids", () => {
    for (const anchor of Object.values(HELP_ANCHORS)) expect(anchor).toMatch(/^[a-z-]+$/);
    expect(unique(Object.values(HELP_ANCHORS))).toBe(true);
  });
});
