import { describe, expect, expectTypeOf, it } from "vitest";
import type { ProviderAvailability } from "@clockoff/shared/providers/workforceProvider";
import { activityQuerySchema } from "./activity";
import { auditLogQuerySchema } from "./auditLogs";
import {
  COMPLIANCE_FILTERS,
  COMPLIANCE_METRIC_FILTER,
  COMPLIANCE_METRIC_KEYS,
  complianceEmployeesQuerySchema,
  complianceMetricsSchema,
} from "./compliance";
import {
  importMappingSchema,
  importMetadataSchema,
  importUploadFormSchema,
  updateImportRowSchema,
} from "./imports";
import { connectIntegrationSchema, integrationParamsSchema } from "./integrations";
import type { PROVIDER_AVAILABILITIES } from "./integrations";
import { addTeamMembersSchema, createLocationSchema, updateLocationSchema } from "./locationsTeams";
import {
  mergeNotificationPreferences,
  NOTIFICATION_PREFERENCE_DEFAULTS,
  notificationQuerySchema,
  updateNotificationPreferencesSchema,
} from "./notifications";
import {
  inviteMemberSchema,
  ONBOARDING_STEP_KEYS,
  onboardingResponseSchema,
  updateOrganisationSchema,
} from "./organisation";
import {
  createOverrideSchema,
  deriveOverrideStatus,
  overrideMaxDurationMinutes,
  overridePayloadSchema,
  overrideSchema,
  resolveOverrideWindow,
} from "./overrides";
import { sseEventSchema } from "./realtime";
import { updateSettingsSchema } from "./settings";

const employeeId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("organisation", () => {
  it("patches name/timezone/dateFormat/settings strictly", () => {
    expect(
      updateOrganisationSchema.parse({
        timezone: "Europe/Dublin",
        settings: { weekStartsOn: "SUNDAY" },
      }),
    ).toEqual({
      timezone: "Europe/Dublin",
      settings: { weekStartsOn: "SUNDAY" },
    });
    expect(updateOrganisationSchema.safeParse({ timezone: "Europe/Atlantis" }).success).toBe(false);
    expect(updateOrganisationSchema.safeParse({ plan: "PRO" }).success).toBe(false);
    expect(updateOrganisationSchema.safeParse({ settings: { theme: "dark" } }).success).toBe(false);
  });

  it("onboarding checklist has the eight spec keys", () => {
    expect(ONBOARDING_STEP_KEYS).toEqual([
      "createCompany",
      "createPolicy",
      "configureBreakRules",
      "addEmployees",
      "addSchedules",
      "inviteEmployees",
      "employeesConnect",
      "goLive",
    ]);
    const items = ONBOARDING_STEP_KEYS.map((key) => ({ key, label: key, done: false, href: "/" }));
    expect(
      onboardingResponseSchema.safeParse({
        items,
        completedCount: 0,
        totalCount: 8,
        allDone: false,
        dismissedAt: null,
        rotaSource: null,
      }).success,
    ).toBe(true);
  });

  it("invites a manager with a role", () => {
    expect(inviteMemberSchema.parse({ email: "Boss@Example.com", role: "ADMIN" })).toEqual({
      email: "boss@example.com",
      role: "ADMIN",
    });
    expect(
      inviteMemberSchema.safeParse({ email: "boss@example.com", role: "SUPERUSER" }).success,
    ).toBe(false);
  });
});

describe("imports", () => {
  it("rejects a field mapped from two headers", () => {
    expect(
      importMappingSchema.safeParse({ mapping: { Date: "date", Day: "date", Start: "start_time" } })
        .success,
    ).toBe(false);
    expect(
      importMappingSchema.safeParse({
        mapping: { Date: "date", Start: "start_time", Notes: null },
        options: { dateFormat: "MDY" },
      }).success,
    ).toBe(true);
    expect(importMappingSchema.safeParse({ mapping: { Date: "shift_date" } }).success).toBe(false);
  });

  it("row resolution is exactly one of match / create / skip", () => {
    expect(updateImportRowSchema.safeParse({ matchedEmployeeId: employeeId }).success).toBe(true);
    expect(updateImportRowSchema.safeParse({ matchedEmployeeId: null }).success).toBe(true);
    expect(updateImportRowSchema.safeParse({ skip: true }).success).toBe(true);
    expect(
      updateImportRowSchema.safeParse({ createEmployee: { firstName: "Sam", lastName: "Lee" } })
        .success,
    ).toBe(true);
    expect(
      updateImportRowSchema.safeParse({ skip: true, matchedEmployeeId: employeeId }).success,
    ).toBe(false);
    expect(updateImportRowSchema.safeParse({}).success).toBe(false);
  });

  it("validates multipart metadata and the uploaded file", () => {
    expect(
      importMetadataSchema.safeParse({ dateFormat: "DMY", timezone: "Europe/London" }).success,
    ).toBe(true);
    expect(importMetadataSchema.safeParse({ delimiter: ";" }).success).toBe(false);
    const csv = new File(["employee_name,date,start_time,end_time\n"], "rota.csv", {
      type: "text/csv",
    });
    expect(importUploadFormSchema.safeParse({ file: csv }).success).toBe(true);
    const pdf = new File(["%PDF"], "rota.pdf", { type: "application/pdf" });
    expect(importUploadFormSchema.safeParse({ file: pdf }).success).toBe(false);
    expect(
      importUploadFormSchema.safeParse({ file: new File([], "empty.csv", { type: "text/csv" }) })
        .success,
    ).toBe(false);
  });
});

describe("integrations", () => {
  it("normalises the provider path segment", () => {
    expect(integrationParamsSchema.parse({ provider: "when-i-work" })).toEqual({
      provider: "WHEN_I_WORK",
    });
    expect(integrationParamsSchema.parse({ provider: "planday" })).toEqual({ provider: "PLANDAY" });
    expect(integrationParamsSchema.safeParse({ provider: "slack" }).success).toBe(false);
  });

  it("lists exactly the shared ProviderAvailability values", () => {
    expectTypeOf<(typeof PROVIDER_AVAILABILITIES)[number]>().toEqualTypeOf<ProviderAvailability>();
  });

  it("requires OAuth code and state together", () => {
    expect(connectIntegrationSchema.safeParse({}).success).toBe(true);
    expect(connectIntegrationSchema.safeParse({ code: "abc" }).success).toBe(false);
    expect(connectIntegrationSchema.safeParse({ code: "abc", state: "xyz" }).success).toBe(true);
  });
});

describe("overrides", () => {
  it("validates reason, target and window", () => {
    expect(
      createOverrideSchema.safeParse({ employeeId, type: "EXEMPT_TEMPORARILY", reason: "Call" })
        .success,
    ).toBe(false);
    expect(
      createOverrideSchema.safeParse({ type: "EXEMPT_TEMPORARILY", reason: "Doctor's appointment" })
        .success,
    ).toBe(false);
    expect(
      createOverrideSchema.safeParse({
        type: "EMERGENCY_POLICY_OVERRIDE",
        reason: "Fire alarm drill",
      }).success,
    ).toBe(true);
    expect(
      createOverrideSchema.safeParse({
        employeeId,
        type: "TEMPORARY_EXCEPTION",
        reason: "Waiting for a call",
        expiresAt: "2026-10-06T12:00:00Z",
        durationMinutes: 30,
      }).success,
    ).toBe(false);
    expect(
      createOverrideSchema.safeParse({
        employeeId,
        type: "END_WORK_MODE_EARLY",
        reason: "Sent home early",
        durationMinutes: 10_081,
      }).success,
    ).toBe(false);
  });

  it("payload is a strict allow-list", () => {
    expect(overridePayloadSchema.safeParse({ restrictionBehaviour: "RELAX_ALL" }).success).toBe(
      true,
    );
    expect(
      overridePayloadSchema.safeParse({ restrictionBehaviour: "RELAX_CATEGORIES" }).success,
    ).toBe(false);
    expect(overridePayloadSchema.safeParse({ note: "free text" }).success).toBe(false);
    expect(
      overridePayloadSchema.safeParse({
        restrictionBehaviour: "RELAX_CATEGORIES",
        relaxedCategories: ["GAMES", "VIDEO"],
      }).success,
    ).toBe(true);
    // Categories only mean something with RELAX_CATEGORIES.
    expect(
      overridePayloadSchema.safeParse({
        restrictionBehaviour: "RELAX_ALL",
        relaxedCategories: ["GAMES"],
      }).success,
    ).toBe(false);
    expect(overridePayloadSchema.safeParse({ relaxedCategories: ["GAMES"] }).success).toBe(false);
    // A break policy reference OR an explicit behaviour, never both.
    expect(overridePayloadSchema.safeParse({ breakPolicyId: employeeId }).success).toBe(true);
    expect(
      overridePayloadSchema.safeParse({
        breakPolicyId: employeeId,
        restrictionBehaviour: "RELAX_ALL",
      }).success,
    ).toBe(false);
  });

  it("returns the stored payload, including a merged break-policy behaviour", () => {
    const stored = {
      id: employeeId,
      type: "TEMPORARY_EXCEPTION",
      status: "ACTIVE",
      reason: "Waiting for a supplier call",
      employee: null,
      createdBy: null,
      startsAt: "2026-10-06T10:00:00.000Z",
      expiresAt: "2026-10-06T11:00:00.000Z",
      revokedAt: null,
      payload: {
        breakPolicyId: employeeId,
        restrictionBehaviour: "RELAX_ALL",
        relaxedCategories: [],
      },
      createdAt: "2026-10-06T10:00:00.000Z",
    };
    expect(overrideSchema.safeParse(stored).success).toBe(true);
    expect(overrideSchema.safeParse({ ...stored, payload: {} }).success).toBe(true);
  });

  it("resolves the window with a 60 minute default and a role cap", () => {
    const now = new Date("2026-10-06T10:00:00Z");
    expect(resolveOverrideWindow({}, now, "MANAGER")).toEqual({
      ok: true,
      startsAt: now,
      expiresAt: new Date("2026-10-06T11:00:00Z"),
      durationMinutes: 60,
    });
    expect(resolveOverrideWindow({ durationMinutes: 1440 }, now, "ADMIN").ok).toBe(true);
    expect(resolveOverrideWindow({ durationMinutes: 1441 }, now, "ADMIN")).toMatchObject({
      ok: false,
      code: "OVERRIDE_TOO_LONG",
    });
    expect(resolveOverrideWindow({ durationMinutes: 1441 }, now, "OWNER").ok).toBe(true);
    expect(
      resolveOverrideWindow({ expiresAt: "2026-10-08T10:00:00Z" }, now, "MANAGER"),
    ).toMatchObject({ code: "OVERRIDE_TOO_LONG" });
    expect(
      resolveOverrideWindow({ expiresAt: "2026-10-06T09:00:00Z" }, now, "OWNER"),
    ).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(overrideMaxDurationMinutes("MANAGER")).toBe(1440);
  });

  it("derives status", () => {
    const now = new Date("2026-10-06T10:00:00Z");
    const window = {
      startsAt: new Date("2026-10-06T09:00:00Z"),
      expiresAt: new Date("2026-10-06T11:00:00Z"),
    };
    expect(deriveOverrideStatus({ ...window, revokedAt: null }, now)).toBe("ACTIVE");
    expect(deriveOverrideStatus({ ...window, revokedAt: now }, now)).toBe("REVOKED");
    expect(
      deriveOverrideStatus({ ...window, revokedAt: null }, new Date("2026-10-06T11:00:00Z")),
    ).toBe("EXPIRED");
    expect(
      deriveOverrideStatus({ ...window, revokedAt: null }, new Date("2026-10-06T08:00:00Z")),
    ).toBe("SCHEDULED");
  });
});

describe("notifications & settings", () => {
  it("merges stored preferences over defaults and drops junk", () => {
    expect(mergeNotificationPreferences(null)).toEqual(NOTIFICATION_PREFERENCE_DEFAULTS);
    const merged = mergeNotificationPreferences(
      { EMPLOYEE_JOINED: { email: true }, UNKNOWN: { email: true }, DEVICE_SYNC_DELAYED: "yes" },
      { INTEGRATION_ERROR: { email: false } },
    );
    expect(merged.EMPLOYEE_JOINED).toEqual({ inApp: true, email: true });
    expect(merged.DEVICE_SYNC_DELAYED).toEqual(
      NOTIFICATION_PREFERENCE_DEFAULTS.DEVICE_SYNC_DELAYED,
    );
    expect(merged.INTEGRATION_ERROR).toEqual({ inApp: true, email: false });
    expect(Object.keys(merged)).not.toContain("UNKNOWN");
  });

  it("validates preference patches and the settings body", () => {
    expect(
      updateNotificationPreferencesSchema.safeParse({ EMPLOYEE_JOINED: { email: true } }).success,
    ).toBe(true);
    expect(
      updateNotificationPreferencesSchema.safeParse({ NEWSLETTER: { email: true } }).success,
    ).toBe(false);
    expect(
      updateNotificationPreferencesSchema.safeParse({ EMPLOYEE_JOINED: { sms: true } }).success,
    ).toBe(false);
    expect(updateSettingsSchema.safeParse({}).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ organisation: { name: "Brew Co" } }).success).toBe(
      true,
    );
  });

  it("parses query booleans without the 'false' → true trap", () => {
    expect(notificationQuerySchema.parse({ unreadOnly: "false" }).unreadOnly).toBe(false);
    expect(notificationQuerySchema.parse({ unreadOnly: "true" }).unreadOnly).toBe(true);
    expect(notificationQuerySchema.safeParse({ unreadOnly: "maybe" }).success).toBe(false);
  });
});

describe("compliance, activity, audit, realtime, org structure", () => {
  it("every metric card maps to a list filter", () => {
    expect(Object.keys(complianceMetricsSchema.shape)).toEqual([...COMPLIANCE_METRIC_KEYS]);
    expect(new Set(Object.values(COMPLIANCE_METRIC_FILTER))).toEqual(new Set(COMPLIANCE_FILTERS));
    expect(complianceEmployeesQuerySchema.parse({}).filter).toBe("ALL");
  });

  it("validates activity and audit log windows", () => {
    expect(activityQuerySchema.parse({ type: "BREAK_STARTED,BREAK_ENDED", limit: "10" })).toEqual({
      type: ["BREAK_STARTED", "BREAK_ENDED"],
      limit: 10,
    });
    expect(
      activityQuerySchema.safeParse({ from: "2026-10-06T10:00:00Z", to: "2026-10-06T09:00:00Z" })
        .success,
    ).toBe(false);
    expect(
      auditLogQuerySchema.safeParse({ from: "2026-10-06T10:00:00Z", to: "2026-10-06T09:00:00Z" })
        .success,
    ).toBe(false);
  });

  it("describes SSE frames", () => {
    expect(
      sseEventSchema.safeParse({
        type: "shift.changed",
        organisationId: employeeId,
        payload: { shiftId: employeeId },
        at: "2026-10-06T10:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("validates locations and team membership", () => {
    expect(createLocationSchema.parse({ name: "Soho", address: "" })).toEqual({
      name: "Soho",
      address: null,
    });
    expect(createLocationSchema.safeParse({ name: "Soho", timezone: "Nowhere/Land" }).success).toBe(
      false,
    );
    expect(updateLocationSchema.parse({ timezone: null })).toEqual({ timezone: null });
    expect(updateLocationSchema.parse({ address: "" })).toEqual({ address: null });
    expect(addTeamMembersSchema.safeParse({ employeeIds: [] }).success).toBe(false);
  });
});
