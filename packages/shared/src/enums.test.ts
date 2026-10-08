import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as enums from "./enums";

/** Parses `enum Name { A B C }` blocks out of the Prisma schema. */
function prismaEnums(): Record<string, string[]> {
  const schema = readFileSync(
    resolve(import.meta.dirname, "../../db/prisma/schema.prisma"),
    "utf8",
  );
  const out: Record<string, string[]> = {};
  for (const m of schema.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) {
    const name = m[1]!;
    const values = m[2]!
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .filter((l) => l && !l.startsWith("///"));
    out[name] = values;
  }
  return out;
}

const MIRROR: Record<string, readonly string[]> = {
  BillingStatus: enums.BILLING_STATUSES,
  Plan: enums.PLANS,
  Role: enums.ROLES,
  DateFormat: enums.DATE_FORMATS,
  JoinCodeStatus: enums.JOIN_CODE_STATUSES,
  InviteChannel: enums.INVITE_CHANNELS,
  EmployeeInviteStatus: enums.EMPLOYEE_INVITE_STATUSES,
  EmploymentStatus: enums.EMPLOYMENT_STATUSES,
  InviteStatus: enums.INVITE_STATUSES,
  Platform: enums.PLATFORMS,
  PermissionState: enums.PERMISSION_STATES,
  SelectionState: enums.SELECTION_STATES,
  WorkModeState: enums.WORK_MODE_STATES,
  EffectiveRestriction: enums.EFFECTIVE_RESTRICTIONS,
  PolicyStatus: enums.POLICY_STATUSES,
  AssignmentScopeType: enums.ASSIGNMENT_SCOPE_TYPES,
  BreakRestrictionBehaviour: enums.BREAK_RESTRICTION_BEHAVIOURS,
  ShiftStatus: enums.SHIFT_STATUSES,
  ShiftSource: enums.SHIFT_SOURCES,
  BreakEndReason: enums.BREAK_END_REASONS,
  BreakSessionStatus: enums.BREAK_SESSION_STATUSES,
  WorkStateSource: enums.WORK_STATE_SOURCES,
  ShiftImportStatus: enums.SHIFT_IMPORT_STATUSES,
  ShiftImportRowStatus: enums.SHIFT_IMPORT_ROW_STATUSES,
  IntegrationProvider: enums.INTEGRATION_PROVIDERS,
  IntegrationStatus: enums.INTEGRATION_STATUSES,
  ActivationMode: enums.ACTIVATION_MODES,
  ClockEventType: enums.CLOCK_EVENT_TYPES,
  OverrideType: enums.OVERRIDE_TYPES,
  ActorType: enums.ACTOR_TYPES,
  ActivityEventType: enums.ACTIVITY_EVENT_TYPES,
  NotificationRecipientType: enums.NOTIFICATION_RECIPIENT_TYPES,
  NotificationChannel: enums.NOTIFICATION_CHANNELS,
  RotaSource: enums.ROTA_SOURCES,
  RecordSource: enums.RECORD_SOURCES,
  IntegrationAuthMethod: enums.INTEGRATION_AUTH_METHODS,
  IntegrationConnectionStatus: enums.INTEGRATION_CONNECTION_STATUSES,
  ExternalEntityType: enums.EXTERNAL_ENTITY_TYPES,
  IntegrationSyncTrigger: enums.INTEGRATION_SYNC_TRIGGERS,
  IntegrationSyncRunStatus: enums.INTEGRATION_SYNC_RUN_STATUSES,
  IntegrationSyncRunKind: enums.INTEGRATION_SYNC_RUN_KINDS,
  PendingExternalEmployeeReason: enums.PENDING_EXTERNAL_EMPLOYEE_REASONS,
  OnboardingSessionStatus: enums.ONBOARDING_SESSION_STATUSES,
  IntegrationWizardStep: enums.INTEGRATION_WIZARD_STEPS,
};

describe("shared enums mirror the Prisma schema", () => {
  const fromPrisma = prismaEnums();
  for (const [name, values] of Object.entries(MIRROR)) {
    it(`${name} matches`, () => {
      expect(fromPrisma[name], `enum ${name} missing from schema.prisma`).toBeDefined();
      expect([...values]).toEqual(fromPrisma[name]);
    });
  }
  it("every Prisma enum has a mirror", () => {
    expect(Object.keys(fromPrisma).sort()).toEqual(Object.keys(MIRROR).sort());
  });
  it("rota sources offer every integration provider plus CSV, manual and other", () => {
    expect([...enums.ROTA_SOURCES]).toEqual([
      ...enums.INTEGRATION_PROVIDERS,
      "CSV",
      "MANUAL",
      "OTHER",
    ]);
  });
  it("integration activity types are organisation events no device may report", () => {
    expect([...enums.INTEGRATION_ACTIVITY_EVENT_TYPES]).toEqual([
      "INTEGRATION_CONNECTED",
      "INTEGRATION_DISCONNECTED",
      "INTEGRATION_SYNCED",
      "EMPLOYEE_DEACTIVATED",
      "EMPLOYEE_REACTIVATED",
    ]);
    for (const t of enums.INTEGRATION_ACTIVITY_EVENT_TYPES) {
      expect(enums.ACTIVITY_EVENT_TYPES).toContain(t);
      expect(enums.DEVICE_REPORTABLE_EVENT_TYPES as readonly string[]).not.toContain(t);
      expect(enums.isIntegrationActivityEventType(t)).toBe(true);
    }
    // INTEGRATION_ERROR predates the Planday work and stays visible.
    expect(enums.isIntegrationActivityEventType("INTEGRATION_ERROR")).toBe(false);
    expect(enums.isIntegrationActivityEventType("WORK_MODE_STARTED")).toBe(false);
  });
  it("device-reportable event types are a subset of activity event types", () => {
    for (const t of enums.DEVICE_REPORTABLE_EVENT_TYPES) {
      expect(enums.ACTIVITY_EVENT_TYPES).toContain(t);
    }
  });
});
