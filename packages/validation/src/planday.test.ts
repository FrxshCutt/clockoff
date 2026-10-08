import { describe, expect, it } from "vitest";
import { INTEGRATION_WIZARD_STEPS } from "@clockoff/shared/enums";
import {
  disconnectIntegrationSchema,
  integrationParamsSchema,
  managedByFromIntegrationId,
} from "./integrations";
import { setRotaSourceSchema } from "./organisation";
import {
  connectPlandayTokenSchema,
  createPlandayConnectLinkSchema,
  departmentMappingsSchema,
  groupMappingsSchema,
  PLANDAY_NO_DEPARTMENT_ID,
  PLANDAY_OAUTH_RETURN_TO_PATHS,
  plandayCatalogSchema,
  plandayDepartmentChoiceSchema,
  plandayOnboardingStateSchema,
  plandayWizardStepParamSchema,
  plandayWizardStepSlug,
  resolvePlandayPendingEmployeesSchema,
  savePlandayEmployeesSchema,
  savePlandayLocationsSchema,
  savePlandayPoliciesSchema,
  startPlandayOAuthSchema,
  updatePlandaySettingsSchema,
} from "./planday";

/** Planday integration contracts (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §5, §9, §10). */

const APP_ID = "f2370889-3ffe-46b6-83e7-1a20f5a20d2f";
const TOKEN = "Q2xvY2tPZmZQbGFuZGF5VG9rZW4xMjM0";
const UUID_A = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const UUID_B = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("connect/token (methods B and C, §5.4)", () => {
  it("strips whitespace and line breaks from pasted values", () => {
    const parsed = connectPlandayTokenSchema.parse({
      method: "CUSTOMER_OWN_APP",
      appId: ` ${APP_ID}\n`,
      refreshToken: `${TOKEN.slice(0, 10)}\n  ${TOKEN.slice(10)}\t`,
    });
    expect(parsed).toEqual({ method: "CUSTOMER_OWN_APP", appId: APP_ID, refreshToken: TOKEN });
  });

  it("needs the App ID for the customer's own app (C) and refuses one for ClockOff's (B)", () => {
    expect(
      connectPlandayTokenSchema.safeParse({ method: "CUSTOMER_OWN_APP", refreshToken: TOKEN })
        .success,
    ).toBe(false);
    expect(
      connectPlandayTokenSchema.safeParse({ method: "CUSTOMER_ADDED_APP_ID", refreshToken: TOKEN })
        .success,
    ).toBe(true);
    expect(
      connectPlandayTokenSchema.safeParse({
        method: "CUSTOMER_ADDED_APP_ID",
        appId: APP_ID,
        refreshToken: TOKEN,
      }).success,
    ).toBe(false);
    // Method A never comes through this endpoint.
    expect(
      connectPlandayTokenSchema.safeParse({ method: "OAUTH", refreshToken: TOKEN }).success,
    ).toBe(false);
  });

  it("bounds the token: 10–512 printable characters", () => {
    const parse = (refreshToken: string) =>
      connectPlandayTokenSchema.safeParse({ method: "CUSTOMER_ADDED_APP_ID", refreshToken })
        .success;
    expect(parse("short")).toBe(false);
    expect(parse("a".repeat(10))).toBe(true);
    expect(parse("a".repeat(512))).toBe(true);
    expect(parse("a".repeat(513))).toBe(false);
    expect(parse(`${TOKEN}\u0000`)).toBe(false);
    expect(parse(`${TOKEN}é`)).toBe(false);
  });

  it("validates the App ID and the optional portal switch", () => {
    expect(
      connectPlandayTokenSchema.safeParse({
        method: "CUSTOMER_OWN_APP",
        appId: "clockoff",
        refreshToken: TOKEN,
      }).success,
    ).toBe(false);
    expect(
      connectPlandayTokenSchema.safeParse({
        method: "CUSTOMER_ADDED_APP_ID",
        refreshToken: TOKEN,
        allowPortalSwitch: true,
      }).success,
    ).toBe(true);
    // Unknown keys (e.g. an organisation id) are rejected.
    expect(
      connectPlandayTokenSchema.safeParse({
        method: "CUSTOMER_ADDED_APP_ID",
        refreshToken: TOKEN,
        organisationId: UUID_A,
      }).success,
    ).toBe(false);
  });
});

describe("connect/oauth (method A, §5.2)", () => {
  it("returns only to fixed in-app paths", () => {
    expect(startPlandayOAuthSchema.parse({ returnTo: "WIZARD" })).toEqual({ returnTo: "WIZARD" });
    expect(startPlandayOAuthSchema.safeParse({ returnTo: "https://evil.example" }).success).toBe(
      false,
    );
    expect(PLANDAY_OAUTH_RETURN_TO_PATHS).toEqual({
      WIZARD: "/onboarding/planday",
      SETTINGS: "/integrations",
    });
  });
});

describe("disconnect (§5.8)", () => {
  it("keeps every record by default, so the existing `{}` body still works", () => {
    expect(disconnectIntegrationSchema.parse({})).toEqual({ mode: "KEEP_RECORDS" });
    expect(disconnectIntegrationSchema.parse({ mode: "CANCEL_FUTURE_SHIFTS" })).toEqual({
      mode: "CANCEL_FUTURE_SHIFTS",
    });
    expect(disconnectIntegrationSchema.safeParse({ mode: "DELETE_EVERYTHING" }).success).toBe(
      false,
    );
  });
});

describe("mapping config JSON (§2.4)", () => {
  it("parses the column defaults", () => {
    expect(departmentMappingsSchema.parse({})).toEqual({});
    expect(groupMappingsSchema.parse({})).toEqual({});
    expect(plandayCatalogSchema.parse({})).toEqual({
      readAt: null,
      departments: [],
      groups: [],
      unassignedEmployeeCount: null,
      childPortalCount: 0,
    });
  });

  it("maps departments (and the no-department row) to a location or a ClockOff department", () => {
    const mappings = {
      "101": { target: "LOCATION", locationId: UUID_A },
      [PLANDAY_NO_DEPARTMENT_ID]: { target: "DEPARTMENT", departmentId: UUID_B },
    };
    expect(departmentMappingsSchema.parse(mappings)).toEqual(mappings);
    expect(departmentMappingsSchema.safeParse({ abc: mappings["101"] }).success).toBe(false);
    expect(
      departmentMappingsSchema.safeParse({ "101": { target: "LOCATION", departmentId: UUID_B } })
        .success,
    ).toBe(false);
    expect(groupMappingsSchema.safeParse({ "7": { target: "TEAM", teamId: UUID_A } }).success).toBe(
      true,
    );
    expect(
      groupMappingsSchema.safeParse({ none: { target: "TEAM", teamId: UUID_A } }).success,
    ).toBe(false);
  });
});

describe("wizard steps and choices (§9.5)", () => {
  it("spells every step in kebab case and parses it back", () => {
    for (const step of INTEGRATION_WIZARD_STEPS) {
      expect(plandayWizardStepParamSchema.parse(plandayWizardStepSlug(step))).toBe(step);
    }
    expect(plandayWizardStepSlug("CONFIRM_PORTAL")).toBe("confirm-portal");
    expect(plandayWizardStepParamSchema.parse("Shift-Preview")).toBe("SHIFT_PREVIEW");
    expect(plandayWizardStepParamSchema.safeParse("payroll").success).toBe(false);
  });

  it("requires the target record for each department choice", () => {
    const parse = (value: unknown) => plandayDepartmentChoiceSchema.safeParse(value).success;
    expect(parse({ externalId: "101", target: "NEW_LOCATION" })).toBe(true);
    expect(parse({ externalId: "101", target: "NEW_LOCATION", name: "Harbour" })).toBe(true);
    expect(parse({ externalId: "101", target: "LOCATION" })).toBe(false);
    expect(parse({ externalId: "101", target: "LOCATION", locationId: UUID_A })).toBe(true);
    expect(parse({ externalId: "none", target: "DEPARTMENT", departmentId: UUID_A })).toBe(true);
    expect(parse({ externalId: "101", target: "EXCLUDE", locationId: UUID_A })).toBe(false);
  });

  it("step 3 needs at least one included department, each department once", () => {
    expect(
      savePlandayLocationsSchema.safeParse({
        departments: [{ externalId: "101", target: "EXCLUDE" }],
      }).success,
    ).toBe(false);
    expect(
      savePlandayLocationsSchema.safeParse({
        departments: [
          { externalId: "101", target: "NEW_LOCATION" },
          { externalId: "101", target: "EXCLUDE" },
        ],
      }).success,
    ).toBe(false);
    expect(
      savePlandayLocationsSchema.safeParse({
        departments: [
          { externalId: "101", target: "NEW_LOCATION" },
          { externalId: "102", target: "EXCLUDE" },
        ],
      }).success,
    ).toBe(true);
  });

  it("step 5 links only with an employee id", () => {
    const body = (resolutions: unknown[]) => ({
      selection: { mode: "ALL_EXCEPT", externalIds: [] },
      resolutions,
      autoIncludeNewEmployees: true,
      importEmails: true,
    });
    expect(savePlandayEmployeesSchema.safeParse(body([])).success).toBe(true);
    expect(
      savePlandayEmployeesSchema.safeParse(body([{ externalId: "5", action: "LINK" }])).success,
    ).toBe(false);
    expect(
      savePlandayEmployeesSchema.safeParse(
        body([{ externalId: "5", action: "LINK", employeeId: UUID_A }]),
      ).success,
    ).toBe(true);
  });

  it("step 7 takes a starter or an existing policy for each default", () => {
    expect(
      savePlandayPoliciesSchema.safeParse({
        work: { starter: true },
        break: { breakPolicyId: UUID_B },
        teamPolicies: [{ teamId: UUID_A, policyId: UUID_B }],
      }).success,
    ).toBe(true);
    expect(
      savePlandayPoliciesSchema.safeParse({
        work: { starter: true, policyId: UUID_A },
        break: { starter: true },
        teamPolicies: [],
      }).success,
    ).toBe(false);
  });

  it("stored wizard state: every key optional, unknown keys rejected", () => {
    expect(plandayOnboardingStateSchema.parse({})).toEqual({});
    expect(
      plandayOnboardingStateSchema.safeParse({
        connect: { method: "CUSTOMER_OWN_APP", connectedAt: "2026-10-08T10:00:00.000Z" },
        employeesImport: { createdIds: [UUID_A], linkedIds: [] },
      }).success,
    ).toBe(true);
    expect(plandayOnboardingStateSchema.safeParse({ refreshToken: TOKEN }).success).toBe(false);
  });
});

describe("settings, pending queue and connect links (§9.7, §10)", () => {
  it("settings: a known sync window, at least one change", () => {
    expect(updatePlandaySettingsSchema.safeParse({ syncWindowDays: 14 }).success).toBe(true);
    expect(updatePlandaySettingsSchema.safeParse({ syncWindowDays: 30 }).success).toBe(false);
    expect(updatePlandaySettingsSchema.safeParse({}).success).toBe(false);
  });

  it("pending queue: LINK needs an employee, each row once", () => {
    expect(
      resolvePlandayPendingEmployeesSchema.safeParse({ items: [{ id: UUID_A, action: "LINK" }] })
        .success,
    ).toBe(false);
    expect(
      resolvePlandayPendingEmployeesSchema.safeParse({
        items: [
          { id: UUID_A, action: "LINK", employeeId: UUID_B },
          { id: UUID_B, action: "DISMISS" },
        ],
      }).success,
    ).toBe(true);
    expect(
      resolvePlandayPendingEmployeesSchema.safeParse({
        items: [
          { id: UUID_A, action: "IMPORT" },
          { id: UUID_A, action: "DISMISS" },
        ],
      }).success,
    ).toBe(false);
  });

  it("connect links: 24 h, 72 h (default) or 7 days", () => {
    expect(createPlandayConnectLinkSchema.parse({})).toEqual({ expiresInHours: 72 });
    expect(createPlandayConnectLinkSchema.safeParse({ expiresInHours: 168 }).success).toBe(true);
    expect(createPlandayConnectLinkSchema.safeParse({ expiresInHours: 1 }).success).toBe(false);
    expect(createPlandayConnectLinkSchema.parse({ email: "Admin@Example.com" }).email).toBe(
      "admin@example.com",
    );
  });
});

describe("rota source (§9.4)", () => {
  it("needs the free text exactly when the answer is OTHER", () => {
    expect(setRotaSourceSchema.safeParse({ rotaSource: "PLANDAY" }).success).toBe(true);
    expect(setRotaSourceSchema.safeParse({ rotaSource: "OTHER" }).success).toBe(false);
    expect(setRotaSourceSchema.parse({ rotaSource: "OTHER", otherText: "  Excel  " })).toEqual({
      rotaSource: "OTHER",
      otherText: "Excel",
    });
    expect(setRotaSourceSchema.safeParse({ rotaSource: "CSV", otherText: "Excel" }).success).toBe(
      false,
    );
    expect(
      setRotaSourceSchema.safeParse({ rotaSource: "OTHER", otherText: "x".repeat(201) }).success,
    ).toBe(false);
  });
});

describe("managed records (§10.6)", () => {
  it("derives managedBy from the row's managing integration", () => {
    expect(managedByFromIntegrationId(null)).toBeNull();
    expect(managedByFromIntegrationId(UUID_A)).toEqual({
      provider: "PLANDAY",
      integrationId: UUID_A,
    });
  });

  it("never reads `health` as a provider (the static health route beside [provider])", () => {
    expect(integrationParamsSchema.safeParse({ provider: "health" }).success).toBe(false);
    expect(integrationParamsSchema.parse({ provider: "planday" })).toEqual({ provider: "PLANDAY" });
  });
});
