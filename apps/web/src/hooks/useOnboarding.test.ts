import { describe, expect, it } from "vitest";
import { computeOnboardingProgress, type OnboardingStepLike } from "./useOnboarding";

const step = (key: string, done: boolean): OnboardingStepLike => ({
  key,
  label: `Step ${key}`,
  done,
  href: `/${key}`,
});

describe("computeOnboardingProgress", () => {
  it("reports nothing to do for an empty checklist (and never divides by zero)", () => {
    expect(computeOnboardingProgress([])).toEqual({
      completedCount: 0,
      totalCount: 0,
      percent: 0,
      allDone: false,
      nextStep: null,
      remaining: [],
    });
  });

  it("counts completed steps and rounds the percentage", () => {
    const items = [step("a", true), step("b", false), step("c", false)];
    const progress = computeOnboardingProgress(items);
    expect(progress.completedCount).toBe(1);
    expect(progress.totalCount).toBe(3);
    expect(progress.percent).toBe(33);
    expect(progress.allDone).toBe(false);
    expect(
      computeOnboardingProgress([step("a", true), step("b", true), step("c", false)]).percent,
    ).toBe(67);
  });

  it("picks the first undone step in checklist order as the next step", () => {
    const items = [
      step("createCompany", true),
      step("createPolicy", false),
      step("addEmployees", false),
      step("goLive", false),
    ];
    const progress = computeOnboardingProgress(items);
    expect(progress.nextStep?.key).toBe("createPolicy");
    expect(progress.remaining.map((item) => item.key)).toEqual([
      "createPolicy",
      "addEmployees",
      "goLive",
    ]);
  });

  it("skips over done steps that come after an undone one", () => {
    const items = [step("a", false), step("b", true), step("c", false)];
    const progress = computeOnboardingProgress(items);
    expect(progress.nextStep?.key).toBe("a");
    expect(progress.remaining.map((item) => item.key)).toEqual(["a", "c"]);
    expect(progress.completedCount).toBe(1);
  });

  it("is all done only when every step is done and there is at least one", () => {
    const progress = computeOnboardingProgress([step("a", true), step("b", true)]);
    expect(progress.allDone).toBe(true);
    expect(progress.percent).toBe(100);
    expect(progress.nextStep).toBeNull();
    expect(progress.remaining).toEqual([]);
  });

  it("preserves the step objects it was given (the card renders their labels and links)", () => {
    const items = [step("a", false)];
    expect(computeOnboardingProgress(items).nextStep).toBe(items[0]);
  });
});
