import { prisma, type Prisma } from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import type {
  AddTeamMembersInput,
  CreateTeamInput,
  ListTeamsResponse,
  Team,
  TeamQuery,
  UpdateTeamInput,
} from "@clockoff/validation/locationsTeams";
import { audit } from "@/server/audit/audit";
import { findLocationInOrganisation } from "@/server/locations/locations.repository";
import {
  endAssignmentsForScope,
  getActiveAssignmentsForScope,
  type ScopeAssignments,
} from "@/server/locations/scopeAssignments";
import { publishBreakPolicyChanged, publishPolicyChanged } from "@/server/policies/events";
import type { ManagerContext } from "@/server/tenancy/context";
import {
  addTeamMemberships,
  findEmployeeIdsInOrganisation,
  findTeamInOrganisation,
  findTeamMemberIds,
  findTeams,
  removeTeamMembership,
  replaceTeamMemberships,
  teamInclude,
  type Db,
  type TeamRow,
} from "./teams.repository";

/**
 * Teams (§5 locations & teams): named groups of employees, optionally attached to a location, used as a
 * policy-assignment scope. Membership edits only ever accept employees of the same organisation
 * (`EMPLOYEE_NOT_FOUND` otherwise — ids are never confirmed across tenants). Deleting a team ends its open
 * policy assignments so no assignment resolves through a vanished scope. Every mutation is audited.
 */

export function toTeamDto(row: TeamRow, assignments: ScopeAssignments | undefined): Team {
  return {
    id: row.id,
    name: row.name,
    location:
      row.location && !row.location.deletedAt
        ? { id: row.location.id, name: row.location.name }
        : null,
    memberCount: row._count.members,
    policyAssignment: assignments?.policy ?? null,
    breakPolicyAssignment: assignments?.breakPolicy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshot(row: TeamRow) {
  return { name: row.name, locationId: row.locationId, memberCount: row._count.members };
}

async function loadTeamOrThrow(organisationId: string, id: string, db?: Db): Promise<TeamRow> {
  const row = await findTeamInOrganisation(organisationId, id, db);
  if (!row) throw new AppError("NOT_FOUND", "Team not found");
  return row;
}

async function hydrate(organisationId: string, row: TeamRow, db?: Db): Promise<Team> {
  const assignments = await getActiveAssignmentsForScope(organisationId, "TEAM", [row.id], { db });
  return toTeamDto(row, assignments.get(row.id));
}

/** The location must be a live location of this organisation (NOT_FOUND otherwise, never 403). */
async function assertLocationInOrganisation(
  organisationId: string,
  locationId: string,
  db?: Db,
): Promise<void> {
  const location = await findLocationInOrganisation(organisationId, locationId, db);
  if (!location) throw new AppError("NOT_FOUND", "Location not found");
}

/** Every id must be a live employee of this organisation. */
async function assertEmployeesInOrganisation(
  organisationId: string,
  employeeIds: readonly string[],
  db?: Db,
): Promise<void> {
  if (employeeIds.length === 0) return;
  const known = await findEmployeeIdsInOrganisation(organisationId, employeeIds, db);
  const missing = employeeIds.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new AppError(
      "EMPLOYEE_NOT_FOUND",
      missing.length === 1 ? "Employee not found" : `${missing.length} employees not found`,
      { details: { employeeIds: missing } },
    );
  }
}

/** `GET /api/teams?locationId=` */
export async function listTeams(ctx: ManagerContext, query: TeamQuery): Promise<ListTeamsResponse> {
  const organisationId = ctx.organisation.id;
  const rows = await findTeams(organisationId, { locationId: query.locationId });
  if (rows.length === 0) return { teams: [] };
  const assignments = await getActiveAssignmentsForScope(
    organisationId,
    "TEAM",
    rows.map((r) => r.id),
  );
  return { teams: rows.map((row) => toTeamDto(row, assignments.get(row.id))) };
}

/** `GET /api/teams/:id` */
export async function getTeam(ctx: ManagerContext, id: string): Promise<Team> {
  const row = await loadTeamOrThrow(ctx.organisation.id, id);
  return hydrate(ctx.organisation.id, row);
}

/** `POST /api/teams` — optionally at a location and with initial members. */
export async function createTeam(ctx: ManagerContext, input: CreateTeamInput): Promise<Team> {
  const organisationId = ctx.organisation.id;
  const employeeIds = [...new Set(input.employeeIds ?? [])];
  const created = await prisma.$transaction(async (tx) => {
    if (input.locationId) await assertLocationInOrganisation(organisationId, input.locationId, tx);
    await assertEmployeesInOrganisation(organisationId, employeeIds, tx);
    const row = await tx.team.create({
      data: { organisationId, name: input.name, locationId: input.locationId ?? null },
    });
    await addTeamMemberships(tx, row.id, employeeIds);
    const withCounts = await tx.team.findUniqueOrThrow({
      where: { id: row.id },
      include: teamInclude,
    });
    await audit(
      ctx,
      { action: "team.created", entityType: "Team", entityId: row.id, after: snapshot(withCounts) },
      tx,
    );
    return withCounts;
  });
  return toTeamDto(created, undefined);
}

/** `PATCH /api/teams/:id`: `locationId: null` detaches the team from its location. */
export async function updateTeam(
  ctx: ManagerContext,
  id: string,
  input: UpdateTeamInput,
): Promise<Team> {
  const organisationId = ctx.organisation.id;
  const updated = await prisma.$transaction(async (tx) => {
    const before = await loadTeamOrThrow(organisationId, id, tx);
    const data: Prisma.TeamUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.locationId !== undefined) {
      if (input.locationId)
        await assertLocationInOrganisation(organisationId, input.locationId, tx);
      data.locationId = input.locationId;
    }
    if (Object.keys(data).length === 0) return before;
    const after = await tx.team.update({ where: { id }, data, include: teamInclude });
    await audit(
      ctx,
      {
        action: "team.updated",
        entityType: "Team",
        entityId: id,
        before: snapshot(before),
        after: snapshot(after),
      },
      tx,
    );
    return after;
  });
  return hydrate(organisationId, updated);
}

/** `DELETE /api/teams/:id`: memberships cascade; open assignments to the team are ended. */
export async function deleteTeam(ctx: ManagerContext, id: string): Promise<void> {
  const organisationId = ctx.organisation.id;
  const result = await prisma.$transaction(async (tx) => {
    const before = await loadTeamOrThrow(organisationId, id, tx);
    const now = new Date();
    const memberIds = await findTeamMemberIds(id, tx);
    const ended = await endAssignmentsForScope(tx, organisationId, "TEAM", id, now);
    await tx.team.delete({ where: { id } });
    await audit(
      ctx,
      {
        action: "team.deleted",
        entityType: "Team",
        entityId: id,
        before: snapshot(before),
        after: {
          membersRemoved: memberIds.length,
          policyAssignmentsEnded: ended.policyIds.length,
          breakPolicyAssignmentsEnded: ended.breakPolicyIds.length,
        },
        occurredAt: now,
      },
      tx,
    );
    return { ...ended, memberIds };
  });
  for (const policyId of result.policyIds) {
    publishPolicyChanged({
      organisationId,
      policyId,
      reason: "UNASSIGNED",
      affectedEmployeeIds: result.memberIds,
    });
  }
  for (const breakPolicyId of result.breakPolicyIds) {
    publishBreakPolicyChanged({
      organisationId,
      breakPolicyId,
      reason: "UNASSIGNED",
      affectedEmployeeIds: result.memberIds,
    });
  }
}

/**
 * `POST /api/teams/:id/members` `{ employeeIds, replace? }`: add the employees (idempotent) or, with
 * `replace: true`, make them the whole membership. Unknown or foreign employees → EMPLOYEE_NOT_FOUND.
 */
export async function addTeamMembers(
  ctx: ManagerContext,
  id: string,
  input: AddTeamMembersInput,
): Promise<Team> {
  const organisationId = ctx.organisation.id;
  const employeeIds = [...new Set(input.employeeIds)];
  const updated = await prisma.$transaction(async (tx) => {
    const before = await loadTeamOrThrow(organisationId, id, tx);
    await assertEmployeesInOrganisation(organisationId, employeeIds, tx);
    const change = input.replace
      ? await replaceTeamMemberships(tx, id, employeeIds)
      : { added: await addTeamMemberships(tx, id, employeeIds), removed: 0 };
    const after = await tx.team.findUniqueOrThrow({ where: { id }, include: teamInclude });
    if (change.added > 0 || change.removed > 0) {
      await audit(
        ctx,
        {
          action: input.replace ? "team.members_replaced" : "team.members_added",
          entityType: "Team",
          entityId: id,
          before: { memberCount: before._count.members },
          after: {
            memberCount: after._count.members,
            added: change.added,
            removed: change.removed,
            employeeIds,
          },
        },
        tx,
      );
    }
    return after;
  });
  return hydrate(organisationId, updated);
}

/** `DELETE /api/teams/:id/members/:employeeId` — NOT_FOUND when the employee is not in the team. */
export async function removeTeamMember(
  ctx: ManagerContext,
  id: string,
  employeeId: string,
): Promise<void> {
  const organisationId = ctx.organisation.id;
  await prisma.$transaction(async (tx) => {
    const before = await loadTeamOrThrow(organisationId, id, tx);
    const removed = await removeTeamMembership(tx, id, employeeId);
    if (removed === 0) throw new AppError("NOT_FOUND", "This employee is not a member of the team");
    await audit(
      ctx,
      {
        action: "team.member_removed",
        entityType: "Team",
        entityId: id,
        before: { memberCount: before._count.members },
        after: { memberCount: before._count.members - removed, employeeId },
      },
      tx,
    );
  });
}
