import { z } from "zod";
import { INTEGRATION_PROVIDERS } from "@clockoff/shared/enums";
import {
  SYNC_ERROR_CODES,
  type ProviderAvailability,
} from "@clockoff/shared/providers/workforceProvider";
import {
  activationModeSchema,
  integrationProviderSchema,
  integrationStatusSchema,
} from "./enumSchemas";
import { instantSchema, nullableInstantSchema } from "./primitives";

/**
 * Workforce integrations (§5 integrations). Providers are listed now and implemented in Phase 2: until a
 * provider is AVAILABLE, `connect` and `sync` answer 501 COMING_SOON and managers can ask to be notified.
 */

/** Values of `ProviderAvailability` (@clockoff/shared, a type only); domain.test.ts asserts equality. */
export const PROVIDER_AVAILABILITIES = [
  "AVAILABLE",
  "COMING_SOON",
] as const satisfies readonly ProviderAvailability[];
export const providerAvailabilitySchema = z
  .enum(PROVIDER_AVAILABILITIES)
  .meta({ id: "ProviderAvailability" });

/**
 * `:provider` path segment. Accepts the enum value in any case, with `-` for `_`
 * (`/api/integrations/when-i-work/connect` ≡ `WHEN_I_WORK`).
 */
export const integrationProviderParamSchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase().replace(/-/g, "_") : value),
    integrationProviderSchema,
  )
  .meta({
    description:
      "IntegrationProvider value, case-insensitive, with `-` accepted for `_` (e.g. `when-i-work`).",
  });
export const integrationParamsSchema = z
  .object({ provider: integrationProviderParamSchema })
  .strict();
export type IntegrationParams = z.infer<typeof integrationParamsSchema>;

export const integrationSchema = z
  .object({
    provider: integrationProviderSchema,
    displayName: z.string(),
    description: z.string(),
    website: z.url(),
    availability: providerAvailabilitySchema,
    status: integrationStatusSchema,
    /** Activation modes ClockOff supports for this provider. */
    supportedActivationModes: z.array(activationModeSchema),
    activationMode: activationModeSchema,
    /** The manager asked to be told when this provider becomes available. */
    notifyRequested: z.boolean(),
    lastSyncAt: nullableInstantSchema,
    lastError: z.string().nullable(),
    /** Name of the connected provider account, when the provider exposes one. */
    externalAccountName: z.string().nullable(),
  })
  .meta({ id: "Integration" });
export type Integration = z.infer<typeof integrationSchema>;

/** `GET /api/integrations` — one entry per provider, in enum order, connected or not. */
export const listIntegrationsResponseSchema = z
  .object({ integrations: z.array(integrationSchema).max(INTEGRATION_PROVIDERS.length) })
  .meta({ id: "ListIntegrationsResponse" });
export type ListIntegrationsResponse = z.infer<typeof listIntegrationsResponseSchema>;

export const integrationResponseSchema = z
  .object({ integration: integrationSchema })
  .meta({ id: "IntegrationResponse" });
export type IntegrationResponse = z.infer<typeof integrationResponseSchema>;

/**
 * `POST /api/integrations/:provider/connect` — 501 COMING_SOON while the provider is not available. For an
 * OAuth provider the response carries the URL to redirect the manager to.
 */
export const connectIntegrationSchema = z
  .object({
    activationMode: activationModeSchema.optional(),
    /** OAuth callback leg: authorisation code + state returned by the provider. */
    code: z.string().min(1).max(2000).optional(),
    state: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => (v.code === undefined) === (v.state === undefined), {
    message: "code and state must be sent together",
    path: ["state"],
  });
export type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>;

export const connectIntegrationResponseSchema = z
  .object({
    integration: integrationSchema,
    /** Set when the manager must authorise at the provider before the connection completes. */
    authorizationUrl: z.url().nullable(),
  })
  .meta({ id: "ConnectIntegrationResponse" });
export type ConnectIntegrationResponse = z.infer<typeof connectIntegrationResponseSchema>;

/** `POST /api/integrations/:provider/disconnect` · `/sync` · `/notify-me` take no body. */
export const integrationActionSchema = z.object({}).strict();

export const syncIntegrationResponseSchema = z
  .object({
    integration: integrationSchema,
    report: z.object({
      startedAt: instantSchema,
      finishedAt: instantSchema,
      created: z.int().min(0),
      updated: z.int().min(0),
      skipped: z.int().min(0),
      errors: z.array(
        z.object({
          code: z.enum(SYNC_ERROR_CODES),
          message: z.string(),
          /** The provider's id for the record that failed, when there is one. */
          externalId: z.string().nullable(),
        }),
      ),
    }),
  })
  .meta({ id: "SyncIntegrationResponse" });
export type SyncIntegrationResponse = z.infer<typeof syncIntegrationResponseSchema>;
