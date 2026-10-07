import {
  acceptManagerInviteSchema,
  createOrganisationSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "@clockoff/validation/auth";
import { passwordSchema } from "@clockoff/validation/common";
import { z } from "zod";

/**
 * Client form schemas derived from the shared API schemas in `@clockoff/validation`, adding only UI concerns
 * (password confirmation, empty optional inputs).
 */

const confirmPasswordShape = { confirmPassword: z.string().min(1, "Confirm your new password") };

function passwordsMatch(values: { password: string; confirmPassword: string }) {
  return values.password === values.confirmPassword;
}

export const resetPasswordFormSchema = z
  .object({ password: passwordSchema, ...confirmPasswordShape })
  .refine(passwordsMatch, { path: ["confirmPassword"], message: "Passwords don't match" });
export type ResetPasswordFormValues = z.infer<typeof resetPasswordFormSchema>;

/** New-account fields when accepting a manager invite (name + password are required in that case). */
export const acceptInviteAccountFormSchema = z.object({
  name: registerSchema.shape.name,
  password: passwordSchema,
});
export type AcceptInviteAccountFormValues = z.infer<typeof acceptInviteAccountFormSchema>;

// Keep the accept schema referenced so a change to its optional fields is caught here at compile time.
export type AcceptManagerInviteBody = z.infer<typeof acceptManagerInviteSchema>;

/** Create-organisation form: the location input may be left blank (sent as `undefined`). */
export const createOrganisationFormSchema = createOrganisationSchema.extend({
  firstLocationName: z
    .string()
    .trim()
    .max(120, "Use 120 characters or fewer")
    .optional()
    .transform((value) => (value ? value : undefined)),
});
export type CreateOrganisationFormInput = z.input<typeof createOrganisationFormSchema>;

/** The API's own rules for each emailed-link token (`?token=`). */
const LINK_TOKEN_SCHEMAS = {
  resetPassword: resetPasswordSchema.shape.token,
  verifyEmail: verifyEmailSchema.shape.token,
  managerInvite: acceptManagerInviteSchema.shape.token,
} as const;
export type LinkTokenKind = keyof typeof LINK_TOKEN_SCHEMAS;

/**
 * The token from an emailed link, or null when it is missing or could never pass the API's schema (e.g. a
 * link truncated by an email client). Pages show "this link is incomplete" for null instead of sending a
 * request that would fail with a field-level `VALIDATION_ERROR` the form has no field for.
 */
export function parseLinkToken(
  kind: LinkTokenKind,
  token: string | null | undefined,
): string | null {
  if (!token) return null;
  const result = LINK_TOKEN_SCHEMAS[kind].safeParse(token);
  return result.success ? result.data : null;
}
