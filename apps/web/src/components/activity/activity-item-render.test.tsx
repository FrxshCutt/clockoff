import { ACTIVITY_EVENT_TYPES, type ActivityEventType } from "@clockoff/shared/enums";
import type { ActivityEvent } from "@clockoff/validation/activity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_ICON_COMPONENTS,
  ActivityItem,
  ActivityList,
  ActivityListSkeleton,
} from "./activity-item";
import { ACTIVITY_ICONS } from "./activity-meta";

const EMPLOYEE_ID = "0b0e2e9e-7c0a-4a2b-9e3b-1b4c2a9d8f10";

function event(
  type: ActivityEventType,
  index: number,
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    type,
    occurredAt: "2026-10-06T09:00:00.000Z",
    actorType: "EMPLOYEE_DEVICE",
    actor: null,
    employee: {
      id: EMPLOYEE_ID,
      firstName: "Jane",
      lastName: "Smith",
      jobTitle: "Barista",
      primaryLocation: null,
      inviteStatus: "CONNECTED",
    },
    deviceId: null,
    summary: "",
    metadata: {},
    ...overrides,
  };
}

describe("ActivityItem", () => {
  it("has a lucide component for every icon key", () => {
    expect(Object.keys(ACTIVITY_ICON_COMPONENTS).sort()).toEqual([...ACTIVITY_ICONS].sort());
  });

  it("renders every event type with its icon, label and employee link", () => {
    const events = ACTIVITY_EVENT_TYPES.map((type, index) => event(type, index));
    const html = renderToStaticMarkup(<ActivityList events={events} label="Feed" />);
    expect(html).toContain('aria-label="Feed"');
    for (const type of ACTIVITY_EVENT_TYPES) expect(html).toContain(`data-event-type="${type}"`);
    expect((html.match(/<li /g) ?? []).length).toBe(ACTIVITY_EVENT_TYPES.length);
    expect((html.match(new RegExp(`href="/employees/${EMPLOYEE_ID}"`, "g")) ?? []).length).toBe(
      ACTIVITY_EVENT_TYPES.length,
    );
    expect((html.match(/<svg /g) ?? []).length).toBe(ACTIVITY_EVENT_TYPES.length);
    expect(html).not.toMatch(/undefined|\[object/);
  });

  it("shows the sentence, the acting manager and a machine-readable time", () => {
    const html = renderToStaticMarkup(
      <ActivityItem
        event={event("OVERRIDE_CREATED", 1, {
          actorType: "MANAGER",
          actor: { id: "u", name: "Ada Lovelace", email: null },
          metadata: { overrideType: "END_WORK_MODE_EARLY" },
        })}
      />,
    );
    expect(html).toContain("Ada Lovelace created a “End work mode early” override for Jane Smith");
    expect(html).toContain("by Ada Lovelace");
    // React keeps the camelCase spelling of the `dateTime` attribute in static markup.
    expect(html).toContain('dateTime="2026-10-06T09:00:00.000Z"');
    expect(html).toContain("Override created");
  });

  it("prefers the server summary and can hide the employee link", () => {
    const html = renderToStaticMarkup(
      <ActivityItem
        event={event("BREAK_STARTED", 2, { summary: "Jane Smith started a 10 minute break" })}
        hideEmployee
      />,
    );
    expect(html).toContain("Jane Smith started a 10 minute break");
    expect(html).not.toContain(`href="/employees/${EMPLOYEE_ID}"`);
  });

  it("renders organisation-level events without an employee", () => {
    const html = renderToStaticMarkup(
      <ActivityItem
        event={event("INTEGRATION_ERROR", 3, { employee: null, metadata: { provider: "DEPUTY" } })}
      />,
    );
    expect(html).toContain("Deputy reported a sync error");
    expect(html).not.toContain("/employees/");
  });

  it("has a skeleton that is hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<ActivityListSkeleton rows={3} />);
    expect(html).toContain('aria-hidden="true"');
    expect((html.match(/data-slot="skeleton"/g) ?? []).length).toBe(9);
  });
});
