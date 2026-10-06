import type { Organisation as OrganisationRow } from "@workmode/db";
import { describe, expect, it } from "vitest";
import { JOIN_CODE_PATTERN, JOIN_CODE_WORD_COUNT, generateCompanyJoinCode } from "./joinCode";
import { managerInviteState, readOrganisationSettings, toOrganisationDto } from "./mappers";
import { buildOnboardingResponse, computeOnboardingSteps } from "./service";
import { slugCandidates, slugify } from "./slug";

describe("slugs", () => {
  it("normalises names", () => {
    expect(slugify("Harpenden Coffee Co.")).toBe("harpenden-coffee-co");
    expect(slugify("  Café Zoë & Sons!! ")).toBe("cafe-zoe-and-sons");
    expect(slugify("日本")).toBe("organisation");
    expect(slugify("a".repeat(80))).toHaveLength(48);
  });

  it("yields numbered then random candidates within 48 chars", () => {
    const list = slugCandidates("Acme", { numbered: 3, random: 2, randomSuffix: () => "zz9zz9" });
    expect(list).toEqual(["acme", "acme-2", "acme-3", "acme-zz9zz9", "acme-zz9zz9"]);
    for (const s of slugCandidates("x".repeat(60))) expect(s.length).toBeLessThanOrEqual(48);
  });
});

describe("join codes", () => {
  it("are WORD-#### without I or O", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCompanyJoinCode();
      expect(code).toMatch(JOIN_CODE_PATTERN);
    }
  });

  it("are deterministic with an injected random source", () => {
    const draws = [0, 0.0042];
    const code = generateCompanyJoinCode(() => draws.shift() ?? 0);
    expect(code).toMatch(/^[A-Z]{4,5}-0042$/);
    expect(JOIN_CODE_WORD_COUNT).toBeGreaterThanOrEqual(100);
  });
});

describe("mappers", () => {
  it("merges stored settings over defaults key by key, dropping invalid values", () => {
    expect(
      readOrganisationSettings({ timeFormat: "H12", weekStartsOn: "FRIDAY", junk: 1 }),
    ).toEqual({
      weekStartsOn: "MONDAY",
      timeFormat: "H12",
      requireInviteCodeToJoin: false,
    });
    expect(readOrganisationSettings(null as never)).toEqual({
      weekStartsOn: "MONDAY",
      timeFormat: "H24",
      requireInviteCodeToJoin: false,
    });
  });

  it("maps organisations with UTC instants and the dismissed onboarding timestamp", () => {
    const row = {
      id: "7d1b5a8e-2f7c-4c35-9a53-2b8f6f0e4a11",
      name: "Org",
      slug: "org",
      timezone: "Europe/London",
      dateFormat: "DMY",
      defaultPolicyId: null,
      defaultBreakPolicyId: null,
      billingStatus: "TRIAL",
      plan: "STARTER",
      onboardingState: { createCompany: true, dismissedAt: "2026-10-06T10:00:00+01:00" },
      settings: {},
      deletedAt: null,
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-10-02T00:00:00Z"),
    } satisfies OrganisationRow;
    const dto = toOrganisationDto(row);
    expect(dto.onboardingDismissedAt).toBe("2026-10-06T09:00:00.000Z");
    expect(dto.createdAt).toBe("2026-10-01T00:00:00.000Z");
    expect(dto).not.toHaveProperty("deletedAt");
  });

  it("derives manager invite state", () => {
    const now = new Date("2026-10-06T00:00:00Z");
    const future = new Date("2026-10-10T00:00:00Z");
    const past = new Date("2026-10-01T00:00:00Z");
    expect(managerInviteState({ acceptedAt: null, revokedAt: null, expiresAt: future }, now)).toBe(
      "PENDING",
    );
    expect(managerInviteState({ acceptedAt: null, revokedAt: null, expiresAt: past }, now)).toBe(
      "EXPIRED",
    );
    expect(managerInviteState({ acceptedAt: null, revokedAt: past, expiresAt: future }, now)).toBe(
      "REVOKED",
    );
    expect(managerInviteState({ acceptedAt: past, revokedAt: past, expiresAt: past }, now)).toBe(
      "ACCEPTED",
    );
  });
});

describe("onboarding checklist", () => {
  const none = {
    activePolicies: 0,
    activeBreakPolicies: 0,
    employees: 0,
    shifts: 0,
    employeeInvites: 0,
    activeDevices: 0,
  };

  it("is computed from counts; go-live needs every other step", () => {
    const empty = buildOnboardingResponse(computeOnboardingSteps(none), null);
    expect(empty.items.map((i) => [i.key, i.done])).toEqual([
      ["createCompany", true],
      ["createPolicy", false],
      ["configureBreakRules", false],
      ["addEmployees", false],
      ["addSchedules", false],
      ["inviteEmployees", false],
      ["employeesConnect", false],
      ["goLive", false],
    ]);
    expect(empty).toMatchObject({
      completedCount: 1,
      totalCount: 8,
      allDone: false,
      dismissedAt: null,
    });

    const all = buildOnboardingResponse(
      computeOnboardingSteps({
        activePolicies: 1,
        activeBreakPolicies: 1,
        employees: 3,
        shifts: 5,
        employeeInvites: 3,
        activeDevices: 2,
      }),
      "2026-10-06T00:00:00.000Z",
    );
    expect(all.allDone).toBe(true);
    expect(all.items.every((i) => i.href.startsWith("/"))).toBe(true);
  });
});
