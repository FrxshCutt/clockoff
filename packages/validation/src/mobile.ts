import { z } from "zod";
import type { BreakEndReason } from "@clockoff/shared/enums";
import type { DeviceToServerFieldGroupKey } from "@clockoff/shared/privacyStatements";
import { isoDateTimeSchema, nonEmptyString, timezoneSchema, uuidSchema } from "./common";
import { BREAK_POLICY_LIMITS, breakPolicyRulesSchema } from "./breakPolicies";
import { selectionCountsSchema } from "./devices";
import {
  apiErrorCodeSchema,
  breakRestrictionBehaviourSchema,
  deviceReportableEventTypeSchema,
  overrideTypeSchema,
  permissionStateSchema,
  platformSchema,
  restrictionCategorySchema,
  selectionStateSchema,
  shiftStatusSchema,
  workModeStateSchema,
} from "./enumSchemas";
import { breakBehaviourDefaultSchema, restrictionConfigSchema } from "./policies";
import {
  companyCodeSchema,
  emptyBodySchema,
  emptyQuerySchema,
  instantSchema,
  inviteCodeSchema,
  shortCodeSchema,
} from "./primitives";
import { breakAllowanceSchema, breakSessionSchema, expectedStateSchema } from "./workState";

/**
 * Mobile API (`/api/mobile/v1`, §5) consumed by the iOS app.
 *
 * PRIVACY (§12): every request schema here is a STRICT object, at every nesting level, and only carries
 * the operational fields listed in docs/PRIVACY.md (`DEVICE_TO_SERVER_ALLOWED_FIELDS` in
 * @clockoff/shared). Unknown keys — `installedApps`, `contacts`, `location`, `notifications`, `messages`,
 * anything — are rejected with VALIDATION_ERROR rather than silently dropped, so a client bug can never
 * leak data into logs. mobile.test.ts enforces this for every mobile route in the OpenAPI registry.
 *
 * Responses are not strict: the client must ignore fields it does not know (additive evolution).
 */

export const MOBILE_API_PREFIX = "/api/mobile/v1";

export const MOBILE_LIMITS = {
  maxEventsPerBatch: 200,
  pushTokenMaxLength: 512,
  maxScheduleRangeDays: 62,
  /** Default `GET /schedule` window when from/to are omitted: 1 day back, 14 days ahead. */
  defaultScheduleDaysBack: 1,
  defaultScheduleDaysAhead: 14,
  /** Same ceiling as a Break Policy's `maxBreakDurationMinutes`; the policy's own value is enforced by the handler. */
  maxRequestedBreakMinutes: BREAK_POLICY_LIMITS.maxBreakDurationMinutes,
} as const;

/**
 * Privacy class of a field a mobile request may carry: the `DEVICE_TO_SERVER_ALLOWED_FIELDS` group in
 * @clockoff/shared (rendered into docs/PRIVACY.md) that discloses it to employees, or one of the classes
 * that carry no information about the employee or the phone:
 * - `credential`     — authentication material (refresh token);
 * - `serverIssuedId` — an id the server itself handed to the device (employee, shift, break session);
 * - `requestShape`   — a container or a query window (`device`, `metadata`, `from`, `to`).
 */
export type MobileFieldPrivacyClass =
  DeviceToServerFieldGroupKey | "credential" | "serverIssuedId" | "requestShape";

/**
 * EVERY field name a mobile request may contain, at any nesting level, with its privacy class. This is the
 * allow-list mobile.test.ts checks the schemas against: a new request field fails the build until it is
 * classified here — and, when it is information about the employee or the phone, disclosed in
 * `DEVICE_TO_SERVER_ALLOWED_FIELDS` (which regenerates docs/PRIVACY.md).
 */
export const MOBILE_REQUEST_FIELD_PRIVACY = {
  // join
  companyCode: "joinDetails",
  inviteCode: "joinDetails",
  firstName: "joinDetails",
  lastName: "joinDetails",
  employeeId: "serverIssuedId",
  device: "requestShape",
  platform: "deviceModel",
  model: "deviceModel",
  appVersion: "versions",
  osVersion: "versions",
  // auth
  refreshToken: "credential",
  // device state
  permissionState: "permissionState",
  selectionState: "selectionState",
  selectionCounts: "selectionState",
  categories: "selectionState",
  applications: "selectionState",
  webDomains: "selectionState",
  restrictionEngineState: "restrictionEngineState",
  engineState: "restrictionEngineState",
  policyVersionApplied: "syncTimestamps",
  scheduleVersionApplied: "syncTimestamps",
  policyVersion: "syncTimestamps",
  scheduleVersion: "syncTimestamps",
  localTime: "deviceTime",
  timezone: "timezone",
  // events
  events: "events",
  clientEventId: "events",
  type: "events",
  occurredAt: "events",
  metadata: "requestShape",
  /** An UPPER_SNAKE_CASE code (event metadata) or an enumerated break end reason — never free text. */
  reason: "events",
  shiftId: "serverIssuedId",
  breakSessionId: "serverIssuedId",
  // breaks
  clientBreakId: "breaks",
  requestedAt: "breaks",
  requestedDurationMinutes: "breaks",
  endedAt: "breaks",
  // push
  token: "pushToken",
  environment: "pushToken",
  // schedule query window
  from: "requestShape",
  to: "requestShape",
} as const satisfies Readonly<Record<string, MobileFieldPrivacyClass>>;
export type MobileRequestField = keyof typeof MOBILE_REQUEST_FIELD_PRIVACY;

/** Short version strings like `1.2.0` / `17.5.1` / `1.2.0 (45)`. No free text. */
const versionStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[0-9A-Za-z.()\- ]+$/, "Invalid version string");

/** Generic model family only (`iPhone`, `iPad`, `iPhone15,2`) — never a serial number or identifier. */
const deviceModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9 ,.]+$/, "Invalid device model");

const personNameSchema = nonEmptyString(100);

// ── Join ────────────────────────────────────────────────────────────────────

/** `POST /join/lookup` — public, rate limited. Finds the employee record the phone is about to link to. */
export const joinLookupSchema = z
  .object({
    companyCode: companyCodeSchema,
    firstName: personNameSchema,
    lastName: personNameSchema,
    /** Per-employee code from the manager's invite; required when names are ambiguous. */
    inviteCode: inviteCodeSchema.optional(),
  })
  .strict();
export type JoinLookupInput = z.infer<typeof joinLookupSchema>;

export const JOIN_MATCH_RESULTS = ["SINGLE", "NONE", "AMBIGUOUS"] as const;
export type JoinMatchResult = (typeof JOIN_MATCH_RESULTS)[number];
export const joinMatchResultSchema = z.enum(JOIN_MATCH_RESULTS).meta({ id: "JoinMatchResult" });

export const joinLookupResponseSchema = z
  .object({
    organisation: z.object({ name: z.string() }),
    /** AMBIGUOUS → ask for the invite code and look up again. NONE → ask the manager to add/invite you. */
    match: joinMatchResultSchema,
    /** Present only when match is SINGLE. */
    employeePreview: z
      .object({
        id: uuidSchema,
        firstName: z.string(),
        lastName: z.string(),
        jobTitle: z.string().nullable(),
        locationName: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: "JoinLookupResponse" });
export type JoinLookupResponse = z.infer<typeof joinLookupResponseSchema>;

export const mobileDeviceInfoSchema = z
  .object({
    platform: platformSchema,
    appVersion: versionStringSchema,
    osVersion: versionStringSchema,
    /** Stored as Device.deviceModel ("Generic device model" in PRIVACY.md). */
    model: deviceModelSchema,
  })
  .strict()
  .meta({ id: "MobileDeviceInfo" });
export type MobileDeviceInfo = z.infer<typeof mobileDeviceInfoSchema>;

/** `POST /join/confirm` — links this phone to the employee and issues tokens. Re-checks the lookup inputs. */
export const joinConfirmSchema = z
  .object({
    companyCode: companyCodeSchema,
    employeeId: uuidSchema,
    firstName: personNameSchema,
    lastName: personNameSchema,
    inviteCode: inviteCodeSchema.optional(),
    device: mobileDeviceInfoSchema,
  })
  .strict();
export type JoinConfirmInput = z.infer<typeof joinConfirmSchema>;

export const mobileTokensSchema = z
  .object({
    /** HS256 JWT, ~15 minutes. Send as `Authorization: Bearer <token>`. */
    accessToken: z.string(),
    /** Opaque, single-use: every refresh returns a new one. Reusing a rotated token revokes the device's session. */
    refreshToken: z.string(),
    accessTokenExpiresAt: instantSchema,
    refreshTokenExpiresAt: instantSchema,
  })
  .meta({ id: "MobileTokens" });
export type MobileTokens = z.infer<typeof mobileTokensSchema>;

export const mobileEmployeeSchema = z
  .object({
    id: uuidSchema,
    firstName: z.string(),
    lastName: z.string(),
    jobTitle: z.string().nullable(),
    primaryLocation: z
      .object({ id: uuidSchema, name: z.string(), timezone: z.string().nullable() })
      .nullable(),
  })
  .meta({ id: "MobileEmployee" });
export type MobileEmployee = z.infer<typeof mobileEmployeeSchema>;

export const mobileOrganisationSchema = z
  .object({ id: uuidSchema, name: z.string(), timezone: z.string() })
  .meta({ id: "MobileOrganisation" });
export type MobileOrganisation = z.infer<typeof mobileOrganisationSchema>;

export const joinConfirmResponseSchema = mobileTokensSchema
  .extend({
    deviceId: uuidSchema,
    employee: mobileEmployeeSchema,
    organisation: mobileOrganisationSchema,
  })
  .meta({ id: "JoinConfirmResponse" });
export type JoinConfirmResponse = z.infer<typeof joinConfirmResponseSchema>;

// ── Auth ────────────────────────────────────────────────────────────────────

const refreshTokenSchema = z.string().min(20).max(512);

/** `POST /auth/refresh` — public (the refresh token is the credential). */
export const mobileRefreshSchema = z.object({ refreshToken: refreshTokenSchema }).strict();
export type MobileRefreshInput = z.infer<typeof mobileRefreshSchema>;
export const mobileRefreshResponseSchema = mobileTokensSchema;
export type MobileRefreshResponse = MobileTokens;

/** `POST /auth/logout` — revokes the device's refresh-token family (the device stays linked). */
export const mobileLogoutSchema = z
  .object({ refreshToken: refreshTokenSchema.optional() })
  .strict();
export type MobileLogoutInput = z.infer<typeof mobileLogoutSchema>;

/** `POST /leave-workplace` — unlinks the employee, deactivates this device and deletes its push token. */
export const leaveWorkplaceSchema = emptyBodySchema;
export type LeaveWorkplaceInput = z.infer<typeof leaveWorkplaceSchema>;

// ── Policy & schedule payloads ──────────────────────────────────────────────

export const mobileResolvedPolicySchema = z
  .object({
    policy: z.object({ id: uuidSchema, name: z.string() }),
    version: z.object({ id: uuidSchema, versionNumber: z.int().min(1) }),
    restrictionConfig: restrictionConfigSchema,
    /** Break behaviour of this version, applied when no Break Policy resolves (`PolicyVersion.breakBehaviourDefault`). */
    breakBehaviourDefault: breakBehaviourDefaultSchema.optional(),
  })
  .meta({ id: "MobileResolvedPolicy" });
export type MobileResolvedPolicy = z.infer<typeof mobileResolvedPolicySchema>;

export const mobileBreakPolicySchema = z
  .object({ id: uuidSchema, name: z.string(), rules: breakPolicyRulesSchema })
  .meta({ id: "MobileBreakPolicy" });
export type MobileBreakPolicy = z.infer<typeof mobileBreakPolicySchema>;

export const mobileScheduledBreakSchema = z
  .object({
    id: uuidSchema,
    offsetMinutesFromStart: z.int().min(0),
    durationMinutes: z.int().min(1),
    startsAt: instantSchema,
    endsAt: instantSchema,
  })
  .meta({ id: "MobileScheduledBreak" });

export const mobileShiftSchema = z
  .object({
    id: uuidSchema,
    startsAt: instantSchema,
    endsAt: instantSchema,
    timezone: z.string(),
    status: shiftStatusSchema,
    location: z.object({ id: uuidSchema, name: z.string() }).nullable(),
    notes: z.string().nullable(),
    /** Per-shift version; changes whenever the shift is edited. */
    version: z.int().min(1),
    scheduledBreaks: z.array(mobileScheduledBreakSchema),
  })
  .meta({ id: "MobileShift" });
export type MobileShift = z.infer<typeof mobileShiftSchema>;

/**
 * Policy version token: the id of the PolicyVersion in force (null when no published policy resolves).
 * The device echoes it back in `/device/state` and events once applied.
 */
const policyVersionTokenSchema = uuidSchema.nullable();
/** Monotonic per-employee schedule version; bumps whenever any of the employee's shifts change. */
const scheduleVersionSchema = z.int().min(0);

/** `GET /me` */
export const mobileMeResponseSchema = z
  .object({
    employee: mobileEmployeeSchema,
    organisation: mobileOrganisationSchema,
    deviceId: uuidSchema,
    resolvedPolicy: mobileResolvedPolicySchema.nullable(),
    resolvedBreakPolicy: mobileBreakPolicySchema.nullable(),
    policyVersion: policyVersionTokenSchema,
    scheduleVersion: scheduleVersionSchema,
  })
  .meta({ id: "MobileMeResponse" });
export type MobileMeResponse = z.infer<typeof mobileMeResponseSchema>;

/** `GET /schedule?from&to` — defaults to [now − 1 day, now + 14 days]; at most 62 days. */
export const mobileScheduleQuerySchema = z
  .object({
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.from !== undefined && v.to !== undefined) {
      const span = Date.parse(v.to) - Date.parse(v.from);
      if (span <= 0)
        ctx.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
      else if (span > MOBILE_LIMITS.maxScheduleRangeDays * 86_400_000) {
        ctx.addIssue({
          code: "custom",
          path: ["to"],
          message: `Range may not exceed ${MOBILE_LIMITS.maxScheduleRangeDays} days`,
        });
      }
    }
  });
export type MobileScheduleQuery = z.infer<typeof mobileScheduleQuerySchema>;

export const mobileScheduleResponseSchema = z
  .object({
    from: instantSchema,
    to: instantSchema,
    shifts: z.array(mobileShiftSchema),
    scheduleVersion: scheduleVersionSchema,
    serverTime: instantSchema,
  })
  .meta({ id: "MobileScheduleResponse" });
export type MobileScheduleResponse = z.infer<typeof mobileScheduleResponseSchema>;

// ── Sync ────────────────────────────────────────────────────────────────────

export const mobileBreakBehaviourSchema = z
  .object({
    restrictionBehaviour: breakRestrictionBehaviourSchema,
    relaxedCategories: z.array(restrictionCategorySchema),
  })
  .meta({ id: "MobileBreakBehaviour" });

export const mobileActiveOverrideSchema = z
  .object({
    id: uuidSchema,
    type: overrideTypeSchema,
    startsAt: instantSchema,
    expiresAt: instantSchema,
    /** Relaxation applied while a TEMPORARY_EXCEPTION is active; null for other types. */
    breakBehaviour: mobileBreakBehaviourSchema.nullable(),
  })
  .meta({ id: "MobileActiveOverride" });
export type MobileActiveOverride = z.infer<typeof mobileActiveOverrideSchema>;

/** `GET /sync` takes no query parameters. */
export const mobileSyncQuerySchema = emptyQuerySchema;

/** `GET /sync` — everything the device needs to schedule DeviceActivity intervals offline. */
export const mobileSyncResponseSchema = z
  .object({
    policy: mobileResolvedPolicySchema.nullable(),
    breakPolicy: mobileBreakPolicySchema.nullable(),
    /** Shifts from 1 day ago to 14 days ahead. */
    shifts: z.array(mobileShiftSchema),
    policyVersion: policyVersionTokenSchema,
    scheduleVersion: scheduleVersionSchema,
    serverTime: instantSchema,
    activeOverrides: z.array(mobileActiveOverrideSchema),
    expectedState: expectedStateSchema,
    activeBreakSession: breakSessionSchema.nullable(),
    /** Allowance for the current (or next) shift; null when there is none. */
    breakAllowance: breakAllowanceSchema.nullable(),
  })
  .meta({ id: "MobileSyncResponse" });
export type MobileSyncResponse = z.infer<typeof mobileSyncResponseSchema>;

// ── Device state ────────────────────────────────────────────────────────────

/** `POST /device/state` — the periodic compliance check-in. */
export const deviceStateReportSchema = z
  .object({
    permissionState: permissionStateSchema,
    selectionState: selectionStateSchema,
    selectionCounts: selectionCountsSchema.optional(),
    restrictionEngineState: workModeStateSchema,
    appVersion: versionStringSchema,
    osVersion: versionStringSchema,
    /** PolicyVersion id the device has applied. */
    policyVersionApplied: uuidSchema.optional(),
    scheduleVersionApplied: scheduleVersionSchema.optional(),
    /** Device clock at send time; the server stores only the skew in seconds. */
    localTime: isoDateTimeSchema,
    timezone: timezoneSchema,
  })
  .strict();
export type DeviceStateReportInput = z.infer<typeof deviceStateReportSchema>;

export const deviceStateResponseSchema = z
  .object({
    ok: z.literal(true),
    serverTime: instantSchema,
    /** device − server, whole seconds (positive = device clock ahead). */
    clockSkewSeconds: z.int(),
    expectedState: expectedStateSchema,
    /** True when |clockSkewSeconds| exceeds the attention threshold (300 s); the app should ask the employee to enable "Set Automatically". */
    clockSkewExceeded: z.boolean().optional(),
  })
  .meta({ id: "DeviceStateResponse" });
export type DeviceStateResponse = z.infer<typeof deviceStateResponseSchema>;

// ── Events ──────────────────────────────────────────────────────────────────

/** Strict allow-list of event metadata. No free text: `reason` is an UPPER_SNAKE_CASE code. */
export const deviceEventMetadataSchema = z
  .object({
    shiftId: uuidSchema.optional(),
    breakSessionId: uuidSchema.optional(),
    clientBreakId: uuidSchema.optional(),
    policyVersion: uuidSchema.optional(),
    scheduleVersion: scheduleVersionSchema.optional(),
    /** Machine-readable reason, e.g. `INTERVAL_ENDED`, `PERMISSION_REVOKED` (max 64 chars). */
    reason: shortCodeSchema.optional(),
    engineState: workModeStateSchema.optional(),
    permissionState: permissionStateSchema.optional(),
    selectionCounts: selectionCountsSchema.optional(),
  })
  .strict()
  .meta({ id: "DeviceEventMetadata" });
export type DeviceEventMetadata = z.infer<typeof deviceEventMetadataSchema>;

export const deviceEventSchema = z
  .object({
    /** Device-generated idempotency key; re-sending the same id is counted as a duplicate. */
    clientEventId: uuidSchema,
    type: deviceReportableEventTypeSchema,
    occurredAt: isoDateTimeSchema,
    metadata: deviceEventMetadataSchema.optional(),
  })
  .strict()
  .meta({ id: "DeviceEvent" });
export type DeviceEventInput = z.infer<typeof deviceEventSchema>;

/** `POST /events` — outbox flush, at most 200 events per request. */
export const deviceEventsSchema = z
  .object({
    events: z.array(deviceEventSchema).min(1).max(MOBILE_LIMITS.maxEventsPerBatch),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.events.forEach((event, index) => {
      const key = event.clientEventId.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "clientEventId"],
          message: "Duplicate clientEventId in batch",
        });
      }
      seen.add(key);
    });
  });
export type DeviceEventsInput = z.infer<typeof deviceEventsSchema>;

export const deviceEventsResponseSchema = z
  .object({
    accepted: z.int().min(0),
    duplicates: z.int().min(0),
    /** Events refused individually (e.g. shiftId of another employee, occurredAt in the future). */
    rejected: z.array(z.object({ clientEventId: uuidSchema, code: apiErrorCodeSchema })),
  })
  .meta({ id: "DeviceEventsResponse" });
export type DeviceEventsResponse = z.infer<typeof deviceEventsResponseSchema>;

// ── Breaks ──────────────────────────────────────────────────────────────────

/** `POST /breaks/start` — idempotent on `clientBreakId` (a retry returns the same session). */
export const mobileStartBreakSchema = z
  .object({
    clientBreakId: uuidSchema,
    shiftId: uuidSchema,
    /**
     * Device time of the tap. The break starts at `min(receivedAt, requestedAt − device skew)` on the SERVER
     * clock (`breakStartInstant`, docs/BREAK_RULES.md): online that is the receive time minus latency; for a
     * break started offline it is the moment the employee tapped, so the rules are evaluated and the break
     * counted where it really happened. It is never later than the receive time.
     */
    requestedAt: isoDateTimeSchema,
    /** Defaults to the policy's maxBreakDurationMinutes. */
    requestedDurationMinutes: z.int().min(1).max(MOBILE_LIMITS.maxRequestedBreakMinutes).optional(),
  })
  .strict();
export type MobileStartBreakInput = z.infer<typeof mobileStartBreakSchema>;

/** End reasons a device may report (MANAGER_ENDED / POLICY_CHANGED are server-side only). */
export const MOBILE_BREAK_END_REASONS = [
  "EMPLOYEE_ENDED",
  "EXPIRED",
  "SHIFT_ENDED",
] as const satisfies readonly BreakEndReason[];
export type MobileBreakEndReason = (typeof MOBILE_BREAK_END_REASONS)[number];

/** `POST /breaks/:id/end` — idempotent: ending an already-ended break returns it unchanged. */
export const mobileEndBreakSchema = z
  .object({
    endedAt: isoDateTimeSchema,
    reason: z.enum(MOBILE_BREAK_END_REASONS),
  })
  .strict();
export type MobileEndBreakInput = z.infer<typeof mobileEndBreakSchema>;

export const mobileBreakResponseSchema = z
  .object({ breakSession: breakSessionSchema, allowance: breakAllowanceSchema })
  .meta({ id: "MobileBreakResponse" });
export type MobileBreakResponse = z.infer<typeof mobileBreakResponseSchema>;

// ── Push token ──────────────────────────────────────────────────────────────

export const APNS_ENVIRONMENTS = ["sandbox", "production"] as const;
export type ApnsEnvironment = (typeof APNS_ENVIRONMENTS)[number];

/** `POST /device/push-token` — hex-encoded APNs device token; encrypted at rest, used only to trigger sync. */
export const pushTokenSchema = z
  .object({
    token: z
      .string()
      .trim()
      .min(32)
      .max(MOBILE_LIMITS.pushTokenMaxLength)
      .regex(/^[0-9a-fA-F]+$/, "Push token must be hex-encoded"),
    environment: z.enum(APNS_ENVIRONMENTS),
  })
  .strict();
export type PushTokenInput = z.infer<typeof pushTokenSchema>;

/** `:id` of `POST /breaks/:id/end` (the server BreakSession id). */
export const mobileBreakParamsSchema = z.object({ id: uuidSchema }).strict();
