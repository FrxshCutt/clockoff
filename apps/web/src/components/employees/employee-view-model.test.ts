import type { ActivityEvent } from "@clockoff/validation/activity";
import type { EmployeeDetail, EmployeeStateResponse } from "@clockoff/validation/employees";
import { describe, expect, it } from "vitest";
import {
  buildSetupChecklist,
  buildTodayTimeline,
  describeExpectedVsReported,
  describeNextShift,
  describeResolvedFrom,
  employeeFullName,
  employeeScheduleWindow,
  permissionGuidance,
} from "./employee-view-model";

const ID = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";
const TEAM = { id: "8d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d", name: "Front of House" };
const LOCATION = { id: "9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d", name: "Harbour" };

describe("describeResolvedFrom", () => {
  it("names the team only when the employee has exactly one", () => {
    expect(
      describeResolvedFrom({ resolvedFrom: "TEAM" }, { teams: [TEAM], primaryLocation: null })
        ?.subtitle,
    ).toBe("from Team: Front of House");
    expect(
      describeResolvedFrom(
        { resolvedFrom: "TEAM" },
        { teams: [TEAM, { ...TEAM, id: ID, name: "Kitchen" }], primaryLocation: null },
      )?.subtitle,
    ).toBe("from Team");
  });

  it("uses the primary location for LOCATION and plain labels for the rest", () => {
    expect(
      describeResolvedFrom({ resolvedFrom: "LOCATION" }, { teams: [], primaryLocation: LOCATION })
        ?.subtitle,
    ).toBe("from Location: Harbour");
    expect(
      describeResolvedFrom({ resolvedFrom: "EMPLOYEE" }, { teams: [], primaryLocation: null })
        ?.subtitle,
    ).toBe("Employee override");
    expect(
      describeResolvedFrom({ resolvedFrom: "DEFAULT" }, { teams: [], primaryLocation: null })
        ?.subtitle,
    ).toBe("Organisation default");
    expect(describeResolvedFrom(null, { teams: [], primaryLocation: null })).toBeNull();
  });
});

describe("describeNextShift", () => {
  const tz = "Europe/London";
  it("says Today / Tomorrow / a date in the shift's zone", () => {
    const now = "2026-10-06T08:00:00.000Z"; // 09:00 BST
    expect(
      describeNextShift(
        { startsAt: "2026-10-06T08:30:00.000Z", endsAt: "2026-10-06T16:00:00.000Z", timezone: tz },
        now,
      ),
    ).toEqual({ primary: "Today", range: "09:30–17:00", isActive: false });
    expect(
      describeNextShift(
        { startsAt: "2026-10-07T08:00:00.000Z", endsAt: "2026-10-07T16:00:00.000Z", timezone: tz },
        now,
      )?.primary,
    ).toBe("Tomorrow");
    expect(
      describeNextShift(
        { startsAt: "2026-10-09T08:00:00.000Z", endsAt: "2026-10-09T16:00:00.000Z", timezone: tz },
        now,
      )?.primary,
    ).toBe("09/10/2026");
  });

  it("marks the current shift and overnight shifts", () => {
    const current = describeNextShift(
      { startsAt: "2026-10-06T06:00:00.000Z", endsAt: "2026-10-06T14:00:00.000Z", timezone: tz },
      "2026-10-06T08:00:00.000Z",
    );
    expect(current).toEqual({ primary: "In progress", range: "07:00–15:00", isActive: true });
    const overnight = describeNextShift(
      { startsAt: "2026-10-06T21:00:00.000Z", endsAt: "2026-10-07T05:00:00.000Z", timezone: tz },
      "2026-10-06T08:00:00.000Z",
    );
    expect(overnight?.range).toBe("22:00–06:00 (+1)");
  });

  it("returns null without a shift or with bad instants", () => {
    expect(describeNextShift(null, Date.now())).toBeNull();
    expect(
      describeNextShift({ startsAt: "nope", endsAt: "nope", timezone: tz }, Date.now()),
    ).toBeNull();
  });
});

describe("buildSetupChecklist", () => {
  const base = { latestInvite: null, device: null } as Pick<
    EmployeeDetail,
    "device" | "latestInvite"
  >;
  it("ticks steps in lifecycle order", () => {
    expect(
      buildSetupChecklist({ ...base, inviteStatus: "NOT_INVITED" }).map((s) => s.done),
    ).toEqual([false, false, false, false, false]);
    expect(buildSetupChecklist({ ...base, inviteStatus: "INVITED" }).map((s) => s.done)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    const device = {
      permissionState: "APPROVED",
      selectionState: "NONE",
      isActive: true,
    } as unknown as NonNullable<EmployeeDetail["device"]>;
    expect(
      buildSetupChecklist({ ...base, inviteStatus: "SETUP_INCOMPLETE", device }).map((s) => s.done),
    ).toEqual([true, true, true, false, false]);
    const connected = { ...device, selectionState: "CONFIGURED" } as unknown as NonNullable<
      EmployeeDetail["device"]
    >;
    expect(
      buildSetupChecklist({ ...base, inviteStatus: "CONNECTED", device: connected }).every(
        (s) => s.done,
      ),
    ).toBe(true);
  });

  it("ignores a deactivated device", () => {
    const device = {
      permissionState: "APPROVED",
      selectionState: "CONFIGURED",
      isActive: false,
    } as unknown as NonNullable<EmployeeDetail["device"]>;
    const steps = buildSetupChecklist({ ...base, inviteStatus: "DEACTIVATED", device });
    expect(steps.find((s) => s.key === "permission")?.done).toBe(false);
  });
});

describe("permissionGuidance", () => {
  it("gives repair guidance per state and nothing without a device", () => {
    expect(permissionGuidance(null)).toBeNull();
    const denied = permissionGuidance({ permissionState: "DENIED", selectionState: "NONE" });
    expect(denied?.permission.tone).toBe("danger");
    expect(denied?.permission.guidance).toContain("Settings");
    expect(denied?.selection.tone).toBe("warning");
    const ok = permissionGuidance({ permissionState: "APPROVED", selectionState: "CONFIGURED" });
    expect(ok?.permission.tone).toBe("success");
    expect(ok?.selection.guidance).toContain("never shared");
  });
});

function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: ID,
    type: "WORK_MODE_STARTED",
    occurredAt: "2026-10-06T08:00:00.000Z",
    actorType: "EMPLOYEE_DEVICE",
    actor: null,
    employee: null,
    deviceId: null,
    summary: "Work Mode started",
    metadata: {},
    ...overrides,
  };
}

function state(
  overrides: Partial<EmployeeStateResponse["expected"]>,
  timeline: ActivityEvent[],
): Pick<EmployeeStateResponse, "timeline" | "expected" | "activeShift"> {
  return {
    timeline,
    activeShift: null,
    expected: {
      state: "WORKING",
      effectiveRestriction: "WORK",
      restrictionsShouldBeActive: true,
      computedAt: "2026-10-06T09:00:00.000Z",
      timezone: "Europe/London",
      permissionState: "APPROVED",
      activeShift: {
        id: ID,
        startsAt: "2026-10-06T07:00:00.000Z",
        endsAt: "2026-10-06T15:00:00.000Z",
      },
      upcomingShift: null,
      activeBreak: null,
      activeOverride: null,
      workingInterval: null,
      relaxation: null,
      nextTransitionAt: "2026-10-06T15:00:00.000Z",
      ...overrides,
    },
  };
}

describe("buildTodayTimeline", () => {
  const now = "2026-10-06T09:00:00.000Z";

  it("orders events, shift boundaries and the now marker chronologically", () => {
    const entries = buildTodayTimeline(
      state({}, [
        event({ id: "b", occurredAt: "2026-10-06T07:00:30.000Z", summary: "Work Mode started" }),
        event({
          id: "a",
          type: "SCHEDULE_SYNCED",
          occurredAt: "2026-10-06T06:50:00.000Z",
          summary: "Schedule synced",
        }),
      ]),
      now,
    );
    expect(entries.map((e) => e.kind)).toEqual(["event", "shiftStart", "event", "now", "shiftEnd"]);
    expect(entries.filter((e) => e.isFuture).map((e) => e.kind)).toEqual(["shiftEnd"]);
    expect(entries.find((e) => e.kind === "shiftStart")?.title).toBe("Shift started");
    expect(entries.find((e) => e.kind === "shiftEnd")?.title).toBe("Shift ends");
  });

  it("adds the next transition only when it is not already a shift boundary", () => {
    const sameAsEnd = buildTodayTimeline(state({}, []), now);
    expect(sameAsEnd.some((e) => e.kind === "nextTransition")).toBe(false);
    const breakEnd = buildTodayTimeline(
      state({ nextTransitionAt: "2026-10-06T09:15:00.000Z" }, []),
      now,
    );
    const next = breakEnd.find((e) => e.kind === "nextTransition");
    expect(next?.at).toBe("2026-10-06T09:15:00.000Z");
    expect(next?.isFuture).toBe(true);
  });

  it("uses the upcoming shift when no shift is active, and tones events by type", () => {
    const entries = buildTodayTimeline(
      state(
        {
          state: "OFF_SHIFT",
          activeShift: null,
          upcomingShift: {
            id: ID,
            startsAt: "2026-10-06T12:00:00.000Z",
            endsAt: "2026-10-06T18:00:00.000Z",
          },
          nextTransitionAt: "2026-10-06T12:00:00.000Z",
        },
        [
          event({
            type: "PERMISSION_NEEDS_ATTENTION",
            summary: "Permission needs attention",
            actorType: "MANAGER",
            actor: { id: ID, name: "Ada", email: null },
          }),
        ],
      ),
      now,
    );
    expect(entries.find((e) => e.kind === "shiftStart")?.title).toBe("Shift starts");
    expect(entries.find((e) => e.kind === "event")?.tone).toBe("danger");
    expect(entries.find((e) => e.kind === "event")?.detail).toBe("by Ada");
    expect(entries.some((e) => e.kind === "nextTransition")).toBe(false);
  });
});

describe("describeExpectedVsReported", () => {
  const expected = state({}, []).expected;
  it("summarises the relationship between expected and reported", () => {
    expect(
      describeExpectedVsReported({
        expected,
        reported: { state: null, reportedAt: null },
        diverged: false,
      }).summary,
    ).toContain("hasn't reported");
    expect(
      describeExpectedVsReported({
        expected,
        reported: { state: "WORKING", reportedAt: null },
        diverged: false,
      }).summary,
    ).toContain("matches");
    expect(
      describeExpectedVsReported({
        expected,
        reported: { state: "OFF_SHIFT", reportedAt: null },
        diverged: true,
      }).summary,
    ).toContain("disagrees");
    expect(
      describeExpectedVsReported({
        expected,
        reported: { state: "OFF_SHIFT", reportedAt: null },
        diverged: false,
      }).summary,
    ).toContain("catching up");
  });
});

describe("employeeScheduleWindow", () => {
  it("spans yesterday to two weeks ahead, anchored to the start of the hour", () => {
    const range = employeeScheduleWindow(Date.parse("2026-10-06T09:17:42.000Z"));
    expect(range).toEqual({ from: "2026-10-05T09:00:00.000Z", to: "2026-10-20T09:00:00.000Z" });
    // Later in the same hour → identical key, so the query does not refetch on every tick.
    expect(employeeScheduleWindow(Date.parse("2026-10-06T09:59:59.000Z"))).toEqual(range);
  });
});

describe("employeeFullName", () => {
  it("joins first and last names", () => {
    expect(employeeFullName({ firstName: "Ada", lastName: "Lovelace" })).toBe("Ada Lovelace");
  });
});
