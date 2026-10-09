import { randomUUID } from "node:crypto";
import { Prisma, type ActivityEvent, type IntegrationProvider } from "@clockoff/db";
import { AppError, isAppError } from "@clockoff/shared/errors";
import type { ShiftRemovalReason } from "@clockoff/shared/providers/syncSink";
import { PROVIDERS } from "@clockoff/shared/providers/registry";
import { managedByFromIntegrationId } from "@clockoff/validation/integrations";
import { publishActivity } from "@/server/activity/recordActivity";
import { audit } from "@/server/audit/audit";
import { publishScheduleChanged, type ScheduleChangeReason } from "./shifts.events";
import {
  endBreakSessionOutside,
  recordShiftActivity,
  shiftActivityData,
  updateShiftRow,
  type ShiftActivityType,
  type ShiftActor,
} from "./shifts.internal";
import { shiftInclude, type ShiftRow } from "./shifts.mappers";

/**
 * Integration writers for shifts (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.6, §6.9). A provider sync
 * (the worker's apply sink) writes Planday's published shifts into ordinary `Shift` rows through these
 * functions only, so the rest of ClockOff sees a synced shift exactly like a manager's:
 *
 * - Every change bumps `version` under the optimistic lock (`updateShiftRow`, or one version-checked bulk
 *   `UPDATE … FROM (VALUES …)`). `computeScheduleVersion` hashes `id:version:status`, so every change reaches
 *   `GET /api/mobile/v1/sync`. A concurrent change (CONFLICT) is retried once with the fresh row.
 * - Every function refuses a shift whose `managedByIntegrationId` is not the caller's integration (manual and
 *   CSV shifts are never touched by a sync) and filters every query on the run's organisation as well as the
 *   id. The one exception is {@link cancelReplacedShift}, limited to the manager-approved ids of the INITIAL
 *   sync (§6.6 Overlaps).
 * - Ended shifts are never modified (spec §5): a change that would touch one is reported in `skipped`.
 * - Nothing is published here: callers write inside their own transaction and, after it commits, call
 *   {@link publishIntegrationShiftWrite} (activity rows and one `SCHEDULE_CHANGED` per employee and reason).
 * - Activity: SHIFT_CREATED / SHIFT_UPDATED / SHIFT_CANCELLED with metadata `{ source: "<PROVIDER>", reason }`
 *   for every change (creations can be left out for the first SYNC after onboarding). No audit row per synced
 *   shift: audit covers manager actions (spec §10).
 *
 * The module also holds the managed-record refusals the employees, locations and teams modules share.
 */

/** Rows per bulk statement (bind parameters stay far below Postgres' 32 767). */
const CHUNK_SIZE = 500;

// ── Managed-record refusals (shared by the shifts, employees, locations and teams modules) ──────────────

export type ManagedEntityType = "Shift" | "Employee" | "Location" | "Team";

const ENTITY_LABEL: Record<ManagedEntityType, string> = {
  Shift: "This shift",
  Employee: "This employee's details",
  Location: "This location",
  Team: "This team",
};

/** The provider whose sync manages a record (Planday is the only provider with connections, plan §3.4). */
export function managingProvider(managedByIntegrationId: string): IntegrationProvider {
  return managedByFromIntegrationId(managedByIntegrationId)?.provider ?? "PLANDAY";
}

/**
 * INTEGRATION_MANAGED (409): a manager tried to change a field an integration owns. `details.provider` names
 * the provider ("PLANDAY"); `extra` adds context such as the refused `fields`.
 */
export function integrationManagedError(
  entityType: ManagedEntityType,
  managedByIntegrationId: string,
  extra: Record<string, unknown> = {},
): AppError {
  const provider = managingProvider(managedByIntegrationId);
  const name = PROVIDERS[provider].displayName;
  return new AppError(
    "INTEGRATION_MANAGED",
    `${ENTITY_LABEL[entityType]} is managed in ${name}. Make the change in ${name} and it will sync to ClockOff.`,
    {
      details: { provider, integrationId: managedByIntegrationId, entityType, ...extra },
    },
  );
}

/** `details.reason` of the refusal below. */
export const NOT_MANAGED_BY_INTEGRATION = "NOT_MANAGED_BY_INTEGRATION";

/**
 * An integration writer was asked to change a record the integration does not manage (a manual or CSV record,
 * one managed by another integration, or one a disconnect released). CONFLICT with
 * `details.reason = NOT_MANAGED_BY_INTEGRATION`; never retried.
 */
export function notManagedByIntegration(entityType: ManagedEntityType, id: string): AppError {
  return new AppError(
    "CONFLICT",
    `${ENTITY_LABEL[entityType]} is not managed by this integration`,
    {
      details: { reason: NOT_MANAGED_BY_INTEGRATION, entityType, id },
    },
  );
}

export function isNotManagedByIntegration(err: unknown): boolean {
  if (!isAppError(err) || err.code !== "CONFLICT") return false;
  const details = err.details as { reason?: unknown } | undefined;
  return details?.reason === NOT_MANAGED_BY_INTEGRATION || details?.reason === "MANAGED_BY_CHANGED";
}

/** A version conflict worth one retry with the fresh row (not a refusal). */
function isVersionConflict(err: unknown): boolean {
  return isAppError(err) && err.code === "CONFLICT" && !isNotManagedByIntegration(err);
}

export interface IntegrationWriteScope {
  /** Checked against the organisation; its provider is returned. */
  integrationId?: string;
  /** Live (not archived) employees of the organisation; INACTIVE is allowed (§6.5). */
  employeeIds?: readonly (string | null | undefined)[];
  /** Live locations of the organisation. */
  locationIds?: readonly (string | null | undefined)[];
  departmentIds?: readonly (string | null | undefined)[];
  teamIds?: readonly (string | null | undefined)[];
}

function uniqueIds(ids: readonly (string | null | undefined)[] | undefined): string[] {
  return [...new Set((ids ?? []).filter((id): id is string => typeof id === "string"))];
}

/**
 * Checks, in one statement, that the integration and every referenced employee, location, department and team
 * belong to the organisation (tenant isolation for the worker's writes, D-056). Throws NOT_FOUND naming the
 * unknown ids; returns the integration's provider when `integrationId` was given.
 */
export async function assertIntegrationWriteScope(
  tx: Prisma.TransactionClient,
  organisationId: string,
  scope: IntegrationWriteScope,
): Promise<{ provider: IntegrationProvider | null }> {
  const wanted = {
    INTEGRATION: scope.integrationId ? [scope.integrationId] : [],
    EMPLOYEE: uniqueIds(scope.employeeIds),
    LOCATION: uniqueIds(scope.locationIds),
    DEPARTMENT: uniqueIds(scope.departmentIds),
    TEAM: uniqueIds(scope.teamIds),
  };
  const parts: Prisma.Sql[] = [];
  if (wanted.INTEGRATION.length > 0) {
    parts.push(Prisma.sql`SELECT 'INTEGRATION' AS kind, id::text AS id, provider::text AS provider
      FROM integrations WHERE organisation_id = ${organisationId}::uuid
      AND id = ANY(${wanted.INTEGRATION}::uuid[])`);
  }
  if (wanted.EMPLOYEE.length > 0) {
    parts.push(Prisma.sql`SELECT 'EMPLOYEE' AS kind, id::text AS id, NULL::text AS provider FROM employees
      WHERE organisation_id = ${organisationId}::uuid AND deleted_at IS NULL
      AND id = ANY(${wanted.EMPLOYEE}::uuid[])`);
  }
  if (wanted.LOCATION.length > 0) {
    parts.push(Prisma.sql`SELECT 'LOCATION' AS kind, id::text AS id, NULL::text AS provider FROM locations
      WHERE organisation_id = ${organisationId}::uuid AND deleted_at IS NULL
      AND id = ANY(${wanted.LOCATION}::uuid[])`);
  }
  if (wanted.DEPARTMENT.length > 0) {
    parts.push(Prisma.sql`SELECT 'DEPARTMENT' AS kind, id::text AS id, NULL::text AS provider FROM departments
      WHERE organisation_id = ${organisationId}::uuid AND id = ANY(${wanted.DEPARTMENT}::uuid[])`);
  }
  if (wanted.TEAM.length > 0) {
    parts.push(Prisma.sql`SELECT 'TEAM' AS kind, id::text AS id, NULL::text AS provider FROM teams
      WHERE organisation_id = ${organisationId}::uuid AND id = ANY(${wanted.TEAM}::uuid[])`);
  }
  if (parts.length === 0) return { provider: null };
  const rows = await tx.$queryRaw<Array<{ kind: string; id: string; provider: string | null }>>`
    ${Prisma.join(parts, " UNION ALL ")}`;
  const found = new Set(rows.map((r) => `${r.kind}:${r.id}`));
  const missing: Record<string, string[]> = {};
  for (const [kind, ids] of Object.entries(wanted)) {
    const unknown = ids.filter((id) => !found.has(`${kind}:${id}`));
    if (unknown.length > 0) missing[kind] = unknown;
  }
  if (Object.keys(missing).length > 0) {
    throw new AppError(
      "NOT_FOUND",
      "A record the integration writes to is not in this organisation",
      {
        details: { reason: "TARGET_NOT_IN_ORGANISATION", missing },
      },
    );
  }
  const integration = rows.find((r) => r.kind === "INTEGRATION");
  return { provider: (integration?.provider as IntegrationProvider | undefined) ?? null };
}

// ── Types ───────────────────────────────────────────────────────────────────

/** A sync (or a disconnect) acting for one integration. Activity rows carry `actorType` (SYSTEM for syncs). */
export interface IntegrationShiftActor extends ShiftActor {
  integrationId: string;
}

/** The fields the writers read from a current shift (a `ShiftRow` satisfies it). */
export type IntegrationShiftCurrent = Pick<
  ShiftRow,
  | "id"
  | "organisationId"
  | "employeeId"
  | "locationId"
  | "startsAt"
  | "endsAt"
  | "timezone"
  | "status"
  | "version"
  | "externalShiftId"
  | "managedByIntegrationId"
  | "deletedAt"
>;

export type IntegrationShiftSkipReason =
  /** Ended (or COMPLETED): ended shifts are never modified. */
  | "ENDED"
  /** Not SCHEDULED (reschedule, cancel) or not CANCELLED (reinstate). */
  | "WRONG_STATUS"
  | "DELETED"
  /** REINSTATE of a shift the integration did not cancel (no `upstreamRemovedAt` on its map row). */
  | "NOT_REMOVED_UPSTREAM";

export interface IntegrationShiftWriteResult {
  rows: ShiftRow[];
  /** Publish after commit (`publishIntegrationShiftWrite`). */
  activities: ActivityEvent[];
  scheduleChanges: Array<{ employeeId: string; shiftIds: string[]; reason: ScheduleChangeReason }>;
  /** Changes not applied because the shift no longer allowed them (ended, completed, deleted, …). */
  skipped: Array<{ shiftId: string; reason: IntegrationShiftSkipReason }>;
}

export interface IntegrationShiftInput {
  /** The provider's shift id: the map row's `externalId`. */
  externalId: string;
  /** Portal-qualified `Shift.externalShiftId` (`PLANDAY:<portalId>:<id>`), unique per organisation. */
  externalShiftId: string;
  employeeId: string;
  locationId: string | null;
  startsAt: Date;
  endsAt: Date;
  /** IANA zone: the shift's own, else the portal's (§6.7). */
  timezone: string;
  /** Decision-input hash for the map row (§6.2). */
  lastHash: string | null;
  /** Activity metadata `reason` (default `CREATED`). */
  reason?: string;
}

/**
 * A change to a managed SCHEDULED shift (§6.6 rows 6, 7 and 9 to 13). Values are absolute; an omitted field
 * keeps the current value (the plan's shape has `endsAt` required; it is optional here so an UPDATE that only
 * moves the location needs no end).
 */
export interface ReschedulePatch {
  startsAt?: Date;
  endsAt?: Date;
  locationId?: string | null;
  /** REASSIGN in place (future shifts only, row 7): SCHEDULE_CHANGED for both employees. */
  employeeId?: string;
  timezone?: string;
  /**
   * End a running break even though `now` stays inside the new window: END_NOW (row 11) rounds the end up
   * to the minute, so the "outside the window" rule alone would leave the break running.
   */
  endRunningBreak?: boolean;
  /** Activity metadata `reason` (default `REASSIGNED` when the employee changes, else `RESCHEDULED`). */
  reason?: string;
}

export type IntegrationShiftCancelReason =
  ShiftRemovalReason | "OUT_OF_WINDOW" | "DISCONNECTED" | "REASSIGNED";

export function emptyIntegrationShiftWriteResult(): IntegrationShiftWriteResult {
  return { rows: [], activities: [], scheduleChanges: [], skipped: [] };
}

/** Concatenates results (scheduleChanges merged per employee and reason). */
export function mergeIntegrationShiftWriteResults(
  ...results: readonly IntegrationShiftWriteResult[]
): IntegrationShiftWriteResult {
  return {
    rows: results.flatMap((r) => r.rows),
    activities: results.flatMap((r) => r.activities),
    scheduleChanges: mergeScheduleChanges(results.flatMap((r) => r.scheduleChanges)),
    skipped: results.flatMap((r) => r.skipped),
  };
}

function mergeScheduleChanges(
  changes: IntegrationShiftWriteResult["scheduleChanges"],
): IntegrationShiftWriteResult["scheduleChanges"] {
  const byKey = new Map<
    string,
    { employeeId: string; ids: Set<string>; reason: ScheduleChangeReason }
  >();
  for (const change of changes) {
    const key = `${change.employeeId}:${change.reason}`;
    const entry = byKey.get(key) ?? {
      employeeId: change.employeeId,
      ids: new Set<string>(),
      reason: change.reason,
    };
    for (const id of change.shiftIds) entry.ids.add(id);
    byKey.set(key, entry);
  }
  return [...byKey.values()].map((e) => ({
    employeeId: e.employeeId,
    shiftIds: [...e.ids],
    reason: e.reason,
  }));
}

/**
 * After the transaction committed: the activity rows and one `SCHEDULE_CHANGED` per employee and reason on
 * the event bus (dashboards over SSE; the push-bridge leader turns them into silent pushes).
 */
export function publishIntegrationShiftWrite(
  organisationId: string,
  result: IntegrationShiftWriteResult,
): void {
  for (const event of result.activities) publishActivity(event);
  for (const change of mergeScheduleChanges(result.scheduleChanges)) {
    publishScheduleChanged(organisationId, change);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function chunks<T>(items: readonly T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The shift must be the actor's organisation's and managed by the actor's integration. */
function assertOwned(actor: IntegrationShiftActor, current: IntegrationShiftCurrent): void {
  if (current.organisationId !== actor.organisationId) {
    throw new AppError("NOT_FOUND", "Shift not found");
  }
  if (current.managedByIntegrationId !== actor.integrationId) {
    throw notManagedByIntegration("Shift", current.id);
  }
}

function hasEnded(row: Pick<ShiftRow, "status" | "endsAt">, now: Date): boolean {
  return row.status === "COMPLETED" || row.endsAt.getTime() <= now.getTime();
}

/** Why a SCHEDULED-only change cannot touch `row` (null: it can). */
function scheduledSkipReason(
  row: Pick<ShiftRow, "status" | "endsAt" | "deletedAt">,
  now: Date,
): IntegrationShiftSkipReason | null {
  if (row.deletedAt) return "DELETED";
  if (hasEnded(row, now)) return "ENDED";
  if (row.status !== "SCHEDULED") return "WRONG_STATUS";
  return null;
}

async function findFreshShift(
  tx: Prisma.TransactionClient,
  organisationId: string,
  shiftId: string,
): Promise<ShiftRow | null> {
  return tx.shift.findFirst({ where: { id: shiftId, organisationId }, include: shiftInclude });
}

async function findRows(
  tx: Prisma.TransactionClient,
  organisationId: string,
  ids: readonly string[],
): Promise<ShiftRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx.shift.findMany({
    where: { organisationId, id: { in: [...ids] } },
    include: shiftInclude,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

async function createActivities(
  tx: Prisma.TransactionClient,
  data: Prisma.ActivityEventCreateManyInput[],
): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for (const chunk of chunks(data)) {
    events.push(...(await tx.activityEvent.createManyAndReturn({ data: chunk })));
  }
  return events;
}

function activityExtra(
  integrationId: string,
  reason: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { source: managingProvider(integrationId), reason, integrationId, ...extra };
}

/** The latest ACTIVE break session per shift (what `findActiveBreakSession` returns, for many shifts). */
async function activeBreakSessions(
  tx: Prisma.TransactionClient,
  organisationId: string,
  shiftIds: readonly string[],
) {
  if (shiftIds.length === 0) return new Map<string, ActiveSession>();
  const sessions = await tx.breakSession.findMany({
    where: { organisationId, shiftId: { in: [...shiftIds] }, status: "ACTIVE" },
    select: { id: true, shiftId: true, employeeId: true, startedAt: true, deviceId: true },
    orderBy: { startedAt: "desc" },
  });
  const byShift = new Map<string, ActiveSession>();
  for (const session of sessions) {
    if (!byShift.has(session.shiftId)) byShift.set(session.shiftId, session);
  }
  return byShift;
}

interface ActiveSession {
  id: string;
  shiftId: string;
  employeeId: string;
  startedAt: Date;
  deviceId: string | null;
}

/** Map rows of `shiftIds` (this integration's): `upstreamRemovedAt` set (cancel) or cleared (reinstate). */
async function markShiftMapRows(
  tx: Prisma.TransactionClient,
  actor: IntegrationShiftActor,
  shiftIds: readonly string[],
  upstreamRemovedAt: Date | null,
): Promise<void> {
  if (shiftIds.length === 0) return;
  await tx.externalEntityMap.updateMany({
    where: {
      organisationId: actor.organisationId,
      integrationId: actor.integrationId,
      entityType: "SHIFT",
      internalId: { in: [...shiftIds] },
    },
    data: { upstreamRemovedAt },
  });
}

// ── Create ──────────────────────────────────────────────────────────────────

/**
 * CREATE (§6.6 row 1): inserts SCHEDULED shifts (`source INTEGRATION`, `managedByIntegrationId`, notes null)
 * and their `SHIFT` map rows with `shift.createMany` + `externalEntityMap.createMany`, then returns the rows.
 * Overlaps with other shifts are allowed (Planday is the source of truth, D-034). A map row of the same
 * external id whose shift is gone is replaced; one whose shift is live means the caller should not have
 * decided CREATE (CONFLICT `EXTERNAL_ID_MAPPED`). A soft-deleted shift still holding the `externalShiftId`
 * is renamed out of the way (`…:deleted:<id>`); a live one answers CONFLICT `EXTERNAL_SHIFT_ID_TAKEN`.
 * `opts.recordActivity: false` leaves out the SHIFT_CREATED rows (first SYNC after onboarding: one
 * INTEGRATION_SYNCED summary instead). `opts.now` stamps the map rows (default: the clock).
 */
export async function createIntegrationShifts(
  tx: Prisma.TransactionClient,
  actor: ShiftActor,
  integrationId: string,
  inputs: IntegrationShiftInput[],
  opts: { recordActivity: boolean; now?: Date },
): Promise<IntegrationShiftWriteResult> {
  if (inputs.length === 0) return emptyIntegrationShiftWriteResult();
  const results: IntegrationShiftWriteResult[] = [];
  for (const chunk of chunks(inputs)) {
    results.push(await createChunk(tx, actor, integrationId, chunk, opts));
  }
  return mergeIntegrationShiftWriteResults(...results);
}

async function createChunk(
  tx: Prisma.TransactionClient,
  actor: ShiftActor,
  integrationId: string,
  inputs: IntegrationShiftInput[],
  opts: { recordActivity: boolean; now?: Date },
): Promise<IntegrationShiftWriteResult> {
  const organisationId = actor.organisationId;
  const now = opts.now ?? new Date();
  const externalIds = new Set<string>();
  const externalShiftIds = new Set<string>();
  for (const input of inputs) {
    if (input.endsAt.getTime() <= input.startsAt.getTime()) {
      throw new Error(`createIntegrationShifts: shift ${input.externalId} ends before it starts`);
    }
    if (externalIds.has(input.externalId) || externalShiftIds.has(input.externalShiftId)) {
      throw new Error(`createIntegrationShifts: shift ${input.externalId} appears twice`);
    }
    externalIds.add(input.externalId);
    externalShiftIds.add(input.externalShiftId);
  }

  const { provider } = await assertIntegrationWriteScope(tx, organisationId, {
    integrationId,
    employeeIds: inputs.map((i) => i.employeeId),
    locationIds: inputs.map((i) => i.locationId),
  });

  // Map rows of these external ids, and the shifts they point at or that already hold the external shift ids.
  const mapRows = await tx.externalEntityMap.findMany({
    where: {
      organisationId,
      integrationId,
      entityType: "SHIFT",
      externalId: { in: [...externalIds] },
    },
    select: { id: true, externalId: true, internalId: true },
  });
  const related = await tx.shift.findMany({
    where: {
      organisationId,
      OR: [
        { externalShiftId: { in: [...externalShiftIds] } },
        ...(mapRows.length > 0 ? [{ id: { in: mapRows.map((m) => m.internalId) } }] : []),
      ],
    },
    select: { id: true, externalShiftId: true, deletedAt: true },
  });
  const live = new Set(related.filter((r) => r.deletedAt === null).map((r) => r.id));
  const liveMapped = mapRows.filter((m) => live.has(m.internalId));
  if (liveMapped.length > 0) {
    throw new AppError("CONFLICT", "These shifts already exist in ClockOff", {
      details: { reason: "EXTERNAL_ID_MAPPED", externalIds: liveMapped.map((m) => m.externalId) },
    });
  }
  const holders = related.filter(
    (r) => r.externalShiftId !== null && externalShiftIds.has(r.externalShiftId),
  );
  const liveHolders = holders.filter((h) => h.deletedAt === null);
  if (liveHolders.length > 0) {
    throw new AppError("CONFLICT", "Another shift already uses this external shift id", {
      details: { reason: "EXTERNAL_SHIFT_ID_TAKEN", shiftIds: liveHolders.map((h) => h.id) },
    });
  }
  // Map rows whose shift is gone (soft-deleted, or removed with its employee) are replaced.
  if (mapRows.length > 0) {
    await tx.externalEntityMap.deleteMany({ where: { id: { in: mapRows.map((m) => m.id) } } });
  }
  for (const holder of holders) {
    // A soft-deleted row keeps its external id, which is unique per organisation: move it aside.
    await tx.shift.updateMany({
      where: { id: holder.id, organisationId, deletedAt: { not: null } },
      data: { externalShiftId: `${holder.externalShiftId}:deleted:${holder.id}` },
    });
  }

  const planned = inputs.map((input) => ({ input, id: randomUUID() }));
  await tx.shift.createMany({
    data: planned.map(({ input, id }) => ({
      id,
      organisationId,
      employeeId: input.employeeId,
      locationId: input.locationId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      status: "SCHEDULED" as const,
      source: "INTEGRATION" as const,
      externalShiftId: input.externalShiftId,
      notes: null,
      managedByIntegrationId: integrationId,
    })),
  });
  await tx.externalEntityMap.createMany({
    data: planned.map(({ input, id }) => ({
      organisationId,
      integrationId,
      provider: provider ?? managingProvider(integrationId),
      entityType: "SHIFT" as const,
      externalId: input.externalId,
      internalId: id,
      lastSeenAt: now,
      lastHash: input.lastHash,
    })),
  });
  const rows = await findRows(
    tx,
    organisationId,
    planned.map((p) => p.id),
  );
  const reasonById = new Map<string, string>(
    planned.map((p) => [p.id, p.input.reason ?? "CREATED"]),
  );
  const activities = opts.recordActivity
    ? await createActivities(
        tx,
        rows.map((row) =>
          shiftActivityData(
            actor,
            "SHIFT_CREATED",
            row,
            activityExtra(integrationId, reasonById.get(row.id) ?? "CREATED"),
            now,
          ),
        ),
      )
    : [];
  return {
    rows,
    activities,
    scheduleChanges: mergeScheduleChanges(
      rows.map((r) => ({ employeeId: r.employeeId, shiftIds: [r.id], reason: "CREATED" as const })),
    ),
    skipped: [],
  };
}

// ── Reschedule ──────────────────────────────────────────────────────────────

/** UPDATE / REASSIGN / UPDATE_END / END_NOW of one managed SCHEDULED shift (§6.6 rows 6, 7, 9 to 13). */
export async function rescheduleIntegrationShift(
  tx: Prisma.TransactionClient,
  actor: IntegrationShiftActor,
  current: IntegrationShiftCurrent,
  patch: ReschedulePatch,
  now: Date,
): Promise<IntegrationShiftWriteResult> {
  return bulkRescheduleIntegrationShifts(tx, actor, [{ current, patch }], now);
}

interface PlannedReschedule {
  current: IntegrationShiftCurrent;
  patch: ReschedulePatch;
  startsAt: Date;
  endsAt: Date;
  employeeId: string;
  locationId: string | null;
  timezone: string;
  timesChanged: boolean;
}

function planReschedule(
  current: IntegrationShiftCurrent,
  patch: ReschedulePatch,
): PlannedReschedule {
  const startsAt = patch.startsAt ?? current.startsAt;
  const endsAt = patch.endsAt ?? current.endsAt;
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new Error(`rescheduleIntegrationShift: shift ${current.id} would end before it starts`);
  }
  return {
    current,
    patch,
    startsAt,
    endsAt,
    employeeId: patch.employeeId ?? current.employeeId,
    locationId: patch.locationId !== undefined ? patch.locationId : current.locationId,
    timezone: patch.timezone ?? current.timezone,
    timesChanged:
      startsAt.getTime() !== current.startsAt.getTime() ||
      endsAt.getTime() !== current.endsAt.getTime(),
  };
}

/**
 * Changed shifts of one page in one version-checked `UPDATE shifts … FROM (VALUES …)` (§6.1): the version is
 * bumped only where it still equals the value read, the row is still SCHEDULED, live and managed by this
 * integration. Rows the statement did not return had a concurrent change and are retried one by one through
 * `updateShiftRow` with the fresh row (a second conflict throws and rolls the page back). A running break the
 * new window no longer covers is ended (`SHIFT_ENDED`); `patch.endRunningBreak` ends it regardless (END_NOW).
 * Ended, deleted or non-SCHEDULED shifts are reported in `skipped`, never written.
 */
export async function bulkRescheduleIntegrationShifts(
  tx: Prisma.TransactionClient,
  actor: IntegrationShiftActor,
  changes: Array<{ current: IntegrationShiftCurrent; patch: ReschedulePatch }>,
  now: Date,
): Promise<IntegrationShiftWriteResult> {
  if (changes.length === 0) return emptyIntegrationShiftWriteResult();
  const seen = new Set<string>();
  for (const { current } of changes) {
    assertOwned(actor, current);
    if (seen.has(current.id)) {
      throw new Error(`bulkRescheduleIntegrationShifts: shift ${current.id} appears twice`);
    }
    seen.add(current.id);
  }
  const results: IntegrationShiftWriteResult[] = [];
  for (const chunk of chunks(changes)) results.push(await rescheduleChunk(tx, actor, chunk, now));
  return mergeIntegrationShiftWriteResults(...results);
}

async function rescheduleChunk(
  tx: Prisma.TransactionClient,
  actor: IntegrationShiftActor,
  changes: Array<{ current: IntegrationShiftCurrent; patch: ReschedulePatch }>,
  now: Date,
): Promise<IntegrationShiftWriteResult> {
  const organisationId = actor.organisationId;
  const skipped: IntegrationShiftWriteResult["skipped"] = [];
  const plans: PlannedReschedule[] = [];
  for (const { current, patch } of changes) {
    const skip = scheduledSkipReason(current, now);
    if (skip) skipped.push({ shiftId: current.id, reason: skip });
    else plans.push(planReschedule(current, patch));
  }
  if (plans.length === 0) return { ...emptyIntegrationShiftWriteResult(), skipped };

  await assertIntegrationWriteScope(tx, organisationId, {
    employeeIds: plans
      .filter((p) => p.employeeId !== p.current.employeeId)
      .map((p) => p.employeeId),
    locationIds: plans
      .filter((p) => p.locationId !== p.current.locationId)
      .map((p) => p.locationId),
  });

  const values = Prisma.join(
    plans.map(
      (p) =>
        Prisma.sql`(${p.current.id}::uuid, ${p.current.version}::int, ${p.startsAt}::timestamptz, ${p.endsAt}::timestamptz, ${p.employeeId}::uuid, ${p.locationId}::uuid, ${p.timezone}::text)`,
    ),
  );
  const updated = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE shifts AS s SET
      starts_at = v.starts_at,
      ends_at = v.ends_at,
      employee_id = v.employee_id,
      location_id = v.location_id,
      timezone = v.timezone,
      version = s.version + 1,
      updated_at = now()
    FROM (VALUES ${values}) AS v(id, version, starts_at, ends_at, employee_id, location_id, timezone)
    WHERE s.id = v.id
      AND s.version = v.version
      AND s.organisation_id = ${organisationId}::uuid
      AND s.managed_by_integration_id = ${actor.integrationId}::uuid
      AND s.deleted_at IS NULL
      AND s.status = 'SCHEDULED'
    RETURNING s.id`;
  const updatedIds = new Set(updated.map((r) => r.id));

  // Concurrent changes: one retry each with the fresh row (the patch holds absolute values).
  const applied: PlannedReschedule[] = plans.filter((p) => updatedIds.has(p.current.id));
  for (const plan of plans.filter((p) => !updatedIds.has(p.current.id))) {
    const fresh = await findFreshShift(tx, organisationId, plan.current.id);
    if (!fresh) {
      skipped.push({ shiftId: plan.current.id, reason: "DELETED" });
      continue;
    }
    assertOwned(actor, fresh);
    const skip = scheduledSkipReason(fresh, now);
    if (skip) {
      skipped.push({ shiftId: fresh.id, reason: skip });
      continue;
    }
    const retried = planReschedule(fresh, plan.patch);
    await updateShiftRow(
      tx,
      organisationId,
      fresh,
      {
        startsAt: retried.startsAt,
        endsAt: retried.endsAt,
        employeeId: retried.employeeId,
        locationId: retried.locationId,
        timezone: retried.timezone,
      },
      undefined,
      { managedByIntegrationId: actor.integrationId },
    );
    applied.push(retried);
  }
  if (applied.length === 0) return { ...emptyIntegrationShiftWriteResult(), skipped };

  const activities: ActivityEvent[] = [];
  const breakCandidates = applied.filter((p) => p.timesChanged || p.patch.endRunningBreak);
  const sessions = await activeBreakSessions(
    tx,
    organisationId,
    breakCandidates.map((p) => p.current.id),
  );
  for (const plan of breakCandidates) {
    const session = sessions.get(plan.current.id);
    if (!session) continue;
    const event = await endBreakSessionOutside(
      tx,
      actor,
      { id: plan.current.id, employeeId: session.employeeId },
      session,
      plan.patch.endRunningBreak ? null : { startsAt: plan.startsAt, endsAt: plan.endsAt },
      now,
    );
    if (event) activities.push(event);
  }

  const rows = await findRows(
    tx,
    organisationId,
    applied.map((p) => p.current.id),
  );
  const planById = new Map(applied.map((p) => [p.current.id, p]));
  activities.push(
    ...(await createActivities(
      tx,
      rows.map((row) => {
        const plan = planById.get(row.id)!;
        const reassigned = plan.employeeId !== plan.current.employeeId;
        return shiftActivityData(
          actor,
          "SHIFT_UPDATED",
          row,
          activityExtra(
            actor.integrationId,
            plan.patch.reason ?? (reassigned ? "REASSIGNED" : "RESCHEDULED"),
            {
              changedFields: changedFields(plan),
              ...(reassigned ? { previousEmployeeId: plan.current.employeeId } : {}),
            },
          ),
          now,
        );
      }),
    )),
  );
  const scheduleChanges: IntegrationShiftWriteResult["scheduleChanges"] = [];
  for (const plan of applied) {
    scheduleChanges.push({
      employeeId: plan.employeeId,
      shiftIds: [plan.current.id],
      reason: "UPDATED",
    });
    if (plan.employeeId !== plan.current.employeeId) {
      scheduleChanges.push({
        employeeId: plan.current.employeeId,
        shiftIds: [plan.current.id],
        reason: "UPDATED",
      });
    }
  }
  return { rows, activities, scheduleChanges: mergeScheduleChanges(scheduleChanges), skipped };
}

function changedFields(plan: PlannedReschedule): string[] {
  const fields: string[] = [];
  if (plan.startsAt.getTime() !== plan.current.startsAt.getTime()) fields.push("startsAt");
  if (plan.endsAt.getTime() !== plan.current.endsAt.getTime()) fields.push("endsAt");
  if (plan.employeeId !== plan.current.employeeId) fields.push("employeeId");
  if (plan.locationId !== plan.current.locationId) fields.push("locationId");
  if (plan.timezone !== plan.current.timezone) fields.push("timezone");
  return fields;
}

// ── Cancel ──────────────────────────────────────────────────────────────────

/**
 * CANCEL (§6.6 rows 8, 14 and 16; disconnect `CANCEL_FUTURE_SHIFTS`, reason `DISCONNECTED`): status
 * CANCELLED, version +1, a running break ended (`SHIFT_ENDED`), the map row's `upstreamRemovedAt = now`
 * (eligible for REINSTATE, row 15). Never deleted. Ended or already cancelled shifts are skipped.
 */
export async function cancelIntegrationShift(
  tx: Prisma.TransactionClient,
  actor: IntegrationShiftActor,
  current: IntegrationShiftCurrent,
  now: Date,
  reason: IntegrationShiftCancelReason,
): Promise<IntegrationShiftWriteResult> {
  return cancelIntegrationShifts(tx, actor, [{ current, reason }], now);
}

/** {@link cancelIntegrationShift} for many shifts in a few statements (a page, or a whole disconnect). */
export async function cancelIntegrationShifts(
  tx: Prisma.TransactionClient,
  actor: IntegrationShiftActor,
  items: Array<{ current: IntegrationShiftCurrent; reason: IntegrationShiftCancelReason }>,
  now: Date,
): Promise<IntegrationShiftWriteResult> {
  if (items.length === 0) return emptyIntegrationShiftWriteResult();
  const seen = new Set<string>();
  for (const { current } of items) {
    assertOwned(actor, current);
    if (seen.has(current.id)) {
      throw new Error(`cancelIntegrationShifts: shift ${current.id} appears twice`);
    }
    seen.add(current.id);
  }
  const results: IntegrationShiftWriteResult[] = [];
  for (const chunk of chunks(items)) results.push(await cancelChunk(tx, actor, chunk, now));
  return mergeIntegrationShiftWriteResults(...results);
}

async function cancelChunk(
  tx: Prisma.TransactionClient,
  actor: IntegrationShiftActor,
  items: Array<{ current: IntegrationShiftCurrent; reason: IntegrationShiftCancelReason }>,
  now: Date,
): Promise<IntegrationShiftWriteResult> {
  const organisationId = actor.organisationId;
  const skipped: IntegrationShiftWriteResult["skipped"] = [];
  const targets = items.filter(({ current }) => {
    const skip = scheduledSkipReason(current, now);
    if (skip) skipped.push({ shiftId: current.id, reason: skip });
    return skip === null;
  });
  if (targets.length === 0) return { ...emptyIntegrationShiftWriteResult(), skipped };

  const values = Prisma.join(
    targets.map(({ current }) => Prisma.sql`(${current.id}::uuid, ${current.version}::int)`),
  );
  const updated = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE shifts AS s SET status = 'CANCELLED', version = s.version + 1, updated_at = now()
    FROM (VALUES ${values}) AS v(id, version)
    WHERE s.id = v.id
      AND s.version = v.version
      AND s.organisation_id = ${organisationId}::uuid
      AND s.managed_by_integration_id = ${actor.integrationId}::uuid
      AND s.deleted_at IS NULL
      AND s.status = 'SCHEDULED'
    RETURNING s.id`;
  const updatedIds = new Set(updated.map((r) => r.id));
  const applied = targets.filter(({ current }) => updatedIds.has(current.id));
  for (const item of targets.filter(({ current }) => !updatedIds.has(current.id))) {
    const fresh = await findFreshShift(tx, organisationId, item.current.id);
    if (!fresh) {
      skipped.push({ shiftId: item.current.id, reason: "DELETED" });
      continue;
    }
    assertOwned(actor, fresh);
    const skip = scheduledSkipReason(fresh, now);
    if (skip) {
      skipped.push({ shiftId: fresh.id, reason: skip });
      continue;
    }
    await updateShiftRow(tx, organisationId, fresh, { status: "CANCELLED" }, undefined, {
      managedByIntegrationId: actor.integrationId,
    });
    applied.push({ current: fresh, reason: item.reason });
  }
  if (applied.length === 0) return { ...emptyIntegrationShiftWriteResult(), skipped };

  const ids = applied.map(({ current }) => current.id);
  const activities: ActivityEvent[] = [];
  const sessions = await activeBreakSessions(tx, organisationId, ids);
  for (const { current } of applied) {
    const session = sessions.get(current.id);
    if (!session) continue;
    const event = await endBreakSessionOutside(
      tx,
      actor,
      { id: current.id, employeeId: session.employeeId },
      session,
      null,
      now,
    );
    if (event) activities.push(event);
  }
  await markShiftMapRows(tx, actor, ids, now);
  const rows = await findRows(tx, organisationId, ids);
  const reasonById = new Map(applied.map(({ current, reason }) => [current.id, reason]));
  activities.push(
    ...(await createActivities(
      tx,
      rows.map((row) =>
        shiftActivityData(
          actor,
          "SHIFT_CANCELLED",
          row,
          activityExtra(actor.integrationId, reasonById.get(row.id) ?? "DELETED"),
          now,
        ),
      ),
    )),
  );
  return {
    rows,
    activities,
    scheduleChanges: mergeScheduleChanges(
      rows.map((r) => ({
        employeeId: r.employeeId,
        shiftIds: [r.id],
        reason: "CANCELLED" as const,
      })),
    ),
    skipped,
  };
}

// ── Reinstate ───────────────────────────────────────────────────────────────

/**
 * REINSTATE (§6.6 row 15) with the full incoming target: a shift the integration cancelled (its map row has
 * `upstreamRemovedAt`) and that has not ended goes back to SCHEDULED with Planday's employee, location and
 * times; version +1; `upstreamRemovedAt = null`. When the employee changes, both employees get
 * SCHEDULE_CHANGED, as for REASSIGN. A shift the integration did not cancel, one already scheduled, or a
 * target that has already ended is skipped.
 */
export async function reinstateIntegrationShift(
  tx: Prisma.TransactionClient,
  actor: IntegrationShiftActor,
  current: IntegrationShiftCurrent,
  target: {
    startsAt: Date;
    endsAt: Date;
    employeeId: string;
    locationId: string | null;
    /** The shift's zone when Planday changed it (default: unchanged). */
    timezone?: string;
  },
  now: Date = new Date(),
): Promise<IntegrationShiftWriteResult> {
  assertOwned(actor, current);
  if (target.endsAt.getTime() <= target.startsAt.getTime()) {
    throw new Error(`reinstateIntegrationShift: shift ${current.id} would end before it starts`);
  }
  const organisationId = actor.organisationId;
  const skip = (reason: IntegrationShiftSkipReason): IntegrationShiftWriteResult => ({
    ...emptyIntegrationShiftWriteResult(),
    skipped: [{ shiftId: current.id, reason }],
  });
  const reinstateSkip = (row: IntegrationShiftCurrent): IntegrationShiftSkipReason | null => {
    if (row.deletedAt) return "DELETED";
    if (row.status !== "CANCELLED") return "WRONG_STATUS";
    if (row.endsAt.getTime() <= now.getTime() || target.endsAt.getTime() <= now.getTime()) {
      return "ENDED";
    }
    return null;
  };
  const first = reinstateSkip(current);
  if (first) return skip(first);

  const mapRow = await tx.externalEntityMap.findFirst({
    where: {
      organisationId,
      integrationId: actor.integrationId,
      entityType: "SHIFT",
      internalId: current.id,
    },
    select: { upstreamRemovedAt: true },
  });
  if (!mapRow?.upstreamRemovedAt) return skip("NOT_REMOVED_UPSTREAM");
  await assertIntegrationWriteScope(tx, organisationId, {
    employeeIds: [target.employeeId],
    locationIds: [target.locationId],
  });

  const data = {
    status: "SCHEDULED" as const,
    employeeId: target.employeeId,
    locationId: target.locationId,
    startsAt: target.startsAt,
    endsAt: target.endsAt,
    ...(target.timezone ? { timezone: target.timezone } : {}),
  };
  const guard = { managedByIntegrationId: actor.integrationId };
  let previous: IntegrationShiftCurrent = current;
  let row: ShiftRow;
  try {
    row = await updateShiftRow(tx, organisationId, current, data, undefined, guard);
  } catch (err) {
    if (!isVersionConflict(err)) throw err;
    const fresh = await findFreshShift(tx, organisationId, current.id);
    if (!fresh) return skip("DELETED");
    assertOwned(actor, fresh);
    const again = reinstateSkip(fresh);
    if (again) return skip(again);
    previous = fresh;
    row = await updateShiftRow(tx, organisationId, fresh, data, undefined, guard);
  }
  await markShiftMapRows(tx, actor, [row.id], null);
  const reassigned = previous.employeeId !== row.employeeId;
  const event = await recordIntegrationShiftActivity(
    tx,
    actor,
    "SHIFT_UPDATED",
    row,
    "REINSTATED",
    {
      changedFields: ["status", "startsAt", "endsAt", "employeeId", "locationId"].filter((field) =>
        field === "status"
          ? true
          : !sameValue(previous, row, field as keyof IntegrationShiftCurrent),
      ),
      ...(reassigned ? { previousEmployeeId: previous.employeeId } : {}),
    },
    now,
  );
  const scheduleChanges: IntegrationShiftWriteResult["scheduleChanges"] = [
    { employeeId: row.employeeId, shiftIds: [row.id], reason: "UPDATED" },
  ];
  if (reassigned) {
    scheduleChanges.push({
      employeeId: previous.employeeId,
      shiftIds: [row.id],
      reason: "UPDATED",
    });
  }
  return { rows: [row], activities: [event], scheduleChanges, skipped: [] };
}

function sameValue(
  a: IntegrationShiftCurrent,
  b: IntegrationShiftCurrent,
  field: keyof IntegrationShiftCurrent,
): boolean {
  const x = a[field];
  const y = b[field];
  if (x instanceof Date && y instanceof Date) return x.getTime() === y.getTime();
  return x === y;
}

async function recordIntegrationShiftActivity(
  tx: Prisma.TransactionClient,
  actor: IntegrationShiftActor,
  type: ShiftActivityType,
  row: ShiftRow,
  reason: string,
  extra: Record<string, unknown>,
  now: Date,
): Promise<ActivityEvent> {
  const [event] = await createActivities(tx, [
    shiftActivityData(actor, type, row, activityExtra(actor.integrationId, reason, extra), now),
  ]);
  return event!;
}

// ── Supersede (in-progress reassignment) ────────────────────────────────────

/**
 * §6.6 row 14 with a mapped new assignee: an in-progress shift reassigned in Planday is cancelled for the old
 * employee (version +1, running break ended `SHIFT_ENDED`) and created afresh for the new one, in the same
 * transaction. The old shift's `externalShiftId` becomes `<externalShiftId>:superseded:<oldShiftId>` (the
 * column is unique per organisation) and the map row is repointed to the new shift (`upstreamRemovedAt`
 * cleared, `lastHash` from `replacement`). In-place reassignment (row 7) is for future shifts only.
 */
export async function supersedeIntegrationShift(
  tx: Prisma.TransactionClient,
  actor: IntegrationShiftActor,
  current: IntegrationShiftCurrent,
  replacement: IntegrationShiftInput,
  now: Date,
): Promise<IntegrationShiftWriteResult> {
  assertOwned(actor, current);
  const organisationId = actor.organisationId;
  const skipReason = scheduledSkipReason(current, now);
  if (skipReason) {
    return {
      ...emptyIntegrationShiftWriteResult(),
      skipped: [{ shiftId: current.id, reason: skipReason }],
    };
  }
  const data = {
    status: "CANCELLED" as const,
    externalShiftId: `${current.externalShiftId ?? replacement.externalShiftId}:superseded:${current.id}`,
  };
  const guard = { managedByIntegrationId: actor.integrationId };
  let old: ShiftRow;
  try {
    old = await updateShiftRow(tx, organisationId, current, data, undefined, guard);
  } catch (err) {
    if (!isVersionConflict(err)) throw err;
    const fresh = await findFreshShift(tx, organisationId, current.id);
    if (!fresh) {
      return {
        ...emptyIntegrationShiftWriteResult(),
        skipped: [{ shiftId: current.id, reason: "DELETED" }],
      };
    }
    assertOwned(actor, fresh);
    const again = scheduledSkipReason(fresh, now);
    if (again) {
      return {
        ...emptyIntegrationShiftWriteResult(),
        skipped: [{ shiftId: fresh.id, reason: again }],
      };
    }
    old = await updateShiftRow(tx, organisationId, fresh, data, undefined, guard);
  }
  const activities: ActivityEvent[] = [];
  const session = (await activeBreakSessions(tx, organisationId, [old.id])).get(old.id);
  if (session) {
    const event = await endBreakSessionOutside(
      tx,
      actor,
      { id: old.id, employeeId: session.employeeId },
      session,
      null,
      now,
    );
    if (event) activities.push(event);
  }
  // The map row moves to the new shift: drop it here, createIntegrationShifts writes it afresh.
  await tx.externalEntityMap.deleteMany({
    where: {
      organisationId,
      integrationId: actor.integrationId,
      entityType: "SHIFT",
      internalId: old.id,
    },
  });
  const created = await createIntegrationShifts(
    tx,
    actor,
    actor.integrationId,
    [{ ...replacement, reason: replacement.reason ?? "REASSIGNED" }],
    { recordActivity: true, now },
  );
  activities.push(
    await recordIntegrationShiftActivity(
      tx,
      actor,
      "SHIFT_CANCELLED",
      old,
      "REASSIGNED",
      {
        supersededByShiftId: created.rows[0]?.id ?? null,
      },
      now,
    ),
  );
  return mergeIntegrationShiftWriteResults(
    {
      rows: [old],
      activities,
      scheduleChanges: [{ employeeId: old.employeeId, shiftIds: [old.id], reason: "CANCELLED" }],
      skipped: [],
    },
    created,
  );
}

// ── Recreate (row 15 after the cancelled shift's own times passed) ──────────

/**
 * §6.6 row 15 for a shift this integration cancelled (`upstreamRemovedAt` set on its map row) whose own times have
 * passed while Planday publishes it again for a time that has not: the ended shift is never modified (spec §5), so
 * Planday's shift is created afresh with `replacement` (the full target) and the map row moves to it
 * (`upstreamRemovedAt` cleared, `lastHash` from `replacement`). The old shift stays CANCELLED with its times; only
 * its `externalShiftId` becomes `<externalShiftId>:superseded:<oldShiftId>` (unique per organisation), without a
 * version bump (nothing a device or dashboard shows changes). Activity SHIFT_CREATED, reason `REINSTATED`. A shift
 * that is not CANCELLED, was not cancelled by the integration, is deleted, or a replacement already over is
 * reported in `skipped`.
 */
export async function recreateIntegrationShift(
  tx: Prisma.TransactionClient,
  actor: IntegrationShiftActor,
  current: IntegrationShiftCurrent,
  replacement: IntegrationShiftInput,
  now: Date,
): Promise<IntegrationShiftWriteResult> {
  assertOwned(actor, current);
  const organisationId = actor.organisationId;
  const skip = (reason: IntegrationShiftSkipReason): IntegrationShiftWriteResult => ({
    ...emptyIntegrationShiftWriteResult(),
    skipped: [{ shiftId: current.id, reason }],
  });
  if (current.deletedAt) return skip("DELETED");
  if (current.status !== "CANCELLED") return skip("WRONG_STATUS");
  if (replacement.endsAt.getTime() <= now.getTime()) return skip("ENDED");
  const mapRow = await tx.externalEntityMap.findFirst({
    where: {
      organisationId,
      integrationId: actor.integrationId,
      entityType: "SHIFT",
      internalId: current.id,
    },
    select: { id: true, upstreamRemovedAt: true },
  });
  if (!mapRow?.upstreamRemovedAt) return skip("NOT_REMOVED_UPSTREAM");
  const renamed = await tx.shift.updateMany({
    where: {
      id: current.id,
      organisationId,
      managedByIntegrationId: actor.integrationId,
      status: "CANCELLED",
      deletedAt: null,
    },
    data: {
      externalShiftId: `${current.externalShiftId ?? replacement.externalShiftId}:superseded:${current.id}`,
    },
  });
  if (renamed.count === 0) return skip("WRONG_STATUS");
  // The map row moves to the new shift: drop it here, createIntegrationShifts writes it afresh.
  await tx.externalEntityMap.delete({ where: { id: mapRow.id } });
  return createIntegrationShifts(
    tx,
    actor,
    actor.integrationId,
    [{ ...replacement, reason: replacement.reason ?? "REINSTATED" }],
    { recordActivity: true, now },
  );
}

// ── Conflict replacement (INITIAL sync) ─────────────────────────────────────

/**
 * §6.6 Overlaps: the INITIAL SYNC cancels a manual or CSV shift the manager ticked for replacement, in the
 * transaction that creates the Planday shift replacing it. The one writer allowed to touch an unmanaged
 * shift, for the ids on the run's `replaceShiftIds` only (the caller's check), and only while the shift is
 * unmanaged, SCHEDULED and still in the future. Activity SHIFT_CANCELLED `{ source, reason:
 * "REPLACED_BY_PLANDAY" }` and audit `integration.conflicting_shift_replaced` on behalf of the manager who
 * finished (`approvedByUserId`). Returns null when the shift was not cancelled.
 */
export async function cancelReplacedShift(
  tx: Prisma.TransactionClient,
  input: {
    organisationId: string;
    shiftId: string;
    approvedByUserId: string | null;
    now: Date;
    /** The Planday shift that replaces it, for the audit row. */
    replacedByExternalShiftId?: string | null;
    /** Activity metadata `source` (default PLANDAY). */
    provider?: IntegrationProvider;
  },
): Promise<IntegrationShiftWriteResult | null> {
  const { organisationId, now } = input;
  const replaceable = (row: ShiftRow | null): row is ShiftRow =>
    row !== null &&
    row.deletedAt === null &&
    row.managedByIntegrationId === null &&
    row.status === "SCHEDULED" &&
    row.startsAt.getTime() > now.getTime();
  let current = await findFreshShift(tx, organisationId, input.shiftId);
  if (!replaceable(current)) return null;
  const guard = { managedByIntegrationId: null };
  let row: ShiftRow;
  try {
    row = await updateShiftRow(
      tx,
      organisationId,
      current,
      { status: "CANCELLED" },
      undefined,
      guard,
    );
  } catch (err) {
    if (!isVersionConflict(err)) throw err;
    current = await findFreshShift(tx, organisationId, input.shiftId);
    if (!replaceable(current)) return null;
    row = await updateShiftRow(
      tx,
      organisationId,
      current,
      { status: "CANCELLED" },
      undefined,
      guard,
    );
  }
  const actor: ShiftActor = { organisationId, actorType: "SYSTEM", actorUserId: null };
  const event = await recordShiftActivity(tx, actor, "SHIFT_CANCELLED", row, {
    source: input.provider ?? "PLANDAY",
    reason: "REPLACED_BY_PLANDAY",
    ...(input.replacedByExternalShiftId
      ? { replacedByExternalShiftId: input.replacedByExternalShiftId }
      : {}),
  });
  await audit(
    {
      organisation: { id: organisationId },
      user: input.approvedByUserId ? { id: input.approvedByUserId } : null,
    },
    {
      action: "integration.conflicting_shift_replaced",
      entityType: "Shift",
      entityId: row.id,
      before: { status: current.status },
      after: {
        status: "CANCELLED",
        replacedByExternalShiftId: input.replacedByExternalShiftId ?? null,
      },
      occurredAt: now,
    },
    tx,
  );
  return {
    rows: [row],
    activities: [event],
    scheduleChanges: [{ employeeId: row.employeeId, shiftIds: [row.id], reason: "CANCELLED" }],
    skipped: [],
  };
}
