import { Prisma, prisma, type ActivityEvent } from "@workmode/db";
import type { ActivityEventType, ActorType } from "@workmode/shared/enums";
import { publishEvent } from "@/server/events";

/**
 * Append an operational activity event (§9 feed; §12 privacy: metadata is operational only — never
 * app names, messages, locations or other personal content) and fan it out to realtime subscribers.
 *
 * Idempotent on `(deviceId, clientEventId)`: a device retrying a report gets the original row back
 * (`created: false`) and no duplicate realtime event is published.
 *
 * Transactions: pass `db` (a `Prisma.TransactionClient`) to write inside a caller's transaction. The
 * idempotent path uses `INSERT … ON CONFLICT DO NOTHING` (via `createManyAndReturn({ skipDuplicates })`)
 * rather than catching a unique violation, because a failed statement would abort the surrounding
 * Postgres transaction. When writing inside a transaction, pass `publish: false` and call
 * {@link publishActivity} after the commit so subscribers never see rolled-back events.
 */
export interface RecordActivityInput {
  organisationId: string;
  employeeId?: string | null;
  deviceId?: string | null;
  actorType: ActorType;
  actorUserId?: string | null;
  type: ActivityEventType;
  /** Defaults to now. A UTC instant. */
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
  /** Device-generated idempotency key (only meaningful together with `deviceId`). */
  clientEventId?: string | null;
}

export interface RecordActivityOptions {
  db?: Prisma.TransactionClient | typeof prisma;
  /** Publish on the event bus when a new row is created (default true). */
  publish?: boolean;
}

export interface RecordActivityResult {
  event: ActivityEvent;
  /** False when an existing row with the same `(deviceId, clientEventId)` was returned. */
  created: boolean;
}

export async function recordActivity(
  input: RecordActivityInput,
  options: RecordActivityOptions = {},
): Promise<RecordActivityResult> {
  const db = options.db ?? prisma;
  const data: Prisma.ActivityEventCreateManyInput = {
    organisationId: input.organisationId,
    employeeId: input.employeeId ?? null,
    deviceId: input.deviceId ?? null,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    type: input.type,
    occurredAt: input.occurredAt ?? new Date(),
    metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    clientEventId: input.clientEventId ?? null,
  };

  let event: ActivityEvent;
  if (input.deviceId && input.clientEventId) {
    const inserted = await db.activityEvent.createManyAndReturn({
      data: [data],
      skipDuplicates: true,
    });
    const row = inserted[0];
    if (!row) {
      const existing = await db.activityEvent.findUnique({
        where: {
          deviceId_clientEventId: { deviceId: input.deviceId, clientEventId: input.clientEventId },
        },
      });
      if (!existing) {
        // ON CONFLICT hit a row that is no longer visible (deleted concurrently): surface it.
        throw new Error("recordActivity: conflicting activity event disappeared");
      }
      if (existing.organisationId !== input.organisationId) {
        // A device id belongs to exactly one organisation; never leak another tenant's row.
        throw new Error("recordActivity: idempotency key collision across organisations");
      }
      return { event: existing, created: false };
    }
    event = row;
  } else {
    event = await db.activityEvent.create({ data });
  }

  if (options.publish ?? true) publishActivity(event);
  return { event, created: true };
}

/** Publish an `activity.recorded` realtime event for a stored row (see transaction note above). */
export function publishActivity(event: ActivityEvent): void {
  publishEvent({
    type: "activity.recorded",
    organisationId: event.organisationId,
    ...(event.employeeId ? { employeeId: event.employeeId } : {}),
    payload: {
      eventId: event.id,
      eventType: event.type,
      actorType: event.actorType,
      employeeId: event.employeeId,
      deviceId: event.deviceId,
      occurredAt: event.occurredAt.toISOString(),
      metadata: event.metadata,
    },
  });
}
