import { randomUUID } from "node:crypto";
import type { Prisma } from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import {
  assertIntegrationWriteScope,
  managingProvider,
  notManagedByIntegration,
} from "@/server/shifts/shifts.integration";

/**
 * Integration writers for teams (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.4, §6.9): Planday employee
 * groups mapped to "new team" become managed teams; groups mapped to an existing team only get a map row (the
 * caller's) and the team stays the manager's. Membership of mapped teams follows Planday; memberships of
 * other teams are never touched, so team overrides stay editable. Every query filters on the run's
 * organisation; a writer refuses a team another integration (or nobody) manages.
 */

/** A sync (or a wizard step applying its choices) acting for one integration. */
export interface IntegrationRecordActor {
  organisationId: string;
  integrationId: string;
}

export interface ManagedTeamInput {
  /** Planday employee group id: the map row's `externalId`. */
  externalId: string;
  name: string;
  /** Decision-input hash for the map row (§6.2). */
  lastHash: string | null;
}

/**
 * "Group mapped to new team" (§6.4): creates `Team { name, source: INTEGRATION, managedByIntegrationId }`
 * and its `TEAM` map row per input. A map row of the same group that points at a team this integration
 * manages answers CONFLICT `EXTERNAL_ID_MAPPED` (rename it instead); one that points at a manager's team or
 * a deleted one is replaced. Returns the new ids in input order.
 */
export async function createManagedTeams(
  tx: Prisma.TransactionClient,
  actor: IntegrationRecordActor,
  inputs: readonly ManagedTeamInput[],
  now: Date,
): Promise<Array<{ externalId: string; teamId: string; name: string }>> {
  if (inputs.length === 0) return [];
  const { organisationId, integrationId } = actor;
  const externalIds = new Set(inputs.map((i) => i.externalId));
  if (externalIds.size !== inputs.length)
    throw new Error("createManagedTeams: a group appears twice");
  const { provider } = await assertIntegrationWriteScope(tx, organisationId, { integrationId });
  const mapRows = await tx.externalEntityMap.findMany({
    where: {
      organisationId,
      integrationId,
      entityType: "TEAM",
      externalId: { in: [...externalIds] },
    },
    select: { id: true, externalId: true, internalId: true },
  });
  if (mapRows.length > 0) {
    const managed = await tx.team.findMany({
      where: {
        organisationId,
        id: { in: mapRows.map((m) => m.internalId) },
        managedByIntegrationId: integrationId,
      },
      select: { id: true },
    });
    if (managed.length > 0) {
      const ids = new Set(managed.map((t) => t.id));
      throw new AppError("CONFLICT", "This Planday group already has a team", {
        details: {
          reason: "EXTERNAL_ID_MAPPED",
          externalIds: mapRows.filter((m) => ids.has(m.internalId)).map((m) => m.externalId),
        },
      });
    }
    await tx.externalEntityMap.deleteMany({ where: { id: { in: mapRows.map((m) => m.id) } } });
  }
  const planned = inputs.map((input) => ({ input, id: randomUUID() as string }));
  await tx.team.createMany({
    data: planned.map(({ input, id }) => ({
      id,
      organisationId,
      name: input.name,
      source: "INTEGRATION" as const,
      managedByIntegrationId: integrationId,
    })),
  });
  await tx.externalEntityMap.createMany({
    data: planned.map(({ input, id }) => ({
      organisationId,
      integrationId,
      provider: provider ?? managingProvider(integrationId),
      entityType: "TEAM" as const,
      externalId: input.externalId,
      internalId: id,
      lastSeenAt: now,
      lastHash: input.lastHash,
    })),
  });
  return planned.map(({ input, id }) => ({
    externalId: input.externalId,
    teamId: id,
    name: input.name,
  }));
}

/**
 * "Renamed in Planday" (§6.4, as for departments): renames a team this integration manages. Returns whether
 * the name changed; refuses a team it does not manage.
 */
export async function renameManagedTeam(
  tx: Prisma.TransactionClient,
  actor: IntegrationRecordActor,
  input: { teamId: string; name: string },
): Promise<{ renamed: boolean }> {
  const team = await tx.team.findFirst({
    where: {
      id: input.teamId,
      organisationId: actor.organisationId,
      managedByIntegrationId: actor.integrationId,
    },
    select: { id: true, name: true },
  });
  if (!team) throw notManagedByIntegration("Team", input.teamId);
  if (team.name === input.name) return { renamed: false };
  const result = await tx.team.updateMany({
    where: {
      id: team.id,
      organisationId: actor.organisationId,
      managedByIntegrationId: actor.integrationId,
    },
    data: { name: input.name },
  });
  if (result.count === 0) throw notManagedByIntegration("Team", input.teamId);
  return { renamed: true };
}

/**
 * "Membership" (§6.4): for mapped teams only, an employee's `EmployeeTeam` rows equal their Planday groups —
 * missing rows added, rows of mapped teams the employee left removed; rows of every other team untouched.
 * One page at a time (a handful of statements). The employees must be managed by this integration and the
 * teams must be the organisation's (`scopeChecked` skips both checks when the caller already made them;
 * `fresh` skips reading rows for employees created in the same transaction).
 */
export async function syncManagedTeamMemberships(
  tx: Prisma.TransactionClient,
  actor: IntegrationRecordActor,
  entries: ReadonlyArray<{
    employeeId: string;
    /** Every team some group maps to: the scope of the rows the sync owns. */
    mappedTeamIds: readonly string[];
    /** The employee's teams within that scope. */
    teamIds: readonly string[];
  }>,
  options: { fresh?: boolean; scopeChecked?: boolean } = {},
): Promise<{ added: number; removed: number }> {
  if (entries.length === 0) return { added: 0, removed: 0 };
  const employeeIds = [...new Set(entries.map((e) => e.employeeId))];
  if (!options.scopeChecked) {
    await assertIntegrationWriteScope(tx, actor.organisationId, {
      teamIds: entries.flatMap((e) => [...e.mappedTeamIds, ...e.teamIds]),
    });
    const managed = await tx.employee.count({
      where: {
        organisationId: actor.organisationId,
        id: { in: employeeIds },
        managedByIntegrationId: actor.integrationId,
      },
    });
    if (managed !== employeeIds.length) {
      throw new AppError("CONFLICT", "Team memberships can only be synced for managed employees", {
        details: { reason: "NOT_MANAGED_BY_INTEGRATION", entityType: "Employee" },
      });
    }
  }
  const existing = options.fresh
    ? []
    : await tx.employeeTeam.findMany({
        where: { employeeId: { in: employeeIds } },
        select: { employeeId: true, teamId: true },
      });
  const has = new Set(existing.map((r) => `${r.employeeId}:${r.teamId}`));
  const remove: Array<{ employeeId: string; teamId: string }> = [];
  const add: Array<{ employeeId: string; teamId: string }> = [];
  for (const entry of entries) {
    const desired = new Set(entry.teamIds);
    const mapped = new Set(entry.mappedTeamIds);
    for (const row of existing) {
      if (row.employeeId !== entry.employeeId) continue;
      if (mapped.has(row.teamId) && !desired.has(row.teamId)) remove.push(row);
    }
    for (const teamId of desired) {
      if (!has.has(`${entry.employeeId}:${teamId}`))
        add.push({ employeeId: entry.employeeId, teamId });
    }
  }
  const removed =
    remove.length > 0 ? (await tx.employeeTeam.deleteMany({ where: { OR: remove } })).count : 0;
  const added =
    add.length > 0
      ? (await tx.employeeTeam.createMany({ data: add, skipDuplicates: true })).count
      : 0;
  return { added, removed };
}
