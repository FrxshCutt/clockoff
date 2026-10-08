import { z } from "zod";
import { INTEGRATION_PROVIDERS } from "@clockoff/shared/enums";
import {
  SYNC_ERROR_CODES,
  type ProviderAvailability,
} from "@clockoff/shared/providers/workforceProvider";
import { uuidSchema } from "./common";
import {
  activationModeSchema,
  integrationProviderSchema,
  integrationStatusSchema,
} from "./enumSchemas";
import { instantSchema, nullableInstantSchema } from "./primitives";

/**
 * Workforce integrations (§5 integrations). Providers are listed now and implemented in Phase 2: until a
 * provider is AVAILABLE, `connect` and `sync` answer 501 COMING_SOON and managers can ask to be notified.
 * Planday's own endpoints and DTOs are in `./planday` (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md).
 */

/**
 * The integration that manages a record's synced fields (Employee name, email and primary location; Location
 * and Team names; every field of a Shift). Null for records ClockOff owns, including every record left behind
 * by a disconnect. The dashboard locks managed fields ("Managed in Planday").
 */
export const managedBySchema = z
  .object({ provider: integrationProviderSchema, integrationId: uuidSchema })
  .meta({ id: "ManagedBy" });
export type ManagedBy = z.infer<typeof managedBySchema>;

/**
 * `managedBy` of a DTO from the row's `managedByIntegrationId`. Planday is the only provider whose sync manages
 * records (the only one with connections); a second provider passes its own id.
 */
export function managedByFromIntegrationId(
  managedByIntegrationId: string | null,
  provider: ManagedBy["provider"] = "PLANDAY",
): ManagedBy | null {
  return managedByIntegrationId ? { provider, integrationId: managedByIntegrationId } : null;
}

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
    /**
     * ClockOff paused the provider (Planday's kill switch, PLANDAY_ENABLED=false) while this organisation has a
     * live connection: the card shows "Paused" instead of "Coming soon"; no sync runs, the data stays.
     */
    paused: z.boolean(),
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

/** `POST /api/integrations/:provider/sync` · `/notify-me` take no body. */
export const integrationActionSchema = z.object({}).strict();

/**
 * What a disconnect does with the records the integration synced (Planday, §5.8): keep them all (they become
 * ClockOff-managed and editable), or also cancel every future synced shift (employees are kept).
 */
export const DISCONNECT_MODES = ["KEEP_RECORDS", "CANCEL_FUTURE_SHIFTS"] as const;
export type DisconnectMode = (typeof DISCONNECT_MODES)[number];

/** `POST /api/integrations/:provider/disconnect` — `{}` keeps every record (`KEEP_RECORDS`). */
export const disconnectIntegrationSchema = z
  .object({ mode: z.enum(DISCONNECT_MODES).default("KEEP_RECORDS") })
  .strict();
export type DisconnectIntegrationInput = z.input<typeof disconnectIntegrationSchema>;
export type DisconnectIntegrationBody = z.output<typeof disconnectIntegrationSchema>;

/**
 * A dashboard banner about an unhealthy connection (§8.3): `error` for AUTH_ERROR ("Planday disconnected"),
 * `warning` for DEGRADED and for a connection paused by ClockOff. `action` is null for MANAGER and when there
 * is nothing to do.
 */
export const integrationHealthBannerSchema = z
  .object({
    provider: integrationProviderSchema,
    level: z.enum(["error", "warning"]),
    title: z.string(),
    body: z.string(),
    action: z.object({ label: z.string(), href: z.string() }).nullable(),
    isMock: z.boolean(),
  })
  .meta({ id: "IntegrationHealthBanner" });
export type IntegrationHealthBanner = z.infer<typeof integrationHealthBannerSchema>;

/** `GET /api/integrations/health` — answers while Planday is switched off too (the paused banner). */
export const integrationHealthResponseSchema = z
  .object({ banners: z.array(integrationHealthBannerSchema) })
  .meta({ id: "IntegrationHealthResponse" });
export type IntegrationHealthResponse = z.infer<typeof integrationHealthResponseSchema>;

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
