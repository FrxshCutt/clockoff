import { describe, expect, it } from "vitest";
import {
  INTEGRATION_EVENT_PAYLOAD_SCHEMAS,
  INTEGRATION_REALTIME_EVENT_TYPES,
  REALTIME_EVENT_TYPES,
  REALTIME_RECONNECT_EVENT,
  integrationSyncProgressPayloadSchema,
  sseEventSchema,
} from "./realtime";

describe("REALTIME_RECONNECT_EVENT", () => {
  it("is the stream's `reconnect` control frame", () => {
    expect(REALTIME_RECONNECT_EVENT).toBe("reconnect");
  });

  it("is not an event kind (it would drive invalidations, contract parity and the push bridge)", () => {
    expect((REALTIME_EVENT_TYPES as readonly string[]).includes(REALTIME_RECONNECT_EVENT)).toBe(
      false,
    );
  });

  it("carries no SseEvent payload (`data: {}`)", () => {
    expect(sseEventSchema.safeParse({}).success).toBe(false);
  });
});

describe("integration events (Planday, plan §7.11)", () => {
  const ids = {
    provider: "PLANDAY",
    integrationId: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
    runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  } as const;

  it("are declared event kinds, each with a payload schema", () => {
    for (const type of INTEGRATION_REALTIME_EVENT_TYPES) {
      expect(REALTIME_EVENT_TYPES as readonly string[]).toContain(type);
      expect(INTEGRATION_EVENT_PAYLOAD_SCHEMAS[type]).toBeDefined();
    }
    expect(Object.keys(INTEGRATION_EVENT_PAYLOAD_SCHEMAS).sort()).toEqual(
      [...INTEGRATION_REALTIME_EVENT_TYPES].sort(),
    );
  });

  it("accept ids, enums, numbers and labels only (strict: no names, emails or Planday values)", () => {
    const progress = {
      ...ids,
      kind: "SYNC",
      trigger: "SCHEDULED",
      status: "RUNNING",
      phase: "EMPLOYEES",
      label: "Reading employees (page 3)",
      completedPhases: 2,
      totalPhases: 9,
      pagesRead: 3,
      queued: false,
      resumeAfter: null,
      finished: false,
    };
    expect(integrationSyncProgressPayloadSchema.safeParse(progress).success).toBe(true);
    expect(
      integrationSyncProgressPayloadSchema.safeParse({ ...progress, employeeName: "Sam Jones" })
        .success,
    ).toBe(false);
    expect(
      INTEGRATION_EVENT_PAYLOAD_SCHEMAS["integration.run.queued"].safeParse({
        ...ids,
        kind: "STRUCTURE",
        trigger: "INITIAL",
      }).success,
    ).toBe(true);
    expect(
      INTEGRATION_EVENT_PAYLOAD_SCHEMAS["integration.run.cancelled"].safeParse(ids).success,
    ).toBe(true);
    const health = INTEGRATION_EVENT_PAYLOAD_SCHEMAS["integration.health.changed"];
    const changed = { provider: "PLANDAY", integrationId: ids.integrationId, status: "AUTH_ERROR" };
    expect(health.safeParse(changed).success).toBe(true);
    expect(health.safeParse({ ...changed, lastError: "401 from Planday" }).success).toBe(false);
  });
});
