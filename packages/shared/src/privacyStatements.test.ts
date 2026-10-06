import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEVICE_REPORTABLE_EVENT_TYPES, INTEGRATION_PROVIDERS } from "./enums";
import { PROVIDERS } from "./providers/registry";
import {
  CAN_SEE,
  CANNOT_SEE,
  DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS,
  DEVICE_TO_SERVER_ALLOWED_FIELDS,
  EMPLOYEE_PRIVACY_SUMMARY,
  PRIVACY_DOC_GENERATED_NOTICE,
  PRIVACY_DOC_REGENERATE_COMMAND,
  PRIVACY_PRINCIPLE,
  isDeviceToServerAllowedField,
  renderPrivacyMarkdown,
} from "./privacyStatements";

const PRIVACY_DOC_PATH = resolve(import.meta.dirname, "../../../docs/PRIVACY.md");

function keysOf(items: readonly { key: string }[]): string[] {
  return items.map((i) => i.key);
}

describe("privacy statements", () => {
  it("states the principle verbatim", () => {
    expect(PRIVACY_PRINCIPLE).toBe("Block distractions. Don't spy on employees.");
  });

  it("has unique camelCase keys and non-empty labels and details", () => {
    for (const list of [CAN_SEE, CANNOT_SEE, DEVICE_TO_SERVER_ALLOWED_FIELDS]) {
      const keys = keysOf(list);
      expect(new Set(keys).size).toBe(keys.length);
      for (const item of list) {
        expect(item.key).toMatch(/^[a-z][A-Za-z]*$/);
        expect(item.label.trim()).toBe(item.label);
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.detail.trim()).toBe(item.detail);
        expect(item.detail.length).toBeGreaterThan(20);
        // Rendered as "**label.** detail" — a trailing full stop in the label would double up.
        expect(item.label.endsWith(".")).toBe(false);
        expect(item.detail.endsWith(".")).toBe(true);
      }
    }
  });

  it("CANNOT_SEE covers every §12 promise", () => {
    const keys = keysOf(CANNOT_SEE);
    for (const required of [
      "messages",
      "photos",
      "browsing",
      "appUsage",
      "selectedApps",
      "notifications",
      "location",
      "personalData",
      "offShift",
    ]) {
      expect(keys).toContain(required);
    }
  });

  it("CAN_SEE is operational status only", () => {
    const keys = keysOf(CAN_SEE);
    for (const required of [
      "connection",
      "permissionState",
      "selectionCounts",
      "workModeState",
      "breaks",
      "syncTimes",
      "deviceBasics",
      "clock",
    ]) {
      expect(keys).toContain(required);
    }
  });

  it("is technically accurate about the selection: opaque Apple tokens, counts only", () => {
    const selection = CAN_SEE.find((s) => s.key === "selectionCounts");
    expect(selection?.detail).toMatch(/opaque Apple tokens/);
    expect(selection?.detail).toMatch(/Never which ones/);
    const selected = CANNOT_SEE.find((s) => s.key === "selectedApps");
    expect(selected?.detail).toMatch(/opaque tokens/);
    expect(selected?.detail).toMatch(/never uploaded/);
    expect(selected?.detail).toMatch(/counts only/);
    expect(renderPrivacyMarkdown()).toMatch(/FamilyActivitySelection/);
  });

  it("the employee summary names messages, photos and browsing history and stays short", () => {
    expect(EMPLOYEE_PRIVACY_SUMMARY).toMatch(/messages/);
    expect(EMPLOYEE_PRIVACY_SUMMARY).toMatch(/photos/);
    expect(EMPLOYEE_PRIVACY_SUMMARY).toMatch(/browsing history/);
    expect(EMPLOYEE_PRIVACY_SUMMARY).toMatch(/stay on this device/);
    expect(EMPLOYEE_PRIVACY_SUMMARY.length).toBeLessThan(500);
  });
});

describe("device → server allow-list", () => {
  it("flattens every group's fields, without duplicates", () => {
    expect(DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS).toEqual(
      DEVICE_TO_SERVER_ALLOWED_FIELDS.flatMap((g) => g.fields),
    );
    expect(new Set(DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS).size).toBe(
      DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS.length,
    );
    for (const field of DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS)
      expect(field).toMatch(/^[a-z][A-Za-z]*$/);
  });

  it("lists exactly these wire fields per group (changing one is a deliberate privacy decision)", () => {
    // Field names as they appear in the mobile request schemas (packages/validation/src/mobile.ts).
    expect(
      Object.fromEntries(DEVICE_TO_SERVER_ALLOWED_FIELDS.map((g) => [g.key, [...g.fields]])),
    ).toEqual({
      joinDetails: ["companyCode", "inviteCode", "firstName", "lastName"],
      permissionState: ["permissionState"],
      selectionState: [
        "selectionState",
        "selectionCounts",
        "categories",
        "applications",
        "webDomains",
      ],
      restrictionEngineState: ["restrictionEngineState", "engineState"],
      versions: ["appVersion", "osVersion"],
      deviceModel: ["platform", "model"],
      syncTimestamps: [
        "policyVersionApplied",
        "scheduleVersionApplied",
        "policyVersion",
        "scheduleVersion",
      ],
      timezone: ["timezone"],
      deviceTime: ["localTime"],
      breaks: ["clientBreakId", "requestedAt", "requestedDurationMinutes", "endedAt"],
      events: ["events", "clientEventId", "type", "occurredAt", "reason"],
      pushToken: ["token", "environment"],
    });
    for (const field of DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS)
      expect(isDeviceToServerAllowedField(field)).toBe(true);
  });

  it("contains nothing that could carry content, identities of selected apps, usage or location", () => {
    const forbidden = [
      "token",
      "bundle",
      "appname",
      "url",
      "domain",
      "history",
      "usage",
      "duration",
      "location",
      "latitude",
      "longitude",
      "ip",
      "contact",
      "message",
      "photo",
      "notification",
      "note",
      "text",
      "description",
      "metadata",
      "serial",
      "imei",
      "udid",
      "identifierforvendor",
      "advertising",
      "name", // firstName / lastName are the only names and are checked below
    ];
    /** Fields whose names trip a forbidden substring, the group that justifies each, and why. */
    const exceptions: Record<string, { group: string; why: string }> = {
      token: { group: "pushToken", why: "the APNs push token, the only token a device sends" },
      webDomains: { group: "selectionState", why: "a count inside selectionCounts, not a list" },
      requestedDurationMinutes: { group: "breaks", why: "the requested break length" },
      firstName: { group: "joinDetails", why: "typed once to find the employer's own record" },
      lastName: { group: "joinDetails", why: "typed once to find the employer's own record" },
    };
    const groupOf = (field: string) =>
      DEVICE_TO_SERVER_ALLOWED_FIELDS.find((g) => (g.fields as readonly string[]).includes(field))
        ?.key;
    for (const [field, { group }] of Object.entries(exceptions)) expect(groupOf(field)).toBe(group);
    for (const field of DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS) {
      if (field in exceptions) continue;
      for (const bad of forbidden) {
        expect(
          field.toLowerCase().includes(bad.toLowerCase()),
          `${field} must not contain "${bad}"`,
        ).toBe(false);
      }
    }
  });

  it("describes the selection by state and counts only", () => {
    const selection = DEVICE_TO_SERVER_ALLOWED_FIELDS.find((g) => g.key === "selectionState");
    expect(selection?.fields).toEqual([
      "selectionState",
      "selectionCounts",
      "categories",
      "applications",
      "webDomains",
    ]);
    expect(selection?.detail).toMatch(/three numbers/);
    expect(selection?.detail).toMatch(/Never the tokens, names or bundle identifiers/);
  });

  it("rejects unknown fields", () => {
    for (const field of [
      "selection",
      "selectedApps",
      "appTokens",
      "location",
      "browsingHistory",
      "notes",
      "",
    ]) {
      expect(isDeviceToServerAllowedField(field)).toBe(false);
    }
  });

  it("the push token is described as encrypted and used only to trigger a sync", () => {
    const push = DEVICE_TO_SERVER_ALLOWED_FIELDS.find((g) => g.key === "pushToken");
    expect(push?.detail).toMatch(/Stored encrypted/);
    expect(push?.detail).toMatch(/used only to ask the app to sync/);
  });

  it("the events entry enumerates exactly the device-reportable event types", () => {
    const events = DEVICE_TO_SERVER_ALLOWED_FIELDS.find((f) => f.key === "events");
    for (const t of DEVICE_REPORTABLE_EVENT_TYPES) expect(events?.detail).toContain(t);
    expect(events?.detail).toMatch(/no free text/);
  });
});

describe("renderPrivacyMarkdown", () => {
  it("is deterministic, starts with the generated notice and ends with exactly one newline", () => {
    const md = renderPrivacyMarkdown();
    expect(md).toBe(renderPrivacyMarkdown());
    expect(md.startsWith(PRIVACY_DOC_GENERATED_NOTICE)).toBe(true);
    expect(PRIVACY_DOC_GENERATED_NOTICE).toContain("privacyStatements.ts");
    expect(PRIVACY_DOC_GENERATED_NOTICE).toContain(PRIVACY_DOC_REGENERATE_COMMAND);
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });

  it("includes every statement, every allowed field, the principle and the employee summary", () => {
    const md = renderPrivacyMarkdown();
    for (const s of [...CAN_SEE, ...CANNOT_SEE])
      expect(md).toContain(`- **${s.label}.** ${s.detail}`);
    for (const f of DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS) expect(md).toContain(`\`${f}\``);
    expect(md).toContain(`> **${PRIVACY_PRINCIPLE}**`);
    expect(md).toContain(`> ${EMPLOYEE_PRIVACY_SUMMARY}`);
    expect(md).toContain("## What the employer CAN see");
    expect(md).toContain("## What the employer CANNOT see");
    expect(md).toContain("## What the device sends");
  });

  it("avoids markdown constructs Prettier rewrites (tables, trailing spaces, setext headings, * bullets)", () => {
    const md = renderPrivacyMarkdown();
    for (const line of md.split("\n")) {
      expect(line).not.toMatch(/\s$/);
      expect(line.startsWith("|")).toBe(false);
      expect(line.startsWith("* ")).toBe(false);
      expect(line).not.toMatch(/^(=+|-{3,})$/);
    }
    expect(md).not.toMatch(/\n{3,}/);
  });

  it("describes workforce integrations according to the provider registry (no sync is claimed early)", () => {
    const md = renderPrivacyMarkdown();
    for (const id of INTEGRATION_PROVIDERS) expect(md).toContain(PROVIDERS[id].displayName);
    const anyAvailable = INTEGRATION_PROVIDERS.some((id) => PROVIDERS[id].status === "AVAILABLE");
    expect(md.includes("are not available yet")).toBe(!anyAvailable);
    expect(md).toMatch(/7shifts, When I Work, Rotaready and Homebase\)/);
  });

  it("names every Apple framework and extension point the app actually uses, and no usage reporting", () => {
    const md = renderPrivacyMarkdown();
    for (const fw of ["FamilyControls", "ManagedSettings", "DeviceActivity"])
      expect(md).toContain(fw);
    expect(md).toMatch(
      /time-based schedules only, with no usage thresholds and no activity-report/,
    );
  });

  it("docs/PRIVACY.md is the committed output of renderPrivacyMarkdown()", () => {
    const rendered = renderPrivacyMarkdown();
    if (process.env.UPDATE_PRIVACY_DOC === "1") writeFileSync(PRIVACY_DOC_PATH, rendered, "utf8");
    const committed = readFileSync(PRIVACY_DOC_PATH, "utf8");
    expect(
      committed,
      `docs/PRIVACY.md is stale. Regenerate: ${PRIVACY_DOC_REGENERATE_COMMAND}`,
    ).toBe(rendered);
  });
});
