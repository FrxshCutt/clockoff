import { UNLIMITED } from "@clockoff/shared/plans";
import { describe, expect, it } from "vitest";
import { usagePercent } from "./usage";

describe("usagePercent", () => {
  it("rounds the share of the limit used", () => {
    expect(usagePercent(5, 20)).toBe(25);
    expect(usagePercent(1, 3)).toBe(33);
    expect(usagePercent(2, 3)).toBe(67);
  });

  it("caps at 100 when over the limit", () => {
    expect(usagePercent(30, 20)).toBe(100);
  });

  it("is 0 for no or invalid usage", () => {
    expect(usagePercent(0, 20)).toBe(0);
    expect(usagePercent(-3, 20)).toBe(0);
    expect(usagePercent(Number.NaN, 20)).toBe(0);
  });

  it("has no meter for unlimited or zero limits", () => {
    expect(usagePercent(500, UNLIMITED)).toBeNull();
    expect(usagePercent(0, 0)).toBeNull();
  });
});
