import { ACTIVITY_EVENT_TYPES, type ActivityEventType } from "@workmode/shared/enums";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_EVENT_META,
  ACTIVITY_GROUP_LABELS,
  ACTIVITY_GROUPS,
  ACTIVITY_ICONS,
  ACTIVITY_TYPE_OPTIONS,
  activityEventMeta,
  activitySentence,
  activitySentenceContext,
  activityText,
  isActivityEventType,
  type ActivityEventLike,
} from "./activity-meta";

const employee = {
  id: "0b0e2e9e-7c0a-4a2b-9e3b-1b4c2a9d8f10",
  firstName: "Jane",
  lastName: "Smith",
  jobTitle: null,
  primaryLocation: null,
  inviteStatus: "CONNECTED" as const,
};
const manager = { id: "c7a1c8f2-4d7e-4d1b-9e55-2a4d8b6c3e21", name: "Ada Lovelace", email: "ada@example.com" };

function event(type: ActivityEventType, overrides: Partial<ActivityEventLike> = {}): ActivityEventLike {
  return { type, employee, actor: null, actorType: "EMPLOYEE_DEVICE", metadata: {}, ...overrides };
}

function byManager(type: ActivityEventType, metadata: Record<string, unknown> = {}): ActivityEventLike {
  return event(type, { actor: manager, actorType: "MANAGER", metadata });
}

describe("ACTIVITY_EVENT_META", () => {
  it("covers every ActivityEventType exactly once", () => {
    expect(Object.keys(ACTIVITY_EVENT_META).sort()).toEqual([...ACTIVITY_EVENT_TYPES].sort());
  });

  it.each(ACTIVITY_EVENT_TYPES)("%s has a label, a known icon and group, and a sentence with or without an employee", (type) => {
    const meta = ACTIVITY_EVENT_META[type];
    expect(meta.label.trim()).not.toBe("");
    expect(ACTIVITY_ICONS).toContain(meta.icon);
    expect(ACTIVITY_GROUPS).toContain(meta.group);
    expect(ACTIVITY_GROUP_LABELS[meta.group].trim()).not.toBe("");

    for (const candidate of [event(type), event(type, { employee: null }), byManager(type)]) {
      const sentence = activitySentence(candidate);
      expect(sentence.trim()).not.toBe("");
      expect(sentence).not.toMatch(/undefined|null|NaN|\[object/);
    }
  });

  it("offers every type as a filter option in enum order, grouped", () => {
    expect(ACTIVITY_TYPE_OPTIONS.map((option) => option.value)).toEqual([...ACTIVITY_EVENT_TYPES]);
    for (const option of ACTIVITY_TYPE_OPTIONS) {
      expect(option.label).toBe(ACTIVITY_EVENT_META[option.value].label);
      expect(option.group).toBe(ACTIVITY_EVENT_META[option.value].group);
    }
  });

  it("labels are unique so the filter picker never shows two identical rows", () => {
    const labels = ACTIVITY_EVENT_TYPES.map((type) => ACTIVITY_EVENT_META[type].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("activitySentence", () => {
  it("names the employee, or falls back to 'An employee' when the event has none", () => {
    expect(activitySentence(event("EMPLOYEE_JOINED"))).toBe("Jane Smith joined from the Work Mode app");
    expect(activitySentence(event("EMPLOYEE_JOINED", { employee: null }))).toBe("An employee joined from the Work Mode app");
    expect(activitySentence(event("EMPLOYEE_JOINED", { employee: { ...employee, firstName: " ", lastName: "" } }))).toBe(
      "An employee joined from the Work Mode app",
    );
  });

  it("builds a possessive that handles names ending in s", () => {
    expect(activitySentenceContext(event("BREAK_EXPIRED")).possessive).toBe("Jane Smith's");
    expect(activitySentenceContext(event("BREAK_EXPIRED", { employee: { ...employee, firstName: "Chris", lastName: "Ross" } })).possessive).toBe(
      "Chris Ross'",
    );
    expect(activitySentence(event("BREAK_EXPIRED"))).toBe("Jane Smith's break ran out and restrictions resumed");
  });

  it("uses operational metadata only when it is well-formed", () => {
    expect(activitySentence(event("BREAK_STARTED", { metadata: { durationMinutes: 15 } }))).toBe("Jane Smith started a 15 min break");
    expect(activitySentence(event("BREAK_STARTED", { metadata: { durationMinutes: "15" } }))).toBe("Jane Smith started a break");
    expect(activitySentence(event("BREAK_STARTED", { metadata: { durationMinutes: 90 } }))).toBe("Jane Smith started a 1 h 30 min break");
    expect(activitySentence(event("POLICY_SYNCED", { metadata: { policyVersionNumber: 4 } }))).toBe(
      "Jane Smith's phone synced the latest Work Policy (version 4)",
    );
    expect(activitySentence(event("PERMISSION_NEEDS_ATTENTION", { metadata: { permissionState: "REVOKED" } }))).toBe(
      "Jane Smith's Screen Time permission needs attention (revoked)",
    );
  });

  it("credits the acting manager, or 'A manager' for manager-only events without an actor", () => {
    expect(activitySentence(byManager("OVERRIDE_CREATED", { overrideType: "EXEMPT_TEMPORARILY" }))).toBe(
      "Ada Lovelace created a “Exempt temporarily” override for Jane Smith",
    );
    expect(activitySentence(event("OVERRIDE_CREATED"))).toBe("A manager created an override for Jane Smith");
    expect(activitySentence(byManager("POLICY_UPDATED", { policyName: "Front of house" }))).toBe(
      "Ada Lovelace updated the “Front of house” Work Policy",
    );
    expect(activitySentence(event("POLICY_UPDATED", { employee: null }))).toBe("A manager updated a Work Policy");
    // A manager reference on a device-reported event is ignored: the device acted, not the manager.
    expect(activitySentence(event("BREAK_ENDED", { actor: manager, actorType: "EMPLOYEE_DEVICE" }))).toBe("Jane Smith ended their break");
  });

  it("pluralises import counts", () => {
    expect(activitySentence(byManager("IMPORT_COMPLETED", { importedCount: 1 }))).toBe("Ada Lovelace imported a schedule (1 shift)");
    expect(activitySentence(byManager("IMPORT_COMPLETED", { shiftsImported: 12 }))).toBe("Ada Lovelace imported a schedule (12 shifts)");
    expect(activitySentence(event("IMPORT_COMPLETED", { employee: null }))).toBe("A manager imported a schedule");
  });

  it("names the provider for integration errors", () => {
    expect(activitySentence(event("INTEGRATION_ERROR", { employee: null, metadata: { provider: "WHEN_I_WORK" } }))).toBe(
      "When i work reported a sync error",
    );
    expect(activitySentence(event("INTEGRATION_ERROR", { employee: null }))).toBe("An integration reported a sync error");
  });
});

describe("activityText", () => {
  it("prefers the server's summary and falls back to the local sentence when it is blank", () => {
    expect(activityText({ ...event("EMPLOYEE_JOINED"), summary: "Jane joined (server)" })).toBe("Jane joined (server)");
    expect(activityText({ ...event("EMPLOYEE_JOINED"), summary: "   " })).toBe("Jane Smith joined from the Work Mode app");
    expect(activityText({ ...event("EMPLOYEE_JOINED"), summary: null })).toBe("Jane Smith joined from the Work Mode app");
    expect(activityText(event("EMPLOYEE_JOINED"))).toBe("Jane Smith joined from the Work Mode app");
  });
});

describe("activityEventMeta", () => {
  it("returns the table entry for known types", () => {
    expect(activityEventMeta("BREAK_STARTED")).toBe(ACTIVITY_EVENT_META.BREAK_STARTED);
  });

  it("degrades gracefully for kinds newer than this UI", () => {
    const meta = activityEventMeta("DEVICE_REPLACED");
    expect(meta.label).toBe("Device replaced");
    expect(meta.icon).toBe("activity");
    expect(meta.tone).toBe("neutral");
    expect(meta.sentence(activitySentenceContext(event("EMPLOYEE_JOINED")))).toContain("Jane Smith");
    // Prototype keys must not be mistaken for event types.
    expect(activityEventMeta("toString").icon).toBe("activity");
  });

  it("recognises event types", () => {
    expect(isActivityEventType("BREAK_STARTED")).toBe(true);
    expect(isActivityEventType("break_started")).toBe(false);
    expect(isActivityEventType(null)).toBe(false);
  });
});
