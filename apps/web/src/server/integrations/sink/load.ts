import type { prisma, Prisma } from "@clockoff/db";
import type { DepartmentMappings, GroupMappings } from "@clockoff/validation/planday";
import { emptyMappingSnapshot, parseMappingSnapshot, type MappingSnapshot } from "./context";

/**
 * The mapping snapshot a slice works with (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.3, §6.4): the stored
 * `IntegrationMappingConfig`, with mappings whose ClockOff target no longer exists (a deleted location, a removed team
 * or department) left out. The DEPARTMENTS and EMPLOYEE_GROUPS phases warn about those (`*_TARGET_MISSING`); the
 * employee and shift decisions then resolve such a department to no location instead of failing the page.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export async function loadMappingSnapshot(
  db: Db,
  input: { organisationId: string; integrationId: string },
): Promise<MappingSnapshot> {
  const row = await db.integrationMappingConfig.findFirst({
    where: { integrationId: input.integrationId, organisationId: input.organisationId },
  });
  if (!row) return emptyMappingSnapshot();
  const snapshot = parseMappingSnapshot(row);
  const locationIds = new Set<string>();
  const departmentIds = new Set<string>();
  for (const mapping of Object.values(snapshot.departmentMappings)) {
    if (mapping.target === "LOCATION") locationIds.add(mapping.locationId);
    else departmentIds.add(mapping.departmentId);
  }
  const teamIds = new Set(Object.values(snapshot.groupMappings).map((m) => m.teamId));
  const [locations, departments, teams] = await Promise.all([
    locationIds.size === 0
      ? []
      : db.location.findMany({
          where: {
            organisationId: input.organisationId,
            id: { in: [...locationIds] },
            deletedAt: null,
          },
          select: { id: true },
        }),
    departmentIds.size === 0
      ? []
      : db.department.findMany({
          where: { organisationId: input.organisationId, id: { in: [...departmentIds] } },
          select: { id: true },
        }),
    teamIds.size === 0
      ? []
      : db.team.findMany({
          where: { organisationId: input.organisationId, id: { in: [...teamIds] } },
          select: { id: true },
        }),
  ]);
  const liveLocations = new Set(locations.map((l) => l.id));
  const liveDepartments = new Set(departments.map((d) => d.id));
  const liveTeams = new Set(teams.map((t) => t.id));
  const departmentMappings: DepartmentMappings = Object.fromEntries(
    Object.entries(snapshot.departmentMappings).filter(([, mapping]) =>
      mapping.target === "LOCATION"
        ? liveLocations.has(mapping.locationId)
        : liveDepartments.has(mapping.departmentId),
    ),
  );
  const groupMappings: GroupMappings = Object.fromEntries(
    Object.entries(snapshot.groupMappings).filter(([, mapping]) => liveTeams.has(mapping.teamId)),
  );
  return { ...snapshot, departmentMappings, groupMappings };
}
