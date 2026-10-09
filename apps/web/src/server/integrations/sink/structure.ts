import type { Prisma } from "@clockoff/db";
import {
  decideDepartmentAction,
  decideGroupAction,
  departmentDecisionInputs,
  groupDecisionInputs,
  hashDecisionInputs,
  markMissingCatalogEntries,
  mergeCatalogPage,
  NO_DEPARTMENT_ID,
  type StructureTargetRow,
} from "@clockoff/integrations";
import { PROVIDERS } from "@clockoff/shared/providers/registry";
import type { ExternalLocation, ExternalTeam } from "@clockoff/shared/providers/workforceProvider";
import {
  departmentMappingsSchema,
  plandayCatalogSchema,
  type PlandayCatalog,
} from "@clockoff/validation/planday";
import {
  createManagedLocations,
  renameManagedLocation,
} from "@/server/locations/locations.integration";
import { createManagedTeams, renameManagedTeam } from "@/server/teams/teams.integration";
import { notifyDepartmentsFound } from "../notifications";
import type { SinkContext } from "./context";
import {
  findAllMapRows,
  findMapRows,
  recordMapRows,
  setUpstreamRemoved,
  upsertStructureMapRow,
  type MapRow,
} from "./entityMaps.repository";

/**
 * Departments → locations and employee groups → teams (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.3, §6.4).
 * The catalogue (`IntegrationMappingConfig.catalog`: names, numbers and counts, not personal data) is merged on every
 * structure read; a SYNC also applies the stored mappings through the location and team writers: rename a managed
 * location or team, link a mapping to its map row, flag a department or group that a complete list no longer has
 * (never deleted). Managers' own locations and teams are never renamed or marked managed.
 */

type Tx = Prisma.TransactionClient;

// ── Catalogue ────────────────────────────────────────────────────────────────

async function readCatalogForUpdate(tx: Tx, integrationId: string): Promise<PlandayCatalog> {
  const rows = await tx.$queryRaw<Array<{ catalog: Prisma.JsonValue }>>`
    SELECT catalog FROM integration_mapping_configs
     WHERE integration_id = ${integrationId}::uuid FOR UPDATE`;
  return plandayCatalogSchema.parse(rows[0]?.catalog ?? {});
}

async function writeCatalog(tx: Tx, integrationId: string, catalog: PlandayCatalog): Promise<void> {
  await tx.integrationMappingConfig.update({
    where: { integrationId },
    data: { catalog: catalog as unknown as Prisma.InputJsonValue },
  });
}

/**
 * Merges one page of departments (`LOCATIONS`) or groups (`TEAMS`) into the catalogue; on the last page entries
 * the phase never read are marked missing. After onboarding a new department stays excluded and OWNER / ADMIN are
 * told once per department id (§6.3 "New department after onboarding", `notifiedAt`).
 */
export async function mergeCatalog(
  tx: Tx,
  ctx: SinkContext,
  kind: "LOCATIONS" | "TEAMS",
  records: readonly (ExternalLocation | ExternalTeam)[],
  completion: { complete: boolean; seenIds: readonly string[] },
): Promise<{ added: string[]; missing: string[] }> {
  const catalog = await readCatalogForUpdate(tx, ctx.integrationId);
  const now = ctx.now;
  let added: string[];
  let missing: string[] = [];
  if (kind === "LOCATIONS") {
    const merged = mergeCatalogPage(
      catalog.departments,
      records.map((r) => ({
        externalId: r.externalId,
        name: r.name,
        number: (r as { number?: string | null }).number ?? null,
      })),
      now,
      (record) => ({
        externalId: record.externalId,
        name: record.name,
        number: record.number,
        employeeCount: null,
        firstSeenAt: record.firstSeenAt,
        notifiedAt: null,
        missing: false,
      }),
    );
    added = merged.added;
    let departments = merged.entries;
    if (completion.complete) {
      const marked = markMissingCatalogEntries(departments, completion.seenIds);
      departments = marked.entries;
      missing = marked.missing;
    }
    const notify =
      ctx.config.onboardingCompletedAt !== null
        ? departments.filter((d) => added.includes(d.externalId) && d.notifiedAt === null)
        : [];
    if (notify.length > 0) {
      const at = now.toISOString();
      departments = departments.map((d) =>
        notify.some((n) => n.externalId === d.externalId) ? { ...d, notifiedAt: at } : d,
      );
      ctx.effects.alerts.push(
        await notifyDepartmentsFound(tx, {
          organisationId: ctx.organisationId,
          integrationId: ctx.integrationId,
          provider: ctx.provider,
          externalDepartmentIds: notify.map((d) => d.externalId),
        }),
      );
      for (const department of notify) {
        ctx.tally.warn(
          "DEPARTMENT_NEW",
          "A new Planday department was found; choose where it goes in the Planday settings",
          department.externalId,
        );
      }
    }
    await writeCatalog(tx, ctx.integrationId, {
      ...catalog,
      departments,
      ...(completion.complete ? { readAt: now.toISOString() } : {}),
    });
  } else {
    const merged = mergeCatalogPage(
      catalog.groups,
      records.map((r) => ({ externalId: r.externalId, name: r.name })),
      now,
      (record) => ({
        externalId: record.externalId,
        name: record.name,
        employeeCount: null,
        firstSeenAt: record.firstSeenAt,
        missing: false,
      }),
    );
    added = merged.added;
    let groups = merged.entries;
    if (completion.complete) {
      const marked = markMissingCatalogEntries(groups, completion.seenIds);
      groups = marked.entries;
      missing = marked.missing;
    }
    await writeCatalog(tx, ctx.integrationId, { ...catalog, groups });
  }
  return { added, missing };
}

/** STRUCTURE's EMPLOYEE_COUNTS: counts per department and group, and the "Not in any department" count (§6.3). */
export async function writeCatalogCounts(
  tx: Tx,
  ctx: SinkContext,
  counts: {
    byDepartment: Readonly<Record<string, number>>;
    byGroup: Readonly<Record<string, number>>;
  },
): Promise<void> {
  const catalog = await readCatalogForUpdate(tx, ctx.integrationId);
  await writeCatalog(tx, ctx.integrationId, {
    ...catalog,
    readAt: ctx.now.toISOString(),
    departments: catalog.departments.map((d) => ({
      ...d,
      employeeCount: counts.byDepartment[d.externalId] ?? 0,
    })),
    groups: catalog.groups.map((g) => ({ ...g, employeeCount: counts.byGroup[g.externalId] ?? 0 })),
    unassignedEmployeeCount: counts.byDepartment[NO_DEPARTMENT_ID] ?? 0,
  });
}

/** STRUCTURE's PORTAL_CHECK: the child-portal count shown on the wizard's step 2. */
export async function writeCatalogPortal(
  tx: Tx,
  ctx: SinkContext,
  childPortalCount: number,
): Promise<void> {
  const catalog = await readCatalogForUpdate(tx, ctx.integrationId);
  if (catalog.childPortalCount === childPortalCount) return;
  await writeCatalog(tx, ctx.integrationId, { ...catalog, childPortalCount });
}

// ── Departments → locations (SYNC) ───────────────────────────────────────────

const DEPARTMENT_WARNINGS: Readonly<Record<string, string>> = {
  DEPARTMENT_MISSING:
    "A Planday department is no longer returned; its ClockOff location was kept (never deleted)",
  DEPARTMENT_UNMAPPED: "An included Planday department has no ClockOff location or department",
  DEPARTMENT_TARGET_MISSING:
    "The ClockOff location a Planday department maps to no longer exists; remap it in the Planday settings",
  GROUP_MISSING: "A Planday employee group is no longer returned; its ClockOff team was kept",
  GROUP_TARGET_MISSING:
    "The ClockOff team a Planday employee group maps to no longer exists; remap it in the Planday settings",
};

function warnStructure(ctx: SinkContext, code: string | undefined, externalId: string): void {
  if (!code) return;
  ctx.tally.warn(code, DEPARTMENT_WARNINGS[code] ?? code, externalId);
}

async function loadLocations(
  tx: Tx,
  organisationId: string,
  ids: readonly string[],
): Promise<Map<string, StructureTargetRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx.location.findMany({
    where: { organisationId, id: { in: unique } },
    select: { id: true, name: true, managedByIntegrationId: true, deletedAt: true },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        managedByIntegrationId: r.managedByIntegrationId,
        deleted: r.deletedAt !== null,
      },
    ]),
  );
}

async function loadTeams(
  tx: Tx,
  organisationId: string,
  ids: readonly string[],
): Promise<Map<string, StructureTargetRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx.team.findMany({
    where: { organisationId, id: { in: unique } },
    select: { id: true, name: true, managedByIntegrationId: true },
  });
  return new Map(rows.map((r) => [r.id, { ...r, deleted: false }]));
}

async function storeDepartmentMapping(
  tx: Tx,
  ctx: SinkContext,
  externalId: string,
  locationId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ department_mappings: Prisma.JsonValue }>>`
    SELECT department_mappings FROM integration_mapping_configs
     WHERE integration_id = ${ctx.integrationId}::uuid FOR UPDATE`;
  const mappings = departmentMappingsSchema.parse(rows[0]?.department_mappings ?? {});
  await tx.integrationMappingConfig.update({
    where: { integrationId: ctx.integrationId },
    data: {
      departmentMappings: {
        ...mappings,
        [externalId]: { target: "LOCATION", locationId },
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

/** One DEPARTMENTS page of a SYNC: the §6.3 table per department, and missing departments on the last page. */
export async function applyDepartments(
  tx: Tx,
  ctx: SinkContext,
  records: readonly ExternalLocation[],
  completion: { complete: boolean; seenIds: readonly string[] },
): Promise<void> {
  await mergeCatalog(tx, ctx, "LOCATIONS", records, completion);
  const actor = { organisationId: ctx.organisationId, integrationId: ctx.integrationId };
  const included = new Set(ctx.config.includedDepartmentIds);
  const mapRows = await findMapRows(
    tx,
    ctx.integrationId,
    ["LOCATION", "DEPARTMENT"],
    records.map((r) => r.externalId),
  );
  const locationIds = records.flatMap((r) => {
    const mapping = ctx.config.storedDepartmentMappings[r.externalId];
    const mapRow = mapRows.get(r.externalId);
    return [
      ...(mapping?.target === "LOCATION" ? [mapping.locationId] : []),
      ...(mapRow?.entityType === "LOCATION" ? [mapRow.internalId] : []),
    ];
  });
  const locations = await loadLocations(tx, ctx.organisationId, locationIds);
  const touch: string[] = [];
  const hashes: Array<{ id: string; lastHash: string | null }> = [];
  const cleared: string[] = [];

  for (const department of records) {
    const mapping = ctx.config.storedDepartmentMappings[department.externalId] ?? null;
    const isIncluded = included.has(department.externalId);
    const mapRow = mapRows.get(department.externalId) ?? null;
    const locationId =
      mapping?.target === "LOCATION"
        ? mapping.locationId
        : mapRow?.entityType === "LOCATION"
          ? mapRow.internalId
          : null;
    const hash = hashDecisionInputs(
      ctx.hasher,
      departmentDecisionInputs(department, isIncluded, mapping),
    );
    const decision = decideDepartmentAction({
      department,
      included: isIncluded,
      mapping,
      mapRow: mapRow
        ? {
            entityType: mapRow.entityType as "LOCATION" | "DEPARTMENT",
            internalId: mapRow.internalId,
            lastHash: mapRow.lastHash,
            upstreamRemovedAt: mapRow.upstreamRemovedAt,
          }
        : null,
      location: locationId ? (locations.get(locationId) ?? null) : null,
      integrationId: ctx.integrationId,
      portalTimezone: ctx.portalTimezone ?? "UTC",
      hash,
      providerName: PROVIDERS[ctx.provider].displayName,
    });
    warnStructure(ctx, decision.warning, department.externalId);
    if (decision.clearMissing && mapRow) cleared.push(mapRow.id);
    switch (decision.action) {
      case "IGNORE":
        if (mapRow) touch.push(mapRow.id);
        break;
      case "UNCHANGED":
        if (mapRow) touch.push(mapRow.id);
        ctx.tally.count("locations", "skipped");
        break;
      case "REHASH_ONLY":
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("locations", "skipped");
        break;
      case "CREATE_LOCATION": {
        const [created] = await createManagedLocations(
          tx,
          actor,
          [
            {
              externalId: department.externalId,
              name: decision.name,
              timezone: decision.timezone,
              lastHash: hash,
            },
          ],
          ctx.now,
        );
        if (created)
          await storeDepartmentMapping(tx, ctx, department.externalId, created.locationId);
        ctx.tally.count("locations", "created");
        break;
      }
      case "LINK":
        await upsertStructureMapRow(tx, {
          organisationId: ctx.organisationId,
          integrationId: ctx.integrationId,
          provider: ctx.provider,
          entityType: decision.entityType,
          externalId: department.externalId,
          internalId: decision.internalId,
          lastHash: hash,
          now: ctx.now,
          replaceTypes: ["LOCATION", "DEPARTMENT"],
        });
        ctx.tally.count("locations", "updated");
        break;
      case "RENAME_LOCATION": {
        const result = await renameManagedLocation(tx, actor, {
          locationId: decision.locationId,
          name: decision.name,
        });
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("locations", result.renamed ? "updated" : "skipped");
        break;
      }
      case "MARK_MISSING":
        if (mapRow) await setUpstreamRemoved(tx, [mapRow.id], ctx.now);
        break;
    }
  }
  await setUpstreamRemoved(tx, cleared, null);
  await recordMapRows(tx, { touched: touch, hashed: hashes }, ctx.now);
  if (completion.complete) await markMissingStructure(tx, ctx, "DEPARTMENT", completion.seenIds);
}

/** Map rows of departments / groups a complete list no longer returned: flagged (`upstreamRemovedAt`), never deleted. */
async function markMissingStructure(
  tx: Tx,
  ctx: SinkContext,
  kind: "DEPARTMENT" | "GROUP",
  seenIds: readonly string[],
): Promise<void> {
  const seen = new Set(seenIds);
  const rows = await findAllMapRows(
    tx,
    ctx.integrationId,
    kind === "DEPARTMENT" ? ["LOCATION", "DEPARTMENT"] : ["TEAM"],
  );
  const missing: MapRow[] = rows.filter(
    (row) => row.externalId !== NO_DEPARTMENT_ID && !seen.has(row.externalId),
  );
  const mark: string[] = [];
  for (const row of missing) {
    const decision =
      kind === "DEPARTMENT"
        ? decideDepartmentAction({
            department: null,
            included: false,
            mapping: null,
            mapRow: {
              entityType: row.entityType as "LOCATION" | "DEPARTMENT",
              internalId: row.internalId,
              lastHash: row.lastHash,
              upstreamRemovedAt: row.upstreamRemovedAt,
            },
            location: null,
            integrationId: ctx.integrationId,
            portalTimezone: ctx.portalTimezone ?? "UTC",
          })
        : decideGroupAction({
            group: null,
            mapping: null,
            mapRow: {
              entityType: "TEAM",
              internalId: row.internalId,
              lastHash: row.lastHash,
              upstreamRemovedAt: row.upstreamRemovedAt,
            },
            team: null,
            integrationId: ctx.integrationId,
          });
    warnStructure(ctx, decision.warning, row.externalId);
    if (decision.action === "MARK_MISSING") mark.push(row.id);
  }
  await setUpstreamRemoved(tx, mark, ctx.now);
}

// ── Employee groups → teams (SYNC) ───────────────────────────────────────────

/** One EMPLOYEE_GROUPS page of a SYNC: the §6.4 table per group, and missing groups on the last page. */
export async function applyGroups(
  tx: Tx,
  ctx: SinkContext,
  records: readonly ExternalTeam[],
  completion: { complete: boolean; seenIds: readonly string[] },
): Promise<void> {
  await mergeCatalog(tx, ctx, "TEAMS", records, completion);
  const actor = { organisationId: ctx.organisationId, integrationId: ctx.integrationId };
  const mapRows = await findMapRows(
    tx,
    ctx.integrationId,
    ["TEAM"],
    records.map((r) => r.externalId),
  );
  const teamIds = records.flatMap((r) => {
    const mapping = ctx.config.storedGroupMappings[r.externalId];
    const mapRow = mapRows.get(r.externalId);
    return [...(mapping ? [mapping.teamId] : []), ...(mapRow ? [mapRow.internalId] : [])];
  });
  const teams = await loadTeams(tx, ctx.organisationId, teamIds);
  const touch: string[] = [];
  const hashes: Array<{ id: string; lastHash: string | null }> = [];
  const cleared: string[] = [];

  for (const group of records) {
    const mapping = ctx.config.storedGroupMappings[group.externalId] ?? null;
    const mapRow = mapRows.get(group.externalId) ?? null;
    const teamId = mapping?.teamId ?? mapRow?.internalId ?? null;
    const hash = hashDecisionInputs(ctx.hasher, groupDecisionInputs(group, mapping));
    const decision = decideGroupAction({
      group,
      mapping,
      mapRow: mapRow
        ? {
            entityType: "TEAM",
            internalId: mapRow.internalId,
            lastHash: mapRow.lastHash,
            upstreamRemovedAt: mapRow.upstreamRemovedAt,
          }
        : null,
      team: teamId ? (teams.get(teamId) ?? null) : null,
      integrationId: ctx.integrationId,
      hash,
    });
    warnStructure(ctx, decision.warning, group.externalId);
    if (decision.clearMissing && mapRow) cleared.push(mapRow.id);
    switch (decision.action) {
      case "IGNORE":
        if (mapRow) touch.push(mapRow.id);
        break;
      case "UNCHANGED":
        if (mapRow) touch.push(mapRow.id);
        ctx.tally.count("teams", "skipped");
        break;
      case "REHASH_ONLY":
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("teams", "skipped");
        break;
      case "CREATE_TEAM":
        await createManagedTeams(
          tx,
          actor,
          [{ externalId: group.externalId, name: decision.name, lastHash: hash }],
          ctx.now,
        );
        ctx.tally.count("teams", "created");
        break;
      case "LINK":
        await upsertStructureMapRow(tx, {
          organisationId: ctx.organisationId,
          integrationId: ctx.integrationId,
          provider: ctx.provider,
          entityType: "TEAM",
          externalId: group.externalId,
          internalId: decision.internalId,
          lastHash: hash,
          now: ctx.now,
        });
        ctx.tally.count("teams", "updated");
        break;
      case "RENAME_TEAM": {
        const result = await renameManagedTeam(tx, actor, {
          teamId: decision.teamId,
          name: decision.name,
        });
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("teams", result.renamed ? "updated" : "skipped");
        break;
      }
      case "MARK_MISSING":
        if (mapRow) await setUpstreamRemoved(tx, [mapRow.id], ctx.now);
        break;
    }
  }
  await setUpstreamRemoved(tx, cleared, null);
  await recordMapRows(tx, { touched: touch, hashed: hashes }, ctx.now);
  if (completion.complete) await markMissingStructure(tx, ctx, "GROUP", completion.seenIds);
}

/** The cursor's `seenIds` (every id the phase read, on its last step; §6.3 "missing from a complete list"). */
export function seenIdsOf(cursor: Readonly<Record<string, unknown>>): string[] {
  const value = cursor.seenIds;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}
