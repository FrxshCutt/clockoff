import type { Prisma } from "@clockoff/db";

/**
 * Re-adoption and mapping reset for the connect transaction (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §5.7),
 * called by `planday.service.ts` (build stage 5). A disconnect clears `managedByIntegrationId` on the organisation's
 * records but keeps the map rows (§5.8); reconnecting the same portal takes them back so no entity is duplicated, and
 * clears every `lastHash` so the RECOVERY SYNC re-decides every record (reverting edits made while disconnected:
 * Planday is the source of truth again). Switching to another portal deletes the mappings instead.
 */

type Tx = Prisma.TransactionClient;

export interface ReadoptedCounts {
  employees: number;
  locations: number;
  teams: number;
  shifts: number;
}

/**
 * Same portal, previous status DISCONNECTED (§5.7), in the connect transaction:
 * 1. EMPLOYEE map rows: a live employee is managed again; otherwise the map row is deleted (the next SYNC matches the
 *    Planday person afresh).
 * 2. LOCATION / TEAM map rows: an entity this integration created (`source = INTEGRATION`) that still exists is
 *    managed again (a manager's own location or team stays the manager's); a deleted one loses its map row.
 *    DEPARTMENT map rows whose ClockOff department is gone are deleted.
 * 3. SHIFT map rows: a live shift is managed again, and a non-ended CANCELLED one gets `upstreamRemovedAt = now`
 *    (eligible for REINSTATE, row 15) whoever cancelled it; a deleted shift loses its map row (re-created by the next
 *    SYNC if Planday still publishes it).
 * 4. `lastHash = null` on every remaining map row.
 * Records another integration manages are never taken.
 */
export async function readoptIntegrationRecords(
  tx: Tx,
  input: { organisationId: string; integrationId: string; now: Date },
): Promise<ReadoptedCounts> {
  const { organisationId, integrationId, now } = input;

  await tx.$executeRaw`
    DELETE FROM external_entity_maps m
     WHERE m.integration_id = ${integrationId}::uuid AND m.entity_type = 'EMPLOYEE'
       AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = m.internal_id
                         AND e.organisation_id = ${organisationId}::uuid AND e.deleted_at IS NULL)`;
  const employees = await tx.$executeRaw`
    UPDATE employees e SET managed_by_integration_id = ${integrationId}::uuid, updated_at = now()
      FROM external_entity_maps m
     WHERE m.integration_id = ${integrationId}::uuid AND m.entity_type = 'EMPLOYEE'
       AND e.id = m.internal_id AND e.organisation_id = ${organisationId}::uuid AND e.deleted_at IS NULL
       AND (e.managed_by_integration_id IS NULL OR e.managed_by_integration_id = ${integrationId}::uuid)`;

  await tx.$executeRaw`
    DELETE FROM external_entity_maps m
     WHERE m.integration_id = ${integrationId}::uuid AND m.entity_type = 'LOCATION'
       AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = m.internal_id
                         AND l.organisation_id = ${organisationId}::uuid AND l.deleted_at IS NULL)`;
  const locations = await tx.$executeRaw`
    UPDATE locations l SET managed_by_integration_id = ${integrationId}::uuid, updated_at = now()
      FROM external_entity_maps m
     WHERE m.integration_id = ${integrationId}::uuid AND m.entity_type = 'LOCATION'
       AND l.id = m.internal_id AND l.organisation_id = ${organisationId}::uuid AND l.deleted_at IS NULL
       AND l.source = 'INTEGRATION'
       AND (l.managed_by_integration_id IS NULL OR l.managed_by_integration_id = ${integrationId}::uuid)`;

  await tx.$executeRaw`
    DELETE FROM external_entity_maps m
     WHERE m.integration_id = ${integrationId}::uuid AND m.entity_type = 'TEAM'
       AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = m.internal_id
                         AND t.organisation_id = ${organisationId}::uuid)`;
  const teams = await tx.$executeRaw`
    UPDATE teams t SET managed_by_integration_id = ${integrationId}::uuid, updated_at = now()
      FROM external_entity_maps m
     WHERE m.integration_id = ${integrationId}::uuid AND m.entity_type = 'TEAM'
       AND t.id = m.internal_id AND t.organisation_id = ${organisationId}::uuid AND t.source = 'INTEGRATION'
       AND (t.managed_by_integration_id IS NULL OR t.managed_by_integration_id = ${integrationId}::uuid)`;

  await tx.$executeRaw`
    DELETE FROM external_entity_maps m
     WHERE m.integration_id = ${integrationId}::uuid AND m.entity_type = 'DEPARTMENT'
       AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = m.internal_id
                         AND d.organisation_id = ${organisationId}::uuid)`;

  await tx.$executeRaw`
    DELETE FROM external_entity_maps m
     WHERE m.integration_id = ${integrationId}::uuid AND m.entity_type = 'SHIFT'
       AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.id = m.internal_id
                         AND s.organisation_id = ${organisationId}::uuid AND s.deleted_at IS NULL)`;
  const shifts = await tx.$executeRaw`
    UPDATE shifts s SET managed_by_integration_id = ${integrationId}::uuid, updated_at = now()
      FROM external_entity_maps m
     WHERE m.integration_id = ${integrationId}::uuid AND m.entity_type = 'SHIFT'
       AND s.id = m.internal_id AND s.organisation_id = ${organisationId}::uuid AND s.deleted_at IS NULL
       AND (s.managed_by_integration_id IS NULL OR s.managed_by_integration_id = ${integrationId}::uuid)`;
  await tx.$executeRaw`
    UPDATE external_entity_maps m SET upstream_removed_at = ${now}::timestamptz, updated_at = now()
      FROM shifts s
     WHERE m.integration_id = ${integrationId}::uuid AND m.entity_type = 'SHIFT'
       AND s.id = m.internal_id AND s.organisation_id = ${organisationId}::uuid
       AND s.status = 'CANCELLED' AND s.ends_at > ${now}::timestamptz
       AND s.managed_by_integration_id = ${integrationId}::uuid`;

  await tx.$executeRaw`
    UPDATE external_entity_maps SET last_hash = NULL, updated_at = now()
     WHERE integration_id = ${integrationId}::uuid`;

  return { employees, locations, teams, shifts };
}

/**
 * Switching to another portal (§5.7, only from DISCONNECTED and only when the manager confirmed): the map rows, the
 * mapping config (with `onboardingCompletedAt`), pending and preview rows are deleted. ClockOff's records stay, with
 * `managedByIntegrationId` already cleared by the disconnect; portal-qualified external ids (§2.6) keep the old
 * portal's records from colliding with the new portal's.
 */
export async function resetIntegrationMappings(
  tx: Tx,
  input: { organisationId: string; integrationId: string },
): Promise<void> {
  const where = { organisationId: input.organisationId, integrationId: input.integrationId };
  await tx.externalEntityMap.deleteMany({ where });
  await tx.integrationPreviewShift.deleteMany({ where });
  await tx.pendingExternalEmployee.deleteMany({ where });
  await tx.integrationMappingConfig.deleteMany({ where });
}
