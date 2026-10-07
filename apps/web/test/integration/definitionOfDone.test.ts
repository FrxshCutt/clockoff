import { randomUUID } from "node:crypto";
import { prisma } from "@clockoff/db";
import { localDateOf, localToInstant } from "@clockoff/shared/time/zone";
import { listActivityResponseSchema, type ActivityEvent } from "@clockoff/validation/activity";
import { breakPolicyResponseSchema } from "@clockoff/validation/breakPolicies";
import {
  complianceEmployeesResponseSchema,
  complianceSummaryResponseSchema,
  type ComplianceEmployeeRow,
} from "@clockoff/validation/compliance";
import { deviceResponseSchema } from "@clockoff/validation/devices";
import {
  employeeDetailResponseSchema,
  employeeResponseSchema,
  listEmployeesResponseSchema,
  type EmployeeDetail,
} from "@clockoff/validation/employees";
import { createEmployeeInviteResponseSchema } from "@clockoff/validation/invites";
import {
  deviceEventsResponseSchema,
  deviceStateResponseSchema,
  joinConfirmResponseSchema,
  joinLookupResponseSchema,
  mobileBreakResponseSchema,
  mobileSyncResponseSchema,
  mobileTokensSchema,
  type MobileSyncResponse,
  type MobileTokens,
} from "@clockoff/validation/mobile";
import {
  joinCodeResponseSchema,
  onboardingResponseSchema,
  ONBOARDING_STEP_KEYS,
  type OnboardingResponse,
} from "@clockoff/validation/organisation";
import { policyResponseSchema } from "@clockoff/validation/policies";
import { createShiftResponseSchema } from "@clockoff/validation/shifts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { GET as activityRoute } from "@/app/api/activity/route";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { POST as verifyEmailRoute } from "@/app/api/auth/verify-email/route";
import { POST as createBreakPolicyRoute } from "@/app/api/break-policies/route";
import { GET as complianceEmployeesRoute } from "@/app/api/compliance/employees/route";
import { GET as complianceSummaryRoute } from "@/app/api/compliance/summary/route";
import { GET as deviceRoute } from "@/app/api/devices/[id]/route";
import { GET as employeeActivityRoute } from "@/app/api/employees/[id]/activity/route";
import { POST as createInviteRoute } from "@/app/api/employees/[id]/invites/route";
import { GET as employeeRoute } from "@/app/api/employees/[id]/route";
import { GET as listEmployeesRoute, POST as createEmployeeRoute } from "@/app/api/employees/route";
import { POST as tickRoute } from "@/app/api/jobs/tick/route";
import { POST as refreshRoute } from "@/app/api/mobile/v1/auth/refresh/route";
import { POST as startBreakRoute } from "@/app/api/mobile/v1/breaks/start/route";
import { POST as pushTokenRoute } from "@/app/api/mobile/v1/device/push-token/route";
import { POST as deviceStateRoute } from "@/app/api/mobile/v1/device/state/route";
import { POST as eventsRoute } from "@/app/api/mobile/v1/events/route";
import { POST as joinConfirmRoute } from "@/app/api/mobile/v1/join/confirm/route";
import { POST as joinLookupRoute } from "@/app/api/mobile/v1/join/lookup/route";
import { GET as syncRoute } from "@/app/api/mobile/v1/sync/route";
import { POST as defaultBreakPolicyRoute } from "@/app/api/organisations/current/default-break-policy/route";
import { POST as defaultPolicyRoute } from "@/app/api/organisations/current/default-policy/route";
import { GET as joinCodeRoute } from "@/app/api/organisations/current/join-code/route";
import { GET as onboardingRoute } from "@/app/api/organisations/current/onboarding/route";
import { POST as createOrganisationRoute } from "@/app/api/organisations/route";
import { POST as publishPolicyRoute } from "@/app/api/policies/[id]/publish/route";
import { POST as createPolicyRoute } from "@/app/api/policies/route";
import { POST as createShiftRoute } from "@/app/api/shifts/route";
import { ORG_COOKIE } from "@/lib/cookies";
import { env } from "@/lib/env";
import { resetPushBridgeForTesting } from "@/server/realtime/pushBridge";
import { runWorkModeTick } from "@/server/workState/workStateJob";
import {
  CookieJar,
  callRoute,
  createTestOrg,
  lastEmailToken,
  loginAs,
  uniqueEmail,
  type ErrorBody,
} from "../helpers";

/**
 * The product's Definition of Done, walked end to end at the API level against the real route handlers and
 * the real Work Mode server job: a manager signs up and sets up "Harpenden Coffee Co.", an employee joins
 * from the iOS app, Work Mode runs through a shift with a break that expires while the app is closed, the
 * shift ends, and the tenant-isolation and privacy guarantees hold on the way.
 *
 * One `describe`, sequential `it`s sharing state (vitest runs them in order and a failed step fails the
 * ones after it, which is what a journey wants).
 *
 * CLOCK. The mobile and manager endpoints read the real clock (`new Date()` inside the services, no
 * seam at the route level) while `runWorkModeTick(now)` takes `now`. Steps 1–8 therefore run on the real
 * clock with a shift that is in progress right now (started 30 min ago, ends in 5 h). Steps 9–10 need the
 * server to be *later* (break expiry at plannedEndsAt + 1 min, shift end + 1 min): running only the job
 * at a future `now` and then calling the device / manager endpoints on the real clock would make the server
 * travel back in time (the employee would be "on break" again for the device, "working" again for the
 * manager), which can never happen in production. So from step 9 on the test moves the process clock
 * forward with `vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true })` + `vi.setSystemTime`:
 * only `Date` is faked (timers, Prisma and the pg pool keep real timers), time keeps flowing, and the job,
 * the device and the dashboard all agree on "now". Postgres-side `now()` is not used by any code path here.
 * The access token issued before the jump has expired by then, so the "phone" refreshes it exactly like
 * the app does after waking up.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ORG_NAME = "Harpenden Coffee Co.";
const TIMEZONE = "Europe/London";
const CATEGORIES = ["SOCIAL_MEDIA", "GAMES", "ENTERTAINMENT"] as const;
const DEVICE_INFO = {
  platform: "IOS",
  appVersion: "1.0.0 (1)",
  osVersion: "17.5.1",
  model: "iPhone15,2",
} as const;
const SELECTION_COUNTS = { categories: 3, applications: 0, webDomains: 0 } as const;
/** Fields a phone must never be able to send (§12) — each is rejected, never silently dropped. */
const FORBIDDEN_DEVICE_FIELDS = {
  installedApps: ["com.example.social"],
  appUsage: [{ app: "com.example.social", minutes: 42 }],
  messages: ["hello"],
  notificationContents: ["New message from Sam"],
  browsingHistory: ["https://example.com"],
} as const;
/** Keys a manager-facing employee / device payload must not carry (§12)… */
const PRIVATE_KEY_PATTERN = /token|app(lication)?s?Selected|bundle|usage|message|photo|browsing/i;
/** …except `hasPushToken`: a boolean "a push token is registered", never the token itself. */
const ALLOWED_PRIVATE_LOOKING_KEYS = new Set(["hasPushToken"]);

// ── Shared journey state ─────────────────────────────────────────────────────

interface Journey {
  managerEmail: string;
  jar: CookieJar;
  organisationId: string;
  companyCode: string;
  employeeId: string;
  policyId: string;
  policyVersionId: string;
  breakPolicyId: string;
  shift: { id: string; startsAt: Date; endsAt: Date };
  /** Today's 09:00–15:00 Europe/London shift, when it does not collide with the in-progress one. */
  todayShiftId: string | null;
  inviteId: string;
  deviceId: string;
  tokens: MobileTokens;
  breakSession: { id: string; clientBreakId: string; startedAt: Date; plannedEndsAt: Date };
  /** Versions the "app" applied from its last GET /sync (echoed in /device/state like the iOS report builder). */
  applied: { policyVersion: string; scheduleVersion: number } | null;
}

const j = {} as Journey;

// ── Helpers ──────────────────────────────────────────────────────────────────

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${j.tokens.accessToken}` };
}

/** Move the process clock (Date only) to `instant`; it keeps flowing from there. See CLOCK above. */
function travelTo(instant: Date): void {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(instant);
}

afterAll(() => {
  vi.useRealTimers();
  resetPushBridgeForTesting();
});

async function managerGet<T>(
  handler: Parameters<typeof callRoute>[0],
  path: string,
  options: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    jar?: CookieJar;
  } = {},
) {
  return callRoute<T>(handler, {
    path,
    jar: options.jar ?? j.jar,
    ...(options.params ? { params: options.params } : {}),
    ...(options.query ? { query: options.query } : {}),
  });
}

async function managerPost<T>(
  handler: Parameters<typeof callRoute>[0],
  path: string,
  body: unknown,
  params?: Record<string, string>,
) {
  return callRoute<T>(handler, {
    method: "POST",
    path,
    jar: j.jar,
    body,
    ...(params ? { params } : {}),
  });
}

async function employeeDetail(jar: CookieJar = j.jar): Promise<EmployeeDetail> {
  const res = await managerGet(employeeRoute, `/api/employees/${j.employeeId}`, {
    params: { id: j.employeeId },
    jar,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return employeeDetailResponseSchema.parse(res.body).employee;
}

async function complianceRow(): Promise<ComplianceEmployeeRow> {
  const res = await managerGet(complianceEmployeesRoute, "/api/compliance/employees", {
    query: { filter: "ALL" },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const rows = complianceEmployeesResponseSchema.parse(res.body).items;
  const row = rows.find((r) => r.employee.id === j.employeeId);
  expect(row, "Zach is on the compliance list").toBeDefined();
  return row!;
}

async function activityOfType(type: string): Promise<ActivityEvent[]> {
  const res = await managerGet(activityRoute, "/api/activity", {
    query: { employeeId: j.employeeId, type, limit: "200" },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return listActivityResponseSchema.parse(res.body).items;
}

async function onboarding(): Promise<OnboardingResponse> {
  const res = await managerGet(onboardingRoute, "/api/organisations/current/onboarding");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return onboardingResponseSchema.parse(res.body);
}

function stepDone(o: OnboardingResponse, key: (typeof ONBOARDING_STEP_KEYS)[number]): boolean {
  return o.items.find((i) => i.key === key)?.done ?? false;
}

function deviceReport(overrides: Record<string, unknown> = {}) {
  return {
    permissionState: "APPROVED",
    selectionState: "CONFIGURED",
    selectionCounts: SELECTION_COUNTS,
    restrictionEngineState: "UNKNOWN",
    appVersion: "1.0.0",
    osVersion: "17.5.1",
    ...(j.applied
      ? {
          policyVersionApplied: j.applied.policyVersion,
          scheduleVersionApplied: j.applied.scheduleVersion,
        }
      : {}),
    localTime: new Date().toISOString(),
    timezone: TIMEZONE,
    ...overrides,
  };
}

async function reportState(engineState: string) {
  const res = await callRoute(deviceStateRoute, {
    method: "POST",
    path: "/api/mobile/v1/device/state",
    headers: bearer(),
    body: deviceReport({ restrictionEngineState: engineState }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return deviceStateResponseSchema.parse(res.body);
}

function deviceEvent(
  type: string,
  metadata: Record<string, unknown> = {},
  occurredAt = new Date(),
) {
  return { clientEventId: randomUUID(), type, occurredAt: occurredAt.toISOString(), metadata };
}

async function sendEvents(events: unknown[]) {
  const res = await callRoute(eventsRoute, {
    method: "POST",
    path: "/api/mobile/v1/events",
    headers: bearer(),
    body: { events },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return deviceEventsResponseSchema.parse(res.body);
}

async function sync(): Promise<MobileSyncResponse> {
  const res = await callRoute(syncRoute, { path: "/api/mobile/v1/sync", headers: bearer() });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return mobileSyncResponseSchema.parse(res.body);
}

/** The phone wakes up after its access token expired: the stale token is refused, refresh rotates the pair. */
async function wakeUpAndRefresh(): Promise<void> {
  const stale = await callRoute<ErrorBody>(syncRoute, {
    path: "/api/mobile/v1/sync",
    headers: bearer(),
  });
  expect(stale.status).toBe(401);
  expect(stale.body.error.code).toBe("UNAUTHENTICATED");
  const refreshed = await callRoute(refreshRoute, {
    method: "POST",
    path: "/api/mobile/v1/auth/refresh",
    body: { refreshToken: j.tokens.refreshToken },
  });
  expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  j.tokens = mobileTokensSchema.parse(refreshed.body);
}

/** Every key (at any depth) of a JSON value, with its path. */
function collectKeys(value: unknown, path = "$"): Array<{ key: string; path: string }> {
  if (Array.isArray(value)) return value.flatMap((v, i) => collectKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => [
    { key, path: `${path}.${key}` },
    ...collectKeys(v, `${path}.${key}`),
  ]);
}

// ── The journey ──────────────────────────────────────────────────────────────

describe("Definition of Done: manager sign-up → employee joins → Work Mode through a shift", () => {
  it("1. a manager registers, verifies the email and creates Harpenden Coffee Co. (checklist + ACTIVE join code)", async () => {
    j.managerEmail = uniqueEmail("dod-owner");
    j.jar = new CookieJar();

    const registered = await callRoute<{ ok: boolean; requiresEmailVerification: boolean }>(
      registerRoute,
      {
        method: "POST",
        path: "/api/auth/register",
        jar: j.jar,
        body: { name: "Harriet Owner", email: j.managerEmail, password: "Sup3r-secret-pass" },
      },
    );
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    expect(registered.body.ok).toBe(true);

    const verified = await callRoute(verifyEmailRoute, {
      method: "POST",
      path: "/api/auth/verify-email",
      body: { token: lastEmailToken(j.managerEmail, "/verify-email") },
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: j.managerEmail } });
    expect(user.emailVerifiedAt).not.toBeNull();

    const created = await managerPost<{
      organisation: { id: string; name: string; timezone: string };
      joinCode: { id: string; code: string; status: string };
    }>(createOrganisationRoute, "/api/organisations", {
      name: ORG_NAME,
      timezone: TIMEZONE,
      firstLocationName: "High Street",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.organisation).toMatchObject({ name: ORG_NAME, timezone: TIMEZONE });
    expect(created.body.joinCode.status).toBe("ACTIVE");
    j.organisationId = created.body.organisation.id;
    j.companyCode = created.body.joinCode.code;
    // The new organisation is selected for the browser.
    expect(j.jar.get(ORG_COOKIE)).toBe(j.organisationId);

    const checklist = await onboarding();
    expect(checklist.items.map((i) => i.key)).toEqual([...ONBOARDING_STEP_KEYS]);
    expect(stepDone(checklist, "createCompany")).toBe(true);
    expect(stepDone(checklist, "createPolicy")).toBe(false);
    expect(checklist.allDone).toBe(false);

    const codes = await managerGet(joinCodeRoute, "/api/organisations/current/join-code");
    expect(codes.status, JSON.stringify(codes.body)).toBe(200);
    const joinCodes = joinCodeResponseSchema.parse(codes.body);
    expect(joinCodes.current?.status).toBe("ACTIVE");
    expect(joinCodes.current?.code).toBe(j.companyCode);
  });

  it("2. creates Zach, the Standard Staff policy, 2×15 RELAX_ALL break rules (both defaults) and his shifts", async () => {
    const employee = await managerPost(createEmployeeRoute, "/api/employees", {
      firstName: "Zach",
      lastName: "Stephens",
      jobTitle: "Barista",
    });
    expect(employee.status, JSON.stringify(employee.body)).toBe(201);
    const zach = employeeResponseSchema.parse(employee.body).employee;
    expect(zach.inviteStatus).toBe("NOT_INVITED");
    j.employeeId = zach.id;

    const policyRes = await managerPost(createPolicyRoute, "/api/policies", {
      name: "Standard Staff",
      restrictionConfig: {
        categories: [...CATEGORIES],
        requireEmployeeAppSelection: true,
        alwaysAllowedNote: ["Phone, Messages and Maps"],
        activationMode: "SCHEDULED",
        preShiftWarningMinutes: 10,
      },
    });
    expect(policyRes.status, JSON.stringify(policyRes.body)).toBe(201);
    const draft = policyResponseSchema.parse(policyRes.body).policy;
    expect(draft.currentVersion).toBeNull();
    j.policyId = draft.id;

    const published = await managerPost(
      publishPolicyRoute,
      `/api/policies/${j.policyId}/publish`,
      { changeNote: "First version" },
      { id: j.policyId },
    );
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const policy = policyResponseSchema.parse(published.body).policy;
    expect(policy.currentVersion?.publishedAt).not.toBeNull();
    expect(policy.currentVersion?.restrictionConfig.categories).toEqual([...CATEGORIES]);
    j.policyVersionId = policy.currentVersion!.id;

    const defaultPolicy = await managerPost(
      defaultPolicyRoute,
      "/api/organisations/current/default-policy",
      { policyId: j.policyId },
    );
    expect(defaultPolicy.status, JSON.stringify(defaultPolicy.body)).toBe(200);

    const breakRes = await managerPost(createBreakPolicyRoute, "/api/break-policies", {
      name: "Standard Breaks",
      maxBreaksPerShift: 2,
      maxBreakDurationMinutes: 15,
      maxTotalBreakMinutes: 30,
      minGapBetweenBreaksMinutes: 30,
      minMinutesAfterShiftStart: 15,
      restrictionBehaviour: "RELAX_ALL",
    });
    expect(breakRes.status, JSON.stringify(breakRes.body)).toBe(201);
    j.breakPolicyId = breakPolicyResponseSchema.parse(breakRes.body).breakPolicy.id;
    const defaultBreaks = await managerPost(
      defaultBreakPolicyRoute,
      "/api/organisations/current/default-break-policy",
      { breakPolicyId: j.breakPolicyId },
    );
    expect(defaultBreaks.status, JSON.stringify(defaultBreaks.body)).toBe(200);

    // A shift in progress on the REAL clock (the mobile endpoints read it): started 30 min ago, 5 h left.
    const now = Date.now();
    const shiftRes = await managerPost(createShiftRoute, "/api/shifts", {
      employeeId: j.employeeId,
      startsAt: new Date(now - 30 * MINUTE).toISOString(),
      endsAt: new Date(now + 5 * HOUR).toISOString(),
    });
    expect(shiftRes.status, JSON.stringify(shiftRes.body)).toBe(201);
    const [shift] = createShiftResponseSchema.parse(shiftRes.body).shifts;
    expect(shift!.status).toBe("SCHEDULED");
    expect(shift!.timezone).toBe(TIMEZONE);
    j.shift = {
      id: shift!.id,
      startsAt: new Date(shift!.startsAt),
      endsAt: new Date(shift!.endsAt),
    };

    // "Today 09:00–15:00 Europe/London" through the local-time form — only when it cannot collide with the
    // journey shift (overlap, or within an hour of it, which would change the state machine's answers in
    // steps 9–10: SHIFT_STARTING_SOON instead of OFF_SHIFT). Otherwise it is skipped (see the report).
    const today = localDateOf(new Date(now), TIMEZONE);
    const nine = localToInstant({ date: today, time: "09:00", timezone: TIMEZONE }).instant;
    const three = localToInstant({ date: today, time: "15:00", timezone: TIMEZONE }).instant;
    const margin = HOUR;
    const collides =
      nine.getTime() < j.shift.endsAt.getTime() + margin &&
      three.getTime() > j.shift.startsAt.getTime() - margin;
    j.todayShiftId = null;
    if (!collides) {
      const todayRes = await managerPost(createShiftRoute, "/api/shifts", {
        employeeId: j.employeeId,
        date: today,
        startTime: "09:00",
        endTime: "15:00",
      });
      expect(todayRes.status, JSON.stringify(todayRes.body)).toBe(201);
      const [todayShift] = createShiftResponseSchema.parse(todayRes.body).shifts;
      expect(new Date(todayShift!.startsAt).getTime()).toBe(nine.getTime());
      expect(new Date(todayShift!.endsAt).getTime()).toBe(three.getTime());
      j.todayShiftId = todayShift!.id;
    }

    // The employee record resolves both organisation defaults and knows the shift in progress.
    const detail = await employeeDetail();
    expect(detail.resolvedPolicy).toEqual({
      id: j.policyId,
      name: "Standard Staff",
      resolvedFrom: "DEFAULT",
    });
    expect(detail.resolvedBreakPolicy).toEqual({
      id: j.breakPolicyId,
      name: "Standard Breaks",
      resolvedFrom: "DEFAULT",
    });
    expect(detail.nextShift?.id).toBe(j.shift.id);

    const checklist = await onboarding();
    for (const key of [
      "createPolicy",
      "configureBreakRules",
      "addEmployees",
      "addSchedules",
    ] as const) {
      expect(stepDone(checklist, key), key).toBe(true);
    }
    expect(stepDone(checklist, "inviteEmployees")).toBe(false);
  });

  it("3. Zach is NOT_INVITED, a LINK invite makes him INVITED and he is awaiting setup", async () => {
    const list = await managerGet(listEmployeesRoute, "/api/employees", {
      query: { search: "Stephens" },
    });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const listed = listEmployeesResponseSchema.parse(list.body).items;
    expect(listed.map((e) => e.id)).toEqual([j.employeeId]);
    expect(listed[0]!.inviteStatus).toBe("NOT_INVITED");
    expect(listed[0]!.deviceStatus).toBeNull();
    const before = await employeeDetail();
    expect(before.inviteStatus).toBe("NOT_INVITED");
    expect(before.latestInvite).toBeNull();
    expect(before.device).toBeNull();

    const invited = await managerPost(
      createInviteRoute,
      `/api/employees/${j.employeeId}/invites`,
      { channel: "LINK" },
      { id: j.employeeId },
    );
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const { invite, instructions } = createEmployeeInviteResponseSchema.parse(invited.body);
    expect(invite.channel).toBe("LINK");
    expect(invite.status).toBe("SENT");
    expect(instructions.companyCode).toBe(j.companyCode);
    expect(instructions.inviteCode).toBe(invite.code);
    j.inviteId = invite.id;

    const after = await employeeDetail();
    expect(after.inviteStatus).toBe("INVITED");
    expect(after.latestInvite?.id).toBe(j.inviteId);

    const awaiting = await managerGet(complianceEmployeesRoute, "/api/compliance/employees", {
      query: { filter: "AWAITING_SETUP" },
    });
    expect(awaiting.status, JSON.stringify(awaiting.body)).toBe(200);
    const rows = complianceEmployeesResponseSchema.parse(awaiting.body).items;
    expect(rows.map((r) => r.employee.id)).toContain(j.employeeId);
    expect(rows.find((r) => r.employee.id === j.employeeId)?.employee.inviteStatus).toBe("INVITED");
    expect(stepDone(await onboarding(), "inviteEmployees")).toBe(true);
  });

  it("4. the iOS app looks Zach up (SINGLE + preview) and joins; the manager sees JOINED and EMPLOYEE_JOINED", async () => {
    const lookup = await callRoute(joinLookupRoute, {
      method: "POST",
      path: "/api/mobile/v1/join/lookup",
      body: { companyCode: j.companyCode, firstName: "zach", lastName: " Stephens " },
    });
    expect(lookup.status, JSON.stringify(lookup.body)).toBe(200);
    const found = joinLookupResponseSchema.parse(lookup.body);
    expect(found.match).toBe("SINGLE");
    expect(found.organisation.name).toBe(ORG_NAME);
    expect(found.employeePreview).toEqual({
      id: j.employeeId,
      firstName: "Zach",
      lastName: "Stephens",
      jobTitle: "Barista",
      locationName: null,
    });

    const confirmed = await callRoute(joinConfirmRoute, {
      method: "POST",
      path: "/api/mobile/v1/join/confirm",
      body: {
        companyCode: j.companyCode,
        employeeId: j.employeeId,
        firstName: "Zach",
        lastName: "Stephens",
        device: DEVICE_INFO,
      },
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    const joined = joinConfirmResponseSchema.parse(confirmed.body);
    expect(joined.employee.id).toBe(j.employeeId);
    expect(joined.organisation).toMatchObject({ id: j.organisationId, name: ORG_NAME });
    j.deviceId = joined.deviceId;
    j.tokens = mobileTokensSchema.parse(joined);
    j.applied = null;

    const detail = await employeeDetail();
    expect(detail.inviteStatus).toBe("JOINED");
    expect(detail.latestInvite?.status).toBe("ACCEPTED");
    expect(detail.device?.id).toBe(j.deviceId);
    expect(detail.device?.permissionState).toBe("NOT_DETERMINED");
    // Joined but Screen Time not authorised yet.
    expect(detail.deviceStatus?.badge).toBe("PERMISSIONS_MISSING");

    const joinedEvents = await activityOfType("EMPLOYEE_JOINED");
    expect(joinedEvents).toHaveLength(1);
    expect(joinedEvents[0]!.employee?.id).toBe(j.employeeId);
    expect(joinedEvents[0]!.deviceId).toBe(j.deviceId);
  });

  it("5. the phone reports setup (APPROVED, CONFIGURED, 3 categories) → CONNECTED, permissions ready, SETUP_COMPLETED", async () => {
    const report = await reportState("UNKNOWN");
    expect(report.ok).toBe(true);
    expect(Math.abs(report.clockSkewSeconds)).toBeLessThan(5);
    expect(report.expectedState.state).toBe("WORKING");

    // Like the app's `completeSetup`: check in first, then flush the outbox queued during onboarding. The
    // check-in already recorded the permission and selection transitions, so the app's copies are duplicates.
    const ingested = await sendEvents([
      deviceEvent("PERMISSION_GRANTED", { permissionState: "APPROVED" }),
      deviceEvent("SELECTION_CONFIGURED", { selectionCounts: SELECTION_COUNTS }),
      deviceEvent("SETUP_COMPLETED", {
        permissionState: "APPROVED",
        selectionCounts: SELECTION_COUNTS,
      }),
    ]);
    expect(ingested).toEqual({ accepted: 1, duplicates: 2, rejected: [] });

    const detail = await employeeDetail();
    expect(detail.inviteStatus).toBe("CONNECTED");
    expect(detail.device).toMatchObject({
      permissionState: "APPROVED",
      selectionState: "CONFIGURED",
      selectionCounts: SELECTION_COUNTS,
      appVersion: "1.0.0",
    });
    expect(detail.deviceStatus?.badge).not.toBe("PERMISSIONS_MISSING");
    expect(detail.deviceStatus?.badge).not.toBe("NEEDS_ATTENTION");

    const row = await complianceRow();
    expect(row.employee.inviteStatus).toBe("CONNECTED");
    expect(row.permissionState).toBe("APPROVED");
    expect(row.selectionState).toBe("CONFIGURED");
    expect(row.attentionReason).toBeNull();

    const setup = await activityOfType("SETUP_COMPLETED");
    expect(setup).toHaveLength(1);
    expect(setup[0]!.actorType).toBe("EMPLOYEE_DEVICE");
    // One grant and one selection happened: the feed shows each once, whichever path reported it first.
    expect(await activityOfType("PERMISSION_GRANTED")).toHaveLength(1);
    expect(await activityOfType("SELECTION_CONFIGURED")).toHaveLength(1);

    const checklist = await onboarding();
    expect(stepDone(checklist, "employeesConnect")).toBe(true);
    expect(checklist.allDone).toBe(true);
  });

  it("6. GET /sync delivers the policy, break rules and shift; the badge waits for the phone to confirm (WORKING)", async () => {
    const bundle = await sync();
    expect(bundle.policy?.policy).toEqual({ id: j.policyId, name: "Standard Staff" });
    expect(bundle.policy?.restrictionConfig.categories).toEqual([...CATEGORIES]);
    expect(bundle.policyVersion).toBe(j.policyVersionId);
    expect(bundle.breakPolicy?.id).toBe(j.breakPolicyId);
    expect(bundle.breakPolicy?.rules).toMatchObject({
      breaksEnabled: true,
      maxBreaksPerShift: 2,
      maxBreakDurationMinutes: 15,
      maxTotalBreakMinutes: 30,
      minGapBetweenBreaksMinutes: 30,
      minMinutesAfterShiftStart: 15,
      employeeTriggeredAllowed: true,
      restrictionBehaviour: "RELAX_ALL",
    });
    expect(bundle.shifts.map((s) => s.id)).toContain(j.shift.id);
    if (j.todayShiftId) expect(bundle.shifts.map((s) => s.id)).toContain(j.todayShiftId);
    expect(bundle.expectedState.state).toBe("WORKING");
    expect(bundle.expectedState.effectiveRestriction).toBe("WORK");
    expect(bundle.expectedState.restrictionsShouldBeActive).toBe(true);
    expect(bundle.expectedState.activeShift?.id).toBe(j.shift.id);
    expect(bundle.activeBreakSession).toBeNull();
    expect(bundle.breakAllowance).toMatchObject({
      breaksTaken: 0,
      breaksRemaining: 2,
      minutesRemaining: 30,
      canStartNow: true,
    });
    j.applied = { policyVersion: bundle.policyVersion!, scheduleVersion: bundle.scheduleVersion };

    // The server noted the first policy / schedule delivery; the app's SyncCoordinator queues the same two
    // events after applying the bundle and flushes them — one feed row per fact.
    const synced = await sendEvents([
      deviceEvent("POLICY_SYNCED", { policyVersion: bundle.policyVersion! }),
      deviceEvent("SCHEDULE_SYNCED", { scheduleVersion: bundle.scheduleVersion }),
    ]);
    expect(synced).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
    const policySynced = await activityOfType("POLICY_SYNCED");
    expect(policySynced).toHaveLength(1);
    expect(policySynced[0]!.metadata).toMatchObject({ policyVersion: j.policyVersionId });
    expect(await activityOfType("SCHEDULE_SYNCED")).toHaveLength(1);

    // The phone has not said Work Mode started yet: working, not "Work Mode active".
    const row = await complianceRow();
    expect(row.expectedState).toBe("WORKING");
    expect(row.activeShift?.id).toBe(j.shift.id);
    expect(row.deviceStatus?.badge).toBe("WORKING");
    expect((await employeeDetail()).deviceStatus?.badge).toBe("WORKING");
    const summary = await managerGet(complianceSummaryRoute, "/api/compliance/summary");
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(complianceSummaryResponseSchema.parse(summary.body).metrics).toMatchObject({
      totalEmployees: 1,
      connected: 1,
      awaitingSetup: 0,
      workingNow: 1,
      workModeActive: 0,
      onBreak: 0,
      needsAttention: 0,
    });
  });

  it("7. the phone confirms Work Mode (WORKING + WORK_MODE_STARTED) → WORK_MODE_ACTIVE", async () => {
    const ingested = await sendEvents([
      deviceEvent("WORK_MODE_STARTED", {
        shiftId: j.shift.id,
        policyVersion: j.policyVersionId,
        reason: "INTERVAL_STARTED",
      }),
    ]);
    expect(ingested).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
    const report = await reportState("WORKING");
    expect(report.expectedState.state).toBe("WORKING");

    const row = await complianceRow();
    expect(row.reportedState).toBe("WORKING");
    expect(row.deviceStatus?.badge).toBe("WORK_MODE_ACTIVE");
    expect(row.deviceStatus?.reason).toBeNull();
    expect((await employeeDetail()).deviceStatus?.badge).toBe("WORK_MODE_ACTIVE");
    const started = await activityOfType("WORK_MODE_STARTED");
    expect(started).toHaveLength(1);
    expect(started[0]!.metadata).toMatchObject({ shiftId: j.shift.id });
  });

  it("8. Zach starts a 15 minute RELAX_ALL break → ON_BREAK; a second start is BREAK_ALREADY_ACTIVE", async () => {
    const clientBreakId = randomUUID();
    const requestedAt = new Date();
    const res = await callRoute(startBreakRoute, {
      method: "POST",
      path: "/api/mobile/v1/breaks/start",
      headers: bearer(),
      body: { clientBreakId, shiftId: j.shift.id, requestedAt: requestedAt.toISOString() },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { breakSession, allowance } = mobileBreakResponseSchema.parse(res.body);
    expect(breakSession).toMatchObject({
      clientBreakId,
      shiftId: j.shift.id,
      status: "ACTIVE",
      endedAt: null,
      endReason: null,
      restrictionBehaviour: "RELAX_ALL",
    });
    const startedAt = new Date(breakSession.startedAt);
    const plannedEndsAt = new Date(breakSession.plannedEndsAt);
    expect(Math.abs(startedAt.getTime() - requestedAt.getTime())).toBeLessThan(5_000);
    expect(plannedEndsAt.getTime() - startedAt.getTime()).toBe(15 * MINUTE);
    expect(Math.abs(plannedEndsAt.getTime() - (Date.now() + 15 * MINUTE))).toBeLessThan(10_000);
    expect(allowance).toMatchObject({ breaksTaken: 1, breaksRemaining: 1, canStartNow: false });
    j.breakSession = { id: breakSession.id, clientBreakId, startedAt, plannedEndsAt };

    // The phone relaxes the shields and says so; its BREAK_STARTED is the one the server already recorded.
    const ingested = await sendEvents([
      deviceEvent(
        "BREAK_STARTED",
        { shiftId: j.shift.id, breakSessionId: breakSession.id, clientBreakId },
        startedAt,
      ),
    ]);
    expect(ingested).toEqual({ accepted: 0, duplicates: 1, rejected: [] });
    const report = await reportState("ON_BREAK");
    expect(report.expectedState.state).toBe("ON_BREAK");
    expect(report.expectedState.effectiveRestriction).toBe("BREAK_RELAXED");
    expect(report.expectedState.activeBreak?.id).toBe(breakSession.id);

    const row = await complianceRow();
    expect(row.expectedState).toBe("ON_BREAK");
    expect(row.deviceStatus?.badge).toBe("ON_BREAK");
    expect((await employeeDetail()).deviceStatus?.badge).toBe("ON_BREAK");

    const again = await callRoute<ErrorBody>(startBreakRoute, {
      method: "POST",
      path: "/api/mobile/v1/breaks/start",
      headers: bearer(),
      body: {
        clientBreakId: randomUUID(),
        shiftId: j.shift.id,
        requestedAt: new Date().toISOString(),
      },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("BREAK_ALREADY_ACTIVE");

    const started = await activityOfType("BREAK_STARTED");
    expect(started).toHaveLength(1);
    expect(started[0]!.metadata).toMatchObject({
      breakSessionId: breakSession.id,
      clientBreakId,
      restrictionBehaviour: "RELAX_ALL",
    });
    expect(await prisma.breakSession.count({ where: { shiftId: j.shift.id } })).toBe(1);
  });

  it("9. with the app closed the break expires server-side (job → EXPIRED + BREAK_EXPIRED), and the phone's late BREAK_EXPIRED is a duplicate", async () => {
    travelTo(new Date(j.breakSession.plannedEndsAt.getTime() + MINUTE));

    const report = await runWorkModeTick(new Date(), { sendDigest: false });
    expect(report.errors).not.toContain(j.organisationId);
    expect(report.breaksExpired).toBeGreaterThanOrEqual(1);

    const session = await prisma.breakSession.findUniqueOrThrow({
      where: { id: j.breakSession.id },
    });
    expect(session.status).toBe("ENDED");
    expect(session.endReason).toBe("EXPIRED");
    expect(session.endedAt?.getTime()).toBe(j.breakSession.plannedEndsAt.getTime());

    // Server-recorded, because the device never reported the end.
    const expired = await activityOfType("BREAK_EXPIRED");
    expect(expired).toHaveLength(1);
    expect(expired[0]!.actorType).toBe("SYSTEM");
    expect(new Date(expired[0]!.occurredAt).getTime()).toBe(j.breakSession.plannedEndsAt.getTime());
    expect(expired[0]!.metadata).toMatchObject({
      breakSessionId: j.breakSession.id,
      shiftId: j.shift.id,
      endReason: "EXPIRED",
    });

    const stored = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: j.employeeId },
    });
    expect(stored.expectedState).toBe("WORKING");
    expect(stored.expectedRestriction).toBe("WORK");
    expect(stored.activeShiftId).toBe(j.shift.id);
    expect(stored.activeBreakSessionId).toBeNull();
    expect(stored.breaksTakenCount).toBe(1);
    expect(stored.breakMinutesUsed).toBe(15);

    // Until the phone checks in, the dashboard shows the shields as back on but says the device still
    // reports the break (no false NEEDS_ATTENTION: that report predates the expiry).
    const pending = await complianceRow();
    expect(pending.expectedState).toBe("WORKING");
    expect(pending.reportedState).toBe("ON_BREAK");
    expect(pending.deviceStatus?.badge).toBe("WORK_MODE_ACTIVE");
    expect(pending.deviceStatus?.reason).toMatch(/break/i);

    // The phone wakes up, flushes the monitor extension's BREAK_EXPIRED (same shape as the extension:
    // occurredAt = plannedEndsAt, server session id + clientBreakId + INTERVAL_ENDED) and checks in.
    await wakeUpAndRefresh();
    const ingested = await sendEvents([
      deviceEvent(
        "BREAK_EXPIRED",
        {
          shiftId: j.shift.id,
          breakSessionId: j.breakSession.id,
          clientBreakId: j.breakSession.clientBreakId,
          reason: "INTERVAL_ENDED",
        },
        j.breakSession.plannedEndsAt,
      ),
    ]);
    expect(ingested).toEqual({ accepted: 0, duplicates: 1, rejected: [] });
    const state = await reportState("WORKING");
    expect(state.expectedState.state).toBe("WORKING");
    expect(state.expectedState.activeBreak).toBeNull();

    expect(await activityOfType("BREAK_EXPIRED")).toHaveLength(1);
    const row = await complianceRow();
    expect(row.deviceStatus?.badge).toBe("WORK_MODE_ACTIVE");
    expect(row.deviceStatus?.reason).toBeNull();

    const bundle = await sync();
    expect(bundle.expectedState.state).toBe("WORKING");
    expect(bundle.activeBreakSession).toBeNull();
    expect(bundle.breakAllowance).toMatchObject({
      breaksTaken: 1,
      breaksRemaining: 1,
      minutesUsed: 15,
      minutesRemaining: 15,
    });
    // Next break: 30 minutes after this one ended (minGapBetweenBreaksMinutes).
    expect(new Date(bundle.breakAllowance!.nextEligibleAt!).getTime()).toBe(
      j.breakSession.plannedEndsAt.getTime() + 30 * MINUTE,
    );
  });

  it("10. at the end of the shift the job expects OFF_SHIFT; the phone ends Work Mode → OFF_SHIFT + WORK_MODE_ENDED", async () => {
    travelTo(new Date(j.shift.endsAt.getTime() + MINUTE));

    // This time through the HTTP trigger an external scheduler would call.
    const unauthorised = await callRoute<ErrorBody>(tickRoute, {
      method: "POST",
      path: "/api/jobs/tick",
      headers: { authorization: "Bearer not-the-secret" },
    });
    expect(unauthorised.status).toBe(401);
    const tick = await callRoute<{ ok: boolean; report: { errors: string[] } }>(tickRoute, {
      method: "POST",
      path: "/api/jobs/tick",
      headers: { authorization: `Bearer ${env().CRON_SECRET}` },
    });
    expect(tick.status, JSON.stringify(tick.body)).toBe(200);
    expect(tick.body.ok).toBe(true);
    expect(tick.body.report.errors).not.toContain(j.organisationId);

    const stored = await prisma.employeeWorkState.findUniqueOrThrow({
      where: { employeeId: j.employeeId },
    });
    expect(stored.expectedState).toBe("OFF_SHIFT");
    expect(stored.expectedRestriction).toBe("NONE");
    expect(stored.activeShiftId).toBeNull();
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: j.shift.id } })).status).toBe(
      "COMPLETED",
    );

    await wakeUpAndRefresh();
    const ingested = await sendEvents([
      deviceEvent(
        "WORK_MODE_ENDED",
        { shiftId: j.shift.id, reason: "INTERVAL_ENDED" },
        j.shift.endsAt,
      ),
    ]);
    expect(ingested).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
    const state = await reportState("OFF_SHIFT");
    expect(state.expectedState.state).toBe("OFF_SHIFT");
    expect(state.expectedState.restrictionsShouldBeActive).toBe(false);

    const row = await complianceRow();
    expect(row.expectedState).toBe("OFF_SHIFT");
    expect(row.reportedState).toBe("OFF_SHIFT");
    expect(row.activeShift).toBeNull();
    expect(row.deviceStatus?.badge).toBe("OFF_SHIFT");
    expect(row.attentionReason).toBeNull();
    expect((await employeeDetail()).deviceStatus?.badge).toBe("OFF_SHIFT");
    const ended = await activityOfType("WORK_MODE_ENDED");
    expect(ended).toHaveLength(1);
    expect(ended[0]!.metadata).toMatchObject({ shiftId: j.shift.id });
    expect((await sync()).expectedState.state).toBe("OFF_SHIFT");
  });

  it("11. a second organisation's manager cannot read Zach, his device, activity or compliance", async () => {
    const other = await createTestOrg({ name: "Other Coffee Ltd" });
    const otherJar = await loginAs(other.owner, { organisationId: other.organisation.id });
    const errorCode = (res: { body: unknown }) => (res.body as ErrorBody).error.code;

    const employee = await managerGet(employeeRoute, `/api/employees/${j.employeeId}`, {
      params: { id: j.employeeId },
      jar: otherJar,
    });
    expect(employee.status).toBe(404);
    // Indistinguishable from an id that does not exist at all (never 403, never a different code).
    const missingId = randomUUID();
    const missing = await managerGet(employeeRoute, `/api/employees/${missingId}`, {
      params: { id: missingId },
      jar: otherJar,
    });
    expect(missing.status).toBe(404);
    expect(errorCode(employee)).toBe(errorCode(missing));

    const device = await managerGet(deviceRoute, `/api/devices/${j.deviceId}`, {
      params: { id: j.deviceId },
      jar: otherJar,
    });
    expect(device.status).toBe(404);

    const timeline = await managerGet(
      employeeActivityRoute,
      `/api/employees/${j.employeeId}/activity`,
      { params: { id: j.employeeId }, jar: otherJar },
    );
    expect(timeline.status).toBe(404);

    const feed = await managerGet(activityRoute, "/api/activity", {
      query: { employeeId: j.employeeId },
      jar: otherJar,
    });
    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    expect(listActivityResponseSchema.parse(feed.body).items).toEqual([]);

    const compliance = await managerGet(complianceEmployeesRoute, "/api/compliance/employees", {
      jar: otherJar,
    });
    expect(compliance.status).toBe(200);
    expect(
      complianceEmployeesResponseSchema.parse(compliance.body).items.map((r) => r.employee.id),
    ).not.toContain(j.employeeId);

    // Pointing the organisation cookie at Harpenden does not switch tenants: the membership decides.
    const spoofed = otherJar.clone();
    spoofed.set(ORG_COOKIE, j.organisationId);
    const spoofedFeed = await managerGet(activityRoute, "/api/activity", { jar: spoofed });
    expect(spoofedFeed.status).toBe(200);
    const spoofedItems = listActivityResponseSchema.parse(spoofedFeed.body).items;
    expect(spoofedItems.some((e) => e.employee?.id === j.employeeId)).toBe(false);
    const spoofedSummary = await managerGet(complianceSummaryRoute, "/api/compliance/summary", {
      jar: spoofed,
    });
    expect(spoofedSummary.status).toBe(200);
    expect(complianceSummaryResponseSchema.parse(spoofedSummary.body).metrics.totalEmployees).toBe(
      0,
    );
    const spoofedEmployee = await managerGet(employeeRoute, `/api/employees/${j.employeeId}`, {
      params: { id: j.employeeId },
      jar: spoofed,
    });
    expect(spoofedEmployee.status).toBe(404);
  });

  it("12. privacy: the phone cannot send content or usage, and the manager never sees tokens, apps or content", async () => {
    const activityBefore = await prisma.activityEvent.count({
      where: { employeeId: j.employeeId },
    });
    const deviceBefore = await prisma.device.findUniqueOrThrow({ where: { id: j.deviceId } });
    // Every forbidden field is refused (not dropped) on /device/state …
    for (const [field, value] of Object.entries(FORBIDDEN_DEVICE_FIELDS)) {
      const res = await callRoute<ErrorBody>(deviceStateRoute, {
        method: "POST",
        path: "/api/mobile/v1/device/state",
        headers: bearer(),
        body: deviceReport({ restrictionEngineState: "OFF_SHIFT", [field]: value }),
      });
      expect(res.status, field).toBe(400);
      expect(res.body.error.code, field).toBe("VALIDATION_ERROR");
    }
    // … and on /events: at the top level, on an event and inside its metadata.
    for (const [field, value] of Object.entries(FORBIDDEN_DEVICE_FIELDS)) {
      const event = deviceEvent("POLICY_SYNCED", { policyVersion: j.policyVersionId });
      for (const body of [
        { events: [event], [field]: value },
        { events: [{ ...event, [field]: value }] },
        { events: [{ ...event, metadata: { ...event.metadata, [field]: value } }] },
      ]) {
        const res = await callRoute<ErrorBody>(eventsRoute, {
          method: "POST",
          path: "/api/mobile/v1/events",
          headers: bearer(),
          body,
        });
        expect(res.status, `${field}: ${JSON.stringify(body)}`).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    }
    // Nothing from the refused requests was stored.
    expect(await prisma.activityEvent.count({ where: { employeeId: j.employeeId } })).toBe(
      activityBefore,
    );
    const deviceAfter = await prisma.device.findUniqueOrThrow({ where: { id: j.deviceId } });
    expect(deviceAfter.lastDeviceSyncAt?.getTime()).toBe(deviceBefore.lastDeviceSyncAt?.getTime());

    // Register an APNs token so the manager-facing payloads have a token they could leak.
    const pushToken = "a1b2c3d4".repeat(8);
    const registered = await callRoute(pushTokenRoute, {
      method: "POST",
      path: "/api/mobile/v1/device/push-token",
      headers: bearer(),
      body: { token: pushToken, environment: "sandbox" },
    });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);

    const employeeRes = await managerGet(employeeRoute, `/api/employees/${j.employeeId}`, {
      params: { id: j.employeeId },
    });
    const deviceRes = await managerGet(deviceRoute, `/api/devices/${j.deviceId}`, {
      params: { id: j.deviceId },
    });
    expect(employeeRes.status).toBe(200);
    expect(deviceRes.status).toBe(200);
    const employee = employeeDetailResponseSchema.parse(employeeRes.body).employee;
    const device = deviceResponseSchema.parse(deviceRes.body);
    expect(employee.device?.hasPushToken).toBe(true);
    expect(device.device.hasPushToken).toBe(true);
    // Selection counts are the only selection data a manager sees.
    expect(device.device.selectionCounts).toEqual(SELECTION_COUNTS);

    for (const [name, body] of [
      ["GET /api/employees/:id", employeeRes.body],
      ["GET /api/devices/:id", deviceRes.body],
    ] as const) {
      const flagged = collectKeys(body).filter(
        ({ key }) => PRIVATE_KEY_PATTERN.test(key) && !ALLOWED_PRIVATE_LOOKING_KEYS.has(key),
      );
      expect(flagged, name).toEqual([]);
      // `hasPushToken` is a boolean; the token itself (raw or encrypted) is nowhere in the payload.
      const raw = JSON.stringify(body);
      expect(raw, name).toMatch(/"hasPushToken":true/);
      expect(raw.toLowerCase(), name).not.toContain(pushToken);
      expect(raw, name).not.toMatch(/"pushToken(Encrypted)?"/);
      expect(raw, name).not.toMatch(/accessToken|refreshToken/);
    }
  });
});
