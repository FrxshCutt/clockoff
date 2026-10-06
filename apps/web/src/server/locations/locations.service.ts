import { prisma, type Prisma } from "@workmode/db";
import { AppError } from "@workmode/shared/errors";
import { isWithinLimit, planLimitsFor } from "@workmode/shared/plans";
import type {
  CreateLocationInput,
  ListLocationsResponse,
  Location,
  UpdateLocationInput,
} from "@workmode/validation/locationsTeams";
import { audit } from "@/server/audit/audit";
import { lockOrganisationRow } from "@/server/joinCodes/joinCodes.repository";
import { publishBreakPolicyChanged, publishPolicyChanged } from "@/server/policies/events";
import type { ManagerContext } from "@/server/tenancy/context";
import {
  countEmployeesByLocation,
  countLocations,
  countUpcomingShiftsForLocation,
  findLocationByName,
  findLocationInOrganisation,
  findLocations,
  locationInclude,
  softDeleteLocation,
  type Db,
  type LocationRow,
} from "./locations.repository";
import { getActiveAssignmentsForScope, type ScopeAssignments } from "./scopeAssignments";

/**
 * Locations (§5 locations & teams): the sites an organisation runs. Names are unique per organisation
 * (case-insensitive), the plan caps how many there are (`isWithinLimit`), deletion is a soft delete that
 * detaches employees, teams and finished shifts (SetNull) and is refused while shifts are still scheduled
 * at the site. Every mutation is audited.
 */

export interface ListLocationsOptions {
  now?: Date;
  db?: Db;
}

export function toLocationDto(
  row: LocationRow,
  employeeCount: number,
  assignments: ScopeAssignments | undefined,
): Location {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    address: row.address,
    employeeCount,
    teamCount: row._count.teams,
    policyAssignment: assignments?.policy ?? null,
    breakPolicyAssignment: assignments?.breakPolicy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshot(row: LocationRow) {
  return { name: row.name, timezone: row.timezone, address: row.address };
}

/**
 * Every live location of an organisation with employee / team counts and the active policy assignments,
 * sorted by name. Exported for other services (the organisation id must come from a verified context).
 */
export async function listLocationsForOrg(
  organisationId: string,
  options: ListLocationsOptions = {},
): Promise<Location[]> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const rows = await findLocations(organisationId, db);
  if (rows.length === 0) return [];
  const [employeeCounts, assignments] = await Promise.all([
    countEmployeesByLocation(organisationId, db),
    getActiveAssignmentsForScope(
      organisationId,
      "LOCATION",
      rows.map((r) => r.id),
      { now, db },
    ),
  ]);
  return rows.map((row) =>
    toLocationDto(row, employeeCounts.get(row.id) ?? 0, assignments.get(row.id)),
  );
}

async function hydrate(
  organisationId: string,
  row: LocationRow,
  db: Db = prisma,
): Promise<Location> {
  const [employeeCounts, assignments] = await Promise.all([
    countEmployeesByLocation(organisationId, db),
    getActiveAssignmentsForScope(organisationId, "LOCATION", [row.id], { db }),
  ]);
  return toLocationDto(row, employeeCounts.get(row.id) ?? 0, assignments.get(row.id));
}

async function loadLocationOrThrow(
  organisationId: string,
  id: string,
  db?: Db,
): Promise<LocationRow> {
  const row = await findLocationInOrganisation(organisationId, id, db);
  if (!row) throw new AppError("NOT_FOUND", "Location not found");
  return row;
}

function nameConflict(): AppError {
  return new AppError("CONFLICT", "A location with this name already exists", {
    details: { field: "name" },
  });
}

/** `GET /api/locations` */
export async function listLocations(ctx: ManagerContext): Promise<ListLocationsResponse> {
  return { locations: await listLocationsForOrg(ctx.organisation.id) };
}

/** `GET /api/locations/:id` */
export async function getLocation(ctx: ManagerContext, id: string): Promise<Location> {
  const row = await loadLocationOrThrow(ctx.organisation.id, id);
  return hydrate(ctx.organisation.id, row);
}

/**
 * `POST /api/locations`: unique name per organisation and within the plan's location limit (both checked
 * under the organisation row lock so two concurrent creates cannot both pass).
 */
export async function createLocation(
  ctx: ManagerContext,
  input: CreateLocationInput,
): Promise<Location> {
  const organisationId = ctx.organisation.id;
  const plan = ctx.organisation.plan;
  const created = await prisma.$transaction(async (tx) => {
    await lockOrganisationRow(tx, organisationId);
    if (await findLocationByName(organisationId, input.name, { db: tx })) throw nameConflict();
    const current = await countLocations(organisationId, tx);
    if (!isWithinLimit(plan, "locations", current + 1)) {
      const limit = planLimitsFor(plan).locations;
      throw new AppError("CONFLICT", `Your ${plan} plan allows up to ${String(limit)} locations`, {
        details: { reason: "PLAN_LIMIT_REACHED", metric: "locations", limit, current, plan },
      });
    }
    const row = await tx.location.create({
      data: {
        organisationId,
        name: input.name,
        timezone: input.timezone ?? null,
        address: input.address ?? null,
      },
      include: locationInclude,
    });
    await audit(
      ctx,
      {
        action: "location.created",
        entityType: "Location",
        entityId: row.id,
        after: snapshot(row),
      },
      tx,
    );
    return row;
  });
  return toLocationDto(created, 0, undefined);
}

/** `PATCH /api/locations/:id`: omitted = unchanged, `null` = clear (timezone falls back to the organisation's). */
export async function updateLocation(
  ctx: ManagerContext,
  id: string,
  input: UpdateLocationInput,
): Promise<Location> {
  const organisationId = ctx.organisation.id;
  const updated = await prisma.$transaction(async (tx) => {
    const before = await loadLocationOrThrow(organisationId, id, tx);
    const data: Prisma.LocationUpdateInput = {};
    if (input.name !== undefined && input.name !== before.name) {
      if (await findLocationByName(organisationId, input.name, { excludeId: id, db: tx }))
        throw nameConflict();
      data.name = input.name;
    }
    if (input.timezone !== undefined) data.timezone = input.timezone;
    if (input.address !== undefined) data.address = input.address;
    if (Object.keys(data).length === 0) return before;
    const after = await tx.location.update({ where: { id }, data, include: locationInclude });
    await audit(
      ctx,
      {
        action: "location.updated",
        entityType: "Location",
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

/**
 * `DELETE /api/locations/:id`: soft delete. Refused (CONFLICT, `details.upcomingShiftCount`) while shifts
 * are still scheduled there — move or cancel them first. Employees, teams and finished shifts are
 * detached; open policy assignments to the location are ended and the affected employees' devices are
 * told to re-resolve their policy.
 */
export async function deleteLocation(ctx: ManagerContext, id: string): Promise<void> {
  const organisationId = ctx.organisation.id;
  const result = await prisma.$transaction(async (tx) => {
    const before = await loadLocationOrThrow(organisationId, id, tx);
    const now = new Date();
    const upcoming = await countUpcomingShiftsForLocation(organisationId, id, now, tx);
    if (upcoming > 0) {
      throw new AppError(
        "CONFLICT",
        `This location still has ${upcoming} scheduled ${upcoming === 1 ? "shift" : "shifts"}; move or cancel them first`,
        { details: { reason: "UPCOMING_SHIFTS", upcomingShiftCount: upcoming } },
      );
    }
    const detached = await softDeleteLocation(tx, organisationId, id, now);
    await audit(
      ctx,
      {
        action: "location.deleted",
        entityType: "Location",
        entityId: id,
        before: snapshot(before),
        after: {
          deletedAt: now,
          employeesDetached: detached.employeesDetached,
          employeeLinksRemoved: detached.employeeLinksRemoved,
          teamsDetached: detached.teamsDetached,
          shiftsDetached: detached.shiftsDetached,
          policyAssignmentsEnded: detached.policyIds.length,
          breakPolicyAssignmentsEnded: detached.breakPolicyIds.length,
        },
        occurredAt: now,
      },
      tx,
    );
    return detached;
  });
  for (const policyId of result.policyIds) {
    publishPolicyChanged({
      organisationId,
      policyId,
      reason: "UNASSIGNED",
      affectedEmployeeIds: result.affectedEmployeeIds,
    });
  }
  for (const breakPolicyId of result.breakPolicyIds) {
    publishBreakPolicyChanged({
      organisationId,
      breakPolicyId,
      reason: "UNASSIGNED",
      affectedEmployeeIds: result.affectedEmployeeIds,
    });
  }
}
