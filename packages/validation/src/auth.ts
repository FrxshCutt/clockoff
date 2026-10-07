import { z } from "zod";
import { ROLES } from "@clockoff/shared/enums";
import { emailSchema, nonEmptyString, passwordSchema, timezoneSchema, uuidSchema } from "./common";

// ── Manager auth (web, cookie sessions) ─────────────────────────────────────

export const registerSchema = z
  .object({
    name: nonEmptyString(120),
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(200),
  })
  .strict();
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(500),
    password: passwordSchema,
  })
  .strict();

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(500) }).strict();

export const resendVerificationSchema = z.object({}).strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordSchema,
  })
  .strict();

/** `GET /api/auth/me` */
export const currentUserSchema = z.object({
  user: z.object({
    id: uuidSchema,
    email: z.string(),
    name: z.string(),
    emailVerified: z.boolean(),
    createdAt: z.string(),
  }),
  organisations: z.array(
    z.object({
      id: uuidSchema,
      name: z.string(),
      slug: z.string(),
      role: z.enum(ROLES),
      timezone: z.string(),
      /**
       * Whether the phone test tools (`POST /api/test-tools/test-shift`) are available in this
       * organisation: the server runs with `DEV_TOOLS_ENABLED=true`, or the organisation is listed in
       * `TEST_TOOLS_ORGANISATION_IDS`. The dashboard hides "Create test shift…" otherwise.
       */
      testToolsEnabled: z.boolean(),
    }),
  ),
  /** Organisation currently selected (cookie), null until the manager creates/joins one. */
  currentOrganisationId: uuidSchema.nullable(),
  csrfToken: z.string(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

export const switchOrganisationSchema = z.object({ organisationId: uuidSchema }).strict();

/** `POST /api/organisations` — create the first (or another) organisation. */
export const createOrganisationSchema = z
  .object({
    name: nonEmptyString(120),
    timezone: timezoneSchema,
    firstLocationName: nonEmptyString(120).optional(),
  })
  .strict();
export type CreateOrganisationInput = z.infer<typeof createOrganisationSchema>;

/** `POST /api/organisations/current/members/accept` — accept a manager invite (existing or new user). */
export const acceptManagerInviteSchema = z
  .object({
    token: z.string().min(20).max(500),
    // Only needed when the invitee has no account yet.
    name: nonEmptyString(120).optional(),
    password: passwordSchema.optional(),
  })
  .strict();
