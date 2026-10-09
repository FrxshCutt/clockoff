import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAppError } from "@clockoff/shared/errors";
import { ProviderError, type ProviderContext } from "@clockoff/shared/providers/workforceProvider";
import type { ExternalShift, SyncBatch } from "@clockoff/shared/providers/workforceProvider";
import { syncWindow } from "../core/window";
import { createInMemoryCredentialStore, type InMemoryCredentialStore } from "./client";
import { REQUIRED_SCOPES } from "./constants";
import { PlandayError } from "./errors";
import { abortErrorFor, isAbortError, PlandayBudgets } from "./http";
import {
  createMockPlanday,
  FROZEN_NOW,
  MOCK_CUSTOMER_APP_ID,
  MOCK_DEPARTMENT_IDS,
  MOCK_EMPLOYEE_IDS,
  MOCK_NO_DEPARTMENTS_PORTAL_ID,
  MOCK_PORTAL_CREDENTIALS,
  MOCK_PORTAL_ID,
  MOCK_READ_SCOPES,
  MOCK_REFRESH_TOKEN,
  SENTINEL_BIRTH_DATE,
  SENTINEL_PII_PREFIX,
  SENTINEL_USERNAME_DOMAIN,
  sentinelPhone,
  type MockPlanday,
} from "./mock";
import {
  isPlandayPortalMismatchError,
  plandayPhasesFor,
  plandayWarningCode,
  PREVIEW_WINDOW_DAYS,
  type PlandayPhaseSettings,
} from "./phases";
import {
  createPlandayProvider,
  isPlandayConnectedCredentials,
  PlandayConnectRefusedError,
  verifiedAuthorizationCode,
  type PlandayConnectedCredentials,
  type PlandayProviderConfig,
} from "./provider";
import { createMemorySink, runPhasesInMemory, type MemorySink } from "./testing/memorySink";

/**
 * `PlandayProvider` against Mock Planday (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §13.1
 * `planday/provider.test.ts`): phases with an in-memory sink, the scope probes of method C, `connect()` accepting only
 * `PlandayConnectCredentials`, the forced refresh in PORTAL_CHECK, the portal mismatch and a portal without
 * departments. Every test ends by asserting the mock saw no request ClockOff must never make.
 */

const PORTAL = String(MOCK_PORTAL_ID);
const ZONE = "Europe/London";
const PARTNER_APP_ID = "0b8a3f1e-1111-4222-8333-444455556666";
const CALLBACK = "https://app.clockoff.test/api/integrations/planday/callback";
const E = MOCK_EMPLOYEE_IDS;
const { BAR, KITCHEN, HEAD_OFFICE } = MOCK_DEPARTMENT_IDS;
const INCLUDED = [String(BAR), String(KITCHEN)];

let clock: number;
let mock: MockPlanday;

beforeEach(() => {
  clock = FROZEN_NOW.getTime();
  mock = createMockPlanday({ now: () => clock, partnerAppIds: [PARTNER_APP_ID] });
});

afterEach(() => {
  expect(mock.unexpectedRequests).toEqual([]);
});

const mockNow = () => new Date(mock.state.now());

function provider(config: PlandayProviderConfig = {}) {
  return createPlandayProvider({
    transport: { fetch: mock.fetch, authorizeBaseUrl: mock.authorizeBaseUrl },
    budgets: new PlandayBudgets(),
    clock: mockNow,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw abortErrorFor(signal);
      clock += ms;
    },
    random: () => 0,
    config,
  });
}

function store(portalId: number = MOCK_PORTAL_ID): InMemoryCredentialStore {
  const credentials = MOCK_PORTAL_CREDENTIALS[portalId]!;
  return createInMemoryCredentialStore(
    {
      clientId: credentials.appId,
      refreshToken: credentials.refreshToken,
      accessToken: null,
      accessTokenExpiresAt: null,
    },
    mockNow,
  );
}

function context(
  settings: PlandayPhaseSettings,
  extra: Partial<ProviderContext> = {},
): ProviderContext {
  return {
    organisationId: "org-1",
    integrationId: "integration-1",
    settings,
    now: FROZEN_NOW,
    credentialStore: store(),
    ...extra,
  };
}

const settings = (extra: Partial<PlandayPhaseSettings> = {}): PlandayPhaseSettings => ({
  portalId: PORTAL,
  portalTimezone: ZONE,
  ...extra,
});

const tokenRequests = () =>
  mock.requestLog.filter((e) => e.host === "id.planday.com" && e.path === "/connect/token");
const apiRequests = (path?: string) =>
  mock.requestLog.filter(
    (e) => e.host === "openapi.planday.com" && (path === undefined || e.path === path),
  );

function shiftsOf(sink: MemorySink): ExternalShift[] {
  return sink.batches.flatMap((b) => (b.kind === "SHIFTS" ? [...b.records] : []));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("phasesFor (§7.2)", () => {
  it("lists each run kind's phases, the optional ones only when enabled", () => {
    const p = provider();
    const none = { clockEvents: false, hiddenDays: false };
    const all = { clockEvents: true, hiddenDays: true };
    expect(p.phasesFor("STRUCTURE", none)).toEqual([
      "PORTAL_CHECK",
      "DEPARTMENTS",
      "EMPLOYEE_GROUPS",
      "EMPLOYEE_COUNTS",
      "FINALISE",
    ]);
    expect(p.phasesFor("DIRECTORY", none)).toEqual([
      "PORTAL_CHECK",
      "EMPLOYEES",
      "MATCH_EMPLOYEES",
      "PREVIEW_SHIFTS",
      "FINALISE",
    ]);
    expect(p.phasesFor("DIRECTORY", all)).toContain("SCHEDULE_DAYS");
    expect(p.phasesFor("IMPORT_EMPLOYEES", all)).toEqual(["APPLY_EMPLOYEES", "FINALISE"]);
    expect(p.phasesFor("SYNC", none)).toEqual([
      "PORTAL_CHECK",
      "DEPARTMENTS",
      "EMPLOYEE_GROUPS",
      "EMPLOYEES",
      "DEACTIVATED_EMPLOYEES",
      "ABSENT_EMPLOYEES",
      "REACTIVATIONS",
      "SHIFTS",
      "DELETED_SHIFTS",
      "ABSENT_SHIFTS",
      "FINALISE",
    ]);
    expect(p.phasesFor("SYNC", all)).toEqual([
      "PORTAL_CHECK",
      "DEPARTMENTS",
      "EMPLOYEE_GROUPS",
      "EMPLOYEES",
      "DEACTIVATED_EMPLOYEES",
      "ABSENT_EMPLOYEES",
      "REACTIVATIONS",
      "SCHEDULE_DAYS",
      "SHIFTS",
      "DELETED_SHIFTS",
      "ABSENT_SHIFTS",
      "CLOCK_EVENTS",
      "FINALISE",
    ]);
    expect(p.phasesFor("CLOCK", none)).toEqual(["CLOCK_EVENTS", "FINALISE"]);
    expect(plandayPhasesFor("SYNC", none)).toEqual(p.phasesFor("SYNC", none));
  });

  it("is available, resumable and refuses the database-only phases", async () => {
    const p = provider();
    expect(p.status).toBe("AVAILABLE");
    for (const phase of ["MATCH_EMPLOYEES", "REACTIVATIONS", "APPLY_EMPLOYEES"] as const) {
      await expect(p.runPhaseStep(context(settings()), phase, {}, {})).rejects.toThrow(TypeError);
    }
    expect(await p.runPhaseStep(context(settings()), "FINALISE", {}, {})).toEqual({
      done: true,
      cursor: {},
      requests: 0,
    });
    expect(mock.requestLog).toEqual([]);
  });

  it("rejects malformed settings and a missing credential store", async () => {
    const p = provider();
    await expect(
      p.runPhaseStep(
        context({ portalId: "not-a-portal", portalTimezone: ZONE }),
        "DEPARTMENTS",
        {},
        {},
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      p.runPhaseStep(context(settings(), { credentialStore: undefined }), "DEPARTMENTS", {}, {}),
    ).rejects.toThrow(TypeError);
  });
});

describe("STRUCTURE", () => {
  it("reads the portal, the catalogue and the employee counts (counts only, in memory)", async () => {
    const sink = createMemorySink();
    const run = await runPhasesInMemory(
      provider(),
      context(settings({ runKind: "STRUCTURE" })),
      sink,
      {
        kind: "STRUCTURE",
      },
    );
    expect(run.phases).toEqual([
      "PORTAL_CHECK",
      "DEPARTMENTS",
      "EMPLOYEE_GROUPS",
      "EMPLOYEE_COUNTS",
    ]);
    expect(sink.portal).toEqual({
      externalId: PORTAL,
      name: "Mock Bistro Group",
      timezone: ZONE,
      reportedTimezone: ZONE,
      childPortalCount: 0,
    });
    expect([...sink.locations.keys()]).toEqual(["101", "102", "103"]);
    expect(sink.locations.get("101")).toEqual({ externalId: "101", name: "Bar", number: "BAR-01" });
    expect([...sink.teams.keys()]).toEqual(["201", "202", "203", "204"]);
    expect([...sink.completeCatalogues].sort()).toEqual(["LOCATIONS", "TEAMS"]);
    // 11 active people (Hannah is only on the deactivated list).
    expect(sink.employeeCounts).toEqual({
      byDepartment: { "101": 5, "102": 6, "103": 1 },
      byGroup: { "201": 2, "202": 3, "203": 4, "204": 3 },
    });
    expect(sink.employees.size).toBe(0);
    // One token request (no cached token), no forced refresh outside SYNC.
    expect(tokenRequests()).toHaveLength(1);
    expect(run.requests).toBe(mock.requestLog.length);
  });

  it("gives the same answer page by page, with the ids seen on the last step", async () => {
    mock.controls.capPageSize(2);
    const sink = createMemorySink();
    const run = await runPhasesInMemory(provider(), context(settings()), sink, {
      kind: "STRUCTURE",
    });
    expect(sink.employeeCounts?.byDepartment).toEqual({ "101": 5, "102": 6, "103": 1 });
    const locationBatches = sink.batches.filter((b) => b.kind === "LOCATIONS");
    expect(locationBatches.length).toBeGreaterThan(1);
    expect(locationBatches.map((b) => (b as { complete: boolean }).complete)).toEqual([
      ...locationBatches.slice(1).map(() => false),
      true,
    ]);
    const lastDepartments = run.cursors.filter((c) => c.phase === "DEPARTMENTS").at(-1)!;
    expect(lastDepartments.cursor.seenIds).toEqual(["101", "102", "103"]);
    // Counts arrive once, when the list is complete.
    expect(sink.batches.filter((b) => b.kind === "EMPLOYEE_COUNTS")).toHaveLength(1);
  });

  it("a portal without departments counts everyone under 'none'", async () => {
    const sink = createMemorySink();
    await runPhasesInMemory(
      provider(),
      context(settings({ portalId: String(MOCK_NO_DEPARTMENTS_PORTAL_ID) }), {
        credentialStore: store(MOCK_NO_DEPARTMENTS_PORTAL_ID),
      }),
      sink,
      { kind: "STRUCTURE" },
    );
    expect(sink.locations.size).toBe(0);
    expect(sink.completeCatalogues.has("LOCATIONS")).toBe(true);
    expect(sink.employeeCounts?.byDepartment).toEqual({ none: 3 });
  });
});

describe("PORTAL_CHECK", () => {
  it("forces a refresh grant in every SYNC run, even with a valid access token (§4.3)", async () => {
    const p = provider();
    const ctx = context(settings({ runKind: "SYNC" }));
    await p.runPhaseStep(ctx, "PORTAL_CHECK", {}, {});
    await p.runPhaseStep(ctx, "PORTAL_CHECK", {}, {});
    expect(tokenRequests()).toHaveLength(2);
    // A DIRECTORY run reuses the cached token.
    const directory = context(settings({ runKind: "DIRECTORY" }), {
      credentialStore: ctx.credentialStore,
    });
    await p.runPhaseStep(directory, "PORTAL_CHECK", {}, {});
    expect(tokenRequests()).toHaveLength(2);
    // A retryAuth run forces it too.
    await p.runPhaseStep(
      context(settings({ runKind: "DIRECTORY", retryAuth: true }), {
        credentialStore: ctx.credentialStore,
      }),
      "PORTAL_CHECK",
      {},
      {},
    );
    expect(tokenRequests()).toHaveLength(3);
  });

  it("detects a revoked refresh token while access tokens stay valid", async () => {
    const p = provider();
    const ctx = context(settings({ runKind: "SYNC" }));
    await p.runPhaseStep(ctx, "PORTAL_CHECK", {}, {});
    mock.controls.revokeRefreshToken({ keepAccessTokens: true });
    const err = await rejection(p.runPhaseStep(ctx, "PORTAL_CHECK", {}, {}));
    expect(err).toBeInstanceOf(PlandayError);
    expect((err as PlandayError).code).toBe("PLANDAY_AUTH_FAILED");
  });

  it("fails with INTEGRATION_PORTAL_MISMATCH when the token opens another portal", async () => {
    const err = await rejection(
      provider().runPhaseStep(context(settings({ portalId: "4100002" })), "PORTAL_CHECK", {}, {}),
    );
    expect(isPlandayPortalMismatchError(err)).toBe(true);
    expect(isAppError(err) && err.code).toBe("INTEGRATION_PORTAL_MISMATCH");
  });

  it("returns the portal batch", async () => {
    const step = await provider().runPhaseStep(context(settings()), "PORTAL_CHECK", {}, {});
    expect(step.done).toBe(true);
    expect(step.batch).toMatchObject({ kind: "PORTAL", portal: { externalId: PORTAL } });
    expect(step.requests).toBe(2);
  });
});

describe("DIRECTORY", () => {
  it("lists every active person with the §8 fields only, then the 14-day preview", async () => {
    const sink = createMemorySink();
    const run = await runPhasesInMemory(
      provider(),
      context(settings({ runKind: "DIRECTORY", includedDepartmentIds: INCLUDED })),
      sink,
      { kind: "DIRECTORY" },
    );
    expect(run.phases).toEqual(["PORTAL_CHECK", "EMPLOYEES", "PREVIEW_SHIFTS"]);
    expect(sink.employees.size).toBe(11);
    expect(sink.employees.has(String(E.HANNAH_WRIGHT))).toBe(false);
    expect(Object.keys(sink.employees.get(String(E.AISHA_KHAN))!).sort()).toEqual([
      "active",
      "email",
      "externalId",
      "externalLocationIds",
      "externalTeamIds",
      "firstName",
      "lastName",
      "primaryExternalLocationId",
    ]);
    expect(sink.employees.get(String(E.DANIEL_EVANS))).toMatchObject({ email: null, active: true });

    const preview = shiftsOf(sink);
    const window = syncWindow(FROZEN_NOW, ZONE, PREVIEW_WINDOW_DAYS);
    for (const s of preview) {
      expect(s.endsAt.getTime()).toBeGreaterThan(window.from.getTime());
      expect(s.startsAt.getTime()).toBeLessThan(window.to.getTime());
    }
    const byId = new Map(preview.map((s) => [s.externalId, s]));
    const specials = mock.fixture.specials;
    expect(byId.get(String(specials.inProgressShiftId))).toMatchObject({
      cancelled: false,
      externalEmployeeId: String(E.AISHA_KHAN),
    });
    expect(byId.get(String(specials.draftShiftId))).toMatchObject({
      cancelled: true,
      removalReason: "DRAFT",
      externalEmployeeId: null,
    });
    expect(byId.get(String(specials.openShiftId))).toMatchObject({
      cancelled: true,
      removalReason: "UNASSIGNED",
      externalEmployeeId: null,
    });
    // Head Office is not included: never imported, and no employee id travels with it.
    expect(byId.get(String(specials.excludedDepartmentShiftId))).toMatchObject({
      cancelled: true,
      removalReason: "OUT_OF_SCOPE",
      externalEmployeeId: null,
    });
    // The DST-spanning shift: 22:00 BST → 06:00 GMT is nine real hours.
    const dst = byId.get(String(specials.dstShiftId))!;
    expect(dst.endsAt.getTime() - dst.startsAt.getTime()).toBe(9 * 3_600_000);
    for (const id of specials.overnightShiftIds) {
      const s = byId.get(String(id));
      if (s) expect(s.cancelled).toBe(false);
    }
    expect(
      preview.some((s) => s.externalId === String(specials.forSaleShiftId) && !s.cancelled),
    ).toBe(preview.some((s) => s.externalId === String(specials.forSaleShiftId)));
  });

  it("previews a portal without departments through 'none'", async () => {
    const sink = createMemorySink();
    await runPhasesInMemory(
      provider(),
      context(
        settings({
          portalId: String(MOCK_NO_DEPARTMENTS_PORTAL_ID),
          runKind: "DIRECTORY",
          includedDepartmentIds: ["none"],
        }),
        { credentialStore: store(MOCK_NO_DEPARTMENTS_PORTAL_ID) },
      ),
      sink,
      { kind: "DIRECTORY" },
    );
    expect(sink.employees.size).toBe(3);
    for (const e of sink.employees.values()) expect(e.externalLocationIds).toEqual([]);
    const preview = shiftsOf(sink);
    expect(preview.length).toBeGreaterThan(0);
    for (const s of preview) {
      expect(s.externalLocationId).toBeNull();
      expect(s.cancelled).toBe(false);
    }
  });

  it("never carries personal data beyond the §8 fields in any batch", async () => {
    const sink = createMemorySink();
    await runPhasesInMemory(
      provider(),
      context(settings({ runKind: "SYNC", includedDepartmentIds: INCLUDED })),
      sink,
      {
        kind: "SYNC",
        phaseOptions: { clockEvents: true, hiddenDays: true },
        inputsFor: (phase) =>
          phase === "ABSENT_EMPLOYEES"
            ? { recheckExternalIds: [String(E.HANNAH_WRIGHT)] }
            : phase === "ABSENT_SHIFTS"
              ? { recheckExternalIds: [String(mock.fixture.specials.approvedShiftId)] }
              : {},
      },
    );
    const json = JSON.stringify(sink.batches);
    for (const needle of [
      SENTINEL_PII_PREFIX,
      SENTINEL_USERNAME_DOMAIN,
      SENTINEL_BIRTH_DATE.slice(0, 10),
      sentinelPhone(E.AISHA_KHAN),
    ]) {
      expect(json).not.toContain(needle);
    }
  });
});

describe("SYNC", () => {
  const syncSettings = (extra: Partial<PlandayPhaseSettings> = {}) =>
    settings({ runKind: "SYNC", includedDepartmentIds: INCLUDED, ...extra });

  it("reports the deactivated list by date: passed → DEACTIVATED, future → ACTIVE (Q23)", async () => {
    // A future dismissal that stays on the active list: on both lists, and still active.
    mock.controls.deactivateEmployee(E.TOM_HARRIS, {
      effectiveDate: "2026-11-30",
      stayOnActiveList: true,
    });
    const sink = createMemorySink();
    await runPhasesInMemory(provider(), context(syncSettings()), sink, {
      kind: "SYNC",
      inputsFor: (phase) =>
        phase === "DEACTIVATED_EMPLOYEES"
          ? { deactivatedSince: new Date("2026-09-01T00:00:00Z") }
          : {},
    });
    expect(sink.employeeStatuses.get(String(E.HANNAH_WRIGHT))).toBe("DEACTIVATED");
    expect(sink.employeeStatuses.get(String(E.TOM_HARRIS))).toBe("ACTIVE");
    expect(sink.employees.get(String(E.TOM_HARRIS))).toMatchObject({ active: true });
    const deactivated = apiRequests("/hr/v1.0/employees/deactivated")[0]!;
    // One day before the watermark (§6.5).
    expect(deactivated.query.deactivatedFrom).toEqual(["2026-08-31T00:00:00Z"]);
  });

  it("marks a person whose dismissal date has passed while still on the active list as not active", async () => {
    mock.controls.deactivateEmployee(E.TOM_HARRIS, {
      effectiveDate: "2026-11-30",
      stayOnActiveList: true,
    });
    const later = new Date("2026-12-01T12:00:00Z");
    const step = await provider().runPhaseStep(
      context(syncSettings(), { now: later }),
      "EMPLOYEES",
      {},
      {},
    );
    const records = (step.batch as Extract<SyncBatch, { kind: "EMPLOYEES" }>).records;
    expect(records.find((r) => r.externalId === String(E.TOM_HARRIS))).toMatchObject({
      active: false,
    });
  });

  it("re-checks absent employees by id: positive evidence, removal or still active", async () => {
    mock.controls.removeEmployee(E.LEO_TURNER);
    const p = provider();
    const ctx = context(syncSettings());
    const ids = [String(E.HANNAH_WRIGHT), String(E.LEO_TURNER), String(E.AISHA_KHAN)];
    const statuses: Array<[string, string]> = [];
    let cursor: Record<string, unknown> = {};
    for (;;) {
      const step = await p.runPhaseStep(ctx, "ABSENT_EMPLOYEES", cursor, {
        recheckExternalIds: ids,
      });
      if (step.batch?.kind === "EMPLOYEE_STATUS") {
        for (const r of step.batch.records) statuses.push([r.externalId, r.status]);
      }
      if (step.done) break;
      cursor = { ...step.cursor };
    }
    expect(statuses).toEqual([
      [String(E.HANNAH_WRIGHT), "DEACTIVATED"],
      [String(E.LEO_TURNER), "REMOVED"],
      [String(E.AISHA_KHAN), "ACTIVE"],
    ]);
  });

  it("re-checks at most 20 employees per run", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => String(990000 + i));
    const sink = createMemorySink();
    await runPhasesInMemory(provider(), context(syncSettings()), sink, {
      kind: "SYNC",
      inputsFor: (phase) => (phase === "ABSENT_EMPLOYEES" ? { recheckExternalIds: ids } : {}),
    });
    expect(
      apiRequests().filter((e) => e.template === "/hr/v1.0/employees/{employeeId}"),
    ).toHaveLength(20);
  });

  it("reads the window's shifts, the deleted list and the absent shifts by id", async () => {
    const specials = mock.fixture.specials;
    const window = syncWindow(FROZEN_NOW, ZONE, 28);
    // A future pattern shift of Ben (Bar) to delete; the draft and a 404 to re-check.
    const deletable = mock.fixture.portals[0]!.shifts.find(
      (s) => s.employeeId === E.BEN_CARTER && s.status === "Assigned" && s.start > "2026-11-0",
    )!;
    mock.controls.deleteShift(deletable.id);
    const sink = createMemorySink();
    const run = await runPhasesInMemory(
      provider(),
      context(syncSettings({ deletedShiftsSince: new Date("2026-10-20T00:00:00Z") })),
      sink,
      {
        kind: "SYNC",
        inputsFor: (phase) =>
          phase === "ABSENT_SHIFTS"
            ? {
                recheckExternalIds: [
                  String(deletable.id),
                  String(specials.draftShiftId),
                  String(specials.inProgressShiftId),
                ],
              }
            : {},
      },
    );
    const synced = shiftsOf(sink);
    for (const s of synced.slice(0, -1)) {
      expect(s.endsAt.getTime()).toBeGreaterThan(window.from.getTime());
      expect(s.startsAt.getTime()).toBeLessThan(window.to.getTime());
    }
    expect(synced.some((s) => s.externalId === String(deletable.id))).toBe(false);
    // The hidden-day shifts are imported while the filter is off (D-040).
    for (const id of specials.hiddenDay.shiftIds) {
      expect(synced.find((s) => s.externalId === String(id))).toMatchObject({ cancelled: false });
    }
    expect(sink.shiftRemovals.get(String(deletable.id))).toBe("NOT_FOUND");
    expect(sink.shiftRemovals.get(String(specials.draftShiftId))).toBe("DRAFT");
    const removalBatches = sink.batches.filter((b) => b.kind === "SHIFT_REMOVALS");
    expect(removalBatches[0]).toEqual({
      kind: "SHIFT_REMOVALS",
      records: [{ externalId: String(deletable.id), reason: "DELETED" }],
    });
    const deleted = apiRequests("/scheduling/v1.0/shifts/deleted")[0]!;
    expect(deleted.query.deletedFrom).toEqual(["2026-10-19T00:00:00Z"]);
    // The in-progress shift re-read by id comes back as a SHIFTS batch with the window.
    const last = sink.batches.at(-1)!;
    expect(last).toMatchObject({ kind: "SHIFTS", window: { from: window.from, to: window.to } });
    const reread = (last as Extract<SyncBatch, { kind: "SHIFTS" }>).records[0]!;
    expect(reread.externalId).toBe(String(specials.inProgressShiftId));
    expect(run.warnings).toEqual([]);
  });

  it("switches to 14-day slices when Planday refuses the range (Q37) and reads the same shifts", async () => {
    const plain = createMemorySink();
    await runPhasesInMemory(provider(), context(syncSettings()), plain, { kind: "SYNC" });
    mock.controls.reset();
    mock.controls.setMaxShiftRangeDays(14);
    const sliced = createMemorySink();
    const run = await runPhasesInMemory(provider(), context(syncSettings()), sliced, {
      kind: "SYNC",
    });
    const ids = (sink: MemorySink) => [...new Set(shiftsOf(sink).map((s) => s.externalId))].sort();
    expect(ids(sliced)).toEqual(ids(plain));
    const shiftCursors = run.cursors.filter((c) => c.phase === "SHIFTS");
    expect(shiftCursors.at(-1)!.cursor.slices).toBeInstanceOf(Array);
    const ranges = apiRequests("/scheduling/v1.0/shifts").map((e) => [
      e.query.from?.[0],
      e.query.to?.[0],
      e.status,
    ]);
    expect(ranges[0]![2]).toBe(400);
    expect(ranges.slice(1).every((r) => r[2] === 200)).toBe(true);
  });

  it("skips an undocumented status and unreadable times with warnings, never as records", async () => {
    const specials = mock.fixture.specials;
    const future = mock.fixture.portals[0]!.shifts.find(
      (s) => s.employeeId === E.CHLOE_DAVIES && s.status === "Assigned" && s.start > "2026-10-26",
    )!;
    mock.controls.setShiftStatus(future.id, "Mystery");
    mock.controls.editShift(specials.forSaleShiftId, { timeZone: "W. Europe Standard Time" });
    const step = await provider().runPhaseStep(context(syncSettings()), "SHIFTS", {}, {});
    const records = (step.batch as Extract<SyncBatch, { kind: "SHIFTS" }>).records;
    expect(records.some((r) => r.externalId === String(future.id))).toBe(false);
    expect(records.some((r) => r.externalId === String(specials.forSaleShiftId))).toBe(false);
    const codes = (step.warnings ?? []).map((w) => [plandayWarningCode(w), w.code, w.externalId]);
    expect(codes).toContainEqual(["UNKNOWN_STATUS", "MAPPING_FAILED", String(future.id)]);
    expect(codes).toContainEqual(["INVALID_TIME", "INVALID_TIME", String(specials.forSaleShiftId)]);
    for (const w of step.warnings ?? []) expect(w.message).not.toContain(SENTINEL_PII_PREFIX);
  });

  it("a draft whose times cannot be read is dropped from SHIFTS and a removal when re-read by id", async () => {
    const future = mock.fixture.portals[0]!.shifts.find(
      (s) => s.employeeId === E.CHLOE_DAVIES && s.status === "Assigned" && s.start > "2026-10-26",
    )!;
    mock.controls.setShiftStatus(future.id, "Draft");
    mock.controls.editShift(future.id, { timeZone: "W. Europe Standard Time" });
    const page = await provider().runPhaseStep(context(syncSettings()), "SHIFTS", {}, {});
    const records = (page.batch as Extract<SyncBatch, { kind: "SHIFTS" }>).records;
    expect(records.some((r) => r.externalId === String(future.id))).toBe(false);
    expect((page.warnings ?? []).some((w) => w.externalId === String(future.id))).toBe(false);
    const step = await provider().runPhaseStep(
      context(syncSettings()),
      "ABSENT_SHIFTS",
      {},
      { recheckExternalIds: [String(future.id)] },
    );
    expect(step.batch).toEqual({
      kind: "SHIFT_REMOVALS",
      records: [{ externalId: String(future.id), reason: "DRAFT" }],
    });
    expect(step.warnings ?? []).toEqual([]);
  });

  it("fails the page when the date-time encoding disagrees with `date` (TIME_ENCODING_MISMATCH)", async () => {
    mock.controls.setDateTimeFormat("utc-without-z");
    const inProgress = mock.fixture.specials.inProgressShiftId;
    mock.controls.editShift(inProgress, {
      startDateTime: "2026-10-21T00:30:00",
      endDateTime: "2026-10-21T08:30:00",
    });
    const err = await rejection(provider().runPhaseStep(context(syncSettings()), "SHIFTS", {}, {}));
    expect(err).toBeInstanceOf(PlandayError);
    expect((err as PlandayError).reason).toBe("TIME_ENCODING_MISMATCH");
  });

  it("reads hidden days per included department; a 404 skips the filter for that department (Q35)", async () => {
    const hidden = mock.fixture.specials.hiddenDay;
    const sink = createMemorySink();
    await runPhasesInMemory(provider(), context(syncSettings()), sink, {
      kind: "SYNC",
      phaseOptions: { clockEvents: false, hiddenDays: true },
    });
    expect([...sink.hiddenDays]).toEqual([`${hidden.departmentId}:${hidden.date}`]);
    expect(
      apiRequests("/scheduling/v1.0/scheduleDay").map((e) => e.query.departmentId?.[0]),
    ).toEqual([String(BAR), String(KITCHEN)]);

    mock.controls.reset();
    mock.controls.queueError({ path: "/scheduling/v1.0/scheduleDay", status: 404 });
    const p = provider();
    const ctx = context(syncSettings());
    const first = await p.runPhaseStep(ctx, "SCHEDULE_DAYS", {}, {});
    expect(first.done).toBe(false);
    expect(first.batch).toBeUndefined();
    expect(first.warnings?.map((w) => [plandayWarningCode(w), w.externalId])).toEqual([
      ["HIDDEN_DAYS_UNAVAILABLE", String(BAR)],
    ]);
    const second = await p.runPhaseStep(ctx, "SCHEDULE_DAYS", first.cursor, {});
    expect(second.done).toBe(true);
    expect(second.batch).toEqual({
      kind: "HIDDEN_DAYS",
      days: [{ externalDepartmentId: String(KITCHEN), date: hidden.date }],
    });
  });

  it("CLOCK_EVENTS: included departments only, portal-qualified ids, breaks of finished punches", async () => {
    const step = await provider().runPhaseStep(
      context(
        syncSettings({
          clockEventsFrom: new Date("2026-10-18T00:00:00Z"),
          punchBreaksSince: new Date("2026-10-18T00:00:00Z"),
        }),
      ),
      "CLOCK_EVENTS",
      {},
      {},
    );
    expect(step.done).toBe(true);
    const events = (step.batch as Extract<SyncBatch, { kind: "CLOCK_EVENTS" }>).records;
    const ids = events.map((e) => e.externalId).sort();
    expect(ids).toEqual(
      [
        `${PORTAL}:800001:in`,
        `${PORTAL}:800002:in`,
        `${PORTAL}:800002:out`,
        `${PORTAL}:810001:start`,
        `${PORTAL}:810001:end`,
      ].sort(),
    );
    // Omar's punch in the excluded Head Office never leaves the provider.
    expect(events.some((e) => e.externalEmployeeId === String(E.OMAR_SAID))).toBe(false);
    expect(events.find((e) => e.externalId === `${PORTAL}:800001:in`)).toMatchObject({
      type: "CLOCK_IN",
      externalEmployeeId: String(E.AISHA_KHAN),
      occurredAt: new Date("2026-10-21T07:58:00Z"),
    });
    // Without the included departments nothing is kept.
    const none = await provider().runPhaseStep(context(settings()), "CLOCK_EVENTS", {}, {});
    expect((none.batch as Extract<SyncBatch, { kind: "CLOCK_EVENTS" }>).records).toEqual([]);
    expect(String(HEAD_OFFICE)).not.toBe(INCLUDED[0]);
  });

  it("an aborted signal stops an API phase without a request", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await rejection(
      provider().runPhaseStep(
        context(syncSettings(), { signal: controller.signal }),
        "DEPARTMENTS",
        {},
        {},
      ),
    );
    expect(isAbortError(err)).toBe(true);
    expect(apiRequests()).toEqual([]);
  });

  it("keeps cursor keys it does not own (the executor's state)", async () => {
    const step = await provider().runPhaseStep(
      context(syncSettings()),
      "DEPARTMENTS",
      { mine: [1] },
      {},
    );
    expect(step.cursor).toMatchObject({ mine: [1], offset: 3, pages: 1 });
  });
});

describe("connect() (§3.3, §5.6)", () => {
  const params = (credentials: unknown) => ({ activationMode: "SCHEDULED" as const, credentials });
  const connectCtx = (): ProviderContext => ({
    organisationId: "org-1",
    integrationId: "integration-1",
    settings: {},
    now: FROZEN_NOW,
  });

  it("method C: token, portal and scope probes; returns everything to persist, nothing else", async () => {
    const result = await provider().connect(
      connectCtx(),
      params({
        method: "CUSTOMER_OWN_APP",
        clientId: MOCK_CUSTOMER_APP_ID,
        refreshToken: MOCK_REFRESH_TOKEN,
      }),
    );
    expect(result.kind).toBe("CONNECTED");
    if (result.kind !== "CONNECTED") return;
    expect(result.externalAccountId).toBe(PORTAL);
    expect(result.externalAccountName).toBe("Mock Bistro Group");
    expect(isPlandayConnectedCredentials(result.credentials)).toBe(true);
    const connected = result.credentials as PlandayConnectedCredentials;
    expect(connected.method).toBe("CUSTOMER_OWN_APP");
    expect(connected.scopesGranted).toEqual([...REQUIRED_SCOPES]);
    expect(connected.portal).toMatchObject({ externalId: PORTAL, timezone: ZONE });
    expect(connected.credentials).toMatchObject({
      clientId: MOCK_CUSTOMER_APP_ID,
      refreshToken: MOCK_REFRESH_TOKEN,
    });
    expect(connected.credentials.accessToken).toEqual(expect.any(String));
    expect(result.tokenExpiresAt).toEqual(connected.credentials.accessTokenExpiresAt);
    // The probes: limit=1 reads of every required endpoint, today's shifts.
    const probes = apiRequests().filter((e) => e.query.limit?.[0] === "1");
    expect(probes.map((e) => e.path)).toEqual([
      "/hr/v1.0/departments",
      "/hr/v1.0/employeegroups",
      "/hr/v1.0/employees",
      "/scheduling/v1.0/shifts",
    ]);
    expect(probes.at(-1)!.query.from).toEqual(["2026-10-21"]);
  });

  it("returns the rotated refresh token when Planday rotates it during the proof", async () => {
    mock.controls.setRotateRefreshTokens(true);
    const result = await provider().connect(
      connectCtx(),
      params({
        method: "CUSTOMER_OWN_APP",
        clientId: MOCK_CUSTOMER_APP_ID,
        refreshToken: MOCK_REFRESH_TOKEN,
      }),
    );
    const connected = (result as { credentials: PlandayConnectedCredentials }).credentials;
    expect(connected.credentials.refreshToken).not.toBe(MOCK_REFRESH_TOKEN);
  });

  it("method C without a required scope fails naming it, and nothing is returned", async () => {
    mock.controls.setScopes(
      MOCK_CUSTOMER_APP_ID,
      MOCK_READ_SCOPES.filter((s) => s !== "employee:read" && s !== "shift:read"),
    );
    const err = await rejection(
      provider().connect(
        connectCtx(),
        params({
          method: "CUSTOMER_OWN_APP",
          clientId: MOCK_CUSTOMER_APP_ID,
          refreshToken: MOCK_REFRESH_TOKEN,
        }),
      ),
    );
    expect(err).toBeInstanceOf(PlandayError);
    expect((err as PlandayError).code).toBe("PLANDAY_SCOPE_MISSING");
    expect((err as PlandayError).missingScopes).toEqual(["employee:read", "shift:read"]);
  });

  it("clock mode also requires and probes the punch clock", async () => {
    mock.controls.setScopes(
      MOCK_CUSTOMER_APP_ID,
      MOCK_READ_SCOPES.filter((s) => s !== "punchclockshift:read"),
    );
    const err = await rejection(
      provider({ clockModeEnabled: true }).connect(
        connectCtx(),
        params({
          method: "CUSTOMER_OWN_APP",
          clientId: MOCK_CUSTOMER_APP_ID,
          refreshToken: MOCK_REFRESH_TOKEN,
        }),
      ),
    );
    expect((err as PlandayError).missingScopes).toEqual(["punchclockshift:read"]);
  });

  it("method B: ClockOff's App ID and the pasted token", async () => {
    const { refreshToken } = mock.controls.issueTokenForApp(PARTNER_APP_ID);
    const result = await provider().connect(
      connectCtx(),
      params({ method: "CUSTOMER_ADDED_APP_ID", clientId: PARTNER_APP_ID, refreshToken }),
    );
    expect((result as { credentials: PlandayConnectedCredentials }).credentials).toMatchObject({
      method: "CUSTOMER_ADDED_APP_ID",
      credentials: { clientId: PARTNER_APP_ID },
    });
  });

  it("method A: only a verified authorization code is exchanged; scopes come from the token response", async () => {
    const scope = ["openid", "offline_access", ...MOCK_READ_SCOPES].join(" ");
    const { code } = mock.controls.issueAuthorizationCode({
      clientId: PARTNER_APP_ID,
      redirectUri: CALLBACK,
      scope,
    });
    const result = await provider().connect(
      connectCtx(),
      params({
        method: "OAUTH",
        clientId: PARTNER_APP_ID,
        authorization: verifiedAuthorizationCode({ code, redirectUri: CALLBACK }),
      }),
    );
    expect(result.kind).toBe("CONNECTED");
    const connected = (result as { credentials: PlandayConnectedCredentials }).credentials;
    expect(connected.method).toBe("OAUTH");
    expect(connected.scopesGranted).toEqual(expect.arrayContaining([...REQUIRED_SCOPES]));
    expect(connected.credentials.refreshToken).toEqual(expect.any(String));
    const exchange = tokenRequests()[0]!;
    expect(exchange.form?.grant_type).toBe("authorization_code");
    // No refresh grant: the exchange's tokens read the portal.
    expect(tokenRequests()).toHaveLength(1);
  });

  it("refuses the generic connect fields and anything but PlandayConnectCredentials", async () => {
    const p = provider();
    const refused = [
      { activationMode: "SCHEDULED" as const, authorizationCode: "abc", redirectUri: CALLBACK },
      { activationMode: "SCHEDULED" as const, state: "xyz" },
      params(undefined),
      params({
        method: "OAUTH",
        clientId: PARTNER_APP_ID,
        authorization: { code: "abc", redirectUri: CALLBACK },
      }),
      params({ method: "CUSTOMER_OWN_APP", clientId: MOCK_CUSTOMER_APP_ID }),
      params({
        method: "SOMETHING",
        clientId: MOCK_CUSTOMER_APP_ID,
        refreshToken: MOCK_REFRESH_TOKEN,
      }),
      params({ method: "CUSTOMER_OWN_APP", clientId: "", refreshToken: MOCK_REFRESH_TOKEN }),
    ];
    for (const input of refused) {
      const err = await rejection(p.connect(connectCtx(), input));
      expect(err).toBeInstanceOf(PlandayConnectRefusedError);
      expect((err as PlandayError).code).toBe("PLANDAY_AUTH_FAILED");
      expect((err as Error).message).toContain("use the Planday connect endpoints");
    }
    expect(mock.requestLog).toEqual([]);
  });

  it("never answers REDIRECT_REQUIRED", async () => {
    const result = await provider().connect(
      connectCtx(),
      params({
        method: "CUSTOMER_OWN_APP",
        clientId: MOCK_CUSTOMER_APP_ID,
        refreshToken: MOCK_REFRESH_TOKEN,
      }),
    );
    expect(result.kind).not.toBe("REDIRECT_REQUIRED");
  });

  it("verifiedAuthorizationCode needs a code and a redirect URI", () => {
    expect(() => verifiedAuthorizationCode({ code: "", redirectUri: CALLBACK })).toThrow(TypeError);
    const v = verifiedAuthorizationCode({ code: "c", redirectUri: CALLBACK, codeVerifier: null });
    expect(v).toEqual({ code: "c", redirectUri: CALLBACK });
    expect(Object.isFrozen(v)).toBe(true);
  });
});

describe("the classic WorkforceProvider surface", () => {
  it("syncEmployees / syncLocations / syncTeams / syncShifts / syncClockEvents loop a phase into ctx.sink", async () => {
    const p = provider();
    const sink = createMemorySink();
    const ctx = context(settings({ includedDepartmentIds: INCLUDED }), { sink });
    expect(await p.syncLocations(ctx)).toMatchObject({
      provider: "PLANDAY",
      created: 3,
      errors: [],
    });
    expect(await p.syncTeams(ctx)).toMatchObject({ created: 4 });
    expect(await p.syncEmployees(ctx)).toMatchObject({ created: 11 });
    expect(await p.syncEmployees(ctx)).toMatchObject({ created: 0, skipped: 11 });
    const window = syncWindow(FROZEN_NOW, ZONE, 7);
    const shifts = await p.syncShifts(ctx, { from: window.from, to: window.to });
    expect(shifts.created).toBeGreaterThan(0);
    const clock = await p.syncClockEvents(ctx, new Date("2026-10-18T00:00:00Z"));
    expect(clock.created).toBeGreaterThan(0);
    expect(sink.clockEvents.has(`${PORTAL}:800002:out`)).toBe(true);
  });

  it("maps Planday errors to ProviderError", async () => {
    mock.controls.revokeRefreshToken("all");
    const err = await rejection(
      provider().syncEmployees(context(settings(), { sink: createMemorySink() })),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("AUTH_EXPIRED");
    expect((err as ProviderError).retryable).toBe(false);
  });

  it("refreshAuthentication runs the refresh grant; getConnectionStatus reads the store", async () => {
    const p = provider();
    const ctx = context(settings());
    await p.refreshAuthentication(ctx);
    await p.refreshAuthentication(ctx);
    expect(tokenRequests()).toHaveLength(2);
    expect(await p.getConnectionStatus(ctx)).toMatchObject({
      status: "CONNECTED",
      connected: true,
    });
    expect(await p.getConnectionStatus({ ...ctx, credentialStore: undefined })).toMatchObject({
      status: "NOT_CONNECTED",
      connected: false,
    });
  });

  it("disconnect revokes the given refresh token once, best effort", async () => {
    await provider().disconnect({
      ...context(settings()),
      credentials: { clientId: MOCK_CUSTOMER_APP_ID, refreshToken: MOCK_REFRESH_TOKEN },
    });
    const revocations = mock.requestLog.filter((e) => e.path === "/connect/revocation");
    expect(revocations).toHaveLength(1);
    expect(revocations[0]!.form).toMatchObject({
      client_id: MOCK_CUSTOMER_APP_ID,
      token: MOCK_REFRESH_TOKEN,
    });
    // Without credentials: nothing.
    await provider().disconnect(context(settings()));
    expect(mock.requestLog.filter((e) => e.path === "/connect/revocation")).toHaveLength(1);
  });
});
