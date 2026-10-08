import { describe, expect, it } from "vitest";
import { integrationKeys, plandayKeys } from "./integration-keys";
import { integrationKeys as reExported } from "./use-integrations";

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((part, index) => key[index] === part);

describe("integration query keys", () => {
  it("are organisation-scoped and re-exported unchanged by use-integrations", () => {
    expect(reExported).toBe(integrationKeys);
    // Organisation-scoped: cleared with every other "org" key when the organisation changes.
    expect(integrationKeys.all[0]).toBe("org");
    expect(integrationKeys.list).toEqual(["org", "integrations", "list"]);
    expect(integrationKeys.health).toEqual(["org", "integrations", "health"]);
  });

  it("nest every Planday key under the integrations prefix", () => {
    const keys = [
      plandayKeys.all,
      plandayKeys.detail,
      plandayKeys.connectMethods,
      plandayKeys.runs,
      plandayKeys.runList(20),
      plandayKeys.run("run-1"),
      plandayKeys.settings,
      plandayKeys.pendingEmployees,
      plandayKeys.pendingEmployeeList({ page: 1 }),
      plandayKeys.connectLinks,
      plandayKeys.onboarding,
      plandayKeys.onboardingSession,
      plandayKeys.onboardingStep("employees", { flag: "ALL" }),
    ];
    for (const key of keys) {
      expect(startsWith(key, integrationKeys.all), JSON.stringify(key)).toBe(true);
      expect(startsWith(key, plandayKeys.all), JSON.stringify(key)).toBe(true);
    }
    // Prefixes the realtime invalidations rely on (plan §7.11).
    expect(startsWith(plandayKeys.run("run-1"), plandayKeys.runs)).toBe(true);
    expect(startsWith(plandayKeys.runList(20), plandayKeys.runs)).toBe(true);
    expect(startsWith(plandayKeys.onboardingSession, plandayKeys.onboarding)).toBe(true);
    expect(startsWith(plandayKeys.onboardingStep("locations"), plandayKeys.onboarding)).toBe(true);
    expect(
      startsWith(
        plandayKeys.pendingEmployeeList({ reason: "NEW_EMPLOYEE" }),
        plandayKeys.pendingEmployees,
      ),
    ).toBe(true);
    // The card is not a run: a run event refetches it through `detail` explicitly.
    expect(startsWith(plandayKeys.detail, plandayKeys.runs)).toBe(false);
  });

  it("gives distinct queries distinct keys", () => {
    const ids = [
      integrationKeys.list,
      integrationKeys.health,
      plandayKeys.detail,
      plandayKeys.connectMethods,
      plandayKeys.runList(20),
      plandayKeys.run("run-1"),
      plandayKeys.settings,
      plandayKeys.connectLinks,
      plandayKeys.onboardingSession,
      plandayKeys.onboardingStep("locations"),
      plandayKeys.onboardingStep("teams"),
    ].map((key) => JSON.stringify(key));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
