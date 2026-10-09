import { Prisma, type ExternalEntityMap } from "@clockoff/db";
import type { ExternalEntityType, IntegrationProvider } from "@clockoff/shared/enums";

/**
 * `ExternalEntityMap` reads and writes for the sinks (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.2), batched:
 * one read per batch (`external_id = ANY(...)`) and one update per batch that stamps `last_seen_at` on every row it
 * saw and writes `last_hash` for the decided ones (`recordMapRows`, one statement whatever the page size, §6.1). The
 * writers in `server/{shifts,employees,locations,teams}/*.integration.ts` create map rows and set or clear
 * `upstream_removed_at` themselves; nothing here undoes that.
 */

type Tx = Prisma.TransactionClient;

export type MapRow = Pick<
  ExternalEntityMap,
  | "id"
  | "externalId"
  | "internalId"
  | "entityType"
  | "lastHash"
  | "lastSeenAt"
  | "upstreamRemovedAt"
  | "upstreamMissingSince"
  | "reviewDismissedAt"
>;

const MAP_ROW_SELECT = {
  id: true,
  externalId: true,
  internalId: true,
  entityType: true,
  lastHash: true,
  lastSeenAt: true,
  upstreamRemovedAt: true,
  upstreamMissingSince: true,
  reviewDismissedAt: true,
} as const;

/** Map rows of `entityTypes` for these external ids, keyed by external id (the first type wins on a clash). */
export async function findMapRows(
  tx: Tx,
  integrationId: string,
  entityTypes: readonly ExternalEntityType[],
  externalIds: readonly string[],
): Promise<Map<string, MapRow>> {
  const ids = [...new Set(externalIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.externalEntityMap.findMany({
    where: { integrationId, entityType: { in: [...entityTypes] }, externalId: { in: ids } },
    select: MAP_ROW_SELECT,
  });
  const order = new Map(entityTypes.map((type, index) => [type, index] as const));
  rows.sort((a, b) => (order.get(a.entityType) ?? 0) - (order.get(b.entityType) ?? 0));
  const byExternalId = new Map<string, MapRow>();
  for (const row of rows)
    if (!byExternalId.has(row.externalId)) byExternalId.set(row.externalId, row);
  return byExternalId;
}

/** Every map row of one type (structure: departments and groups are few). */
export async function findAllMapRows(
  tx: Tx,
  integrationId: string,
  entityTypes: readonly ExternalEntityType[],
): Promise<MapRow[]> {
  return tx.externalEntityMap.findMany({
    where: { integrationId, entityType: { in: [...entityTypes] } },
    select: MAP_ROW_SELECT,
  });
}

/**
 * One statement for a batch's map rows (§6.2 steps 3 and 4): `last_seen_at = now` on every `touched` and `hashed` row,
 * and `last_hash` on the `hashed` (decided) ones; a row in both lists takes its hash.
 */
export async function recordMapRows(
  tx: Tx,
  rows: {
    touched?: readonly string[];
    hashed?: ReadonlyArray<{ id: string; lastHash: string | null }>;
  },
  now: Date,
): Promise<void> {
  const entries = new Map<string, { hash: string | null; setHash: boolean }>();
  for (const id of rows.touched ?? []) entries.set(id, { hash: null, setHash: false });
  for (const { id, lastHash } of rows.hashed ?? [])
    entries.set(id, { hash: lastHash, setHash: true });
  if (entries.size === 0) return;
  const values = Prisma.join(
    [...entries].map(
      ([id, entry]) => Prisma.sql`(${id}::uuid, ${entry.hash}::text, ${entry.setHash}::boolean)`,
    ),
  );
  await tx.$executeRaw`
    UPDATE external_entity_maps m
       SET last_hash = CASE WHEN v.set_hash THEN v.hash ELSE m.last_hash END,
           last_seen_at = ${now}::timestamptz, updated_at = now()
      FROM (VALUES ${values}) AS v(id, hash, set_hash)
     WHERE m.id = v.id`;
}

/** Sets or clears `upstream_removed_at` on rows (structure missing, departments back on the list). */
export async function setUpstreamRemoved(
  tx: Tx,
  ids: readonly string[],
  value: Date | null,
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  await tx.$executeRaw`
    UPDATE external_entity_maps SET upstream_removed_at = ${value}::timestamptz, updated_at = now()
     WHERE id = ANY(${unique}::uuid[])`;
}

/** Creates or repoints a structure map row (LOCATION, DEPARTMENT or TEAM: a mapping to a manager's record). */
export async function upsertStructureMapRow(
  tx: Tx,
  input: {
    organisationId: string;
    integrationId: string;
    provider: IntegrationProvider;
    entityType: "LOCATION" | "DEPARTMENT" | "TEAM";
    externalId: string;
    internalId: string;
    lastHash: string | null;
    now: Date;
    /** Map rows of other structure types for the same department (a remap from location to department). */
    replaceTypes?: readonly ExternalEntityType[];
  },
): Promise<void> {
  if (input.replaceTypes && input.replaceTypes.length > 0) {
    await tx.externalEntityMap.deleteMany({
      where: {
        integrationId: input.integrationId,
        externalId: input.externalId,
        entityType: { in: input.replaceTypes.filter((type) => type !== input.entityType) },
      },
    });
  }
  await tx.externalEntityMap.upsert({
    where: {
      integrationId_entityType_externalId: {
        integrationId: input.integrationId,
        entityType: input.entityType,
        externalId: input.externalId,
      },
    },
    create: {
      organisationId: input.organisationId,
      integrationId: input.integrationId,
      provider: input.provider,
      entityType: input.entityType,
      externalId: input.externalId,
      internalId: input.internalId,
      lastSeenAt: input.now,
      lastHash: input.lastHash,
    },
    update: {
      internalId: input.internalId,
      lastSeenAt: input.now,
      lastHash: input.lastHash,
      upstreamRemovedAt: null,
    },
  });
}

/** EMPLOYEE map rows of the integration whose employee is live, keyed by Planday id (`isEmployeeMapped`). */
export async function mappedEmployeeIds(
  tx: Tx,
  input: { organisationId: string; integrationId: string; externalIds: readonly string[] },
): Promise<Map<string, string>> {
  const ids = [...new Set(input.externalIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ external_id: string; employee_id: string }>>`
    SELECT m.external_id, e.id::text AS employee_id
      FROM external_entity_maps m
      JOIN employees e ON e.id = m.internal_id AND e.organisation_id = ${input.organisationId}::uuid
     WHERE m.integration_id = ${input.integrationId}::uuid
       AND m.entity_type = 'EMPLOYEE'
       AND m.external_id = ANY(${ids}::text[])
       AND e.deleted_at IS NULL`;
  return new Map(rows.map((row) => [row.external_id, row.employee_id] as const));
}
