import {
  acceptManagerInviteSchema,
  createOrganisationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "@clockoff/validation/auth";
import { describe, expect, it } from "vitest";
import {
  acceptInviteAccountFormSchema,
  createOrganisationFormSchema,
  parseLinkToken,
  resetPasswordFormSchema,
} from "./schemas";

describe("resetPasswordFormSchema", () => {
  it("requires matching passwords that satisfy the API policy", () => {
    expect(
      resetPasswordFormSchema.safeParse({
        password: "correct horse 1",
        confirmPassword: "correct horse 1",
      }).success,
    ).toBe(true);
    const mismatch = resetPasswordFormSchema.safeParse({
      password: "correct horse 1",
      confirmPassword: "correct horse 2",
    });
    expect(mismatch.success).toBe(false);
    expect(mismatch.error?.issues[0]?.path).toEqual(["confirmPassword"]);
    expect(
      resetPasswordFormSchema.safeParse({ password: "short1", confirmPassword: "short1" }).success,
    ).toBe(false);
    expect(
      resetPasswordFormSchema.safeParse({
        password: "nodigitshere",
        confirmPassword: "nodigitshere",
      }).success,
    ).toBe(false);
  });
});

describe("acceptInviteAccountFormSchema", () => {
  it("requires a name and a policy-compliant password", () => {
    expect(
      acceptInviteAccountFormSchema.safeParse({ name: "Ada", password: "password1234" }).success,
    ).toBe(true);
    expect(
      acceptInviteAccountFormSchema.safeParse({ name: "  ", password: "password1234" }).success,
    ).toBe(false);
    expect(
      acceptInviteAccountFormSchema.safeParse({ name: "Ada", password: "password" }).success,
    ).toBe(false);
  });
});

describe("createOrganisationFormSchema", () => {
  it("drops a blank first location so the API body stays valid", () => {
    const parsed = createOrganisationFormSchema.parse({
      name: " Harbour Café ",
      timezone: "Europe/London",
      firstLocationName: "  ",
    });
    expect(parsed).toEqual({
      name: "Harbour Café",
      timezone: "Europe/London",
      firstLocationName: undefined,
    });
    expect(createOrganisationSchema.safeParse(parsed).success).toBe(true);
  });

  it("keeps a provided location and rejects invalid zones", () => {
    const parsed = createOrganisationFormSchema.parse({
      name: "Harbour",
      timezone: "UTC",
      firstLocationName: " High Street ",
    });
    expect(parsed.firstLocationName).toBe("High Street");
    expect(createOrganisationSchema.safeParse(parsed).success).toBe(true);
    expect(
      createOrganisationFormSchema.safeParse({ name: "Harbour", timezone: "Not/AZone" }).success,
    ).toBe(false);
    expect(createOrganisationFormSchema.safeParse({ name: "", timezone: "UTC" }).success).toBe(
      false,
    );
  });
});

describe("parseLinkToken", () => {
  const token = "a".repeat(43);

  it("keeps tokens the API would accept", () => {
    expect(parseLinkToken("resetPassword", token)).toBe(token);
    expect(parseLinkToken("verifyEmail", token)).toBe(token);
    expect(parseLinkToken("managerInvite", token)).toBe(token);
    expect(resetPasswordSchema.shape.token.safeParse(token).success).toBe(true);
  });

  it("rejects missing, truncated and oversized tokens with the same rules as the API", () => {
    for (const kind of ["resetPassword", "verifyEmail", "managerInvite"] as const) {
      expect(parseLinkToken(kind, null), kind).toBeNull();
      expect(parseLinkToken(kind, undefined), kind).toBeNull();
      expect(parseLinkToken(kind, ""), kind).toBeNull();
      expect(parseLinkToken(kind, "abc123"), kind).toBeNull();
      expect(parseLinkToken(kind, "x".repeat(501)), kind).toBeNull();
    }
    expect(verifyEmailSchema.shape.token.safeParse("abc123").success).toBe(false);
    expect(acceptManagerInviteSchema.shape.token.safeParse("abc123").success).toBe(false);
  });
});
