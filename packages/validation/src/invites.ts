import { z } from "zod";
import { uuidSchema } from "./common";
import { employeeInviteStatusSchema, inviteChannelSchema } from "./enumSchemas";
import { instantSchema, nullableInstantSchema } from "./primitives";

/**
 * Employee invites (§5 "invites (employee)"). An invite carries a per-employee code that disambiguates
 * duplicate names during the iOS join flow; the company join code identifies the organisation.
 */

export const employeeInviteSchema = z
  .object({
    id: uuidSchema,
    employeeId: uuidSchema,
    /** Per-employee invite code typed in the app (e.g. `K7PQ2M`). */
    code: z.string(),
    channel: inviteChannelSchema,
    status: employeeInviteStatusSchema,
    sentAt: nullableInstantSchema,
    acceptedAt: nullableInstantSchema,
    expiresAt: instantSchema,
    revokedAt: nullableInstantSchema,
    createdAt: instantSchema,
  })
  .meta({ id: "EmployeeInvite" });
export type EmployeeInvite = z.infer<typeof employeeInviteSchema>;

/**
 * `POST /api/employees/:id/invites`. EMAIL requires the employee to have an email, SMS a phone
 * (VALIDATION_ERROR otherwise). LINK only creates the invite so the manager can share the instructions.
 * Creating a new invite revokes any previous pending one for the same employee.
 */
export const createEmployeeInviteSchema = z
  .object({ channel: inviteChannelSchema.default("LINK") })
  .strict();
export type CreateEmployeeInviteInput = z.infer<typeof createEmployeeInviteSchema>;

/** `POST /api/invites/:id/resend` — optional channel switch. */
export const resendEmployeeInviteSchema = z
  .object({ channel: inviteChannelSchema.optional() })
  .strict();
export type ResendEmployeeInviteInput = z.infer<typeof resendEmployeeInviteSchema>;

/** `POST /api/invites/:id/revoke` */
export const revokeEmployeeInviteSchema = z.object({}).strict();
export type RevokeEmployeeInviteInput = z.infer<typeof revokeEmployeeInviteSchema>;

/** `GET /api/invites/:id/instructions` — copy the manager can paste into a message or print. */
export const inviteInstructionsSchema = z
  .object({
    employee: z.object({ id: uuidSchema, firstName: z.string(), lastName: z.string() }),
    /** Active company join code; null when the organisation has revoked it (regenerate first). */
    companyCode: z.string().nullable(),
    inviteCode: z.string(),
    expiresAt: instantSchema,
    appStoreUrl: z.url(),
    /** Ordered, plain-language setup steps for the employee. */
    steps: z.array(z.string()),
    /** What the employer can see (from the shared privacy statements). */
    canSee: z.array(z.string()),
    /** What the employer cannot see. */
    cannotSee: z.array(z.string()),
    /** Ready-to-send message combining the above. */
    copyText: z.string(),
  })
  .meta({ id: "InviteInstructions" });
export type InviteInstructions = z.infer<typeof inviteInstructionsSchema>;

export const inviteInstructionsResponseSchema = z
  .object({ instructions: inviteInstructionsSchema })
  .meta({ id: "InviteInstructionsResponse" });
export type InviteInstructionsResponse = z.infer<typeof inviteInstructionsResponseSchema>;

/** Response of resend / revoke. */
export const employeeInviteResponseSchema = z
  .object({ invite: employeeInviteSchema })
  .meta({ id: "EmployeeInviteResponse" });
export type EmployeeInviteResponse = z.infer<typeof employeeInviteResponseSchema>;

/** Response of `POST /api/employees/:id/invites` — the invite plus its instructions, so the UI needs no second call. */
export const createEmployeeInviteResponseSchema = z
  .object({ invite: employeeInviteSchema, instructions: inviteInstructionsSchema })
  .meta({ id: "CreateEmployeeInviteResponse" });
export type CreateEmployeeInviteResponse = z.infer<typeof createEmployeeInviteResponseSchema>;
