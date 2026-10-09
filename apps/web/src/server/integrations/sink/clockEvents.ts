import type { Prisma } from "@clockoff/db";
import { EARLY_CLOCK_IN_MS } from "@clockoff/integrations";
import type { ExternalClockEvent } from "@clockoff/shared/providers/workforceProvider";
import {
  bulkRescheduleIntegrationShifts,
  type IntegrationShiftCurrent,
  type ReschedulePatch,
} from "@/server/shifts/shifts.integration";
import type { SinkContext } from "./context";
import { mappedEmployeeIds } from "./entityMaps.repository";

/**
 * Clock events (Beta, docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.8): Planday punch records become
 * `ClockEvent` rows, idempotent on `(organisationId, source, externalId)` with the portal-qualified ids of §2.6.
 * Punches of people who are not mapped to a ClockOff employee are counted and dropped (never persisted). With
 * clock-in activation, a new punch-out ends the matched in-progress Planday shift at the punch-out time and a
 * punch-in up to 60 minutes early moves a matched future shift's start to it, through `shifts.integration.ts` only;
 * without punches the shift runs as published. The SHIFTS phase keeps a start moved by a clock-in (`sink/shifts.ts`,
 * `clockedInAt`), so the next SYNC does not move it back to Planday's start.
 */

type Tx = Prisma.TransactionClient;

const MINUTE_MS = 60_000;
/** A punch-in at most this long before a future shift's start moves the start (§6.8). */
export const EARLY_PUNCH_IN_MS = EARLY_CLOCK_IN_MS;

const SHIFT_SELECT = {
  id: true,
  organisationId: true,
  employeeId: true,
  locationId: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  status: true,
  version: true,
  externalShiftId: true,
  managedByIntegrationId: true,
  deletedAt: true,
} as const;

export async function applyClockEvents(
  tx: Tx,
  ctx: SinkContext,
  records: readonly ExternalClockEvent[],
): Promise<void> {
  if (records.length === 0) return;
  const mapped = await mappedEmployeeIds(tx, {
    organisationId: ctx.organisationId,
    integrationId: ctx.integrationId,
    externalIds: records.map((r) => r.externalEmployeeId),
  });
  const rows: Prisma.ClockEventCreateManyInput[] = [];
  for (const record of records) {
    const employeeId = mapped.get(record.externalEmployeeId);
    if (!employeeId) {
      ctx.tally.exclude("outOfScope");
      continue;
    }
    rows.push({
      organisationId: ctx.organisationId,
      employeeId,
      type: record.type,
      occurredAt: record.occurredAt,
      source: ctx.provider,
      externalId: record.externalId,
    });
  }
  if (rows.length === 0) return;
  const inserted = await tx.clockEvent.createManyAndReturn({
    data: rows,
    skipDuplicates: true,
    select: { employeeId: true, type: true, occurredAt: true },
  });
  ctx.tally.count("clockEvents", "created", inserted.length);
  ctx.tally.count("clockEvents", "skipped", rows.length - inserted.length);
  if (ctx.activationMode === "CLOCK_EVENT") await reconcile(tx, ctx, inserted);
}

/** Moves Planday shifts to new punches (each punch once: only events inserted by this step). */
async function reconcile(
  tx: Tx,
  ctx: SinkContext,
  events: ReadonlyArray<{ employeeId: string; type: string; occurredAt: Date }>,
): Promise<void> {
  const punches = events.filter((e) => e.type === "CLOCK_IN" || e.type === "CLOCK_OUT");
  if (punches.length === 0) return;
  const earliest = Math.min(...punches.map((p) => p.occurredAt.getTime()));
  const latest = Math.max(...punches.map((p) => p.occurredAt.getTime()));
  const shifts = await tx.shift.findMany({
    where: {
      organisationId: ctx.organisationId,
      managedByIntegrationId: ctx.integrationId,
      employeeId: { in: [...new Set(punches.map((p) => p.employeeId))] },
      status: "SCHEDULED",
      deletedAt: null,
      startsAt: { lte: new Date(latest + EARLY_PUNCH_IN_MS) },
      endsAt: { gt: new Date(earliest) },
    },
    select: SHIFT_SELECT,
  });
  const now = ctx.now.getTime();
  const changes = new Map<string, { current: IntegrationShiftCurrent; patch: ReschedulePatch }>();
  for (const punch of punches) {
    const at = punch.occurredAt.getTime();
    for (const shift of shifts) {
      if (shift.employeeId !== punch.employeeId || changes.has(shift.id)) continue;
      const start = shift.startsAt.getTime();
      const end = shift.endsAt.getTime();
      if (punch.type === "CLOCK_OUT" && start <= now && now < end && start <= at && at < end) {
        // END_NOW at the punch-out time (never before start + 1 minute; the 15-minute minimum does not apply).
        const endsAt = new Date(Math.max(Math.ceil(at / MINUTE_MS) * MINUTE_MS, start + MINUTE_MS));
        changes.set(shift.id, {
          current: shift,
          patch: { endsAt, endRunningBreak: true, reason: "CLOCKED_OUT" },
        });
      } else if (
        punch.type === "CLOCK_IN" &&
        start > now &&
        at < start &&
        start - at <= EARLY_PUNCH_IN_MS
      ) {
        const startsAt = new Date(Math.floor(at / MINUTE_MS) * MINUTE_MS);
        changes.set(shift.id, { current: shift, patch: { startsAt, reason: "CLOCKED_IN" } });
      }
    }
  }
  if (changes.size === 0) return;
  const result = await bulkRescheduleIntegrationShifts(
    tx,
    {
      organisationId: ctx.organisationId,
      actorType: "SYSTEM",
      actorUserId: null,
      integrationId: ctx.integrationId,
    },
    [...changes.values()],
    ctx.now,
  );
  ctx.effects.shiftWrites.push(result);
  ctx.tally.count("shifts", "updated", result.rows.length);
}
