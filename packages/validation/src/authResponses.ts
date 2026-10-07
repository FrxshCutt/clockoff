import { z } from "zod";
import { currentUserSchema } from "./auth";
import { uuidSchema } from "./common";
import { roleSchema } from "./enumSchemas";
import { instantSchema } from "./primitives";

/**
 * Response bodies of the manager auth routes (`/api/auth/*`). The request bodies live in `auth.ts`; these
 * mirror what the handlers in apps/web/src/app/api/auth return. Every sign-in style response also sets the
 * `clockoff_session` / `clockoff_csrf` cookies and returns the CSRF token so the client can send `x-csrf-token` at once.
 */

/** `POST /api/auth/register` (201) and `POST /api/auth/login`. */
export const authSessionResponseSchema = z
  .object({
    ok: z.literal(true),
    /** True when the deployment requires a verified email before manager routes can be used. */
    requiresEmailVerification: z.boolean(),
    csrfToken: z.string(),
  })
  .meta({ id: "AuthSessionResponse" });
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

/** `POST /api/auth/reset-password` — consumes the token and signs in with a fresh session. */
export const resetPasswordResponseSchema = z
  .object({ ok: z.literal(true), csrfToken: z.string() })
  .meta({ id: "ResetPasswordResponse" });
export type ResetPasswordResponse = z.infer<typeof resetPasswordResponseSchema>;

/** `POST /api/auth/resend-verification` */
export const resendVerificationResponseSchema = z
  .object({ ok: z.literal(true), alreadyVerified: z.boolean() })
  .meta({ id: "ResendVerificationResponse" });
export type ResendVerificationResponse = z.infer<typeof resendVerificationResponseSchema>;

/** `POST /api/auth/change-password` — every other session of the user is revoked. */
export const changePasswordResponseSchema = z
  .object({ ok: z.literal(true), revokedSessions: z.int().min(0) })
  .meta({ id: "ChangePasswordResponse" });
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

/** `POST /api/auth/switch-organisation` — also sets the `clockoff_org` cookie. */
export const switchOrganisationResponseSchema = z
  .object({ ok: z.literal(true), currentOrganisationId: uuidSchema })
  .meta({ id: "SwitchOrganisationResponse" });
export type SwitchOrganisationResponse = z.infer<typeof switchOrganisationResponseSchema>;

/**
 * `GET /api/auth/me` — `currentUserSchema` (auth.ts) published as the `CurrentUser` component, with `role`
 * referencing the shared `Role` enum component and `createdAt` documented as an instant. The inferred type
 * is identical to `CurrentUser` from auth.ts (asserted in authResponses.test.ts).
 */
export const currentUserResponseSchema = currentUserSchema
  .extend({
    user: currentUserSchema.shape.user.extend({ createdAt: instantSchema }),
    organisations: z.array(
      currentUserSchema.shape.organisations.element.extend({ role: roleSchema }),
    ),
  })
  .meta({ id: "CurrentUser" });
export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;

// ── Health ──────────────────────────────────────────────────────────────────

export const HEALTH_STATUSES = ["ok", "degraded"] as const;
export const DATABASE_HEALTH_STATUSES = ["ok", "unreachable"] as const;
export const MIGRATION_HEALTH_STATUSES = ["up_to_date", "pending", "failed", "unknown"] as const;

/**
 * `GET /api/health` — 200 when the database answers and every migration is applied; 503 (same shape)
 * when the database is unreachable or migrations are pending/failed.
 */
export const healthResponseSchema = z
  .object({
    status: z.enum(HEALTH_STATUSES),
    database: z.enum(DATABASE_HEALTH_STATUSES),
    migrations: z.enum(MIGRATION_HEALTH_STATUSES),
    time: instantSchema,
  })
  .meta({ id: "HealthResponse" });
export type HealthResponse = z.infer<typeof healthResponseSchema>;
