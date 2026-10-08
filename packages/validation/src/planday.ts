import { z } from "zod";
import type { IntegrationWizardStep } from "@clockoff/shared/enums";
import { emailSchema, nonEmptyString, offsetPaginationQuerySchema, uuidSchema } from "./common";
import {
  activationModeSchema,
  apiErrorCodeSchema,
  integrationAuthMethodSchema,
  integrationConnectionStatusSchema,
  integrationSyncRunKindSchema,
  integrationSyncRunStatusSchema,
  integrationSyncTriggerSchema,
  integrationWizardStepSchema,
  onboardingSessionStatusSchema,
  pendingExternalEmployeeReasonSchema,
} from "./enumSchemas";
import { integrationSchema } from "./integrations";
import {
  instantSchema,
  localDateSchema,
  localTimeSchema,
  nullableInstantSchema,
  offsetPaginatedResponseSchema,
  uuidListSchema,
} from "./primitives";
import { actorRefSchema, employeeSummarySchema, namedRefSchema, shiftSummarySchema } from "./refs";

/**
 * Planday integration contracts (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §5, §7.11, §9, §10): the
 * connect methods, sync runs, settings, the pending-employee queue, shareable connect links, the setup wizard
 * and the JSON stored on `IntegrationMappingConfig` / `IntegrationOnboardingSession`. Every Planday endpoint
 * lives under `/api/integrations/planday/…` (the `[provider]` route folder) and answers 404 while
 * `PLANDAY_ENABLED=false`.
 *
 * Nothing here carries a token, an App ID pasted by a customer, an OAuth code or a Planday response body: a
 * connection is described by its status, its portal and `credentialHint` ("ending ••••4f2a") only.
 */

// ── Identifiers and limits ──────────────────────────────────────────────────

/** A Planday id as stored by ClockOff: a decimal string of a safe integer (Planday ids are int64 numbers). */
export const plandayExternalIdSchema = z
  .string()
  .regex(/^[0-9]{1,16}$/, "Expected a Planday id")
  .meta({ description: "Planday id as a decimal string" });

/** Pseudo department id for "not in any department" (employees with no department, shifts without one). */
export const PLANDAY_NO_DEPARTMENT_ID = "none";

/** A department key in mappings and choices: a Planday department id, or `"none"`. */
export const plandayDepartmentKeySchema = z
  .string()
  .regex(/^(?:[0-9]{1,16}|none)$/, 'Expected a Planday department id or "none"')
  .meta({ description: 'Planday department id as a decimal string, or "none" for no department' });

/** Sync window choices in the settings drawer (the database allows 7–56 days). */
export const PLANDAY_SYNC_WINDOW_DAYS = [7, 14, 28, 42, 56] as const;
export const PLANDAY_DEFAULT_SYNC_WINDOW_DAYS = 28;
export const plandaySyncWindowDaysSchema = z.literal(PLANDAY_SYNC_WINDOW_DAYS);

/** Connect-link lifetimes offered (hours): 24 h, 72 h (default) or 7 days. */
export const PLANDAY_CONNECT_LINK_EXPIRY_HOURS = [24, 72, 168] as const;
export const PLANDAY_CONNECT_LINK_DEFAULT_EXPIRY_HOURS = 72;
/** At most this many unexpired, unrevoked connect links per organisation. */
export const PLANDAY_MAX_ACTIVE_CONNECT_LINKS = 5;

/** `GET /api/integrations/planday/runs?limit=` maximum, and the warnings a run DTO carries. */
export const PLANDAY_RUNS_LIST_MAX = 50;
export const PLANDAY_RUN_WARNINGS_IN_DTO = 20;
/** Record-level warnings stored per run. */
export const PLANDAY_RUN_WARNINGS_STORED = 100;

/** "Sync now" is refused within this long of the previous manual request (spec §5: at most once a minute). */
export const PLANDAY_MANUAL_SYNC_COOLDOWN_MS = 60_000;

/** Where the OAuth flow returns to (an enum mapped to fixed paths: never a free URL). */
export const PLANDAY_OAUTH_RETURN_TO = ["WIZARD", "SETTINGS"] as const;
export type PlandayOAuthReturnTo = (typeof PLANDAY_OAUTH_RETURN_TO)[number];
export const PLANDAY_OAUTH_RETURN_TO_PATHS: Readonly<Record<PlandayOAuthReturnTo, string>> = {
  WIZARD: "/onboarding/planday",
  SETTINGS: "/integrations",
};

/** Landing page of a shareable connect link (`/connect/planday?token=…`). */
export const PLANDAY_CONNECT_LINK_PATH = "/connect/planday";

/** `?step=` spelling of a wizard step: `CONFIRM_PORTAL` → `confirm-portal`. */
export function plandayWizardStepSlug(step: IntegrationWizardStep): string {
  return step.toLowerCase().replace(/_/g, "-");
}

/** Parses a wizard `?step=` value (`confirm-portal`, case-insensitive) into an IntegrationWizardStep. */
export const plandayWizardStepParamSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase().replace(/-/g, "_") : value),
  integrationWizardStepSchema,
);

// ── Stored JSON: IntegrationMappingConfig ───────────────────────────────────

/** Where one included Planday department goes (`IntegrationMappingConfig.departmentMappings` values). */
export const plandayDepartmentMappingSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("LOCATION"), locationId: uuidSchema }).strict(),
  z.object({ target: z.literal("DEPARTMENT"), departmentId: uuidSchema }).strict(),
]);
export type PlandayDepartmentMapping = z.infer<typeof plandayDepartmentMappingSchema>;

/** `{ "<deptId>" | "none": mapping }` for included departments only. */
export const departmentMappingsSchema = z.record(
  plandayDepartmentKeySchema,
  plandayDepartmentMappingSchema,
);
export type DepartmentMappings = z.infer<typeof departmentMappingsSchema>;

/** `{ "<groupId>": { target: "TEAM", teamId } }`; a group not listed is not mapped to a team. */
export const groupMappingsSchema = z.record(
  plandayExternalIdSchema,
  z.object({ target: z.literal("TEAM"), teamId: uuidSchema }).strict(),
);
export type GroupMappings = z.infer<typeof groupMappingsSchema>;

const plandayCatalogDepartmentSchema = z
  .object({
    externalId: plandayExternalIdSchema,
    name: z.string(),
    /** Planday's department number, when it has one. */
    number: z.string().nullable().default(null),
    /** Employees in the department from the last count; null before the count ran. */
    employeeCount: z.int().min(0).nullable().default(null),
    firstSeenAt: instantSchema,
    /** OWNER/ADMIN were told about this (new) department; once per department id (§8.4). */
    notifiedAt: nullableInstantSchema.default(null),
    /** The last complete structure read no longer returned it. */
    missing: z.boolean().default(false),
  })
  .strict();

const plandayCatalogGroupSchema = z
  .object({
    externalId: plandayExternalIdSchema,
    name: z.string(),
    employeeCount: z.int().min(0).nullable().default(null),
    firstSeenAt: instantSchema,
    missing: z.boolean().default(false),
  })
  .strict();

/**
 * `IntegrationMappingConfig.catalog`: the department and employee-group catalogue from the last structure read
 * (names, numbers, employee counts). Not personal data. `{}` (the column default) parses to the empty catalogue.
 */
export const plandayCatalogSchema = z
  .object({
    readAt: nullableInstantSchema.default(null),
    departments: z.array(plandayCatalogDepartmentSchema).default([]),
    groups: z.array(plandayCatalogGroupSchema).default([]),
    /** Employees in no department (the "Not in any department" row); null before the count ran. */
    unassignedEmployeeCount: z.int().min(0).nullable().default(null),
    /** Child portals the account can see; ClockOff syncs only the connected portal. */
    childPortalCount: z.int().min(0).default(0),
  })
  .strict();
export type PlandayCatalog = z.infer<typeof plandayCatalogSchema>;

// ── Choices (wizard steps 3 to 5, settings) ─────────────────────────────────

/**
 * Step 3 / settings: where a Planday department goes. `NEW_LOCATION` creates a ClockOff location (named after
 * the department unless `name` is given); `LOCATION` / `DEPARTMENT` map to an existing record of the
 * organisation (checked when saved, D-056); `EXCLUDE` leaves its employees and shifts out.
 */
export const plandayDepartmentChoiceSchema = z
  .discriminatedUnion("target", [
    z
      .object({
        externalId: plandayDepartmentKeySchema,
        target: z.literal("NEW_LOCATION"),
        name: nonEmptyString(100).optional(),
      })
      .strict(),
    z
      .object({
        externalId: plandayDepartmentKeySchema,
        target: z.literal("LOCATION"),
        locationId: uuidSchema,
      })
      .strict(),
    z
      .object({
        externalId: plandayDepartmentKeySchema,
        target: z.literal("DEPARTMENT"),
        departmentId: uuidSchema,
      })
      .strict(),
    z.object({ externalId: plandayDepartmentKeySchema, target: z.literal("EXCLUDE") }).strict(),
  ])
  .meta({ id: "PlandayDepartmentChoice" });
export type PlandayDepartmentChoice = z.infer<typeof plandayDepartmentChoiceSchema>;

/** Step 4 / settings: an employee group becomes a new team, maps to an existing team, or is ignored. */
export const plandayGroupChoiceSchema = z
  .discriminatedUnion("target", [
    z.object({ externalId: plandayExternalIdSchema, target: z.literal("NEW_TEAM") }).strict(),
    z
      .object({
        externalId: plandayExternalIdSchema,
        target: z.literal("TEAM"),
        teamId: uuidSchema,
      })
      .strict(),
    z.object({ externalId: plandayExternalIdSchema, target: z.literal("IGNORE") }).strict(),
  ])
  .meta({ id: "PlandayGroupChoice" });
export type PlandayGroupChoice = z.infer<typeof plandayGroupChoiceSchema>;

/** Unique external ids across a list of choices. */
function uniqueExternalIds(choices: ReadonlyArray<{ externalId: string }>): boolean {
  return new Set(choices.map((c) => c.externalId)).size === choices.length;
}

const departmentChoicesSchema = z
  .array(plandayDepartmentChoiceSchema)
  .max(500)
  .refine(uniqueExternalIds, "Each department appears once");
const groupChoicesSchema = z
  .array(plandayGroupChoiceSchema)
  .max(500)
  .refine(uniqueExternalIds, "Each employee group appears once");

/** Step 5: which Planday employees to import. */
export const PLANDAY_EMPLOYEE_SELECTION_MODES = ["ALL_EXCEPT", "ONLY"] as const;
export const plandayEmployeeSelectionSchema = z
  .object({
    /** ALL_EXCEPT: every in-scope employee but `externalIds`; ONLY: just `externalIds`. */
    mode: z.enum(PLANDAY_EMPLOYEE_SELECTION_MODES),
    externalIds: z.array(plandayExternalIdSchema).max(5000),
  })
  .strict()
  .meta({ id: "PlandayEmployeeSelection" });
export type PlandayEmployeeSelection = z.infer<typeof plandayEmployeeSelectionSchema>;

/** Step 5: a manager decision for one employee (required for every selected ambiguous row). */
export const plandayEmployeeResolutionSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        externalId: plandayExternalIdSchema,
        action: z.literal("LINK"),
        employeeId: uuidSchema,
      })
      .strict(),
    z.object({ externalId: plandayExternalIdSchema, action: z.literal("CREATE") }).strict(),
    z.object({ externalId: plandayExternalIdSchema, action: z.literal("EXCLUDE") }).strict(),
  ])
  .meta({ id: "PlandayEmployeeResolution" });
export type PlandayEmployeeResolution = z.infer<typeof plandayEmployeeResolutionSchema>;

const policyChoiceSchema = z.union([
  z.object({ starter: z.literal(true) }).strict(),
  z.object({ policyId: uuidSchema }).strict(),
]);
const breakPolicyChoiceSchema = z.union([
  z.object({ starter: z.literal(true) }).strict(),
  z.object({ breakPolicyId: uuidSchema }).strict(),
]);
const teamPolicySchema = z.object({ teamId: uuidSchema, policyId: uuidSchema }).strict();

// ── Stored JSON: IntegrationOnboardingSession.state ─────────────────────────

/**
 * `IntegrationOnboardingSession.state` (§9.3): step drafts and choices. Every key is optional (a step writes
 * its key when the manager continues) and unknown keys are rejected.
 */
export const plandayOnboardingStateSchema = z
  .object({
    connect: z
      .object({ method: integrationAuthMethodSchema, connectedAt: instantSchema })
      .strict()
      .optional(),
    locations: z
      .object({ savedAt: instantSchema, departments: departmentChoicesSchema })
      .strict()
      .optional(),
    teams: z
      .object({ savedAt: instantSchema, skipped: z.boolean(), groups: groupChoicesSchema })
      .strict()
      .optional(),
    employees: z
      .object({
        savedAt: instantSchema,
        selection: plandayEmployeeSelectionSchema,
        resolutions: z.array(plandayEmployeeResolutionSchema).max(5000),
        autoIncludeNewEmployees: z.boolean(),
        importEmails: z.boolean(),
      })
      .strict()
      .optional(),
    /** Written by the IMPORT_EMPLOYEES apply sink: what this session imported, for release (§9.3). */
    employeesImport: z
      .object({ createdIds: z.array(uuidSchema), linkedIds: z.array(uuidSchema) })
      .strict()
      .optional(),
    shiftPreview: z
      .object({
        savedAt: instantSchema,
        replaceConflictingShiftIds: z.array(uuidSchema),
        sampleTimesConfirmed: z.boolean(),
      })
      .strict()
      .optional(),
    policies: z
      .object({
        savedAt: instantSchema,
        workPolicyId: uuidSchema,
        breakPolicyId: uuidSchema,
        createdStarterWork: z.boolean(),
        createdStarterBreak: z.boolean(),
        teamPolicies: z.array(teamPolicySchema),
      })
      .strict()
      .optional(),
    activation: z
      .object({ savedAt: instantSchema, mode: activationModeSchema })
      .strict()
      .optional(),
    finish: z.object({ finishedAt: instantSchema, runId: uuidSchema }).strict().optional(),
  })
  .strict();
export type PlandayOnboardingState = z.infer<typeof plandayOnboardingStateSchema>;

// ── Sync runs (§7.11) ───────────────────────────────────────────────────────

const runEntityCountsSchema = z.object({
  created: z.int().min(0),
  updated: z.int().min(0),
  cancelled: z.int().min(0),
  skipped: z.int().min(0),
});

/** Per entity type counts of a run (`IntegrationSyncRun.counts`); each run kind fills what it touches. */
export const plandaySyncRunCountsSchema = z
  .object({
    employees: runEntityCountsSchema.optional(),
    locations: runEntityCountsSchema.optional(),
    teams: runEntityCountsSchema.optional(),
    shifts: runEntityCountsSchema.optional(),
    clockEvents: runEntityCountsSchema.optional(),
    /** Employees waiting in the pending queue after the run. */
    pending: z.int().min(0).optional(),
    /** Shifts deliberately not synced. */
    excluded: z
      .object({
        drafts: z.int().min(0),
        open: z.int().min(0),
        hiddenDays: z.int().min(0),
        unknownStatus: z.int().min(0),
        outOfScope: z.int().min(0),
      })
      .optional(),
  })
  .meta({ id: "PlandaySyncRunCounts" });
export type PlandaySyncRunCounts = z.infer<typeof plandaySyncRunCountsSchema>;

/** A record-level problem (`IntegrationSyncRun.warnings` item). `message` never holds personal data. */
export const plandaySyncRunWarningSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    /** The Planday record id, when the warning is about one record. */
    externalId: z.string().nullable(),
  })
  .meta({ id: "PlandaySyncRunWarning" });
export type PlandaySyncRunWarning = z.infer<typeof plandaySyncRunWarningSchema>;

export const plandaySyncRunProgressSchema = z
  .object({
    completedPhases: z.int().min(0),
    totalPhases: z.int().min(0),
    /** Human label written by ClockOff, e.g. "Reading employees (page 3)", "Waiting to start". */
    label: z.string(),
    pagesRead: z.int().min(0),
  })
  .meta({ id: "PlandaySyncRunProgress" });

/** `GET /api/integrations/planday/runs/:runId`. Events are hints: the UI always refetches this. */
export const plandaySyncRunSchema = z
  .object({
    id: uuidSchema,
    kind: integrationSyncRunKindSchema,
    trigger: integrationSyncTriggerSchema,
    status: integrationSyncRunStatusSchema,
    /** RUNNING and not claimed by the worker yet ("Waiting to start"). */
    queued: z.boolean(),
    /** Current phase (`START` before the first slice). */
    phase: z.string(),
    progress: plandaySyncRunProgressSchema,
    counts: plandaySyncRunCountsSchema,
    warningsCount: z.int().min(0),
    /** The first {@link PLANDAY_RUN_WARNINGS_IN_DTO} warnings. */
    warnings: z.array(plandaySyncRunWarningSchema).max(PLANDAY_RUN_WARNINGS_IN_DTO),
    /** Not before this instant: queued jitter, a rate-limit park or a retry backoff. */
    resumeAfter: nullableInstantSchema,
    startedAt: instantSchema,
    finishedAt: nullableInstantSchema,
    errorCode: z.string().nullable(),
    /** Sanitised, from ClockOff's own message table; never Planday response text. */
    errorMessage: z.string().nullable(),
  })
  .meta({ id: "PlandaySyncRun" });
export type PlandaySyncRun = z.infer<typeof plandaySyncRunSchema>;

/** `GET /api/integrations/planday/runs` */
export const plandayRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PLANDAY_RUNS_LIST_MAX).default(20),
});
export type PlandayRunsQuery = z.infer<typeof plandayRunsQuerySchema>;

export const listPlandayRunsResponseSchema = z
  .object({ runs: z.array(plandaySyncRunSchema).max(PLANDAY_RUNS_LIST_MAX) })
  .meta({ id: "ListPlandayRunsResponse" });
export type ListPlandayRunsResponse = z.infer<typeof listPlandayRunsResponseSchema>;

export const plandayRunParamsSchema = z.object({ runId: uuidSchema }).strict();
export type PlandayRunParams = z.infer<typeof plandayRunParamsSchema>;

/** The connection's one-slot "next run" queue: a request made while another run was active. */
export const plandayPendingRunSchema = z
  .object({
    kind: integrationSyncRunKindSchema,
    trigger: integrationSyncTriggerSchema,
    requestedAt: instantSchema,
  })
  .meta({ id: "PlandayPendingRun" });

// ── Connection ──────────────────────────────────────────────────────────────

/** A Planday connection as the dashboard sees it: never a token, App ID or code. */
export const plandayConnectionSummarySchema = z
  .object({
    status: integrationConnectionStatusSchema,
    statusChangedAt: instantSchema,
    authMethod: integrationAuthMethodSchema.nullable(),
    /** Made against Mock Planday ("Mock Planday" badge); refused in live mode. */
    isMock: z.boolean(),
    /** Null until a connect proof read the portal. */
    portal: z
      .object({
        /** Planday portal id (decimal string). */
        id: z.string(),
        name: z.string().nullable(),
        /** IANA time zone of the portal. */
        timezone: z.string().nullable(),
      })
      .nullable(),
    /** Last four characters of the refresh token, shown as "ending ••••4f2a". */
    credentialHint: z.string().max(4).nullable(),
    scopesGranted: z.array(z.string()),
    connectedAt: nullableInstantSchema,
    disconnectedAt: nullableInstantSchema,
    lastSuccessfulSyncAt: nullableInstantSchema,
    /** Next quarter-hour slot, or when the recovery run is due after a failure. */
    nextSyncAt: nullableInstantSchema,
    consecutiveFailureCount: z.int().min(0),
    lastErrorCode: z.string().nullable(),
    /** Sanitised (ClockOff's own message table), at most 300 characters. */
    lastErrorMessage: z.string().nullable(),
  })
  .meta({ id: "PlandayConnectionSummary" });
export type PlandayConnectionSummary = z.infer<typeof plandayConnectionSummarySchema>;

/** `GET /api/integrations/planday` — the Integrations page card (§10.1). */
export const plandayIntegrationDetailSchema = z
  .object({
    /** The generic list item (coarse status, activation mode, `paused`). */
    integration: integrationSchema,
    /** Null until a connection was attempted. */
    connection: plandayConnectionSummarySchema.nullable(),
    isMock: z.boolean(),
    clockModeEnabled: z.boolean(),
    /** Wizard Finish; before it only the wizard's runs exist and "Set up Planday" is shown. */
    onboardingCompletedAt: nullableInstantSchema,
    /** The active setup session's current step, while setup is in progress. */
    onboardingStep: integrationWizardStepSchema.nullable(),
    activeRun: plandaySyncRunSchema.nullable(),
    pendingRun: plandayPendingRunSchema.nullable(),
    /** The last run that finished (succeeded, partial or failed): the card's "Last sync" summary. */
    lastFinishedRun: plandaySyncRunSchema.nullable(),
    /** Last manual "Sync now" request, for the 60-second cooldown. */
    lastManualSyncAt: nullableInstantSchema,
    pendingEmployees: z.object({
      total: z.int().min(0),
      /** Of which MISSING_IN_PLANDAY ("can no longer be found"). */
      missingInPlanday: z.int().min(0),
    }),
  })
  .meta({ id: "PlandayIntegrationDetail" });
export type PlandayIntegrationDetail = z.infer<typeof plandayIntegrationDetailSchema>;

// ── Connect (§5) ────────────────────────────────────────────────────────────

/** `GET /api/integrations/planday/connect-methods` (§5.1). */
export const plandayConnectMethodsResponseSchema = z
  .object({
    methods: z.array(z.object({ method: integrationAuthMethodSchema, available: z.boolean() })),
    /** A when available, else B, else C. */
    recommended: integrationAuthMethodSchema,
    isMock: z.boolean(),
    clockModeEnabled: z.boolean(),
    /** Planday scopes ClockOff needs (method C's instructions list them). */
    requiredScopes: z.array(z.string()),
    /** ClockOff's App ID for method B (not a secret); null unless B is available. */
    clockOffAppId: z.string().nullable(),
  })
  .meta({ id: "PlandayConnectMethodsResponse" });
export type PlandayConnectMethodsResponse = z.infer<typeof plandayConnectMethodsResponseSchema>;

/** `POST /api/integrations/planday/connect/oauth` (method A). */
export const startPlandayOAuthSchema = z
  .object({
    returnTo: z.enum(PLANDAY_OAUTH_RETURN_TO),
    /** "Use a different portal" confirmed; honoured only while the connection is DISCONNECTED (§5.7). */
    allowPortalSwitch: z.boolean().optional(),
  })
  .strict();
export type StartPlandayOAuthInput = z.infer<typeof startPlandayOAuthSchema>;

export const startPlandayOAuthResponseSchema = z
  .object({ authorizationUrl: z.url() })
  .meta({ id: "StartPlandayOAuthResponse" });
export type StartPlandayOAuthResponse = z.infer<typeof startPlandayOAuthResponseSchema>;

/**
 * `GET /api/integrations/planday/callback` (not in the OpenAPI document). Planday sends `code` and `state`, or
 * `error` (e.g. `access_denied`); unknown parameters are ignored.
 */
export const plandayOAuthCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(500).optional(),
  error: z.string().min(1).max(200).optional(),
});
export type PlandayOAuthCallbackQuery = z.infer<typeof plandayOAuthCallbackQuerySchema>;

/** Pasted values: every whitespace character (spaces, tabs, line breaks) is removed first. */
function pasted<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" ? value.replace(/\s+/g, "") : value),
    schema,
  );
}

/** A Planday refresh token as copied from the Token column: 10–512 printable characters, no spaces. */
export const plandayRefreshTokenSchema = pasted(
  z
    .string()
    .min(10, "That doesn't look like a Planday token")
    .max(512, "That doesn't look like a Planday token")
    .regex(/^[\x21-\x7E]+$/, "That doesn't look like a Planday token"),
);

/** A Planday App ID (a GUID) as copied from the App Id column. */
export const plandayAppIdSchema = pasted(z.guid("That doesn't look like a Planday App ID"));

/** `POST /api/integrations/planday/connect/token` (methods B and C, §5.3, §5.4). */
export const connectPlandayTokenSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("CUSTOMER_ADDED_APP_ID"),
      refreshToken: plandayRefreshTokenSchema,
      allowPortalSwitch: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("CUSTOMER_OWN_APP"),
      appId: plandayAppIdSchema,
      refreshToken: plandayRefreshTokenSchema,
      allowPortalSwitch: z.boolean().optional(),
    })
    .strict(),
]);
export type ConnectPlandayTokenInput = z.infer<typeof connectPlandayTokenSchema>;

/** Connect (token or OAuth callback) result: the connection and the run it queued. */
export const plandayConnectResponseSchema = z
  .object({
    connection: plandayConnectionSummarySchema,
    run: plandaySyncRunSchema.nullable(),
  })
  .meta({ id: "PlandayConnectResponse" });
export type PlandayConnectResponse = z.infer<typeof plandayConnectResponseSchema>;

// ── Sync now (§7.10) ────────────────────────────────────────────────────────

/** `POST /api/integrations/planday/sync`. `retryAuth`: "Try again" from AUTH_ERROR. */
export const plandaySyncRequestSchema = z.object({ retryAuth: z.boolean().optional() }).strict();
export type PlandaySyncRequest = z.infer<typeof plandaySyncRequestSchema>;

export const plandaySyncResponseSchema = z
  .object({
    /** The queued SYNC run, or the run already active. */
    run: plandaySyncRunSchema,
    /** A SYNC run was already queued or running: nothing new was queued. */
    alreadyRunning: z.boolean(),
    /** Another kind of run is active: the SYNC waits in the pending slot and starts after it. */
    followUpQueued: z.boolean(),
  })
  .meta({ id: "PlandaySyncResponse" });
export type PlandaySyncResponse = z.infer<typeof plandaySyncResponseSchema>;

// ── Settings (§10.2) ────────────────────────────────────────────────────────

/** One Planday department as the wizard's step 3 and the settings drawer show it. */
export const plandayDepartmentRowSchema = z
  .object({
    /** Planday department id, or "none" for the "Not in any department" row. */
    externalId: z.string(),
    name: z.string(),
    number: z.string().nullable(),
    employeeCount: z.int().min(0).nullable(),
    /** Found after onboarding and not decided yet. */
    isNew: z.boolean(),
    /** Planday no longer returns it. */
    missing: z.boolean(),
    /** The saved choice; null while undecided. */
    choice: plandayDepartmentChoiceSchema.nullable(),
    /** What the form pre-selects (§6.3). */
    suggestion: plandayDepartmentChoiceSchema,
    /** The ClockOff location or department `choice` points at. */
    target: namedRefSchema.nullable(),
  })
  .meta({ id: "PlandayDepartmentRow" });
export type PlandayDepartmentRow = z.infer<typeof plandayDepartmentRowSchema>;

/** One Planday employee group as the wizard's step 4 and the settings drawer show it. */
export const plandayGroupRowSchema = z
  .object({
    externalId: z.string(),
    name: z.string(),
    /** Employees of the group in the included departments. */
    employeeCount: z.int().min(0).nullable(),
    isNew: z.boolean(),
    missing: z.boolean(),
    choice: plandayGroupChoiceSchema.nullable(),
    suggestion: plandayGroupChoiceSchema,
    /** The ClockOff team `choice` points at. */
    target: namedRefSchema.nullable(),
  })
  .meta({ id: "PlandayGroupRow" });
export type PlandayGroupRow = z.infer<typeof plandayGroupRowSchema>;

/** `GET /api/integrations/planday/settings` */
export const plandaySettingsSchema = z
  .object({
    departments: z.array(plandayDepartmentRowSchema),
    groups: z.array(plandayGroupRowSchema),
    autoIncludeNewEmployees: z.boolean(),
    /** Store Planday's email on employees (D-042); off: used in memory for matching only. */
    importEmails: z.boolean(),
    syncWindowDays: z.int().min(7).max(56),
    activationMode: activationModeSchema,
    /** Skip shifts on days hidden from employees in Planday (off by default, D-040). */
    respectHiddenDays: z.boolean(),
    clockModeEnabled: z.boolean(),
    mappingVersion: z.int().min(1),
  })
  .meta({ id: "PlandaySettings" });
export type PlandaySettings = z.infer<typeof plandaySettingsSchema>;

/** `PATCH /api/integrations/planday/settings` (409 INTEGRATION_ONBOARDING_INCOMPLETE before Finish). */
export const updatePlandaySettingsSchema = z
  .object({
    departments: departmentChoicesSchema.optional(),
    groups: groupChoicesSchema.optional(),
    autoIncludeNewEmployees: z.boolean().optional(),
    importEmails: z.boolean().optional(),
    syncWindowDays: plandaySyncWindowDaysSchema.optional(),
    /** CLOCK_EVENT only while PLANDAY_CLOCK_MODE_ENABLED=true. */
    activationMode: activationModeSchema.optional(),
    respectHiddenDays: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Change at least one setting",
  });
export type UpdatePlandaySettingsInput = z.infer<typeof updatePlandaySettingsSchema>;

export const updatePlandaySettingsResponseSchema = z
  .object({
    settings: plandaySettingsSchema,
    /** The MANUAL SYNC run the change queued (or the active run it waits behind). */
    run: plandaySyncRunSchema.nullable(),
    followUpQueued: z.boolean(),
  })
  .meta({ id: "UpdatePlandaySettingsResponse" });
export type UpdatePlandaySettingsResponse = z.infer<typeof updatePlandaySettingsResponseSchema>;

// ── Pending employees (§10.4) ───────────────────────────────────────────────

/** How a Planday employee was matched to a ClockOff employee (§6.5). */
export const PLANDAY_MATCH_SIGNALS = ["EXTERNAL_ID", "EXTERNAL_ID_RAW", "EMAIL", "NAME"] as const;
export type PlandayMatchSignal = (typeof PLANDAY_MATCH_SIGNALS)[number];
export const plandayMatchSignalSchema = z
  .enum(PLANDAY_MATCH_SIGNALS)
  .meta({ id: "PlandayMatchSignal" });

const plandayDepartmentRefSchema = z
  .object({ externalId: z.string(), name: z.string().nullable() })
  .meta({ id: "PlandayDepartmentRef" });

export const plandayPendingEmployeeSchema = z
  .object({
    id: uuidSchema,
    externalId: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    /** Planday's address while pending; null when it has none (or importEmails is off after onboarding). */
    workEmail: z.string().nullable(),
    hasEmail: z.boolean(),
    reason: pendingExternalEmployeeReasonSchema,
    departments: z.array(plandayDepartmentRefSchema),
    /** The matched / single-candidate / mapped ClockOff employee. */
    matchedEmployee: employeeSummarySchema.nullable(),
    matchSignal: plandayMatchSignalSchema.nullable(),
    /** ClockOff employees sharing the exact full name (ambiguous match). */
    candidates: z.array(employeeSummarySchema),
    firstSeenAt: instantSchema,
    lastSeenAt: instantSchema,
  })
  .meta({ id: "PlandayPendingEmployee" });
export type PlandayPendingEmployee = z.infer<typeof plandayPendingEmployeeSchema>;

/** `GET /api/integrations/planday/pending-employees` */
export const plandayPendingEmployeesQuerySchema = offsetPaginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  reason: pendingExternalEmployeeReasonSchema.optional(),
});
export type PlandayPendingEmployeesQuery = z.infer<typeof plandayPendingEmployeesQuerySchema>;

export const listPlandayPendingEmployeesResponseSchema = offsetPaginatedResponseSchema(
  plandayPendingEmployeeSchema,
)
  .extend({
    /** Every pending row of the integration by reason (whatever the filters). */
    counts: z.array(
      z.object({ reason: pendingExternalEmployeeReasonSchema, count: z.int().min(0) }),
    ),
  })
  .meta({ id: "ListPlandayPendingEmployeesResponse" });
export type ListPlandayPendingEmployeesResponse = z.infer<
  typeof listPlandayPendingEmployeesResponseSchema
>;

export const PLANDAY_PENDING_EMPLOYEE_ACTIONS = [
  "IMPORT",
  "LINK",
  "DISMISS",
  "DEACTIVATE",
  "KEEP",
] as const;
export type PlandayPendingEmployeeAction = (typeof PLANDAY_PENDING_EMPLOYEE_ACTIONS)[number];

/**
 * One decision. LINK needs the ClockOff employee (of this organisation, D-056); DEACTIVATE and KEEP apply to
 * MISSING_IN_PLANDAY rows only (checked by the service).
 */
const plandayPendingResolutionSchema = z.discriminatedUnion("action", [
  z.object({ id: uuidSchema, action: z.literal("IMPORT") }).strict(),
  z.object({ id: uuidSchema, action: z.literal("LINK"), employeeId: uuidSchema }).strict(),
  z.object({ id: uuidSchema, action: z.literal("DISMISS") }).strict(),
  z.object({ id: uuidSchema, action: z.literal("DEACTIVATE") }).strict(),
  z.object({ id: uuidSchema, action: z.literal("KEEP") }).strict(),
]);

/** `POST /api/integrations/planday/pending-employees/resolve` */
export const resolvePlandayPendingEmployeesSchema = z
  .object({
    items: z
      .array(plandayPendingResolutionSchema)
      .min(1)
      .max(200)
      .refine((items) => new Set(items.map((i) => i.id)).size === items.length, {
        message: "Each pending employee appears once",
      }),
  })
  .strict();
export type ResolvePlandayPendingEmployeesInput = z.infer<
  typeof resolvePlandayPendingEmployeesSchema
>;

export const resolvePlandayPendingEmployeesResponseSchema = z
  .object({
    results: z.array(
      z.object({
        id: uuidSchema,
        action: z.enum(PLANDAY_PENDING_EMPLOYEE_ACTIONS),
        ok: z.boolean(),
        /** The imported, linked or deactivated ClockOff employee. */
        employeeId: uuidSchema.nullable(),
        /** Why this item failed (e.g. plan limit, already resolved); the others still applied. */
        errorCode: apiErrorCodeSchema.nullable(),
      }),
    ),
  })
  .meta({ id: "ResolvePlandayPendingEmployeesResponse" });
export type ResolvePlandayPendingEmployeesResponse = z.infer<
  typeof resolvePlandayPendingEmployeesResponseSchema
>;

// ── Connect links (§9.7) ────────────────────────────────────────────────────

export const plandayConnectLinkSchema = z
  .object({
    id: uuidSchema,
    createdBy: actorRefSchema.nullable(),
    /** Sent with an ADMIN invite to someone not yet in the organisation. */
    invited: z.boolean(),
    expiresAt: instantSchema,
    lastUsedAt: nullableInstantSchema,
    useCount: z.int().min(0),
    createdAt: instantSchema,
  })
  .meta({ id: "PlandayConnectLink" });
export type PlandayConnectLink = z.infer<typeof plandayConnectLinkSchema>;

/** `GET /api/integrations/planday/connect-links` — active (unexpired, unrevoked) links. */
export const listPlandayConnectLinksResponseSchema = z
  .object({ links: z.array(plandayConnectLinkSchema).max(PLANDAY_MAX_ACTIVE_CONNECT_LINKS) })
  .meta({ id: "ListPlandayConnectLinksResponse" });
export type ListPlandayConnectLinksResponse = z.infer<typeof listPlandayConnectLinksResponseSchema>;

/** `POST /api/integrations/planday/connect-links` */
export const createPlandayConnectLinkSchema = z
  .object({
    expiresInHours: z
      .literal(PLANDAY_CONNECT_LINK_EXPIRY_HOURS)
      .default(PLANDAY_CONNECT_LINK_DEFAULT_EXPIRY_HOURS),
    /** The recipient: someone not yet an OWNER/ADMIN gets an ADMIN invite carrying the link. */
    email: emailSchema.optional(),
  })
  .strict();
export type CreatePlandayConnectLinkInput = z.infer<typeof createPlandayConnectLinkSchema>;

/** The link's URL is returned once, here; only its hash is stored. */
export const createPlandayConnectLinkResponseSchema = z
  .object({
    id: uuidSchema,
    url: z.url(),
    expiresAt: instantSchema,
    invited: z.boolean(),
  })
  .meta({ id: "CreatePlandayConnectLinkResponse" });
export type CreatePlandayConnectLinkResponse = z.infer<
  typeof createPlandayConnectLinkResponseSchema
>;

export const plandayConnectLinkParamsSchema = z.object({ linkId: uuidSchema }).strict();
export type PlandayConnectLinkParams = z.infer<typeof plandayConnectLinkParamsSchema>;

/** `POST /api/integrations/planday/connect-links/resolve` (signed-in user; generic NOT_FOUND otherwise). */
export const resolvePlandayConnectLinkSchema = z
  .object({ token: z.string().trim().min(20).max(200) })
  .strict();
export type ResolvePlandayConnectLinkInput = z.infer<typeof resolvePlandayConnectLinkSchema>;

export const resolvePlandayConnectLinkResponseSchema = z
  .object({ redirectTo: z.string() })
  .meta({ id: "ResolvePlandayConnectLinkResponse" });
export type ResolvePlandayConnectLinkResponse = z.infer<
  typeof resolvePlandayConnectLinkResponseSchema
>;

// ── Setup wizard (§9.3, §9.5) ───────────────────────────────────────────────

/** What each completed step decided, for the stepper and the Finish summary. Null until the step is saved. */
export const plandayStepSummariesSchema = z
  .object({
    locations: z
      .object({
        included: z.int().min(0),
        newLocations: z.int().min(0),
        excluded: z.int().min(0),
      })
      .nullable(),
    teams: z.object({ skipped: z.boolean(), mapped: z.int().min(0) }).nullable(),
    employees: z
      .object({
        selected: z.int().min(0),
        linked: z.int().min(0),
        created: z.int().min(0),
        withoutEmail: z.int().min(0),
      })
      .nullable(),
    shiftPreview: z
      .object({ shifts: z.int().min(0), conflictsToReplace: z.int().min(0) })
      .nullable(),
    policies: z
      .object({ workPolicy: namedRefSchema.nullable(), breakPolicy: namedRefSchema.nullable() })
      .nullable(),
    activation: z.object({ mode: activationModeSchema }).nullable(),
  })
  .meta({ id: "PlandayStepSummaries" });

export const plandayOnboardingSessionSchema = z
  .object({
    id: uuidSchema,
    status: onboardingSessionStatusSchema,
    currentStep: integrationWizardStepSchema,
    completedSteps: z.array(integrationWizardStepSchema),
    isMock: z.boolean(),
    connection: plandayConnectionSummarySchema.nullable(),
    runs: z.object({
      structure: plandaySyncRunSchema.nullable(),
      directory: plandaySyncRunSchema.nullable(),
      importEmployees: plandaySyncRunSchema.nullable(),
      final: plandaySyncRunSchema.nullable(),
    }),
    stepSummaries: plandayStepSummariesSchema,
    lastActivityAt: instantSchema,
    completedAt: nullableInstantSchema,
    createdAt: instantSchema,
  })
  .meta({ id: "PlandayOnboardingSession" });
export type PlandayOnboardingSession = z.infer<typeof plandayOnboardingSessionSchema>;

/** `GET` / `POST /api/integrations/planday/onboarding` and `…/goto`, `…/confirm-portal`. */
export const plandayOnboardingResponseSchema = z
  .object({ session: plandayOnboardingSessionSchema })
  .meta({ id: "PlandayOnboardingResponse" });
export type PlandayOnboardingResponse = z.infer<typeof plandayOnboardingResponseSchema>;

/** A step save: the session and the run the step queued (if any). */
export const plandayOnboardingStepResponseSchema = z
  .object({
    session: plandayOnboardingSessionSchema,
    run: plandaySyncRunSchema.nullable(),
    /** The run waits behind an active one (FOLLOW_UP_QUEUED, §7.3). */
    followUpQueued: z.boolean(),
  })
  .meta({ id: "PlandayOnboardingStepResponse" });
export type PlandayOnboardingStepResponse = z.infer<typeof plandayOnboardingStepResponseSchema>;

/** `POST /api/integrations/planday/onboarding/goto` — only completed steps or the current one. */
export const plandayOnboardingGotoSchema = z.object({ step: integrationWizardStepSchema }).strict();
export type PlandayOnboardingGotoInput = z.infer<typeof plandayOnboardingGotoSchema>;

/** `GET /api/integrations/planday/onboarding/locations` (step 3). */
export const plandayOnboardingLocationsResponseSchema = z
  .object({
    departments: z.array(plandayDepartmentRowSchema),
    /** The portal's time zone, which new locations inherit. */
    portalTimezone: z.string().nullable(),
  })
  .meta({ id: "PlandayOnboardingLocationsResponse" });
export type PlandayOnboardingLocationsResponse = z.infer<
  typeof plandayOnboardingLocationsResponseSchema
>;

/** `PUT /api/integrations/planday/onboarding/locations` → session + DIRECTORY run. */
export const savePlandayLocationsSchema = z
  .object({ departments: departmentChoicesSchema })
  .strict()
  .refine((body) => body.departments.some((d) => d.target !== "EXCLUDE"), {
    message: "Include at least one department",
    path: ["departments"],
  });
export type SavePlandayLocationsInput = z.infer<typeof savePlandayLocationsSchema>;

/** `GET /api/integrations/planday/onboarding/teams` (step 4). */
export const plandayOnboardingTeamsResponseSchema = z
  .object({ groups: z.array(plandayGroupRowSchema) })
  .meta({ id: "PlandayOnboardingTeamsResponse" });
export type PlandayOnboardingTeamsResponse = z.infer<typeof plandayOnboardingTeamsResponseSchema>;

/** `PUT /api/integrations/planday/onboarding/teams` — `skip: true` maps no group. */
export const savePlandayTeamsSchema = z
  .object({ skip: z.literal(true).optional(), groups: groupChoicesSchema })
  .strict();
export type SavePlandayTeamsInput = z.infer<typeof savePlandayTeamsSchema>;

/** Step 5 table filters. */
export const PLANDAY_ONBOARDING_EMPLOYEE_FLAGS = [
  "ALL",
  "NEW",
  "MATCHED",
  "POSSIBLE_MATCH",
  "AMBIGUOUS",
  "MISSING_EMAIL",
  "SELECTED",
] as const;
export type PlandayOnboardingEmployeeFlag = (typeof PLANDAY_ONBOARDING_EMPLOYEE_FLAGS)[number];

/** `GET /api/integrations/planday/onboarding/employees` */
export const plandayOnboardingEmployeesQuerySchema = offsetPaginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  flag: z.enum(PLANDAY_ONBOARDING_EMPLOYEE_FLAGS).default("ALL"),
});
export type PlandayOnboardingEmployeesQuery = z.infer<typeof plandayOnboardingEmployeesQuerySchema>;

export const plandayOnboardingEmployeeRowSchema = z
  .object({
    externalId: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    workEmail: z.string().nullable(),
    hasEmail: z.boolean(),
    departments: z.array(plandayDepartmentRefSchema),
    /** The ClockOff employee matched by external id or email, or the single weak candidate. */
    matchedEmployee: employeeSummarySchema.nullable(),
    matchSignal: plandayMatchSignalSchema.nullable(),
    candidates: z.array(employeeSummarySchema),
    flags: z.object({
      new: z.boolean(),
      matched: z.boolean(),
      possibleMatch: z.boolean(),
      ambiguous: z.boolean(),
      missingEmail: z.boolean(),
    }),
    selected: z.boolean(),
    resolution: plandayEmployeeResolutionSchema.nullable(),
  })
  .meta({ id: "PlandayOnboardingEmployeeRow" });
export type PlandayOnboardingEmployeeRow = z.infer<typeof plandayOnboardingEmployeeRowSchema>;

export const plandayOnboardingEmployeesResponseSchema = offsetPaginatedResponseSchema(
  plandayOnboardingEmployeeRowSchema,
)
  .extend({
    counts: z.object({
      total: z.int().min(0),
      selected: z.int().min(0),
      new: z.int().min(0),
      matched: z.int().min(0),
      possibleMatch: z.int().min(0),
      ambiguous: z.int().min(0),
      missingEmail: z.int().min(0),
    }),
    selection: plandayEmployeeSelectionSchema,
    autoIncludeNewEmployees: z.boolean(),
    importEmails: z.boolean(),
    /** The plan's employee limit (null: unlimited); a selection above the headroom is refused. */
    employeeLimit: z.int().min(0).nullable(),
  })
  .meta({ id: "PlandayOnboardingEmployeesResponse" });
export type PlandayOnboardingEmployeesResponse = z.infer<
  typeof plandayOnboardingEmployeesResponseSchema
>;

/** `PUT /api/integrations/planday/onboarding/employees` → IMPORT_EMPLOYEES run. */
export const savePlandayEmployeesSchema = z
  .object({
    selection: plandayEmployeeSelectionSchema,
    resolutions: z
      .array(plandayEmployeeResolutionSchema)
      .max(5000)
      .refine(uniqueExternalIds, "Each employee appears once"),
    autoIncludeNewEmployees: z.boolean(),
    importEmails: z.boolean(),
  })
  .strict();
export type SavePlandayEmployeesInput = z.infer<typeof savePlandayEmployeesSchema>;

export const plandayPreviewShiftSchema = z
  .object({
    externalShiftId: z.string(),
    /** The ClockOff employee once imported, else null (name from Planday). */
    employeeId: uuidSchema.nullable(),
    employeeName: z.string(),
    location: namedRefSchema.nullable(),
    startsAt: instantSchema,
    endsAt: instantSchema,
    timezone: z.string(),
    localDate: localDateSchema,
    localStartTime: localTimeSchema,
    localEndTime: localTimeSchema,
    isOvernight: z.boolean(),
    /** DST note, e.g. AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE. */
    timeWarning: z.string().nullable(),
  })
  .meta({ id: "PlandayPreviewShift" });
export type PlandayPreviewShift = z.infer<typeof plandayPreviewShiftSchema>;

/** `GET /api/integrations/planday/onboarding/shift-preview` (step 6: the next 14 days). */
export const plandayShiftPreviewResponseSchema = z
  .object({
    /** The DIRECTORY run that produced the preview (its age is shown with "Refresh"). */
    run: plandaySyncRunSchema.nullable(),
    generatedAt: nullableInstantSchema,
    /** The organisation's time zone (days are grouped in it). */
    timezone: z.string(),
    days: z.array(
      z.object({
        date: localDateSchema,
        count: z.int().min(0),
        shifts: z.array(plandayPreviewShiftSchema),
      }),
    ),
    /** Existing manual / CSV shifts of the same employee overlapping a Planday shift. */
    conflicts: z.array(
      z.object({
        externalShiftId: z.string(),
        shift: shiftSummarySchema,
        employee: employeeSummarySchema,
        /** In progress: listed, never replaced. */
        inProgress: z.boolean(),
        /** Ticked for replacement (the default for a conflict not in progress). */
        replace: z.boolean(),
      }),
    ),
    excluded: z.object({
      drafts: z.int().min(0),
      open: z.int().min(0),
      /** Only counted with respectHiddenDays. */
      hiddenDays: z.int().min(0),
    }),
    /** Three shifts with their Planday local times: "Do these match Planday?". */
    samples: z.array(plandayPreviewShiftSchema).max(3),
    sampleTimesConfirmed: z.boolean(),
  })
  .meta({ id: "PlandayShiftPreviewResponse" });
export type PlandayShiftPreviewResponse = z.infer<typeof plandayShiftPreviewResponseSchema>;

/** `PUT /api/integrations/planday/onboarding/shift-preview` */
export const savePlandayShiftPreviewSchema = z
  .object({
    replaceConflictingShiftIds: uuidListSchema({ max: 5000 }),
    sampleTimesConfirmed: z.boolean(),
  })
  .strict();
export type SavePlandayShiftPreviewInput = z.infer<typeof savePlandayShiftPreviewSchema>;

/** `GET /api/integrations/planday/onboarding/policies` (step 7). */
export const plandayOnboardingPoliciesResponseSchema = z
  .object({
    /** Published Work Policies of the organisation. */
    workPolicies: z.array(namedRefSchema),
    breakPolicies: z.array(namedRefSchema),
    /** Teams mapped from Planday employee groups (optional per-team policies). */
    teams: z.array(namedRefSchema),
    defaults: z.object({
      workPolicy: namedRefSchema.nullable(),
      breakPolicy: namedRefSchema.nullable(),
    }),
    /** The one-click starters, and the policy each already created in this session. */
    starters: z.object({
      work: z.object({ name: z.string(), createdPolicyId: uuidSchema.nullable() }),
      break: z.object({ name: z.string(), createdBreakPolicyId: uuidSchema.nullable() }),
    }),
    teamPolicies: z.array(z.object({ teamId: uuidSchema, policyId: uuidSchema })),
  })
  .meta({ id: "PlandayOnboardingPoliciesResponse" });
export type PlandayOnboardingPoliciesResponse = z.infer<
  typeof plandayOnboardingPoliciesResponseSchema
>;

/** `PUT /api/integrations/planday/onboarding/policies` */
export const savePlandayPoliciesSchema = z
  .object({
    work: policyChoiceSchema,
    break: breakPolicyChoiceSchema,
    teamPolicies: z
      .array(teamPolicySchema)
      .max(500)
      .refine((items) => new Set(items.map((i) => i.teamId)).size === items.length, {
        message: "One policy per team",
      }),
  })
  .strict();
export type SavePlandayPoliciesInput = z.infer<typeof savePlandayPoliciesSchema>;

/** `PUT /api/integrations/planday/onboarding/activation` (CLOCK_EVENT only with the flag). */
export const savePlandayActivationSchema = z
  .object({ activationMode: activationModeSchema })
  .strict();
export type SavePlandayActivationInput = z.infer<typeof savePlandayActivationSchema>;

/** `POST /api/integrations/planday/onboarding/finish` */
export const finishPlandayOnboardingResponseSchema = z
  .object({
    session: plandayOnboardingSessionSchema,
    /** The INITIAL SYNC run. */
    run: plandaySyncRunSchema,
    summary: z.object({
      locations: z.int().min(0),
      teams: z.int().min(0),
      employees: z.int().min(0),
      employeesWithoutEmail: z.int().min(0),
      workPolicy: namedRefSchema.nullable(),
      breakPolicy: namedRefSchema.nullable(),
      activationMode: activationModeSchema,
      conflictsToReplace: z.int().min(0),
    }),
  })
  .meta({ id: "FinishPlandayOnboardingResponse" });
export type FinishPlandayOnboardingResponse = z.infer<typeof finishPlandayOnboardingResponseSchema>;

/** `GET /api/integrations/planday/onboarding/invites` (step 9: invite staff). */
export const plandayOnboardingInvitesResponseSchema = z
  .object({
    /** The ACTIVE company join code (null when revoked and not regenerated). */
    joinCode: z.string().nullable(),
    /** Copyable invite message (company code and App Store link). */
    inviteMessage: z.string(),
    appStoreUrl: z.string(),
    /** Employees sharing a full name: they need personal invite codes to join. */
    duplicateNameGroups: z.array(
      z.object({ name: z.string(), employees: z.array(employeeSummarySchema) }),
    ),
  })
  .meta({ id: "PlandayOnboardingInvitesResponse" });
export type PlandayOnboardingInvitesResponse = z.infer<
  typeof plandayOnboardingInvitesResponseSchema
>;
