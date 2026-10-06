import { describe, expect, it } from "vitest";
import {
  OVERRIDE_DURATION_PRESETS,
  OVERRIDE_TYPE_META,
  OVERRIDE_TYPE_ORDER,
  buildCreateOverrideInput,
  computeOverrideExpiry,
  describeOverrideRemaining,
  overrideMaxMinutes,
} from "./override-helpers";

const NOW = new Date("2026-10-06T09:00:00.000Z");
const EMPLOYEE = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";
const BREAK_POLICY = "7f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a11";

/** `datetime-local` value for a Date in the test runner's local zone. */
function localInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe("computeOverrideExpiry", () => {
  it("turns a preset into durationMinutes and an absolute expiry", () => {
    const result = computeOverrideExpiry({ kind: "preset", minutes: 30 }, NOW, "MANAGER");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.durationMinutes).toBe(30);
      expect(result.expiresAt.toISOString()).toBe("2026-10-06T09:30:00.000Z");
      expect(result.body).toEqual({ durationMinutes: 30 });
    }
  });

  it("caps managers and admins at 24 hours and owners at 7 days", () => {
    expect(overrideMaxMinutes("MANAGER")).toBe(24 * 60);
    expect(overrideMaxMinutes("ADMIN")).toBe(24 * 60);
    expect(overrideMaxMinutes("OWNER")).toBe(7 * 24 * 60);
    expect(overrideMaxMinutes(null)).toBe(24 * 60);
    const tooLong = computeOverrideExpiry({ kind: "preset", minutes: 25 * 60 }, NOW, "MANAGER");
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.message).toContain("24 h");
    expect(computeOverrideExpiry({ kind: "preset", minutes: 25 * 60 }, NOW, "OWNER").ok).toBe(true);
  });

  it("accepts a custom end in the future within the cap, rounding the duration up", () => {
    const until = new Date(NOW.getTime() + 90.5 * 60_000);
    const result = computeOverrideExpiry(
      { kind: "custom", until: localInputValue(until) },
      NOW,
      "ADMIN",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.durationMinutes).toBe(90); // the input has minute precision
      expect("expiresAt" in result.body).toBe(true);
    }
  });

  it("rejects a custom end in the past, empty, or beyond the cap", () => {
    expect(computeOverrideExpiry({ kind: "custom", until: "" }, NOW, "MANAGER").ok).toBe(false);
    const past = computeOverrideExpiry(
      { kind: "custom", until: localInputValue(new Date(NOW.getTime() - 60_000)) },
      NOW,
      "MANAGER",
    );
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.message).toContain("future");
    const far = computeOverrideExpiry(
      { kind: "custom", until: localInputValue(new Date(NOW.getTime() + 36 * 3_600_000)) },
      NOW,
      "MANAGER",
    );
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.message).toContain("24 h");
  });

  it("offers the 15/30/60/120 minute presets", () => {
    expect([...OVERRIDE_DURATION_PRESETS]).toEqual([15, 30, 60, 120]);
  });
});

describe("buildCreateOverrideInput", () => {
  const base = {
    employeeId: EMPLOYEE,
    type: "EXEMPT_TEMPORARILY" as const,
    reason: "Family emergency",
    expiry: { kind: "preset" as const, minutes: 60 },
    behaviour: { kind: "RELAX_ALL" as const },
  };

  it("builds a contract-valid body for lifting overrides without a payload", () => {
    const result = buildCreateOverrideInput(base, NOW, "MANAGER");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({
        employeeId: EMPLOYEE,
        type: "EXEMPT_TEMPORARILY",
        reason: "Family emergency",
        durationMinutes: 60,
      });
      expect(result.expiresAt.toISOString()).toBe("2026-10-06T10:00:00.000Z");
    }
  });

  it("requires a reason of at least 5 characters", () => {
    const result = buildCreateOverrideInput({ ...base, reason: "  ok " }, NOW, "MANAGER");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("reason");
  });

  it("adds the payload for TEMPORARY_EXCEPTION (break policy, categories, relax all)", () => {
    const viaPolicy = buildCreateOverrideInput(
      {
        ...base,
        type: "TEMPORARY_EXCEPTION",
        behaviour: { kind: "BREAK_POLICY", breakPolicyId: BREAK_POLICY },
      },
      NOW,
      "MANAGER",
    );
    expect(viaPolicy.ok && viaPolicy.input.payload).toEqual({ breakPolicyId: BREAK_POLICY });

    const categories = buildCreateOverrideInput(
      {
        ...base,
        type: "TEMPORARY_EXCEPTION",
        behaviour: { kind: "RELAX_CATEGORIES", categories: ["SOCIAL_MEDIA"] },
      },
      NOW,
      "MANAGER",
    );
    expect(categories.ok && categories.input.payload).toEqual({
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["SOCIAL_MEDIA"],
    });

    const none = buildCreateOverrideInput(
      {
        ...base,
        type: "TEMPORARY_EXCEPTION",
        behaviour: { kind: "RELAX_CATEGORIES", categories: [] },
      },
      NOW,
      "MANAGER",
    );
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.field).toBe("behaviour");

    const all = buildCreateOverrideInput({ ...base, type: "TEMPORARY_EXCEPTION" }, NOW, "MANAGER");
    expect(all.ok && all.input.payload).toEqual({ restrictionBehaviour: "RELAX_ALL" });
  });

  it("only allows an organisation-wide override for the emergency type", () => {
    const bad = buildCreateOverrideInput({ ...base, employeeId: null }, NOW, "OWNER");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe("employee");
    const ok = buildCreateOverrideInput(
      { ...base, employeeId: null, type: "EMERGENCY_POLICY_OVERRIDE" },
      NOW,
      "OWNER",
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect("employeeId" in ok.input).toBe(false);
  });

  it("has copy for every override type, in display order", () => {
    expect(OVERRIDE_TYPE_ORDER).toHaveLength(4);
    for (const type of OVERRIDE_TYPE_ORDER)
      expect(OVERRIDE_TYPE_META[type].description.length).toBeGreaterThan(20);
  });
});

describe("describeOverrideRemaining", () => {
  it("describes the time left or the end state", () => {
    expect(
      describeOverrideRemaining({ expiresAt: "2026-10-06T09:45:00.000Z", status: "ACTIVE" }, NOW),
    ).toBe("45 min left");
    expect(
      describeOverrideRemaining({ expiresAt: "2026-10-06T08:45:00.000Z", status: "EXPIRED" }, NOW),
    ).toBe("Expired");
    expect(
      describeOverrideRemaining({ expiresAt: "2026-10-06T09:45:00.000Z", status: "REVOKED" }, NOW),
    ).toBe("Revoked");
  });
});
