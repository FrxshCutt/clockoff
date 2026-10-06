import { prisma, type Prisma } from "@workmode/db";
import {
  DEVICE_REPORTABLE_EVENT_TYPES,
  type DeviceReportableEventType,
  type WorkModeState,
} from "@workmode/shared/enums";
import type { ApiErrorCode } from "@workmode/shared/errors";
import type {
  DeviceEventInput,
  DeviceEventMetadata,
  DeviceEventsInput,
  DeviceEventsResponse,
} from "@workmode/validation/mobile";
import { recordActivity } from "@/server/activity/recordActivity";
import { applyReportedState } from "@/server/deviceState/deviceState.service";
import { updateDevice } from "@/server/sync/sync.repository";
import type { DeviceContext } from "@/server/tenancy/context";
import { recomputeEmployeeWorkState } from "@/server/workState/workState.service";

/**
 * `POST /api/mobile/v1/events` — the device outbox flush. Idempotent per `(deviceId, clientEventId)` through
 * `recordActivity`; each event is accepted, counted as a duplicate or rejected individually, so one bad item
 * never fails the batch (the device deletes accepted/duplicate/rejected items alike).
 */

export const EVENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const EVENT_MAX_FUTURE_MS = 10 * 60 * 1000;

const REPORTABLE: ReadonlySet<string> = new Set(DEVICE_REPORTABLE_EVENT_TYPES);
const METADATA_KEYS = [
  "shiftId",
  "breakSessionId",
  "clientBreakId",
  "policyVersion",
  "scheduleVersion",
  "reason",
  "engineState",
  "permissionState",
  "selectionCounts",
] as const satisfies readonly (keyof DeviceEventMetadata)[];
const BREAK_EVENT_TYPES: ReadonlySet<string> = new Set(["BREAK_STARTED", "BREAK_ENDED", "BREAK_EXPIRED"]);

/** Allow-list copy of the metadata (defence in depth behind the strict schema). */
export function pickEventMetadata(metadata: DeviceEventMetadata | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!metadata) return out;
  for (const key of METADATA_KEYS) {
    const value = metadata[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** What a device event says about the engine state it reports, if anything. */
export function reportedStateForEvent(
  type: DeviceReportableEventType,
  metadata: DeviceEventMetadata | undefined,
): WorkModeState | null {
  if (metadata?.engineState) return metadata.engineState;
  switch (type) {
    case "WORK_MODE_STARTED":
      return "WORKING";
    case "WORK_MODE_ENDED":
      return "OFF_SHIFT";
    case "BREAK_STARTED":
      return "ON_BREAK";
    case "BREAK_ENDED":
    case "BREAK_EXPIRED":
      return "WORKING";
    case "PERMISSION_NEEDS_ATTENTION":
      return "PERMISSION_ERROR";
    case "SETUP_COMPLETED":
    case "PERMISSION_GRANTED":
    case "SELECTION_CONFIGURED":
    case "SCHEDULE_SYNCED":
    case "POLICY_SYNCED":
      return null;
    default: {
      const exhaustive: never = type;
      throw new Error(`Unhandled event type ${String(exhaustive)}`);
    }
  }
}

export function classifyOccurredAt(occurredAt: Date, now: Date): "ok" | "CLOCK_SKEW" {
  const ms = occurredAt.getTime();
  if (!Number.isFinite(ms)) return "CLOCK_SKEW";
  if (ms < now.getTime() - EVENT_MAX_AGE_MS || ms > now.getTime() + EVENT_MAX_FUTURE_MS) return "CLOCK_SKEW";
  return "ok";
}

type Db = Prisma.TransactionClient | typeof prisma;

async function ownedIds(
  organisationId: string,
  employeeId: string,
  events: readonly DeviceEventInput[],
  db: Db,
): Promise<{ shifts: Set<string>; sessions: Set<string> }> {
  const shiftIds = [...new Set(events.map((e) => e.metadata?.shiftId).filter((v): v is string => !!v))];
  const sessionIds = [
    ...new Set(events.map((e) => e.metadata?.breakSessionId).filter((v): v is string => !!v)),
  ];
  const [shifts, sessions] = await Promise.all([
    shiftIds.length
      ? db.shift.findMany({ where: { organisationId, employeeId, id: { in: shiftIds } }, select: { id: true } })
      : [],
    sessionIds.length
      ? db.breakSession.findMany({
          where: { organisationId, employeeId, id: { in: sessionIds } },
          select: { id: true },
        })
      : [],
  ]);
  return { shifts: new Set(shifts.map((s) => s.id)), sessions: new Set(sessions.map((s) => s.id)) };
}

/** A break event the server already recorded for the same session (from /breaks/start|end) is a duplicate. */
async function serverAlreadyRecordedBreakEvent(
  organisationId: string,
  employeeId: string,
  type: DeviceReportableEventType,
  metadata: DeviceEventMetadata | undefined,
  db: Db,
): Promise<boolean> {
  if (!BREAK_EVENT_TYPES.has(type)) return false;
  const conditions: Prisma.ActivityEventWhereInput[] = [];
  if (metadata?.breakSessionId)
    conditions.push({ metadata: { path: ["breakSessionId"], equals: metadata.breakSessionId } });
  if (metadata?.clientBreakId)
    conditions.push({ metadata: { path: ["clientBreakId"], equals: metadata.clientBreakId } });
  if (conditions.length === 0) return false;
  const existing = await db.activityEvent.findFirst({
    where: { organisationId, employeeId, type, OR: conditions },
    select: { id: true },
  });
  return existing !== null;
}

export async function ingestDeviceEvents(
  ctx: DeviceContext,
  input: DeviceEventsInput,
  now: Date = new Date(),
): Promise<DeviceEventsResponse> {
  const organisationId = ctx.organisation.id;
  const employeeId = ctx.employee.id;
  const owned = await ownedIds(organisationId, employeeId, input.events, prisma);

  let accepted = 0;
  let duplicates = 0;
  const rejected: Array<{ clientEventId: string; code: ApiErrorCode }> = [];
  let latestReport: { state: WorkModeState; at: Date } | null = null;

  for (const event of input.events) {
    if (!REPORTABLE.has(event.type)) {
      rejected.push({ clientEventId: event.clientEventId, code: "UNKNOWN_EVENT_TYPE" });
      continue;
    }
    const occurredAt = new Date(event.occurredAt);
    if (classifyOccurredAt(occurredAt, now) !== "ok") {
      rejected.push({ clientEventId: event.clientEventId, code: "CLOCK_SKEW" });
      continue;
    }
    if (
      (event.metadata?.shiftId && !owned.shifts.has(event.metadata.shiftId)) ||
      (event.metadata?.breakSessionId && !owned.sessions.has(event.metadata.breakSessionId))
    ) {
      rejected.push({ clientEventId: event.clientEventId, code: "NOT_FOUND" });
      continue;
    }
    if (await serverAlreadyRecordedBreakEvent(organisationId, employeeId, event.type, event.metadata, prisma)) {
      duplicates += 1;
      continue;
    }
    const { created } = await recordActivity({
      organisationId,
      employeeId,
      deviceId: ctx.device.id,
      actorType: "EMPLOYEE_DEVICE",
      type: event.type,
      occurredAt,
      metadata: pickEventMetadata(event.metadata),
      clientEventId: event.clientEventId,
    });
    if (!created) {
      duplicates += 1;
      continue;
    }
    accepted += 1;
    const state = reportedStateForEvent(event.type, event.metadata);
    if (state && (latestReport === null || occurredAt.getTime() >= latestReport.at.getTime())) {
      latestReport = { state, at: occurredAt };
    }
  }

  await updateDevice(ctx.device.id, { lastSeenAt: now });
  if (latestReport) {
    const applied = await applyReportedState(employeeId, latestReport.state, latestReport.at);
    if (applied) await recomputeEmployeeWorkState({ organisationId, employeeId, now });
  }
  return { accepted, duplicates, rejected };
}
