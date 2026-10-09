import { randomUUID } from "node:crypto";
import type { ActivityEvent, Prisma } from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import { publishActivity, recordActivity } from "@/server/activity/recordActivity";
import { publishEvent } from "@/server/events";
import {
  assertIntegrationWriteScope,
  integrationManagedError,
  managingProvider,
  notManagedByIntegration,
} from "@/server/shifts/shifts.integration";
import { syncManagedTeamMemberships } from "@/server/teams/teams.integration";
import { revokeEmployeeAccess } from "./employeeAccess";
import type { Db } from "./employees.repository";
import { recomputeEmployeeInviteStatus } from "./inviteStatus";

/**
 * Integration writers for employees (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.5, §6.9) and the
 * managed-field lock the manager-facing service applies.
 *
 * A provider sync imports, links, updates, deactivates and reactivates ClockOff employees only through these
 * functions. Every query filters on the run's organisation as well as the id, every referenced location,
 * department and team is checked against the organisation, and a writer refuses an employee another
 * integration (or, once linked, nobody) manages. Never a hard delete. Nothing is published here: callers
 * publish after their transaction commits (`publishManagedEmployeeWrite`).
 *
 * Managed fields: first name, last name, email (only while the integration's `importEmails` is on) and the
 * primary location, plus the department when it maps to a ClockOff department and the memberships of mapped
 * locations and teams. Invite status, devices, policy and break-policy assignments, job title and phone are
 * never written by a sync.
 */

/** A sync acting for one integration. */
export interface IntegrationEmployeeActor {
  organisationId: string;
  integrationId: string;
}

/** Managed fields of an employee as Planday has them (§6.5). `undefined` leaves a field alone. */
export interface ManagedEmployeeFields {
  firstName: string;
  lastName: string;
  /** Written only while the integration imports emails (`importEmails`); `undefined` = not written. */
  email?: string | null;
  primaryLocationId: string | null;
  /** Only when the employee's department maps to a ClockOff department; `undefined` = not written. */
  departmentId?: string | null;
}

/**
 * Memberships the sync owns (§6.4, §6.5): `EmployeeLocation` rows for locations some included department maps
 * to, and `EmployeeTeam` rows for teams some employee group maps to. Rows outside those scopes (a manager's
 * own team overrides, extra locations) are never touched.
 */
export interface ManagedEmployeeMemberships {
  /** Every location a department maps to: the scope of the location rows the sync owns. */
  mappedLocationIds: readonly string[];
  /** The employee's locations within that scope (the primary location is added automatically). */
  locationIds: readonly string[];
  /** Every team a group maps to: the scope of the team rows the sync owns. */
  mappedTeamIds: readonly string[];
  /** The employee's teams within that scope. */
  teamIds: readonly string[];
}

export interface ImportExternalEmployeeInput {
  /** The provider's employee id: the map row's `externalId`. */
  externalId: string;
  /** Portal-qualified `Employee.externalEmployeeId` (`PLANDAY:<portalId>:<id>`). */
  externalEmployeeId: string;
  fields: ManagedEmployeeFields;
  memberships: ManagedEmployeeMemberships;
  /** Decision-input hash for the map row (§6.2). */
  lastHash: string | null;
}

export interface LinkExternalEmployeeInput extends ImportExternalEmployeeInput {
  /** The existing ClockOff employee (a match or the manager's choice). */
  employeeId: string;
}

/** What a deactivation or reactivation did, to publish after commit. */
export interface ManagedEmployeeWriteResult {
  changed: boolean;
  /** Why nothing changed (`changed: false`). */
  reason?: "ALREADY_INACTIVE" | "ALREADY_ACTIVE" | "DEACTIVATED_BY_MANAGER" | "ARCHIVED";
  activities: ActivityEvent[];
  deviceStatusChanges: Array<{
    employeeId: string;
    inviteStatus: string;
    employmentStatus: "ACTIVE" | "INACTIVE";
  }>;
}

export type ManagedEmployeeRemovalReason = "DEACTIVATED_IN_PLANDAY" | "REMOVED_FROM_PLANDAY";

/** After commit: activity rows and `device.status.changed` hints. */
export function publishManagedEmployeeWrite(
  organisationId: string,
  result: ManagedEmployeeWriteResult,
): void {
  for (const event of result.activities) publishActivity(event);
  for (const change of result.deviceStatusChanges) {
    publishEvent({
      type: "device.status.changed",
      organisationId,
      employeeId: change.employeeId,
      payload: { ...change },
    });
  }
}

// ── Managed-field lock (manager edits) ──────────────────────────────────────

export const MANAGED_EMPLOYEE_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "externalEmployeeId",
  "primaryLocationId",
] as const;
export type ManagedEmployeeField = (typeof MANAGED_EMPLOYEE_FIELDS)[number];

/**
 * The fields of `employee` a manager may not change: none while unmanaged; otherwise name, external id and
 * primary location, plus email while the managing integration imports emails.
 */
export async function lockedEmployeeFields(
  db: Db,
  organisationId: string,
  employee: { managedByIntegrationId: string | null },
): Promise<ManagedEmployeeField[]> {
  if (!employee.managedByIntegrationId) return [];
  const config = await db.integrationMappingConfig.findFirst({
    where: { organisationId, integrationId: employee.managedByIntegrationId },
    select: { importEmails: true },
  });
  // No mapping config (should not happen while managed): keep the default, which locks the email.
  const importEmails = config?.importEmails ?? true;
  return MANAGED_EMPLOYEE_FIELDS.filter((field) => field !== "email" || importEmails);
}

function sameField(field: ManagedEmployeeField, a: unknown, b: unknown): boolean {
  const x = typeof a === "string" ? a : (a ?? null);
  const y = typeof b === "string" ? b : (b ?? null);
  if (field === "email" && typeof x === "string" && typeof y === "string") {
    return x.toLowerCase() === y.toLowerCase();
  }
  return x === y;
}

/**
 * `updateEmployee` / `assignEmployeeLocation` (and the bulk actions built on them) refuse a change to a locked
 * field of a managed employee with INTEGRATION_MANAGED (409, `details.provider`, `details.fields`). Sending a
 * locked field with its current value is not a change and passes, as do every other field (policy, break
 * policy, team overrides, job title, phone, …).
 */
export async function assertManagedEmployeeEdit(
  db: Db,
  organisationId: string,
  before: { id: string; managedByIntegrationId: string | null } & Record<
    ManagedEmployeeField,
    string | null
  >,
  patch: Partial<Record<ManagedEmployeeField, string | null | undefined>>,
): Promise<void> {
  if (!before.managedByIntegrationId) return;
  const locked = await lockedEmployeeFields(db, organisationId, before);
  const refused = locked.filter(
    (field) => patch[field] !== undefined && !sameField(field, patch[field], before[field]),
  );
  if (refused.length > 0) {
    throw integrationManagedError("Employee", before.managedByIntegrationId, { fields: refused });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function employeeData(fields: ManagedEmployeeFields): Prisma.EmployeeUncheckedUpdateManyInput {
  return {
    firstName: fields.firstName,
    lastName: fields.lastName,
    primaryLocationId: fields.primaryLocationId,
    ...(fields.email !== undefined ? { email: fields.email } : {}),
    ...(fields.departmentId !== undefined ? { departmentId: fields.departmentId } : {}),
  };
}

function scopeOf(
  inputs: ReadonlyArray<{ fields: ManagedEmployeeFields; memberships: ManagedEmployeeMemberships }>,
) {
  return {
    locationIds: inputs.flatMap((i) => [
      i.fields.primaryLocationId,
      ...i.memberships.locationIds,
      ...i.memberships.mappedLocationIds,
    ]),
    departmentIds: inputs.map((i) => i.fields.departmentId),
    teamIds: inputs.flatMap((i) => [...i.memberships.teamIds, ...i.memberships.mappedTeamIds]),
  };
}

/** The employee's desired location rows: its locations within the mapped scope plus the primary location. */
function desiredLocations(entry: {
  fields: ManagedEmployeeFields;
  memberships: ManagedEmployeeMemberships;
}): string[] {
  return [
    ...new Set([
      ...(entry.fields.primaryLocationId ? [entry.fields.primaryLocationId] : []),
      ...entry.memberships.locationIds,
    ]),
  ];
}

/**
 * `EmployeeLocation` rows for mapped locations equal the desired set: missing rows added, rows of mapped
 * locations the employee left removed; rows of other locations untouched. Batched for a page.
 */
async function syncManagedLocationMemberships(
  tx: Prisma.TransactionClient,
  entries: ReadonlyArray<{
    employeeId: string;
    mappedLocationIds: readonly string[];
    locationIds: readonly string[];
  }>,
  options: { fresh?: boolean } = {},
): Promise<void> {
  if (entries.length === 0) return;
  const existing = options.fresh
    ? []
    : await tx.employeeLocation.findMany({
        where: { employeeId: { in: entries.map((e) => e.employeeId) } },
        select: { employeeId: true, locationId: true },
      });
  const has = new Set(existing.map((r) => `${r.employeeId}:${r.locationId}`));
  const remove: Array<{ employeeId: string; locationId: string }> = [];
  const add: Array<{ employeeId: string; locationId: string }> = [];
  for (const entry of entries) {
    const desired = new Set(entry.locationIds);
    const mapped = new Set(entry.mappedLocationIds);
    for (const row of existing) {
      if (row.employeeId !== entry.employeeId) continue;
      if (mapped.has(row.locationId) && !desired.has(row.locationId)) remove.push(row);
    }
    for (const locationId of desired) {
      if (!has.has(`${entry.employeeId}:${locationId}`))
        add.push({ employeeId: entry.employeeId, locationId });
    }
  }
  if (remove.length > 0) await tx.employeeLocation.deleteMany({ where: { OR: remove } });
  if (add.length > 0) await tx.employeeLocation.createMany({ data: add, skipDuplicates: true });
}

async function syncMemberships(
  tx: Prisma.TransactionClient,
  actor: IntegrationEmployeeActor,
  entries: ReadonlyArray<{
    employeeId: string;
    fields: ManagedEmployeeFields;
    memberships: ManagedEmployeeMemberships;
  }>,
  options: { fresh?: boolean } = {},
): Promise<void> {
  await syncManagedLocationMemberships(
    tx,
    entries.map((e) => ({
      employeeId: e.employeeId,
      mappedLocationIds: e.memberships.mappedLocationIds,
      locationIds: desiredLocations(e),
    })),
    options,
  );
  await syncManagedTeamMemberships(
    tx,
    actor,
    entries.map((e) => ({
      employeeId: e.employeeId,
      mappedTeamIds: e.memberships.mappedTeamIds,
      teamIds: e.memberships.teamIds,
    })),
    { ...options, scopeChecked: true },
  );
}

/**
 * Map rows of `externalIds` whose employee is gone are dropped; one whose employee is live answers CONFLICT
 * `EXTERNAL_ID_MAPPED` (the caller should have linked or updated instead). Returns nothing.
 */
async function clearStaleEmployeeMapRows(
  tx: Prisma.TransactionClient,
  actor: IntegrationEmployeeActor,
  externalIds: readonly string[],
  allowEmployeeId?: string,
): Promise<void> {
  const mapRows = await tx.externalEntityMap.findMany({
    where: {
      organisationId: actor.organisationId,
      integrationId: actor.integrationId,
      entityType: "EMPLOYEE",
      externalId: { in: [...externalIds] },
    },
    select: { id: true, externalId: true, internalId: true },
  });
  const stale = mapRows.filter((m) => m.internalId !== allowEmployeeId);
  if (stale.length === 0) return;
  const live = await tx.employee.findMany({
    where: {
      organisationId: actor.organisationId,
      id: { in: stale.map((m) => m.internalId) },
      deletedAt: null,
    },
    select: { id: true },
  });
  if (live.length > 0) {
    const liveIds = new Set(live.map((e) => e.id));
    throw new AppError(
      "CONFLICT",
      "This Planday employee is already linked to a ClockOff employee",
      {
        details: {
          reason: "EXTERNAL_ID_MAPPED",
          externalIds: stale.filter((m) => liveIds.has(m.internalId)).map((m) => m.externalId),
        },
      },
    );
  }
  await tx.externalEntityMap.deleteMany({ where: { id: { in: stale.map((m) => m.id) } } });
}

/**
 * `Employee.externalEmployeeId` is unique per organisation, archived rows included: an archived employee still
 * holding one of `values` gives it up (`…:archived:<id>`); a live holder other than `allowEmployeeId` answers
 * CONFLICT `EXTERNAL_EMPLOYEE_ID_TAKEN`.
 */
async function releaseExternalEmployeeIds(
  tx: Prisma.TransactionClient,
  organisationId: string,
  values: readonly string[],
  allowEmployeeId?: string,
): Promise<void> {
  if (values.length === 0) return;
  const holders = await tx.employee.findMany({
    where: { organisationId, externalEmployeeId: { in: [...values] } },
    select: { id: true, externalEmployeeId: true, deletedAt: true },
  });
  const live = holders.filter((h) => h.deletedAt === null && h.id !== allowEmployeeId);
  if (live.length > 0) {
    throw new AppError("CONFLICT", "Another employee already has this external ID", {
      details: { reason: "EXTERNAL_EMPLOYEE_ID_TAKEN", employeeIds: live.map((h) => h.id) },
    });
  }
  for (const holder of holders.filter((h) => h.deletedAt !== null)) {
    await tx.employee.updateMany({
      where: { id: holder.id, organisationId, deletedAt: { not: null } },
      data: { externalEmployeeId: `${holder.externalEmployeeId}:archived:${holder.id}` },
    });
  }
}

// ── Import / link / update ──────────────────────────────────────────────────

/**
 * IMPORT (§6.5 "IMPORT_EMPLOYEES, selected, new" and "SYNC, new in scope, auto-include"): one page of new
 * employees with `employee.createMany` (`source INTEGRATION`, `managedByIntegrationId`, `inviteStatus
 * NOT_INVITED`, email only with `importEmails`), their location and team rows, and `EMPLOYEE` map rows.
 * The plan limit is the caller's check (`assertEmployeeCapacity`). Returns the new ids in input order.
 */
export async function importExternalEmployees(
  tx: Prisma.TransactionClient,
  actor: IntegrationEmployeeActor,
  inputs: readonly ImportExternalEmployeeInput[],
  now: Date,
): Promise<{ employeeIds: string[] }> {
  if (inputs.length === 0) return { employeeIds: [] };
  const externalIds = new Set(inputs.map((i) => i.externalId));
  const externalEmployeeIds = new Set(inputs.map((i) => i.externalEmployeeId));
  if (externalIds.size !== inputs.length || externalEmployeeIds.size !== inputs.length) {
    throw new Error("importExternalEmployees: an employee appears twice");
  }
  const { provider } = await assertIntegrationWriteScope(tx, actor.organisationId, {
    integrationId: actor.integrationId,
    ...scopeOf(inputs),
  });
  await clearStaleEmployeeMapRows(tx, actor, [...externalIds]);
  await releaseExternalEmployeeIds(tx, actor.organisationId, [...externalEmployeeIds]);

  const planned = inputs.map((input) => ({ input, id: randomUUID() as string }));
  await tx.employee.createMany({
    data: planned.map(({ input, id }) => ({
      id,
      organisationId: actor.organisationId,
      firstName: input.fields.firstName,
      lastName: input.fields.lastName,
      email: input.fields.email ?? null,
      externalEmployeeId: input.externalEmployeeId,
      departmentId: input.fields.departmentId ?? null,
      primaryLocationId: input.fields.primaryLocationId,
      employmentStatus: "ACTIVE" as const,
      inviteStatus: "NOT_INVITED" as const,
      source: "INTEGRATION" as const,
      managedByIntegrationId: actor.integrationId,
    })),
  });
  await tx.externalEntityMap.createMany({
    data: planned.map(({ input, id }) => ({
      organisationId: actor.organisationId,
      integrationId: actor.integrationId,
      provider: provider ?? managingProvider(actor.integrationId),
      entityType: "EMPLOYEE" as const,
      externalId: input.externalId,
      internalId: id,
      lastSeenAt: now,
      lastHash: input.lastHash,
    })),
  });
  await syncMemberships(
    tx,
    actor,
    planned.map(({ input, id }) => ({ employeeId: id, ...input })),
    { fresh: true },
  );
  return { employeeIds: planned.map((p) => p.id) };
}

/** {@link importExternalEmployees} for one employee. */
export async function importExternalEmployee(
  tx: Prisma.TransactionClient,
  actor: IntegrationEmployeeActor,
  input: ImportExternalEmployeeInput,
  now: Date,
): Promise<{ employeeId: string }> {
  const { employeeIds } = await importExternalEmployees(tx, actor, [input], now);
  return { employeeId: employeeIds[0]! };
}

/**
 * LINK (§6.5 "matched or manager-linked"): the existing employee becomes managed by the integration. Map row
 * written; first and last name (and email with `importEmails`), primary location and department overwritten
 * with Planday's; `externalEmployeeId = PLANDAY:<portalId>:<id>` only when it was null; mapped memberships
 * synced. Invite status, devices and policies are untouched, and `source` keeps its provenance. Refused for an
 * employee another integration manages or already linked to a different Planday employee.
 */
export async function linkExternalEmployee(
  tx: Prisma.TransactionClient,
  actor: IntegrationEmployeeActor,
  input: LinkExternalEmployeeInput,
  now: Date,
): Promise<{ employeeId: string }> {
  const { organisationId, integrationId } = actor;
  const { provider } = await assertIntegrationWriteScope(tx, organisationId, {
    integrationId,
    ...scopeOf([input]),
  });
  const employee = await tx.employee.findFirst({
    where: { id: input.employeeId, organisationId, deletedAt: null },
    select: { id: true, managedByIntegrationId: true, externalEmployeeId: true },
  });
  if (!employee) throw new AppError("EMPLOYEE_NOT_FOUND", "Employee not found");
  if (employee.managedByIntegrationId && employee.managedByIntegrationId !== integrationId) {
    throw notManagedByIntegration("Employee", employee.id);
  }
  const otherLink = await tx.externalEntityMap.findFirst({
    where: {
      organisationId,
      integrationId,
      entityType: "EMPLOYEE",
      internalId: employee.id,
      externalId: { not: input.externalId },
    },
    select: { externalId: true },
  });
  if (otherLink) {
    throw new AppError("CONFLICT", "This employee is already linked to another Planday employee", {
      details: { reason: "EMPLOYEE_ALREADY_MAPPED", employeeId: employee.id },
    });
  }
  await clearStaleEmployeeMapRows(tx, actor, [input.externalId], employee.id);
  const setExternalId = employee.externalEmployeeId === null;
  if (setExternalId) {
    await releaseExternalEmployeeIds(tx, organisationId, [input.externalEmployeeId], employee.id);
  }
  const result = await tx.employee.updateMany({
    where: {
      id: employee.id,
      organisationId,
      deletedAt: null,
      OR: [{ managedByIntegrationId: null }, { managedByIntegrationId: integrationId }],
    },
    data: {
      ...employeeData(input.fields),
      managedByIntegrationId: integrationId,
      ...(setExternalId ? { externalEmployeeId: input.externalEmployeeId } : {}),
    },
  });
  if (result.count === 0) throw notManagedByIntegration("Employee", employee.id);
  await tx.externalEntityMap.upsert({
    where: {
      integrationId_entityType_externalId: {
        integrationId,
        entityType: "EMPLOYEE",
        externalId: input.externalId,
      },
    },
    create: {
      organisationId,
      integrationId,
      provider: provider ?? managingProvider(integrationId),
      entityType: "EMPLOYEE",
      externalId: input.externalId,
      internalId: employee.id,
      lastSeenAt: now,
      lastHash: input.lastHash,
    },
    update: {
      lastSeenAt: now,
      lastHash: input.lastHash,
      upstreamRemovedAt: null,
      upstreamMissingSince: null,
      reviewDismissedAt: null,
    },
  });
  await syncMemberships(tx, actor, [
    { employeeId: employee.id, fields: input.fields, memberships: input.memberships },
  ]);
  return { employeeId: employee.id };
}

/**
 * SYNC, mapped, fields changed (§6.5): writes the managed fields and the mapped memberships of an employee
 * this integration manages (refused otherwise). The map row's hash is the caller's batched write.
 */
export async function updateManagedEmployee(
  tx: Prisma.TransactionClient,
  actor: IntegrationEmployeeActor,
  input: {
    employeeId: string;
    fields: ManagedEmployeeFields;
    memberships: ManagedEmployeeMemberships;
  },
): Promise<{ employeeId: string }> {
  await assertIntegrationWriteScope(tx, actor.organisationId, scopeOf([input]));
  const result = await tx.employee.updateMany({
    where: {
      id: input.employeeId,
      organisationId: actor.organisationId,
      managedByIntegrationId: actor.integrationId,
      deletedAt: null,
    },
    data: employeeData(input.fields),
  });
  if (result.count === 0) throw notManagedByIntegration("Employee", input.employeeId);
  await syncMemberships(tx, actor, [input]);
  return { employeeId: input.employeeId };
}

// ── Deactivate / reactivate ─────────────────────────────────────────────────

async function requireManagedEmployee(
  tx: Prisma.TransactionClient,
  input: { organisationId: string; employeeId: string; integrationId: string },
) {
  // Archived employees are found too: the callers leave them alone rather than failing the page.
  const employee = await tx.employee.findFirst({
    where: { id: input.employeeId, organisationId: input.organisationId },
    select: { id: true, employmentStatus: true, managedByIntegrationId: true, deletedAt: true },
  });
  if (!employee || employee.managedByIntegrationId !== input.integrationId) {
    throw notManagedByIntegration("Employee", input.employeeId);
  }
  return employee;
}

/**
 * §6.5 deactivation (Planday deactivated or removed the person, with positive evidence): exactly what
 * `deactivateEmployee` does, with a SYSTEM actor — `employmentStatus INACTIVE`, `inviteStatus DEACTIVATED`,
 * phones cut off (`revokeEmployeeAccess`: devices deactivated, push tokens forgotten, refresh tokens revoked,
 * mobile identity unlinked, live invites revoked, running break ended) — plus activity
 * `EMPLOYEE_DEACTIVATED { source, reason }` and the map row's `upstreamRemovedAt = now` (eligible for
 * reactivation). Shifts are kept. An employee already inactive is left alone (a manager's deactivation stays
 * the manager's). Never a hard delete.
 */
export async function deactivateManagedEmployee(
  tx: Prisma.TransactionClient,
  input: {
    organisationId: string;
    employeeId: string;
    integrationId: string;
    now: Date;
    reason: ManagedEmployeeRemovalReason;
  },
): Promise<ManagedEmployeeWriteResult> {
  const { organisationId, employeeId, integrationId, now } = input;
  const employee = await requireManagedEmployee(tx, input);
  const unchanged = (reason: ManagedEmployeeWriteResult["reason"]): ManagedEmployeeWriteResult => ({
    changed: false,
    reason,
    activities: [],
    deviceStatusChanges: [],
  });
  if (employee.deletedAt) return unchanged("ARCHIVED");
  if (employee.employmentStatus === "INACTIVE") return unchanged("ALREADY_INACTIVE");
  const updated = await tx.employee.updateMany({
    where: {
      id: employeeId,
      organisationId,
      managedByIntegrationId: integrationId,
      employmentStatus: "ACTIVE",
      deletedAt: null,
    },
    data: { employmentStatus: "INACTIVE", inviteStatus: "DEACTIVATED" },
  });
  if (updated.count === 0) return unchanged("ALREADY_INACTIVE");
  const access = await revokeEmployeeAccess(tx, {
    organisationId,
    employeeId,
    revokeInvites: true,
    actor: { type: "SYSTEM" },
    breakEndReason: "MANAGER_ENDED",
    now,
  });
  const { event } = await recordActivity(
    {
      organisationId,
      employeeId,
      actorType: "SYSTEM",
      type: "EMPLOYEE_DEACTIVATED",
      occurredAt: now,
      metadata: {
        source: managingProvider(integrationId),
        reason: input.reason,
        integrationId,
        deactivatedDevices: access.deactivatedDevices,
        revokedInvites: access.revokedInvites,
      },
    },
    { db: tx, publish: false },
  );
  await tx.externalEntityMap.updateMany({
    where: { organisationId, integrationId, entityType: "EMPLOYEE", internalId: employeeId },
    data: { upstreamRemovedAt: now },
  });
  return {
    changed: true,
    activities: [...access.endedBreakEvents, event],
    deviceStatusChanges: [
      { employeeId, inviteStatus: "DEACTIVATED", employmentStatus: "INACTIVE" },
    ],
  };
}

/**
 * §6.5 `REACTIVATIONS`: an employee the sync deactivated (map row `upstreamRemovedAt` set) who is back on
 * Planday's active list becomes ACTIVE again, with the invite status recomputed
 * (`recomputeEmployeeInviteStatus`; the person must join again, their devices were revoked), activity
 * `EMPLOYEE_REACTIVATED` and `upstreamRemovedAt = null`. An employee a manager deactivated is left inactive
 * (`reason: "DEACTIVATED_BY_MANAGER"`, the caller's warning). The plan limit is the caller's check.
 */
export async function reactivateManagedEmployee(
  tx: Prisma.TransactionClient,
  input: { organisationId: string; employeeId: string; integrationId: string; now: Date },
): Promise<ManagedEmployeeWriteResult> {
  const { organisationId, employeeId, integrationId, now } = input;
  const employee = await requireManagedEmployee(tx, input);
  const mapWhere = {
    organisationId,
    integrationId,
    entityType: "EMPLOYEE" as const,
    internalId: employeeId,
  };
  const mapRow = await tx.externalEntityMap.findFirst({
    where: mapWhere,
    select: { upstreamRemovedAt: true },
  });
  const unchanged = (reason: ManagedEmployeeWriteResult["reason"]): ManagedEmployeeWriteResult => ({
    changed: false,
    reason,
    activities: [],
    deviceStatusChanges: [],
  });
  if (employee.deletedAt) return unchanged("ARCHIVED");
  if (employee.employmentStatus === "ACTIVE") {
    if (mapRow?.upstreamRemovedAt) {
      await tx.externalEntityMap.updateMany({ where: mapWhere, data: { upstreamRemovedAt: null } });
    }
    return unchanged("ALREADY_ACTIVE");
  }
  if (!mapRow?.upstreamRemovedAt) return unchanged("DEACTIVATED_BY_MANAGER");
  const updated = await tx.employee.updateMany({
    where: {
      id: employeeId,
      organisationId,
      managedByIntegrationId: integrationId,
      employmentStatus: "INACTIVE",
      deletedAt: null,
    },
    data: { employmentStatus: "ACTIVE" },
  });
  if (updated.count === 0) return unchanged("ALREADY_ACTIVE");
  const inviteStatus = await recomputeEmployeeInviteStatus(employeeId, {
    db: tx,
    now,
    publish: false,
  });
  const { event } = await recordActivity(
    {
      organisationId,
      employeeId,
      actorType: "SYSTEM",
      type: "EMPLOYEE_REACTIVATED",
      occurredAt: now,
      metadata: { source: managingProvider(integrationId), integrationId, inviteStatus },
    },
    { db: tx, publish: false },
  );
  await tx.externalEntityMap.updateMany({ where: mapWhere, data: { upstreamRemovedAt: null } });
  return {
    changed: true,
    activities: [event],
    deviceStatusChanges: [{ employeeId, inviteStatus, employmentStatus: "ACTIVE" }],
  };
}
