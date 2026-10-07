import { updateOrganisationSchema } from "@clockoff/validation/organisation";
import { describe, expect, it } from "vitest";
import type { OrganisationSummary } from "@/hooks/api-shapes";
import { organisationSettingsFormSchema, toOrganisationFormValues } from "./organisation-settings";

const organisation: OrganisationSummary = {
  id: "8d6f1f3e-2a52-4f43-9d0c-7a1f0b8f2c11",
  name: "Harbour Café",
  slug: "harbour-cafe",
  timezone: "Europe/London",
  dateFormat: "DMY",
  plan: "STARTER",
  billingStatus: "TRIAL",
  settings: { weekStartsOn: "MONDAY", timeFormat: "H24", requireInviteCodeToJoin: false },
};

describe("organisationSettingsFormSchema", () => {
  it("accepts the values prefilled from the organisation and produces a valid PATCH body", () => {
    const parsed = organisationSettingsFormSchema.parse(toOrganisationFormValues(organisation));
    expect(parsed).toEqual({
      name: "Harbour Café",
      timezone: "Europe/London",
      dateFormat: "DMY",
      settings: { weekStartsOn: "MONDAY", timeFormat: "H24", requireInviteCodeToJoin: false },
    });
    expect(updateOrganisationSchema.safeParse(parsed).success).toBe(true);
  });

  it("applies the API's rules: trimmed non-empty name, real IANA zone, every setting present", () => {
    const values = toOrganisationFormValues(organisation);
    expect(organisationSettingsFormSchema.parse({ ...values, name: "  Harbour  " }).name).toBe(
      "Harbour",
    );
    expect(organisationSettingsFormSchema.safeParse({ ...values, name: "   " }).success).toBe(
      false,
    );
    expect(
      organisationSettingsFormSchema.safeParse({ ...values, name: "x".repeat(121) }).success,
    ).toBe(false);
    expect(
      organisationSettingsFormSchema.safeParse({ ...values, timezone: "Mars/Olympus" }).success,
    ).toBe(false);
    expect(
      organisationSettingsFormSchema.safeParse({ ...values, dateFormat: "DDMMYY" }).success,
    ).toBe(false);
    const { timeFormat: _omitted, ...partialSettings } = values.settings;
    expect(
      organisationSettingsFormSchema.safeParse({ ...values, settings: partialSettings }).success,
    ).toBe(false);
  });

  it("does not share the organisation's settings object with the form", () => {
    const values = toOrganisationFormValues(organisation);
    expect(values.settings).not.toBe(organisation.settings);
  });
});
