import { ACTIVITY_EVENT_TYPES, INTEGRATION_ACTIVITY_EVENT_TYPES } from "@clockoff/shared/enums";
import type { ActivityEvent } from "@clockoff/validation/activity";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TYPE_OPTIONS,
  activityTypeLabel,
  activityTypeSelectOptions,
  describeActor,
  groupActivityByDay,
  isActivityEventType,
} from "./activity-feed-model";

const ID = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a1";

function event(
  id: string,
  occurredAt: string,
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    id: `${ID}${id}`,
    type: "WORK_MODE_STARTED",
    occurredAt,
    actorType: "EMPLOYEE_DEVICE",
    actor: null,
    employee: null,
    deviceId: null,
    summary: "Work Mode started",
    metadata: {},
    ...overrides,
  };
}

describe("activity type labels", () => {
  it("has an option for every event type and labels unknown ones gracefully", () => {
    expect(ACTIVITY_TYPE_OPTIONS.map((o) => o.id).sort()).toEqual([...ACTIVITY_EVENT_TYPES].sort());
    expect(activityTypeLabel("BREAK_STARTED")).toBe("Break started");
    expect(activityTypeLabel("SOMETHING_NEW")).toBe("Something new");
    expect(isActivityEventType("BREAK_ENDED")).toBe(true);
    expect(isActivityEventType("nope")).toBe(false);
  });

  it("offers the integration-only types only while Planday is switched on", () => {
    expect(activityTypeSelectOptions(true)).toBe(ACTIVITY_TYPE_OPTIONS);
    const dark = activityTypeSelectOptions(false).map((o) => o.id);
    expect(dark).toHaveLength(
      ACTIVITY_EVENT_TYPES.length - INTEGRATION_ACTIVITY_EVENT_TYPES.length,
    );
    for (const type of INTEGRATION_ACTIVITY_EVENT_TYPES) expect(dark).not.toContain(type);
    expect(dark).toContain("INTEGRATION_ERROR");
    expect(activityTypeLabel("EMPLOYEE_DEACTIVATED")).toBe("Deactivated by integration");
  });
});

describe("groupActivityByDay", () => {
  it("groups consecutive events by local day in the given zone and drops duplicate ids", () => {
    const groups = groupActivityByDay(
      [
        event("1", "2026-10-06T23:30:00.000Z"), // 00:30 on the 7th in London (BST)
        event("2", "2026-10-06T20:00:00.000Z"),
        event("2", "2026-10-06T20:00:00.000Z"),
        event("3", "2026-10-05T08:00:00.000Z"),
      ],
      "Europe/London",
    );
    expect(groups.map((g) => [g.day, g.events.length])).toEqual([
      ["2026-10-07", 1],
      ["2026-10-06", 1],
      ["2026-10-05", 1],
    ]);
    expect(groups[0]?.at).toBe("2026-10-06T23:30:00.000Z");
  });

  it("keeps the same day together in UTC when no zone is given", () => {
    const groups = groupActivityByDay(
      [event("1", "2026-10-06T23:30:00.000Z"), event("2", "2026-10-06T01:00:00.000Z")],
      "UTC",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.events).toHaveLength(2);
  });
});

describe("describeActor", () => {
  it("names managers, devices and the system", () => {
    expect(
      describeActor({ actorType: "MANAGER", actor: { id: ID + "0", name: "Ada", email: null } }),
    ).toBe("Ada");
    expect(describeActor({ actorType: "MANAGER", actor: null })).toBe("A manager");
    expect(describeActor({ actorType: "EMPLOYEE_DEVICE", actor: null })).toBe("Device");
    expect(describeActor({ actorType: "SYSTEM", actor: null })).toBe("ClockOff");
  });
});
