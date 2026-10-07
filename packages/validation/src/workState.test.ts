import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { computeBreakAllowance } from "@clockoff/shared/breaks/breakRules";
import type { BreakAllowance } from "@clockoff/shared/breaks/breakTypes";
import {
  computeExpectedState,
  toExpectedStateJson,
} from "@clockoff/shared/workMode/computeExpectedState";
import type { ExpectedStateJson } from "@clockoff/shared/workMode/types";
import { BREAK_POLICY_DEFAULTS } from "./breakPolicies";
import { mobileSyncResponseSchema } from "./mobile";
import { breakAllowanceSchema, expectedStateSchema } from "./workState";

const SHIFT_ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const BREAK_ID = "0e5c2b1a-9d8f-4e7a-8b6c-5d4e3f2a1b0c";
const OVERRIDE_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const shift = {
  id: SHIFT_ID,
  startsAt: "2026-10-06T09:00:00Z",
  endsAt: "2026-10-06T17:00:00Z",
  status: "SCHEDULED" as const,
};

describe("expectedStateSchema", () => {
  it("is the wire form of the state machine's ExpectedStateJson", () => {
    expectTypeOf<z.infer<typeof expectedStateSchema>>().toEqualTypeOf<ExpectedStateJson>();
  });

  it("parses real state machine output: working, on break, override, off shift", () => {
    const working = computeExpectedState({
      now: "2026-10-06T10:00:00Z",
      shifts: [shift],
      permissionState: "APPROVED",
    });
    const onBreak = computeExpectedState({
      now: "2026-10-06T12:05:00Z",
      shifts: [shift],
      breakSessions: [
        {
          id: BREAK_ID,
          shiftId: SHIFT_ID,
          startedAt: "2026-10-06T12:00:00Z",
          plannedEndsAt: "2026-10-06T12:15:00Z",
          status: "ACTIVE",
          restrictionBehaviour: "RELAX_CATEGORIES",
          relaxedCategories: ["SOCIAL_MEDIA"],
        },
      ],
      permissionState: "APPROVED",
      timezone: "Europe/London",
    });
    const overridden = computeExpectedState({
      now: "2026-10-06T13:00:00Z",
      shifts: [shift],
      overrides: [
        {
          id: OVERRIDE_ID,
          type: "EXEMPT_TEMPORARILY",
          startsAt: "2026-10-06T12:30:00Z",
          expiresAt: "2026-10-06T14:00:00Z",
        },
      ],
      permissionState: "APPROVED",
    });
    const offShift = computeExpectedState({
      now: "2026-10-06T20:00:00Z",
      shifts: [shift],
      permissionState: "DENIED",
    });

    for (const state of [working, onBreak, overridden, offShift]) {
      const json = toExpectedStateJson(state);
      expect(expectedStateSchema.parse(json)).toEqual(json);
    }
    expect(toExpectedStateJson(onBreak).state).toBe("ON_BREAK");
    expect(toExpectedStateJson(onBreak).relaxation).toMatchObject({
      source: "BREAK",
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["SOCIAL_MEDIA"],
    });
  });
});

describe("breakAllowanceSchema", () => {
  it("mirrors BreakAllowance with instants as strings", () => {
    type Wire = {
      [K in keyof BreakAllowance]: BreakAllowance[K] extends Date | null
        ? string | null
        : BreakAllowance[K];
    };
    expectTypeOf<z.infer<typeof breakAllowanceSchema>>().toEqualTypeOf<Wire>();
    const allowance = computeBreakAllowance(
      BREAK_POLICY_DEFAULTS,
      { id: SHIFT_ID, startsAt: new Date(shift.startsAt), endsAt: new Date(shift.endsAt) },
      [],
      new Date("2026-10-06T10:30:00Z"),
    );
    const wire = { ...allowance, nextEligibleAt: allowance.nextEligibleAt?.toISOString() ?? null };
    expect(breakAllowanceSchema.parse(wire)).toEqual(wire);
    expect(wire.canStartNow).toBe(true);
  });
});

describe("mobileSyncResponseSchema", () => {
  it("accepts a realistic sync payload", () => {
    const now = "2026-10-06T10:00:00.000Z";
    const payload = {
      policy: {
        policy: { id: "8e7d6c5b-4a39-4281-9706-f5e4d3c2b1a0", name: "Floor staff" },
        version: { id: "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091", versionNumber: 3 },
        restrictionConfig: {
          categories: ["SOCIAL_MEDIA", "GAMES"],
          requireEmployeeAppSelection: true,
          alwaysAllowedNote: ["Phone, Messages and FaceTime"],
          activationMode: "SCHEDULED",
          preShiftWarningMinutes: 10,
        },
      },
      breakPolicy: {
        id: "c0ffee00-1234-4abc-9def-0123456789ab",
        name: "Standard",
        rules: BREAK_POLICY_DEFAULTS,
      },
      shifts: [
        {
          id: SHIFT_ID,
          startsAt: "2026-10-06T09:00:00.000Z",
          endsAt: "2026-10-06T17:00:00.000Z",
          timezone: "Europe/London",
          status: "SCHEDULED",
          location: null,
          notes: null,
          version: 2,
          scheduledBreaks: [],
        },
      ],
      policyVersion: "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091",
      scheduleVersion: 12,
      serverTime: now,
      activeOverrides: [],
      expectedState: toExpectedStateJson(
        computeExpectedState({ now, shifts: [shift], permissionState: "APPROVED" }),
      ),
      activeBreakSession: null,
      breakAllowance: null,
    };
    expect(mobileSyncResponseSchema.safeParse(payload).success).toBe(true);
  });
});
