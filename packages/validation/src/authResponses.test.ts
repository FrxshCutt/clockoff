import { describe, expect, expectTypeOf, it } from "vitest";
import { currentUserSchema, type CurrentUser } from "./auth";
import {
  authSessionResponseSchema,
  currentUserResponseSchema,
  healthResponseSchema,
  type CurrentUserResponse,
} from "./authResponses";
import { apiErrorResponseSchema } from "./primitives";

const me: CurrentUser = {
  user: {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    email: "owner@harpendencoffee.test",
    name: "Olivia Owner",
    emailVerified: true,
    createdAt: "2026-10-01T09:00:00.000Z",
  },
  organisations: [
    {
      id: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
      name: "Harpenden Coffee Co.",
      slug: "harpenden-coffee",
      role: "OWNER",
      timezone: "Europe/London",
    },
  ],
  currentOrganisationId: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
  csrfToken: "csrf-token-value",
};

describe("auth responses", () => {
  it("publishes CurrentUser with the same type as auth.ts currentUserSchema", () => {
    expectTypeOf<CurrentUserResponse>().toEqualTypeOf<CurrentUser>();
    expect(currentUserResponseSchema.parse(me)).toEqual(currentUserSchema.parse(me));
    const badRole = { ...me, organisations: [{ ...me.organisations[0], role: "ROOT" }] };
    expect(currentUserResponseSchema.safeParse(badRole).success).toBe(false);
    expect(currentUserSchema.safeParse(badRole).success).toBe(false);
  });

  it("describes the session, health and error envelopes", () => {
    expect(
      authSessionResponseSchema.safeParse({
        ok: true,
        requiresEmailVerification: false,
        csrfToken: "t",
      }).success,
    ).toBe(true);
    expect(
      healthResponseSchema.safeParse({
        status: "degraded",
        database: "unreachable",
        time: "2026-10-06T10:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: "SHIFT_OVERLAP", message: "Overlap" } })
        .success,
    ).toBe(true);
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: "TEAPOT", message: "No" } }).success,
    ).toBe(false);
  });
});
