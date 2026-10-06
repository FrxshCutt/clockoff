import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { DEVICE_TO_SERVER_ALLOWED_FIELDS } from "@workmode/shared/privacyStatements";
import {
  deviceEventsSchema,
  deviceStateReportSchema,
  joinConfirmSchema,
  joinLookupSchema,
  MOBILE_API_PREFIX,
  MOBILE_REQUEST_FIELD_PRIVACY,
  mobileEndBreakSchema,
  mobileScheduleQuerySchema,
  mobileStartBreakSchema,
  pushTokenSchema,
} from "./mobile";
import { convertSchema, type JsonSchema } from "./openapi/generate";
import { registry, routeKey } from "./openapi/registry";
import "./openapi/routes";

const EMPLOYEE_ID = "0b6d9c2e-6a43-4c1e-9d7f-2f4a1c9e8b10";
const SHIFT_ID = "5f0c8a7e-3b2d-4e6f-8a9b-1c2d3e4f5a6b";
const POLICY_VERSION_ID = "8e7d6c5b-4a39-4281-9706-f5e4d3c2b1a0";
/** iOS `UUID().uuidString` is upper-case. */
const IOS_UUID = "E621E1F8-C36C-495A-93FC-0C247A3E6E5F";

/** A valid request for every mobile endpoint that takes input, keyed by `METHOD path`. */
const VALID_MOBILE_REQUESTS: Record<
  string,
  { body?: Record<string, unknown>; query?: Record<string, unknown> }
> = {
  "POST /api/mobile/v1/join/lookup": {
    body: { companyCode: "brew-4821", firstName: "Jane", lastName: "Smith", inviteCode: "K7PQ2M" },
  },
  "POST /api/mobile/v1/join/confirm": {
    body: {
      companyCode: "BREW-4821",
      employeeId: EMPLOYEE_ID,
      firstName: "Jane",
      lastName: "Smith",
      device: {
        platform: "IOS",
        appVersion: "1.2.0 (45)",
        osVersion: "17.5.1",
        model: "iPhone15,2",
      },
    },
  },
  "POST /api/mobile/v1/auth/refresh": {
    body: { refreshToken: "dGhpcy1pcy1hLXJlZnJlc2gtdG9rZW4tdmFsdWU" },
  },
  "POST /api/mobile/v1/auth/logout": {
    body: { refreshToken: "dGhpcy1pcy1hLXJlZnJlc2gtdG9rZW4tdmFsdWU" },
  },
  "POST /api/mobile/v1/leave-workplace": { body: {} },
  "GET /api/mobile/v1/me": { query: {} },
  "GET /api/mobile/v1/schedule": {
    query: { from: "2026-10-05T00:00:00Z", to: "2026-10-20T00:00:00Z" },
  },
  "GET /api/mobile/v1/sync": { query: {} },
  "POST /api/mobile/v1/device/state": {
    body: {
      permissionState: "APPROVED",
      selectionState: "CONFIGURED",
      selectionCounts: { categories: 3, applications: 12, webDomains: 0 },
      restrictionEngineState: "WORKING",
      appVersion: "1.2.0",
      osVersion: "17.5.1",
      policyVersionApplied: POLICY_VERSION_ID,
      scheduleVersionApplied: 7,
      localTime: "2026-10-06T10:00:03+01:00",
      timezone: "Europe/London",
    },
  },
  "POST /api/mobile/v1/events": {
    body: {
      events: [
        {
          clientEventId: IOS_UUID,
          type: "WORK_MODE_STARTED",
          occurredAt: "2026-10-06T09:00:00Z",
          metadata: {
            shiftId: SHIFT_ID,
            policyVersion: POLICY_VERSION_ID,
            scheduleVersion: 7,
            reason: "INTERVAL_STARTED",
            engineState: "WORKING",
            permissionState: "APPROVED",
            selectionCounts: { categories: 3, applications: 12, webDomains: 0 },
          },
        },
        {
          clientEventId: "1d2c3b4a-5f6e-4d8c-9b0a-112233445566",
          type: "POLICY_SYNCED",
          occurredAt: "2026-10-06T09:01:00Z",
        },
      ],
    },
  },
  "POST /api/mobile/v1/breaks/start": {
    body: {
      clientBreakId: IOS_UUID,
      shiftId: SHIFT_ID,
      requestedAt: "2026-10-06T11:00:00Z",
      requestedDurationMinutes: 15,
    },
  },
  "POST /api/mobile/v1/breaks/:id/end": {
    body: { endedAt: "2026-10-06T11:12:00Z", reason: "EMPLOYEE_ENDED" },
  },
  "POST /api/mobile/v1/device/push-token": {
    body: { token: "a".repeat(64), environment: "production" },
  },
};

/** Data the API must never accept from a phone (§12). */
const FORBIDDEN_KEYS = [
  "installedApps",
  "contacts",
  "location",
  "notifications",
  "messages",
  "selectedApps",
  "browsingHistory",
  "photos",
  "idfa",
  "idfv",
  "serialNumber",
  "phoneNumber",
];

/** Privacy classes that carry no information about the employee or the phone (see mobile.ts). */
const NON_PERSONAL_CLASSES = new Set(["credential", "serverIssuedId", "requestShape"]);
const DISCLOSED_GROUPS = new Set<string>(DEVICE_TO_SERVER_ALLOWED_FIELDS.map((g) => g.key));

const mobileRoutes = registry.filter((r) => r.path.startsWith(`${MOBILE_API_PREFIX}/`));

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Paths (as key arrays) of every plain object inside `value`, root included. */
function objectPaths(
  value: unknown,
  path: Array<string | number> = [],
): Array<Array<string | number>> {
  if (Array.isArray(value)) return value.flatMap((v, i) => objectPaths(v, [...path, i]));
  if (!isObject(value)) return [];
  return [path, ...Object.entries(value).flatMap(([k, v]) => objectPaths(v, [...path, k]))];
}

function withKeyAt(value: unknown, path: Array<string | number>, key: string): unknown {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let target: unknown = copy;
  for (const segment of path) target = (target as Record<string | number, unknown>)[segment];
  (target as Record<string, unknown>)[key] = key === "location" ? { lat: 51.5, lng: -0.12 } : ["x"];
  return copy;
}

function walkJsonSchema(schema: unknown, visit: (node: JsonSchema) => void): void {
  if (Array.isArray(schema)) schema.forEach((s) => walkJsonSchema(s, visit));
  else if (isObject(schema)) {
    visit(schema);
    Object.values(schema).forEach((s) => walkJsonSchema(s, visit));
  }
}

describe("mobile API privacy (§12)", () => {
  it("registers the mobile endpoints, all under /api/mobile/v1", () => {
    expect(mobileRoutes.length).toBe(13);
    for (const route of mobileRoutes)
      expect(route.auth === "mobile" || route.auth === "public").toBe(true);
  });

  it("has a valid fixture for every mobile endpoint that takes input", () => {
    for (const route of mobileRoutes) {
      const fixture = VALID_MOBILE_REQUESTS[routeKey(route)];
      const takesInput = route.request?.body !== undefined || route.request?.query !== undefined;
      if (!takesInput) continue;
      expect(fixture, `missing fixture for ${routeKey(route)}`).toBeDefined();
      if (route.request?.body) {
        const result = route.request.body.safeParse(fixture?.body);
        expect(result.success, `${routeKey(route)}: ${JSON.stringify(result.error?.issues)}`).toBe(
          true,
        );
      }
      if (route.request?.query) {
        const result = route.request.query.safeParse(fixture?.query ?? {});
        expect(result.success, `${routeKey(route)}: ${JSON.stringify(result.error?.issues)}`).toBe(
          true,
        );
      }
    }
  });

  it("rejects installedApps / contacts / location / notifications / messages (and friends) at every nesting level of every mobile endpoint", () => {
    let checked = 0;
    for (const route of mobileRoutes) {
      const fixture = VALID_MOBILE_REQUESTS[routeKey(route)];
      for (const part of ["body", "query"] as const) {
        const schema: z.ZodType | undefined = route.request?.[part];
        if (!schema) continue;
        const valid = fixture?.[part] ?? {};
        for (const path of objectPaths(valid)) {
          for (const key of FORBIDDEN_KEYS) {
            const result = schema.safeParse(withKeyAt(valid, path, key));
            expect(
              result.success,
              `${routeKey(route)} accepted ${part}.${[...path, key].join(".")}`,
            ).toBe(false);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("emits additionalProperties:false for every object in every mobile request schema", () => {
    for (const route of mobileRoutes) {
      for (const schema of [route.request?.body, route.request?.query]) {
        if (!schema) continue;
        const { root, defs } = convertSchema(schema, "input");
        walkJsonSchema([root, defs], (node) => {
          if (node.type === "object")
            expect(node.additionalProperties, routeKey(route)).toBe(false);
        });
      }
    }
  });

  /** Every property name declared by any mobile request schema (body, query or params), at any depth. */
  function mobileRequestFieldNames(): Set<string> {
    const seen = new Set<string>();
    for (const route of mobileRoutes) {
      for (const schema of [route.request?.body, route.request?.query, route.request?.params]) {
        if (!schema) continue;
        const { root, defs } = convertSchema(schema, "input");
        walkJsonSchema([root, defs], (node) => {
          if (isObject(node.properties)) Object.keys(node.properties).forEach((k) => seen.add(k));
        });
      }
    }
    return seen;
  }

  it("only accepts fields classified in MOBILE_REQUEST_FIELD_PRIVACY (a new field is a privacy decision)", () => {
    const seen = mobileRequestFieldNames();
    // Path params (`:id` of /breaks/:id/end) are server-issued ids in the URL, not request content.
    seen.delete("id");
    const unclassified = [...seen].filter((k) => !Object.hasOwn(MOBILE_REQUEST_FIELD_PRIVACY, k));
    expect(unclassified).toEqual([]);
    const stale = Object.keys(MOBILE_REQUEST_FIELD_PRIVACY).filter((k) => !seen.has(k));
    expect(stale, "allow-list entries no mobile schema uses").toEqual([]);
  });

  it("discloses every field about the employee or the phone in DEVICE_TO_SERVER_ALLOWED_FIELDS (docs/PRIVACY.md)", () => {
    for (const [field, privacyClass] of Object.entries(MOBILE_REQUEST_FIELD_PRIVACY)) {
      expect(
        NON_PERSONAL_CLASSES.has(privacyClass) || DISCLOSED_GROUPS.has(privacyClass),
        `${field} → ${privacyClass}`,
      ).toBe(true);
    }
    // None of the forbidden data has a classification, at any level.
    for (const key of FORBIDDEN_KEYS)
      expect(Object.hasOwn(MOBILE_REQUEST_FIELD_PRIVACY, key)).toBe(false);
  });

  it("rejects unknown keys in the path params of mobile routes", () => {
    const end = mobileRoutes.find((r) => r.path.endsWith("/breaks/:id/end"));
    const params = end?.request?.params;
    expect(params).toBeDefined();
    expect(params?.safeParse({ id: SHIFT_ID }).success).toBe(true);
    expect(params?.safeParse({ id: SHIFT_ID, location: "x" }).success).toBe(false);
  });
});

describe("mobile request validation", () => {
  it("normalises company and invite codes", () => {
    const parsed = joinLookupSchema.parse({
      companyCode: " brew-4821 ",
      firstName: "Jane",
      lastName: "Smith",
      inviteCode: "k7pq2m",
    });
    expect(parsed.companyCode).toBe("BREW-4821");
    expect(parsed.inviteCode).toBe("K7PQ2M");
    // Codes are read off posters and typed on phones: separators and spaces are optional on input and
    // iOS smart punctuation is tolerated; the parsed value is always canonical.
    for (const typed of ["BREW4821", "brew 4821", "brew\u20144821", "Brew_4821"]) {
      expect(
        joinLookupSchema.parse({ companyCode: typed, firstName: "Jane", lastName: "Smith" })
          .companyCode,
      ).toBe("BREW-4821");
    }
    expect(
      joinLookupSchema.parse({
        companyCode: "BREW-4821",
        firstName: "Jane",
        lastName: "Smith",
        inviteCode: "k7p-q2m",
      }).inviteCode,
    ).toBe("K7PQ2M");
    for (const bad of ["BREW", "BREW-48", "4821", ""]) {
      expect(
        joinLookupSchema.safeParse({ companyCode: bad, firstName: "Jane", lastName: "Smith" })
          .success,
      ).toBe(false);
    }
  });

  it("requires a generic device model and the IOS platform", () => {
    const body = VALID_MOBILE_REQUESTS["POST /api/mobile/v1/join/confirm"]?.body as Record<
      string,
      unknown
    >;
    const device = body.device as Record<string, unknown>;
    expect(
      joinConfirmSchema.safeParse({ ...body, device: { ...device, platform: "ANDROID" } }).success,
    ).toBe(false);
    expect(
      joinConfirmSchema.safeParse({ ...body, device: { ...device, model: "Jane's iPhone 😀" } })
        .success,
    ).toBe(false);
    const { device: _omit, ...withoutDevice } = body;
    expect(joinConfirmSchema.safeParse(withoutDevice).success).toBe(false);
  });

  it("validates the device state report", () => {
    const body = VALID_MOBILE_REQUESTS["POST /api/mobile/v1/device/state"]?.body as Record<
      string,
      unknown
    >;
    expect(deviceStateReportSchema.safeParse({ ...body, timezone: "Mars/Olympus" }).success).toBe(
      false,
    );
    expect(
      deviceStateReportSchema.safeParse({ ...body, localTime: "2026-10-06T10:00:03" }).success,
    ).toBe(false);
    expect(deviceStateReportSchema.safeParse({ ...body, permissionState: "MAYBE" }).success).toBe(
      false,
    );
    expect(
      deviceStateReportSchema.safeParse({
        ...body,
        selectionCounts: { categories: 1, applications: 1, webDomains: 0, appNames: ["TikTok"] },
      }).success,
    ).toBe(false);
    const {
      selectionCounts: _omit,
      policyVersionApplied: _p,
      scheduleVersionApplied: _s,
      ...minimal
    } = body;
    expect(deviceStateReportSchema.safeParse(minimal).success).toBe(true);
  });

  it("only accepts device-reportable event types, at most 200, with unique ids and no free text", () => {
    const event = {
      clientEventId: IOS_UUID,
      type: "BREAK_STARTED",
      occurredAt: "2026-10-06T11:00:00Z",
    };
    expect(deviceEventsSchema.safeParse({ events: [event] }).success).toBe(true);
    expect(
      deviceEventsSchema.safeParse({ events: [{ ...event, type: "POLICY_UPDATED" }] }).success,
    ).toBe(false);
    expect(
      deviceEventsSchema.safeParse({ events: [{ ...event, type: "APP_OPENED" }] }).success,
    ).toBe(false);
    expect(deviceEventsSchema.safeParse({ events: [] }).success).toBe(false);
    expect(
      deviceEventsSchema.safeParse({
        events: [event, { ...event, clientEventId: IOS_UUID.toLowerCase() }],
      }).success,
    ).toBe(false);
    expect(
      deviceEventsSchema.safeParse({
        events: [{ ...event, metadata: { reason: "opened Instagram at lunch" } }],
      }).success,
    ).toBe(false);
    expect(
      deviceEventsSchema.safeParse({ events: [{ ...event, metadata: { reason: "R".repeat(65) } }] })
        .success,
    ).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => ({
      ...event,
      clientEventId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    }));
    expect(deviceEventsSchema.safeParse({ events: many }).success).toBe(false);
    expect(deviceEventsSchema.safeParse({ events: many.slice(0, 200) }).success).toBe(true);
  });

  it("validates break start / end", () => {
    const start = VALID_MOBILE_REQUESTS["POST /api/mobile/v1/breaks/start"]?.body as Record<
      string,
      unknown
    >;
    expect(
      mobileStartBreakSchema.safeParse({ ...start, requestedDurationMinutes: 0 }).success,
    ).toBe(false);
    expect(
      mobileStartBreakSchema.safeParse({ ...start, clientBreakId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      mobileEndBreakSchema.safeParse({ endedAt: "2026-10-06T11:12:00Z", reason: "MANAGER_ENDED" })
        .success,
    ).toBe(false);
    expect(
      mobileEndBreakSchema.safeParse({ endedAt: "2026-10-06T11:12:00Z", reason: "SHIFT_ENDED" })
        .success,
    ).toBe(true);
  });

  it("only accepts a hex APNs token for a known environment", () => {
    expect(
      pushTokenSchema.safeParse({ token: "zz".repeat(32), environment: "production" }).success,
    ).toBe(false);
    expect(
      pushTokenSchema.safeParse({ token: "ab".repeat(32), environment: "staging" }).success,
    ).toBe(false);
    expect(
      pushTokenSchema.safeParse({ token: "ab".repeat(257), environment: "sandbox" }).success,
    ).toBe(false);
    expect(
      pushTokenSchema.safeParse({ token: "AB".repeat(32), environment: "sandbox" }).success,
    ).toBe(true);
  });

  it("bounds the schedule window", () => {
    expect(mobileScheduleQuerySchema.safeParse({}).success).toBe(true);
    expect(
      mobileScheduleQuerySchema.safeParse({
        from: "2026-10-01T00:00:00Z",
        to: "2026-09-01T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      mobileScheduleQuerySchema.safeParse({
        from: "2026-01-01T00:00:00Z",
        to: "2026-06-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});
